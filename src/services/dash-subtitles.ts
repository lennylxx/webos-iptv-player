import { parseMpd } from '../parsers/mpd-manifest';
import type { DashSubtitleSegment, ManifestSubtitle } from '../types';
import { parseWebVTT } from '../utils/webvtt';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { WebVttCueTrack } from './webvtt-cue-track';

const log = createLogger('DashSubs');
const POLL_MS = 2000;
const CUE_RETENTION_S = 30;

export class DashSubtitles {
  private video: HTMLVideoElement | null = null;
  private cueTrack = new WebVttCueTrack();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private gen = 0;
  private _active = false;
  private clock: (() => number) | null = null;
  private manifestText: string | undefined;
  private onUnavailable: ((reason: string) => void) | null = null;
  private loadedSegment = false;

  get active(): boolean {
    return this._active;
  }

  async start(
    video: HTMLVideoElement,
    manifestUrl: string,
    want?: { name?: string; lang?: string },
    // Another pipeline's playback clock, when the element plays a placeholder.
    clock?: () => number,
    // The MPD already read, at manifestUrl, when the page cannot read it again.
    manifestText?: string,
    // Called once, after stopping, when the rendition can never render.
    onUnavailable?: (reason: string) => void,
  ): Promise<void> {
    this.stop();
    const gen = ++this.gen;
    this.video = video;
    this.clock = clock ?? null;
    this.manifestText = manifestText;
    this.onUnavailable = onUnavailable ?? null;
    this.loadedSegment = false;
    try {
      const subtitle = await this.loadSubtitle(manifestUrl, want, gen);
      if (gen !== this.gen || !subtitle) return;
      this._active = true;
      this.cueTrack.attach(video, t('player.subtitles'), subtitle.lang || 'und', this.clock ?? undefined);
      log.info('subtitles on:', 'format=webvtt', 'source=dash');
      await this.refresh(manifestUrl, want, gen);
      if (gen === this.gen) {
        this.timer = setInterval(
          () => void this.refresh(manifestUrl, want, gen),
          POLL_MS,
        );
      }
    } catch (e) {
      this._active = false;
      log.warn('subtitles start failed:', e);
    }
  }

  stop(): void {
    this.gen++;
    this._active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cueTrack.disable();
    this.seen.clear();
  }

  private now(): number {
    return this.clock ? this.clock() : (this.video?.currentTime ?? 0);
  }

  setOffset(seconds: number): void {
    this.cueTrack.setOffset(seconds);
  }

  owns(track: TextTrack): boolean {
    return this.cueTrack.owns(track);
  }

  private async loadSubtitle(
    manifestUrl: string,
    want: { name?: string; lang?: string } | undefined,
    gen: number,
  ): Promise<ManifestSubtitle | null> {
    let text = this.manifestText;
    let base = manifestUrl;
    if (text === undefined) {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      text = await res.text();
      base = res.url;
    }
    const now = this.now();
    const parsed = parseMpd(text, base, Number.isFinite(now) ? now : undefined);
    if (gen !== this.gen) return null;
    // A rendition only a manifest re-read can extend is not in the menu.
    const subtitles = this.manifestText === undefined
      ? parsed.subtitles
      : parsed.subtitles.filter(s => !s.dash?.needsManifestRefresh);
    return pickWebVttSubtitle(subtitles, want);
  }

  private async refresh(
    manifestUrl: string,
    want: { name?: string; lang?: string } | undefined,
    gen: number,
  ): Promise<void> {
    if (gen !== this.gen || !this.video || !this.cueTrack.current) return;
    try {
      const subtitle = await this.loadSubtitle(manifestUrl, want, gen);
      if (gen !== this.gen || !subtitle || !this.cueTrack.current) return;
      const source = subtitle.dash;
      if (!source || source.kind !== 'webvtt') return;
      const segments = source.segments?.length
        ? source.segments
        : source.url ? [{ url: source.url, start: 0, duration: 0 }] : [];
      const currentTime = this.now();
      // No cue can be placed before the clock reports a position.
      if (!Number.isFinite(currentTime)) return;
      const seekable = this.clock ? null : this.video.seekable;
      const ahead = seekable?.length
        ? seekable.end(seekable.length - 1) + 5
        : currentTime + 15;
      const relevant = segments.filter(segment =>
        !segment.duration
        || (segment.start <= ahead && segment.start + segment.duration >= currentTime - 4),
      );
      const currentKeys = new Set(segments.map(segment =>
        segment.range ? `${segment.url}|${segment.range}` : segment.url));
      for (const segment of relevant) {
        const key = segment.range ? `${segment.url}|${segment.range}` : segment.url;
        if (this.seen.has(key)) continue;
        const response = segment.range
          ? await fetch(segment.url, {
              headers: { Range: `bytes=${segment.range}` },
            })
          : await fetch(segment.url);
        if (!response.ok) {
          if (gen !== this.gen) return;
          // Segments of an MPD only the service could read go out without its
          // headers; a header refusal before any segment loaded never clears.
          // Any other 4xx, such as a live edge ahead of the origin, retries.
          if (this.manifestText !== undefined && !this.loadedSegment
            && (response.status === 401 || response.status === 403)) {
            this.unavailable(`segment_http_${String(response.status)}`);
            return;
          }
          throw new Error(`HTTP ${String(response.status)}`);
        }
        const parsed = parseWebVTT(await response.text());
        if (gen !== this.gen || !this.cueTrack.current) return;
        this.seen.add(key);
        this.loadedSegment = true;
        for (const cue of parsed.cues) {
          const start = cueMediaTime(segment, cue.start, parsed.mapLocal);
          const end = start + cue.end - cue.start;
          this.cueTrack.add(start, end, cue.text, cue.settings);
        }
      }
      for (const key of Array.from(this.seen)) {
        if (!currentKeys.has(key)) this.seen.delete(key);
      }
      this.cueTrack.prune(this.now() - CUE_RETENTION_S);
    } catch (e) {
      log.debug('subtitles refresh failed:', e);
    }
  }

  private unavailable(reason: string): void {
    const report = this.onUnavailable;
    this.stop();
    report?.(reason);
  }

}

export function cueMediaTime(
  segment: DashSubtitleSegment,
  cueStart: number,
  mapLocal: number,
): number {
  if (!segment.duration) return cueStart;
  const relative = cueStart - mapLocal;
  const looksAbsolute = cueStart >= segment.start - 1
    && cueStart <= segment.start + segment.duration + 1;
  return looksAbsolute ? cueStart : segment.start + relative;
}

export function pickWebVttSubtitle(
  subtitles: ManifestSubtitle[],
  want?: { name?: string; lang?: string },
): ManifestSubtitle | null {
  const candidates = subtitles.filter(s =>
    s.dash?.kind === 'webvtt'
    && (!!s.dash.url || !!s.dash.segments?.length),
  );
  if (!candidates.length) return null;
  return candidates.find(s =>
    (want?.name && s.name === want.name)
    || (want?.lang && s.lang === want.lang),
  ) || candidates[0];
}
