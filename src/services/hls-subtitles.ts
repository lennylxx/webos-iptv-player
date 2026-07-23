import { parseWebVTT, applyCueSettings, type VttCueSettings } from '../utils/webvtt';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';

const log = createLogger('HlsSubs');

const POLL_MS = 2000;        // subtitle media playlist target-duration is ~2s
const WINDOW = 15;           // only the most recent N segments (~30s); playlists can hold hours
const CUE_RETENTION_S = 30;  // drop cues this far behind the playhead
const CALIB_REMEASURE_MS = 6000;  // re-sample the reconstructed startDate this often (averaged)
const MERGE_GAP_S = 1.0;          // merge same-text cues within this gap (boundary-split blink/overlap)

interface Segment { uri: string; pdtMs: number | null; }
interface Rendition { name: string; lang: string; uri: string; def: boolean; }
interface MediaPlaylist { segs: Segment[]; unsupported: 'fmp4' | 'encrypted' | null; }

/**
 * Self-rendered HLS subtitles for the webOS native player. The TV plays the video
 * natively (no hls.js) and does not surface in-manifest WebVTT renditions as
 * switchable text tracks, so we fetch the subtitle rendition ourselves, parse the
 * WebVTT segments, and feed cues into a `TextTrack` we create. Blink renders the
 * cues (parsing `<c.class>` markup) styled by our `::cue` CSS.
 *
 * Placing a cue means mapping its wall clock (PROGRAM-DATE-TIME) onto the video media
 * clock. That hinges on `getStartDate()`, which is NaN for HLS on webOS — see `anchor`
 * (the map) and `maybeCalibrate` (how we reconstruct getStartDate).
 */
export class HlsSubtitles {
  private video: HTMLVideoElement | null = null;
  private track: TextTrack | null = null;
  private trackVideo: HTMLVideoElement | null = null; // element the track belongs to (for reuse)
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private subsUrl = '';
  private gen = 0;            // bumped on stop(); in-flight async bails when it changes
  private _active = false;
  private offset = 0; // per-stream subtitle timing offset (seconds; + = later)
  private loggedNoAnchor = false; // one-shot: warn once when cues can't be anchored
  private addedKeys = new Map<string, number>(); // dedup repeated cues (key -> cue wall ms)
  // Reconstructed getStartDate (see maybeCalibrate), since webOS returns NaN for HLS.
  private videoVariantUrl = '';
  private reconStartDateMs: number | null = null; // reconstructed wall-clock of currentTime=0
  private calibAt = 0;                            // Date.now() of the last calibration
  private startDateSamples: number[] = [];        // reconstructions, averaged to cut quantization jitter
  private videoHasNoPdt = false;                  // video playlist carries no PDT → can't reconstruct, stop trying

  /** True once we own subtitle rendering — the native picker must defer to us. */
  get active(): boolean {
    return this._active;
  }

  async start(video: HTMLVideoElement, masterUrl: string, want?: { name?: string; lang?: string }): Promise<void> {
    this.stop();
    const gen = ++this.gen;
    this.video = video;
    try {
      const res = await fetch(masterUrl);
      if (gen !== this.gen) return;
      const masterText = await res.text();
      const rend = pickSubtitleRendition(masterText, want);
      if (gen !== this.gen) return;
      if (!rend) { log.info('no subtitle rendition with a URI in the master'); return; }
      this.subsUrl = new URL(rend.uri, res.url).href;
      // Also grab a video variant playlist: its oldest PDT vs seekable.start
      // reconstructs getStartDate (see maybeCalibrate).
      const variant = pickVideoVariant(masterText);
      this.videoVariantUrl = variant ? new URL(variant, res.url).href : '';
      this.reconStartDateMs = null; this.calibAt = 0; this.startDateSamples = []; this.videoHasNoPdt = false;
      this._active = true; // claim ownership before addTextTrack fires its addtrack event
      this.loggedNoAnchor = false;
      // Reuse one track per element — TextTracks can't be removed, only disabled.
      if (!this.track || this.trackVideo !== video) {
        this.track = video.addTextTrack('subtitles', t('player.subtitles'), rend.lang || 'und');
        this.trackVideo = video;
      }
      this.track.mode = 'showing';
      log.info('subtitles on:', rend.name || rend.lang || '?', '| playlist', this.subsUrl);
      await this.refresh(gen);
      this.timer = setInterval(() => void this.refresh(gen), POLL_MS);
    } catch (e) {
      this._active = false;
      log.warn('subtitles start failed:', e);
    }
  }

