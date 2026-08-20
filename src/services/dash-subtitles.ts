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

  get active(): boolean {
    return this._active;
  }

  async start(
    video: HTMLVideoElement,
    manifestUrl: string,
    want?: { name?: string; lang?: string },
  ): Promise<void> {
    this.stop();
    const gen = ++this.gen;
    this.video = video;
    try {
      const subtitle = await this.loadSubtitle(manifestUrl, want, gen);
      if (gen !== this.gen || !subtitle) return;
      this._active = true;
      this.cueTrack.attach(video, t('player.subtitles'), subtitle.lang || 'und');
      log.info('subtitles on:', subtitle.name || subtitle.lang || '?');
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
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    const parsed = parseMpd(await res.text(), res.url, this.video?.currentTime);
    if (gen !== this.gen) return null;
    return pickWebVttSubtitle(parsed.subtitles, want);
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
      const currentTime = this.video.currentTime;
      const seekable = this.video.seekable;
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
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const parsed = parseWebVTT(await response.text());
        if (gen !== this.gen || !this.cueTrack.current) return;
        this.seen.add(key);
        for (const cue of parsed.cues) {
          const start = cueMediaTime(segment, cue.start, parsed.mapLocal);
          const end = start + cue.end - cue.start;
          this.cueTrack.add(start, end, cue.text, cue.settings);
        }
      }
      for (const key of Array.from(this.seen)) {
        if (!currentKeys.has(key)) this.seen.delete(key);
      }
      this.cueTrack.prune(this.video.currentTime - CUE_RETENTION_S);
    } catch (e) {
      log.debug('subtitles refresh failed:', e);
    }
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
