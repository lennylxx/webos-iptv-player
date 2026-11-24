import type { SidecarSubtitle } from '../types';
import { parseSubtitleFile } from '../utils/srt';
import { fetchText } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { WebVttCueTrack } from './webvtt-cue-track';
import type { VttCue } from '../utils/webvtt';

const log = createLogger('VodSubs');

/**
 * Loads Xtream sidecar subtitle files (SRT / WebVTT) into one reusable
 * application-created TextTrack. Empty `<track>` elements accept cues but do not
 * paint them on some older webOS releases, while `addTextTrack()` does.
 */
export class VodSubtitles {
  private entries: Array<{
    name: string;
    lang: string;
    url: string;
    text?: string;
    cues?: VttCue[];
    loading?: Promise<VttCue[]>;
    // A translation of this entry index; its cues start as copies of the source's.
    source?: number;
  }> = [];
  // Cues added for the shown entry, by its cue index, so a translation can update them.
  private shownCues: Array<VTTCue | null> = [];
  private video: HTMLVideoElement | null = null;
  private cueTrack = new WebVttCueTrack();
  private gen = 0;
  private _activeIndex = -1;

  get activeIndex(): number {
    return this._activeIndex;
  }

  attach(video: HTMLVideoElement, sidecars: SidecarSubtitle[]): void {
    this.clear();
    this.video = video;
    this.entries = sidecars.map(sidecar => ({
      name: sidecar.name || sidecar.lang || t('player.subtitles'),
      lang: sidecar.lang,
      url: sidecar.url,
      text: sidecar.text,
    }));
    if (sidecars.length) log.info('attached', this.entries.length, 'sidecar track(s)');
  }

  async show(index: number): Promise<void> {
    const entry = this.entries[index];
    const video = this.video;
    if (!entry || !video) {
      this.hide();
      return;
    }
    if (this._activeIndex === index) return;
    const gen = ++this.gen;
    this._activeIndex = index;
    this.shownCues = [];
    this.cueTrack.disable();
    try {
      const cues = await this.load(entry);
      if (gen !== this.gen) return;
      this.cueTrack.attach(video, entry.name, entry.lang);
      this.shownCues = cues.map(cue => this.cueTrack.addCue(cue.start, cue.end, cue.text, cue.settings));
      this.cueTrack.redraw();
      log.info('loaded', cues.length, 'cues', entry.source === undefined ? 'from sidecar' : 'for translation');
    } catch (e) {
      if (gen === this.gen) {
        this._activeIndex = -1;
        this.cueTrack.disable();
      }
      log.warn(
        'VOD sidecar subtitle load failed',
        'event=xtream.subtitle.load.failed',
        e,
      );
    }
  }

  /** The cues of entry `index`, loading them on first use. */
  cuesOf(index: number): Promise<VttCue[]> {
    const entry = this.entries[index];
    return entry ? this.load(entry) : Promise.reject(new Error('No such subtitle'));
  }

  private load(entry: typeof this.entries[number]): Promise<VttCue[]> {
    if (entry.cues) return Promise.resolve(entry.cues);
    if (entry.source !== undefined && !entry.loading) {
      entry.loading = this.cuesOf(entry.source).then((cues) => {
        entry.cues = cues.map(cue => ({ ...cue }));
        entry.loading = undefined;
        return entry.cues;
      }, (error: unknown) => {
        entry.loading = undefined;
        throw error;
      });
    }
    if (!entry.loading) {
      entry.loading = (entry.text != null
        ? Promise.resolve(entry.text)
        : fetchText(entry.url))
        .then(parseSubtitleFile)
        .then((cues) => {
          entry.cues = cues;
          entry.loading = undefined;
          return cues;
        }, (error: unknown) => {
          entry.loading = undefined;
          throw error;
        });
    }
    return entry.loading;
  }

  /** Append a sidecar downloaded during playback and return its picker index. */
  addOnline(video: HTMLVideoElement, sub: SidecarSubtitle): number {
    if (this.video !== video) {
      this.clear();
      this.video = video;
    }
    this.entries.push({
      name: sub.name || sub.lang || t('player.subtitles'),
      lang: sub.lang,
      url: sub.url,
      text: sub.text,
    });
    return this.entries.length - 1;
  }

  /** Add a translation of entry `source` and return its picker index. */
  addTranslation(source: number, name: string, lang: string): number {
    this.entries.push({ name, lang, url: '', source });
    return this.entries.length - 1;
  }

  /** Index of the translation of `source` into `lang`, or -1. */
  translationOf(source: number, lang: string): number {
    return this.entries.findIndex(entry => entry.source === source && entry.lang === lang);
  }

  sourceOf(index: number): number {
    return this.entries[index]?.source ?? -1;
  }

  /** Replace the text of translated cues, live if the entry is shown. */
  setCueTexts(index: number, cueIndices: readonly number[], texts: readonly string[]): void {
    const cues = this.entries[index]?.cues;
    if (!cues) return;
    const shown = this._activeIndex === index && this.shownCues.length === cues.length;
    const now = this.video?.currentTime ?? NaN;
    let onScreen = false;
    cueIndices.forEach((cueIndex, k) => {
      const cue = cues[cueIndex];
      if (!cue) return;
      cue.text = texts[k];
      const live = shown ? this.shownCues[cueIndex] : null;
      if (!live) return;
      live.text = texts[k];
      if (live.startTime <= now && now < live.endTime) onScreen = true;
    });
    if (onScreen) this.cueTrack.redraw();
  }

  hide(): void {
    this.gen++;
    this.shownCues = [];
    this._activeIndex = -1;
    this.cueTrack.disable();
  }

  setOffset(seconds: number): void {
    this.cueTrack.setOffset(seconds);
  }

  owns(track: TextTrack): boolean {
    return this.cueTrack.owns(track);
  }

  clear(): void {
    this.hide();
    this.entries = [];
    this.video = null;
  }
}