  stop(): void {
    this.gen++;
    this._active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.clearCues();
    if (this.track) this.track.mode = 'disabled';
    this.seen.clear();
    this.addedKeys.clear();
    this.subsUrl = '';
    // Keep this.track / trackVideo so the next start() on the same element reuses it.
  }

  private async refresh(gen: number): Promise<void> {
    if (gen !== this.gen || !this.video || !this.track) return;
    const v = this.video;
    try {
      const res = await fetch(this.subsUrl);
      if (gen !== this.gen || !this.track) return;
      const pl = parseMediaPlaylist(await res.text());
      if (pl.unsupported) {
        // fMP4/IMSC or encrypted WebVTT — a text fetch can't decode it, so stop
        // polling and say why (otherwise it silently renders nothing forever).
        log.info('subtitles: cannot self-render this rendition —', pl.unsupported);
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this._active = false;
        return;
      }
      const all = pl.segs;
      const base = res.url;
      await this.maybeCalibrate(gen);
      if (gen !== this.gen || !this.track) return;
      const anchor = this.anchor(all);
      if (!anchor && !this.loggedNoAnchor && all.length > 0 && !all.some(s => s.pdtMs != null)) {
        this.loggedNoAnchor = true;
        log.info('subtitles: no PROGRAM-DATE-TIME in the playlist — cannot anchor cue timing');
      }
      if (!anchor) return;

      const ct = v.currentTime;
      const windowUris = new Set<string>();
      let added = 0;
      for (const seg of all.slice(-WINDOW)) {
        windowUris.add(seg.uri);
        if (this.seen.has(seg.uri) || seg.pdtMs == null) continue;
        this.seen.add(seg.uri);
        const segMedia = wallToMediaSeconds(anchor, seg.pdtMs);
        if (segMedia < ct - 4) continue; // already played past the playhead — don't fetch it
        const vtt = await (await fetch(new URL(seg.uri, base).href)).text();
        if (gen !== this.gen || !this.track) return;
        const { mapLocal, cues } = parseWebVTT(vtt);
        if (!cues.length) continue;
        // Each cue's wall clock comes from THIS segment's PROGRAM-DATE-TIME (a
        // per-segment anchor, robust when the playlist is a sliding window). Usually
        // cue times are offsets from the X-TIMESTAMP-MAP LOCAL anchor; some broadcasters
        // instead number cues along the whole media timeline (LOCAL:0, cue at e.g.
        // 03:21:40) — detect that (cue clock far past a per-segment offset) and anchor
        // to the segment's own first cue.
        const local = cues[0].start - mapLocal > 60 ? cues[0].start : mapLocal;
        for (const c of cues) {
          if (c.end <= c.start) continue;
          const wallMs = seg.pdtMs + (c.start - local) * 1000;
          // Dedup re-adds of the same cue — identical text *and* timing. Key on
          // start+end (not a rounded second) so the two abutting halves a broadcaster
          // emits for a caption straddling a segment boundary both survive instead of
          // one being dropped (which made the caption flash too briefly to read).
          const endWallMs = wallMs + (c.end - c.start) * 1000;
          const key = cueKey(wallMs, endWallMs, c.text);
          if (this.addedKeys.has(key)) continue;
          this.addedKeys.set(key, wallMs);
          const start = wallToMediaSeconds(anchor, wallMs);
          try {
            this.track.addCue(this.makeCue(start, start + (c.end - c.start), c.text, c.settings)); added++;
          } catch { /* invalid */ }
        }
      }
      this.seen = new Set([...this.seen].filter(u => windowUris.has(u))); // bound to the window
      this.pruneKeys();
      if (added) {
        this.mergeSameTextCues();
        this.prune();
      }
    } catch (e) {
      log.debug('subtitles refresh failed:', e);
    }
  }

