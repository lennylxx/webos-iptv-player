import type { SidecarSubtitle } from '../types';
import { parseSubtitleFile } from '../utils/srt';
import { fetchText } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';

const log = createLogger('VodSubs');

/**
 * Loads Xtream sidecar subtitle files (SRT / WebVTT) as native `<track>` text
 * tracks on the VOD player. Each sidecar becomes an empty `<track>` up front so
 * it lists in the subtitle picker immediately; its cues are fetched and parsed
 * the first time it's actually shown. The `<track>` elements are children of the
 * `<video>`, so the player's `innerHTML` reset between streams removes them and
 * their tracks — no leakage from one item into the next.
 */
export class VodSubtitles {
  private entries: { track: TextTrack; url: string; text?: string; loaded: boolean }[] = [];
  private gen = 0; // bumped on each attach/clear; in-flight loads bail when it changes
  private offset = 0; // per-stream subtitle timing offset (seconds; + = later)

  attach(video: HTMLVideoElement, sidecars: SidecarSubtitle[]): void {
    this.gen++;
    this.entries = [];
    for (const s of sidecars) {
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = s.name || s.lang || t('player.subtitles');
      if (s.lang) el.srclang = s.lang;
      video.appendChild(el);
      const track = el.track;
      if (!track) continue;
      track.mode = 'disabled';
      this.entries.push({ track, url: s.url, text: s.text, loaded: false });
    }
    if (sidecars.length) log.info('attached', this.entries.length, 'sidecar track(s)');
  }

  // Fetch + parse + populate the cues for `track` the first time it's shown.
  // No-op for a track we don't own or one already loaded.
  async ensureLoaded(track: TextTrack): Promise<void> {
    const entry = this.entries.find((e) => e.track === track);
    if (!entry || entry.loaded) return;
    entry.loaded = true; // claim before await so a repeated show doesn't double-fetch
    const gen = this.gen;
    try {
      const raw = entry.text != null ? entry.text : await fetchText(entry.url);
      const cues = parseSubtitleFile(raw);
      if (gen !== this.gen) return; // a new item was attached while this was fetching
      for (const c of cues) entry.track.addCue(new VTTCue(c.start + this.offset, c.end + this.offset, c.text));
      log.info('loaded', cues.length, 'cues from', entry.url);
    } catch (e) {
      entry.loaded = false; // allow a retry on the next show
      log.warn(
        'VOD sidecar subtitle load failed',
        'event=xtream.subtitle.load.failed',
        e,
      );
    }
  }

  /** Append one more sidecar track after attach (online results fetched
   *  mid-playback). Does not disturb existing entries or bump `gen`. */
  addOnline(video: HTMLVideoElement, sub: SidecarSubtitle): TextTrack | null {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = sub.name || sub.lang || t('player.subtitles');
    if (sub.lang) el.srclang = sub.lang;
    video.appendChild(el);
    const track = el.track;
    if (!track) return null;
    track.mode = 'disabled';
    this.entries.push({ track, url: sub.url, text: sub.text, loaded: false });
    return track;
  }

  /** Shift all sidecar cues (across every owned track) by `seconds`. Positive = later. */
  setOffset(seconds: number): void {
    const delta = seconds - this.offset;
    this.offset = seconds;
    if (!delta) return;
    for (const e of this.entries) {
      const cues = e.track.cues;
      if (!cues) continue;
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i] as VTTCue;
        c.startTime += delta;
        c.endTime += delta;
      }
    }
  }

  /** True when `track` is one of the sidecar tracks this instance created. */
  owns(track: TextTrack): boolean {
    return this.entries.some((e) => e.track === track);
  }

  clear(): void {
    this.gen++;
    this.entries = [];
  }
}