  /** Shift all self-rendered cues (and any added later) by `seconds` relative to their true
   *  media time. Positive = subtitles appear later. */
  setOffset(seconds: number): void {
    const delta = seconds - this.offset;
    this.offset = seconds;
    if (!delta || !this.track || !this.track.cues) return;
    const cues = this.track.cues;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i] as VTTCue;
      c.startTime += delta;
      c.endTime += delta;
    }
  }

  /** True when `track` is the TextTrack this instance self-renders into. */
  owns(track: TextTrack): boolean {
    return this.track === track;
  }

  // Build a cue at (start, end) media time with the active offset baked in.
  private makeCue(startMedia: number, endMedia: number, text: string, settings?: VttCueSettings): VTTCue {
    const cue = new VTTCue(startMedia + this.offset, endMedia + this.offset, text);
    if (settings) { try { applyCueSettings(cue, settings); } catch { /* positioning unsupported */ } }
    return cue;
  }

  // A caption that spans segment boundaries is re-emitted as several same-text cues —
  // clamped per segment, so they overlap (a doubled line) or leave a small gap (a blink).
  // Merge each run of identical-text cues within MERGE_GAP_S into one continuous cue.
  private mergeSameTextCues(): void {
    const list = this.track?.cues;
    if (!list || list.length < 2) return;
    const cues: VTTCue[] = [];
    for (let i = 0; i < list.length; i++) cues.push(list[i] as VTTCue);
    for (const g of planSameTextMerges(cues, MERGE_GAP_S, CUE_RETENTION_S)) {
      cues[g.keep].endTime = g.end;
      for (const d of g.drop) this.track!.removeCue(cues[d]);
    }
  }

  // Map the subtitle wall-clock timeline to the video media clock. Returns null until
  // `seekable` is populated, so we don't fetch/place cues while still buffering (no live
  // edge yet, and it competes for bandwidth). Three anchor sources, best first:
  //  - getStartDate(): wall-clock of currentTime=0, so a cue's media time is exactly
  //    (cueWall - startDate)/1000. Exact, but NaN for HLS on webOS.
  //  - recon (webOS): getStartDate reconstructed from the video feed's oldest PDT
  //    (maybeCalibrate), sidestepping the live-edge hold-back.
  //  - edge (fallback, no video PDT): newest PDT ↔ `seekable.end`, accepting the
  //    hold-back skew (cues run a few seconds early).
  private anchor(segments: Segment[]): { media: number; wallMs: number; src: string } | null {
    const v = this.video;
    if (!v || !v.seekable || !v.seekable.length) return null;
    const sd = (v as unknown as { getStartDate?: () => Date }).getStartDate?.();
    const sdMs = sd ? sd.getTime() : NaN;
    if (Number.isFinite(sdMs)) return { media: 0, wallMs: sdMs, src: 'getStartDate' };
    if (this.reconStartDateMs != null) return { media: 0, wallMs: this.reconStartDateMs, src: 'recon' };
    const newest = newestPdt(segments);
    if (newest == null) return null;
    return { media: v.seekable.end(v.seekable.length - 1), wallMs: newest, src: 'edge' };
  }

  // Reconstruct getStartDate (wall-clock of currentTime=0) from the VIDEO feed, avoiding
  // the live-edge hold-back that makes `seekable.end` lag the newest PDT. Pair the video
  // variant's *oldest* PDT with `seekable.start` (the timeline start has no hold-back):
  // startDate = oldestPDT − seekable.start·1000, constant since both slide together at 1x.
  // Both are quantized to ~segment boundaries, so each sample carries ±~half-a-segment of
  // noise; startDate is fixed per session, so we average several samples (lowPercentile) to
  // stop the sync shifting each recalibration. A few quick fetches, then it settles.
  private async maybeCalibrate(gen: number): Promise<void> {
    if (!this.videoVariantUrl || this.videoHasNoPdt) return;
    if (this.startDateSamples.length >= 8) return; // enough samples — startDate is fixed, stop fetching
    const v = this.video;
    if (!v || !v.seekable || !v.seekable.length) return;
    if (this.calibAt && Date.now() - this.calibAt < CALIB_REMEASURE_MS) return;
    this.calibAt = Date.now();
    try {
      const res = await fetch(this.videoVariantUrl);
      if (gen !== this.gen || !this.video || !v.seekable.length) return;
      const segs = parseMediaPlaylist(await res.text()).segs;
      const oldest = oldestPdt(segs);
      if (oldest == null) {
        this.videoHasNoPdt = true;
        log.info('video playlist has no PROGRAM-DATE-TIME — using live-edge anchor (cues may run a few seconds early)');
        return;
      }
      const sStart = v.seekable.start(0);
      this.startDateSamples.push(Math.round(oldest - sStart * 1000));
      // A low percentile of the reconstructions tracks the audio best on the channels
      // tested (the residual that's left is a per-channel feed offset, not estimator error).
      this.reconStartDateMs = lowPercentile(this.startDateSamples, 0.2);
    } catch (e) {
      log.debug('calibrate failed:', e);
    }
  }

  private prune(): void {
    const cues = this.track?.cues;
    if (!cues || !this.track) return;
    const cutoff = (this.video?.currentTime ?? 0) - CUE_RETENTION_S;
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].endTime < cutoff) this.track.removeCue(cues[i]);
    }
  }

  // Bound the dedup map: keep only keys from roughly the last 90s of subtitle time.
  private pruneKeys(): void {
    let max = 0;
    for (const w of this.addedKeys.values()) if (w > max) max = w;
    for (const [k, w] of this.addedKeys) if (w < max - 90000) this.addedKeys.delete(k);
  }

  private clearCues(): void {
    const cues = this.track?.cues;
    if (!cues || !this.track) return;
    for (let i = cues.length - 1; i >= 0; i--) this.track.removeCue(cues[i]);
  }
}

// Place a wall-clock instant on the video media timeline. The anchor pins one
// media time to its wall clock; live plays at 1x (slope 1), so it's a plain
// linear map with no fudge offset.
export function wallToMediaSeconds(anchor: { media: number; wallMs: number }, wallMs: number): number {
  return anchor.media + (wallMs - anchor.wallMs) / 1000;
}

/** Dedup key for a cue: identical text AND timing → same key (a true re-add);
 *  the abutting halves of a boundary-straddling caption differ in their start/end
 *  wall times, so they get distinct keys and both survive. */
export function cueKey(startWallMs: number, endWallMs: number, text: string): string {
  return Math.round(startWallMs) + '-' + Math.round(endWallMs) + '|' + text;
}

/** Newest PROGRAM-DATE-TIME in the playlist (the live-edge wall clock), or null if
 *  no segment carries one. */
export function newestPdt(segments: Segment[]): number | null {
  let newest: number | null = null;
  for (const s of segments) if (s.pdtMs != null && (newest == null || s.pdtMs > newest)) newest = s.pdtMs;
  return newest;
}

/** Plan merges of adjacent same-text cues (sorted by startTime) within `gapS` of each
 *  other, scanning only the tail within `windowS` of the newest. Returns one group per
 *  run that has anything to absorb: `keep` (anchor index), `drop` (absorbed indices),
 *  `end` (the run's max endTime). Pure, so the merge logic is unit-tested. */
export function planSameTextMerges(
  cues: ReadonlyArray<{ text: string; startTime: number; endTime: number }>,
  gapS: number, windowS: number,
): Array<{ keep: number; drop: number[]; end: number }> {
  if (cues.length < 2) return [];
  const newest = cues[cues.length - 1].startTime;
  const groups: Array<{ keep: number; drop: number[]; end: number }> = [];
  let cur: { keep: number; drop: number[]; end: number } | null = null;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.startTime < newest - windowS) continue; // recent tail only
    if (cur && cues[cur.keep].text === c.text && c.startTime <= cur.end + gapS) {
      cur.drop.push(i);
      if (c.endTime > cur.end) cur.end = c.endTime;
    } else {
      if (cur && cur.drop.length) groups.push(cur);
      cur = { keep: i, drop: [], end: c.endTime };
    }
  }
  if (cur && cur.drop.length) groups.push(cur);
  return groups;
}

/** Oldest PROGRAM-DATE-TIME in the playlist (the window start's wall clock), or null
 *  if no segment carries one. */
export function oldestPdt(segments: Segment[]): number | null {
  let oldest: number | null = null;
  for (const s of segments) if (s.pdtMs != null && (oldest == null || s.pdtMs < oldest)) oldest = s.pdtMs;
  return oldest;
}

/** Value at low percentile `p` (0..1) of `samples`, nearest-rank on a sorted copy. Used to
 *  estimate startDate from the per-recalibration reconstructions: a low percentile tracked
 *  the audio best on the channels tested (vs. the mean/midpoint). */
export function lowPercentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.round(p * (sorted.length - 1))];
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const segs: Segment[] = [];
  let pdt: number | null = null;      // explicit PROGRAM-DATE-TIME for the next segment
  let dur = 0;                        // EXTINF of the next segment (seconds)
  let nextWall: number | null = null; // predicted wall start of the next segment (carry-forward)
  let unsupported: MediaPlaylist['unsupported'] = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const v = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
      pdt = Number.isFinite(v) ? v : null;
    } else if (line.startsWith('#EXTINF:')) {
      dur = parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-MAP')) {
      unsupported = 'fmp4'; // fMP4/IMSC subtitle segments — not text WebVTT we can parse
    } else if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) {
      unsupported = 'encrypted';
    } else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
      nextWall = null; // media timeline reset — stop carrying PDT until the next explicit one
    } else if (line && !line.startsWith('#')) {
      // Per §6.2.1 a server need only tag PROGRAM-DATE-TIME once (or per discontinuity);
      // carry it forward by summing EXTINF so later segments aren't dropped for lack of a tag.
      const segPdt: number | null = pdt != null ? pdt : nextWall;
      segs.push({ uri: line, pdtMs: segPdt });
      nextWall = segPdt != null ? segPdt + dur * 1000 : null;
      pdt = null;
      dur = 0;
    }
  }
  return { segs, unsupported };
}

/** First video variant playlist URI in a master (any variant — they share one
 *  timeline), so we can read the video feed's oldest PROGRAM-DATE-TIME to reconstruct
 *  getStartDate. Returns null for a bare media playlist (no `#EXT-X-STREAM-INF`). */
export function pickVideoVariant(master: string): string | null {
  const lines = master.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j].trim();
      if (u && !u.startsWith('#')) return u;
    }
  }
  return null;
}

function pickSubtitleRendition(master: string, want?: { name?: string; lang?: string }): Rendition | null {
  const subs: Rendition[] = [];
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES(?:,|$)/.test(line)) continue;
    const attr = (k: string): string => line.match(new RegExp(`[:,]\\s*${k}="([^"]*)"`))?.[1] ?? '';
    const uri = attr('URI');
    if (!uri) continue;
    subs.push({ name: attr('NAME'), lang: attr('LANGUAGE'), uri, def: /[:,]DEFAULT=YES(?:,|$)/.test(line) });
  }
  if (!subs.length) return null;
  if (want?.name) {
    const m = subs.find(s => s.name.toLowerCase() === want.name!.toLowerCase());
    if (m) return m;
  }
  if (want?.lang) {
    const m = subs.find(s => s.lang.toLowerCase() === want.lang!.toLowerCase());
    if (m) return m;
  }
  return subs.find(s => s.def) ?? subs[0];
}
