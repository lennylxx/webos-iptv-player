import type {
  Action,
  AudioOption,
  AudioPref,
  AudioTrackOption,
  Channel,
  ManifestAudio,
  ManifestClosedCaption,
  ManifestSubtitle,
  SidecarSubtitle,
  SubtitleOption,
  SubtitlePref,
  SubtitleTrackOption,
  VodPlayback,
} from '../types';
import { StorageService } from '../services/storage-service';
import {
  HlsSubtitles,
  isPermanentSubtitleFailure,
  type HlsSubtitlesOptions,
} from '../services/hls-subtitles';
import { DashSubtitles } from '../services/dash-subtitles';
import { VodSubtitles } from '../services/vod-subtitles';
import { AssSubtitles, isAssSidecar } from '../services/ass-subtitles';
import { getCachedSubtitle, setCachedSubtitle } from '../services/idb-cache';
import { isLunaAvailable, lunaRequest } from '../services/luna';
import {
  audioLabel,
  chooseAudioIndex,
  isPrefMatch,
  mapLunaAudio,
  mergeManifestNames,
  nativeAudioOptions,
} from '../utils/audio-tracks';
import {
  chooseSubtitleIndex,
  clampSubtitleOffset,
  closedCaptionLabel,
  formatSubtitleOffset,
  isSubtitlePrefMatch,
  languageKey,
  languageName,
  manifestSubtitleOptions,
  nativeSubtitleOptions,
  shiftForeignTrack,
  subtitleLabel,
} from '../utils/subtitle-tracks';
import { playbackPreferenceKey } from '../utils/channel';
import { createLogger } from '../utils/logger';
import { isWebOS } from '../utils/platform';
import { $ } from '../utils/dom';
import { t } from '../i18n';
import { showToast } from './toast';
import type { VttCue } from '../utils/webvtt';
import { cleanSearchTitle, workTitle } from '../services/subtitle-search/title-cleanup';
import { SUBTITLE_TITLE_FEATURE, suggestSearchTitle, type AiSearchTitle } from '../services/subtitle-search/ai-title';
import { LlmError } from '../services/llm/client';
import { LlmService } from '../services/llm/llm-service';
import {
  needsTranslation,
  SUBTITLE_TRANSLATION_FEATURE,
  SubtitleTranslation,
  targetLabel,
  translationTarget,
} from '../services/subtitle-translation';
import { subtitleSearchService } from '../services/subtitle-search/subtitle-search-service';
import { SubtitleSearchOverlay } from './subtitle-search-overlay';
import { SubtitleOffsetOverlay } from './subtitle-offset-overlay';
import type {
  OnlineSubtitleResult,
  SubtitleQuery,
} from '../services/subtitle-search/types';
import type { PipelineManifest, PlayerPipeline } from './player-pipeline';

const log = createLogger('Player');

// Picker sentinel for the in-band CEA-608/708 toggle. -1 is the synthetic "Off"
// row; -2 is the single closed-caption entry, drawn by the native compositor via
// setSubtitleEnable (channel selection is impossible — selectTrack decode-freezes).
const CC_SUBTITLE_INDEX = -2;


// Base for the synthetic picker indices of ASS/SSA sidecars, which can't surface
// as native <track>s (assjs draws them). Kept high so it never collides with a
// real textTracks index or the -1 Off / -2 CC sentinels; the i-th ASS sidecar is
// ASS_SUBTITLE_BASE + i.
export const ASS_SUBTITLE_BASE = 1000;
export const VOD_SUBTITLE_BASE = 2000;

function sidecarName(sidecar: SidecarSubtitle): string {
  return sidecar.name || sidecar.lang || t('player.subtitles');
}

interface PlayerTracksOptions {
  getVideoElement: () => HTMLVideoElement | null;
  getChannel: () => Channel | null;
  getVod: () => VodPlayback | null;
  playbackLabel: () => string;
  // The pick changed without a user action, e.g. a reset to Off.
  onChanged?: () => void;
}

export class PlayerTracks {
  private manifestAudio: ManifestAudio[] = []; // real track names parsed from the HLS master (webOS)
  private manifestSubtitles: ManifestSubtitle[] = []; // subtitle names parsed from the stream manifest (webOS)
  private manifestClosedCaptions: ManifestClosedCaption[] = []; // CEA-608/708 declared in the HLS master (webOS)
  private ccEnabled = false; // live state of the native caption compositor (setSubtitleEnable)
  private ccPending: boolean | null = null;
  private ccRequestSeq = 0;
  private ccMediaId = ''; // the pipeline ccEnabled/ccPending describe
  private ccRefusedMediaId = ''; // Luna pipeline that refused an enable; only a user pick retries it
  private selfRenderIndex = -1; // manifest subtitle rendition currently self-rendered (-1 = off)
  private masterUrl = ''; // HLS master URL of the active stream, for re-pointing self-render
  private masterText: string | undefined; // the master as the bundled service read it, if it did
  // One subtitles.luna.unavailable event per load, plus one when a permanent reason follows.
  private lunaSubsReported: 'none' | 'transient' | 'permanent' = 'none';
  private manifestSettled = false; // this load's master playlist was parsed or failed
  private lunaAudioReported = false; // one audio.luna.tracks decision per load
  private lunaAudioPicked = false; // the user switched Luna audio this load
  private lunaAudioSeq = 0;
  private unavailableSubs = new Set<number>(); // renditions Luna can never self-render this load
  private subtitlePick: 'saved' | 'forced' | 'user' = 'user';
  private subs = new HlsSubtitles(); // self-rendered subtitles on the webOS native path
  private dashSubs = new DashSubtitles(); // self-rendered DASH WebVTT on the native path
  private vodSubs = new VodSubtitles(); // sidecar SRT/WebVTT tracks for VOD (Xtream)
  private assSubs = new AssSubtitles(); // sidecar ASS/SSA subtitles for VOD, drawn by assjs
  private vodTextSidecars: SidecarSubtitle[] = []; // SRT/WebVTT sidecars of the current VOD item
  private vodAssSidecars: SidecarSubtitle[] = []; // the ASS/SSA sidecars of the current VOD item
  private activeAssIndex = -1; // index into vodAssSidecars currently shown (-1 = none)
  private translations = new Map<number, SubtitleTranslation>(); // by translated vodSubs entry
  private translationGen = 0;
  private translationRestoreLoggedFor = ''; // one subtitle.translate.restore per opening, across reloads
  private subsOverlay: SubtitleSearchOverlay | null = null; // online subtitle search overlay
  private searchSeq = 0; // the online search under way; a newer one or a close supersedes it
  private searchAbort: AbortController | null = null;
  private subtitleOffsetS = 0; // per-stream subtitle timing offset (seconds; + = later)
  private offsetOverlay: SubtitleOffsetOverlay | null = null;

  constructor(
    private pipeline: PlayerPipeline,
    private options: PlayerTracksOptions,
  ) {}

  // `reload` reloads the same item (e.g. a quality change) rather than opening it.
  resetForLoad(reload = false): void {
    if (!reload) this.translationRestoreLoggedFor = '';
    this.manifestAudio = [];
    this.manifestSubtitles = [];
    this.manifestClosedCaptions = [];
    this.ccEnabled = false; // fresh pipeline — captions start off (608 doesn't auto-draw)
    this.ccPending = null;
    this.ccRequestSeq++;
    this.ccMediaId = '';
    this.ccRefusedMediaId = '';
    this.selfRenderIndex = -1;
    this.masterUrl = '';
    this.masterText = undefined;
    this.lunaSubsReported = 'none';
    this.manifestSettled = false;
    this.lunaAudioReported = false;
    this.lunaAudioPicked = false;
    this.lunaAudioSeq++;
    this.unavailableSubs.clear();
    this.subs.stop();
    this.dashSubs.stop();
    this.clearVodSubtitles();
  }

  applyManifest(manifest: PipelineManifest): void {
    this.manifestAudio = manifest.audio;
    this.manifestSubtitles = manifest.subtitles;
    this.manifestClosedCaptions = manifest.closedCaptions;
    this.masterUrl = manifest.masterUrl;
    this.masterText = manifest.masterText;
    this.manifestSettled = true;
    if (this.pipeline.isLunaActive()) this.applyLunaAudioSelection();
    else if (manifest.audio.length) this.applyNativeAudioSelection();
    // Off unless FORCED or a saved pick (spec-correct — see applySelfRenderSelection).
    if (manifest.subtitles.length) this.applySelfRenderSelection();
    // Re-apply a saved CC choice now the manifest confirms captions exist.
    if (manifest.closedCaptions.length) this.applyNativeSubtitleSelection();
  }

  attachVod(vod: VodPlayback): void {
    const video = this.options.getVideoElement();
    if (!video) return;
    // Split sidecars: SRT/WebVTT use a reusable application TextTrack; ASS/SSA
    // are drawn by assjs. Both attach after loadStream resets the video.
    this.activeAssIndex = -1;
    this.vodTextSidecars = vod.subtitles.filter((s) => !isAssSidecar(s.url));
    this.vodAssSidecars = vod.subtitles.filter((s) => isAssSidecar(s.url));
    this.vodSubs.attach(video, this.vodTextSidecars);
    this.assSubs.attach(video, video.parentElement ?? document.body, this.vodAssSidecars);
    void this.restoreOnlineSubtitle(vod);
  }

  suspend(): void {
    this.subs.stop();
    this.dashSubs.stop();
  }

  stop(): void {
    this.subs.stop();
    this.dashSubs.stop();
    this.clearVodSubtitles();
  }

  private clearVodSubtitles(): void {
    this.translations.forEach(job => job.stop());
    this.translations.clear();
    this.translationGen++;
    this.vodSubs.clear();
    this.assSubs.destroy();
    this.vodTextSidecars = [];
    this.vodAssSidecars = [];
    this.activeAssIndex = -1;
  }

  handleAction(action: Action): boolean {
    if (!this.subsOverlay?.visible) return false;
    this.subsOverlay.handleAction(action);
    return true;
  }

  isSubtitleSearchOpen(): boolean {
    return !!this.subsOverlay?.visible;
  }

  // Whether one of the app's own subtitle renderers created this track.
  ownsTextTrack(track: TextTrack): boolean {
    return this.subs.owns(track) || this.dashSubs.owns(track) || this.vodSubs.owns(track);
  }

  // In-container text tracks, without the app's own renderer tracks.
  nativeTextTrackCount(list: TextTrackList | undefined): number {
    let count = 0;
    for (let i = 0; list && i < list.length; i++) if (!this.ownsTextTrack(list[i])) count++;
    return count;
  }

  /** Dismiss the online subtitle-search overlay if it is open. Called on every
   *  view transition (App.showView) so it never lingers over another view or
   *  reappears when its player view is shown again. */
  closeSubtitleSearch(): void {
    this.cancelSearch();
    this.subsOverlay?.close();
  }

  private ensureOffsetOverlay(): SubtitleOffsetOverlay | null {
    if (this.offsetOverlay) return this.offsetOverlay;
    const container = $('#subtitle-offset');
    if (!container) return null;
    this.offsetOverlay = new SubtitleOffsetOverlay(container, (s) => this.setSubtitleOffset(s));
    return this.offsetOverlay;
  }

  /** Open the subtitle-sync adjuster, seeded with the current offset. */
  openSubtitleOffset(): void {
    const overlay = this.ensureOffsetOverlay();
    if (overlay) overlay.open(this.subtitleOffsetS);
  }

  /** Dismiss the subtitle-sync adjuster (called on every view transition). */
  closeSubtitleOffset(): void {
    this.offsetOverlay?.close();
  }

  // Whether an offset-capable subtitle is currently active (a subtitle is on and it's a
  // path whose cues we can shift — not the native-compositor CC).
  private subtitleOffsetAvailable(): boolean {
    if (this.pipeline.isMseActive()) return this.pipeline.mseSubtitleOptions().some(o => o.active);
    if (this.ccEnabled) return false;
    if (this.options.getVod()) {
      if (this.vodSubs.activeIndex >= 0) return true;
      if (this.activeAssIndex >= 0) return true;
      const list = this.options.getVideoElement()?.textTracks;
      if (list) for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if ((track.kind === 'subtitles' || track.kind === 'captions')
            && track.mode === 'showing') return true;
      }
      return false;
    }
    return this.selfRenderIndex >= 0;
  }

  /** State for the menu's "Subtitle Sync" row. */
  subtitleOffsetState(): { available: boolean; label: string } {
    return {
      available: this.subtitleOffsetAvailable(),
      label: formatSubtitleOffset(this.subtitleOffsetS),
    };
  }

  /** Set the subtitle offset (clamped), persist it per stream, and apply it live. */
  setSubtitleOffset(seconds: number): void {
    this.subtitleOffsetS = clampSubtitleOffset(seconds);
    const key = this.preferenceKey();
    if (key) StorageService.setSubtitleOffset(key, this.subtitleOffsetS);
    this.applySubtitleOffset();
    log.debug('subtitle offset', formatSubtitleOffset(this.subtitleOffsetS),
      key ? '(persisted)' : '(not persisted)');
  }

  // Push the current offset to every engine. Owned tracks are shifted by their engine;
  // foreign native tracks (in-container VOD, hls.js preview) go through the idempotent
  // shifter. Safe to call anytime — inactive engines no-op.
  private applySubtitleOffset(): void {
    const seconds = this.subtitleOffsetS;
    this.subs.setOffset(seconds);
    this.dashSubs.setOffset(seconds);
    this.vodSubs.setOffset(seconds);
    this.assSubs.setOffset(seconds);
    const list = this.options.getVideoElement()?.textTracks;
    if (list) for (let i = 0; i < list.length; i++) {
      const track = list[i];
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      if (this.ownsTextTrack(track)) continue; // an engine already shifted these
      shiftForeignTrack(track, seconds);
    }
  }

  // Load the saved offset for the current stream and apply it (called on tune-in).
  private loadSubtitleOffset(): void {
    this.subtitleOffsetS = StorageService.getSubtitleOffset(this.preferenceKey());
    this.applySubtitleOffset();
  }

  private ensureSubsOverlay(): SubtitleSearchOverlay | null {
    if (this.subsOverlay) return this.subsOverlay;
    const container = $('#subtitle-search');
    if (!container) return null;
    this.subsOverlay = new SubtitleSearchOverlay(
      container,
      (result) => void this.applyOnlineSubtitle(result),
      () => this.cancelSearch(),
      (query) => void this.runSubtitleSearch(query),
    );
    return this.subsOverlay;
  }

  // The name of the work itself: an episode searches by its series.
  private searchName(vod: VodPlayback): string {
    return vod.kind === 'episode' ? (vod.watchlistOwner?.name || workTitle(vod.title)) : vod.title;
  }

  private buildSubtitleQuery(vod: VodPlayback): SubtitleQuery {
    const meta = vod.searchMeta ?? {};
    const clean = cleanSearchTitle(this.searchName(vod));
    return {
      type: vod.kind === 'episode' ? 'episode' : 'movie',
      title: clean.title,
      imdbId: meta.imdbId,
      tmdbId: meta.tmdbId,
      year: meta.year || clean.year || undefined,
      season: meta.season,
      episode: meta.episode,
    };
  }

  // With nothing found for the catalog name, asks the AI model for a clean
  // title, then its original or English title, and searches by those.
  // Null once a newer search or a closed overlay superseded this one.
  private async searchByAiTitle(
    vod: VodPlayback,
    base: SubtitleQuery,
    current: () => boolean,
    signal: AbortSignal,
  ): Promise<OnlineSubtitleResult[] | null> {
    let suggestion: AiSearchTitle | null;
    try {
      suggestion = await suggestSearchTitle(this.searchName(vod), base.type, signal);
    } catch (error) {
      if (!current()) return null;
      const reason = error instanceof LlmError ? error.reason : 'network';
      log.warn('AI search title failed', 'event=subtitle.search.ai_title', 'outcome=failed', `reason=${reason}`, 'results=0');
      return [];
    }
    if (!current()) return null;
    const overlay = this.ensureSubsOverlay();
    // Ids found nothing, so the retries go by title alone.
    const query: SubtitleQuery = {
      ...base,
      imdbId: undefined,
      tmdbId: undefined,
      year: base.year || suggestion?.year || undefined,
      season: base.season ?? (suggestion?.season || undefined),
      episode: base.episode ?? (suggestion?.episode || undefined),
    };
    const titles = suggestion ? [suggestion.title, suggestion.originalTitle] : [];
    // With ids, SubDL and OpenSubtitles never searched by the title itself.
    const tried = base.imdbId || base.tmdbId ? [] : [base.title.toLowerCase()];
    let outcome = suggestion ? 'unchanged' : 'empty';
    let results: OnlineSubtitleResult[] = [];
    for (let i = 0; i < titles.length && !results.length; i++) {
      const title = titles[i];
      if (!title || tried.indexOf(title.toLowerCase()) >= 0) continue;
      tried.push(title.toLowerCase());
      overlay?.setQuery(title);
      results = await subtitleSearchService.search({ ...query, title });
      if (!current()) return null;
      outcome = results.length ? (i === 0 ? 'found_title' : 'found_original') : 'none';
    }
    log.info('AI search title', 'event=subtitle.search.ai_title', `outcome=${outcome}`, `results=${results.length}`);
    return results;
  }

  subtitleSearchAvailable(): boolean {
    return !!this.options.getVod() && subtitleSearchService.isAvailable();
  }

  // What the translate row acts on: the shown SRT/WebVTT sidecar, or a shown
  // translation that stopped before it finished.
  private translateOffer(): { entry: number; target: string } | null {
    if (!this.options.getVod() || this.pipeline.isMseActive()) return null;
    if (!LlmService.isReady(SUBTITLE_TRANSLATION_FEATURE)) return null;
    const active = this.vodSubs.activeIndex;
    const sidecar = this.vodTextSidecars[active];
    if (!sidecar) return null;
    if (this.vodSubs.sourceOf(active) >= 0) {
      const job = this.translations.get(active);
      return job && !job.complete && !job.running ? { entry: active, target: sidecar.lang } : null;
    }
    const target = translationTarget();
    return needsTranslation(sidecar.lang, target) ? { entry: active, target } : null;
  }

  /** Label of the menu's translate row, or null to hide it. */
  subtitleTranslationLabel(): string | null {
    const offer = this.translateOffer();
    return offer ? t('player.translateTo', { language: targetLabel(offer.target) }) : null;
  }

  /** Translate the shown subtitle, reusing or resuming a translation into the same language. */
  translateSubtitles(): void {
    const offer = this.translateOffer();
    if (!offer) return;
    const entry = this.vodSubs.sourceOf(offer.entry) >= 0
      ? offer.entry
      : this.translationEntry(offer.entry, offer.target);
    this.selectSubtitleTrack(VOD_SUBTITLE_BASE + entry);
    const job = this.translations.get(entry);
    if (!job?.complete) showToast(t('subtitle.translating', { percent: job?.percent ?? 0 }));
  }

  private translationEntry(source: number, target: string): number {
    const existing = this.vodSubs.translationOf(source, target);
    if (existing >= 0) return existing;
    const sidecar = this.vodTextSidecars[source];
    const name = t('player.aiTranslation', { name: sidecarName(sidecar) });
    this.vodTextSidecars.push({ id: `${sidecar.id}|${target}`, name, lang: target, url: '' });
    return this.vodSubs.addTranslation(source, name, target);
  }

  // Translates the batches of a shown translation entry that are still missing.
  private async runTranslation(entry: number): Promise<void> {
    const source = this.vodSubs.sourceOf(entry);
    if (source < 0 || !LlmService.isReady(SUBTITLE_TRANSLATION_FEATURE)) return;
    const gen = this.translationGen;
    let job = this.translations.get(entry);
    if (!job) {
      let cues: VttCue[];
      try {
        cues = await this.vodSubs.cuesOf(source);
        await this.vodSubs.cuesOf(entry);
      } catch {
        return; // VodSubtitles.show logs the load failure
      }
      if (gen !== this.translationGen || this.vodSubs.activeIndex !== entry) return;
      job = this.translations.get(entry) ?? new SubtitleTranslation(
        cues,
        this.vodTextSidecars[entry].lang,
        // Cue times are media time less the subtitle offset.
        () => (this.options.getVideoElement()?.currentTime || 0) - this.subtitleOffsetS,
        (indices, texts) => {
          // A stopped job's last batches can land after the item changed.
          if (gen === this.translationGen) this.vodSubs.setCueTexts(entry, indices, texts);
        },
        () => { if (gen === this.translationGen) this.options.onChanged?.(); },
      );
      this.translations.set(entry, job);
    }
    if (job.complete || job.running) return;
    const report = await job.start();
    if (gen !== this.translationGen) return;
    this.options.onChanged?.();
    const reason = report.error?.reason;
    if (!reason || reason === 'cancelled') return;
    showToast(reason === 'cap' ? t('subtitle.translateLimit') : t('subtitle.translateFailed'));
  }

  private translationSource(index: number): string | undefined {
    const source = index >= VOD_SUBTITLE_BASE ? this.vodSubs.sourceOf(index - VOD_SUBTITLE_BASE) : -1;
    return source >= 0 ? sidecarName(this.vodTextSidecars[source]) : undefined;
  }

  private translationDetail(index: number): string | undefined {
    if (index < VOD_SUBTITLE_BASE) return undefined;
    const job = this.translations.get(index - VOD_SUBTITLE_BASE);
    return job?.running ? t('subtitle.translationProgress', { percent: job.percent }) : undefined;
  }

  // A saved translation comes back over its source while AI features are on.
  private restoreTranslation(options: SubtitleOption[], index: number, pref: SubtitlePref | null): number {
    const source = index - VOD_SUBTITLE_BASE;
    if (!pref?.translateTo || source < 0 || !this.vodTextSidecars[source]) return index;
    if (this.vodSubs.sourceOf(source) >= 0 || !isSubtitlePrefMatch(options.find(o => o.index === index), pref)) return index;
    const ready = LlmService.isReady(SUBTITLE_TRANSLATION_FEATURE);
    const item = this.preferenceKey();
    if (this.translationRestoreLoggedFor !== item) {
      this.translationRestoreLoggedFor = item;
      log.info('Saved subtitle translation', 'event=subtitle.translate.restore',
        `outcome=${ready ? 'restored' : 'ai_off'}`, `target=${pref.translateTo}`);
    }
    if (!ready) return index;
    return VOD_SUBTITLE_BASE + this.translationEntry(source, pref.translateTo);
  }

  async openSubtitleSearch(): Promise<void> {
    const overlay = this.ensureSubsOverlay();
    const vod = this.options.getVod();
    if (!overlay || !vod) return;
    overlay.setQuery(this.buildSubtitleQuery(vod).title); // prefill the box with the detected title
    await this.runSubtitleSearch(null);
  }

  /** Run an online subtitle search and feed the overlay. `query === null` uses the
   *  structured keys (imdb/tmdb/title); a string is a manual free-form title that
   *  overrides them via `manualQuery`. Errors/empties stay on screen (no
   *  auto-close) so the persistent search box can be edited and retried. */
  // A new search or a closed overlay supersedes the search under way.
  private cancelSearch(): void {
    this.searchSeq++;
    this.searchAbort?.abort();
    this.searchAbort = null;
  }

  private async runSubtitleSearch(query: string | null): Promise<void> {
    const overlay = this.ensureSubsOverlay();
    const vod = this.options.getVod();
    if (!overlay || !vod) return;
    this.cancelSearch();
    const seq = this.searchSeq;
    const abort = new AbortController();
    this.searchAbort = abort;
    const current = (): boolean => seq === this.searchSeq && this.options.getVod() === vod;
    if (query != null) overlay.setQuery(query);
    overlay.showStatus(t('subtitle.searching'));
    try {
      const base = this.buildSubtitleQuery(vod);
      const search = query != null ? { ...base, manualQuery: query } : base;
      let results: OnlineSubtitleResult[] | null = await subtitleSearchService.search(search);
      if (!current()) return;
      if (!results.length && query == null && LlmService.isReady(SUBTITLE_TITLE_FEATURE)) {
        results = await this.searchByAiTitle(vod, base, current, abort.signal);
        if (!results || !current()) return;
      }
      if (!results.length) {
        overlay.showStatus(t('subtitle.noneFound'));
        return;
      }
      overlay.open(results, subtitleSearchService.preferredLanguage());
    } catch (e) {
      log.warn('subtitle search failed:', e);
      overlay.showStatus(t('subtitle.searchFailed'));
    }
  }

  private async applyOnlineSubtitle(result: OnlineSubtitleResult): Promise<void> {
    const overlay = this.subsOverlay;
    const vod = this.options.getVod();
    if (!vod) return;
    overlay?.showStatus(t('subtitle.downloading'));
    try {
      const download = await subtitleSearchService.download(result);
      if (this.options.getVod() !== vod) return; // the user switched items mid-download — don't apply/persist to the wrong VOD
      const cacheKey = `${result.providerId}:${result.id}`;
      void setCachedSubtitle(cacheKey, download.text);
      StorageService.setPickedOnlineSub(vod.accountId, vod.kind, vod.itemId, {
        providerId: result.providerId,
        id: result.id,
        name: result.releaseName || result.language,
        lang: result.language,
        format: download.format,
      });
      const subtitle = {
        id: cacheKey,
        name: result.releaseName || result.language,
        lang: result.language,
        url: '',
        text: download.text,
      };
      if (download.format === 'ass' || download.format === 'ssa') {
        this.vodAssSidecars.push(subtitle);
        this.applySubtitleChoice(ASS_SUBTITLE_BASE + this.vodAssSidecars.length - 1);
      } else {
        const video = this.options.getVideoElement();
        if (video) {
          this.vodTextSidecars.push(subtitle);
          const sidecarIndex = this.vodSubs.addOnline(video, subtitle);
          this.applySubtitleChoice(VOD_SUBTITLE_BASE + sidecarIndex);
        }
      }
      this.rememberSubtitle({
        off: false,
        name: result.releaseName || result.language,
        lang: result.language,
      });
      // A search typed while this downloaded must not reopen the overlay.
      this.cancelSearch();
      overlay?.close();
      showToast(t('player.subtitlesTrack', {
        name: result.releaseName || result.language,
      }));
    } catch (e) {
      log.warn('online subtitle download failed:', e);
      overlay?.showStatus(t('subtitle.downloadFailed'), true);
    }
  }

  private async restoreOnlineSubtitle(vod: VodPlayback): Promise<void> {
    const pick = StorageService.getPickedOnlineSub(vod.accountId, vod.kind, vod.itemId);
    if (!pick || this.options.getVod() !== vod) return;
    const cacheKey = `${pick.providerId}:${pick.id}`;
    let text = await getCachedSubtitle(cacheKey);
    if (this.options.getVod() !== vod) return;
    if (text == null) {
      try {
        const download = await subtitleSearchService.download({
          providerId: pick.providerId,
          id: pick.id,
          language: pick.lang,
          releaseName: pick.name,
          fileName: pick.name,
          format: pick.format,
          hearingImpaired: false,
          downloads: 0,
        });
        if (this.options.getVod() !== vod) return;
        text = download.text;
        void setCachedSubtitle(cacheKey, text);
      } catch (e) {
        log.warn('restore online subtitle failed:', e);
        return;
      }
    }
    const subtitle = {
      id: cacheKey,
      name: pick.name,
      lang: pick.lang,
      url: '',
      text,
    };
    if (pick.format === 'ass' || pick.format === 'ssa') {
      this.vodAssSidecars.push(subtitle);
    } else {
      const video = this.options.getVideoElement();
      if (video) {
        this.vodTextSidecars.push(subtitle);
        this.vodSubs.addOnline(video, subtitle);
      }
    }
    this.applyNativeSubtitleSelection();
  }

  /**
   * Normalized audio renditions of the active stream — from hls.js in the desktop
   * preview, or the native `HTMLMediaElement.audioTracks` on webOS (whose alternate
   * tracks come back empty-named, so real labels are overlaid from the parsed
   * manifest — see the manifest handling in PlayerPipeline).
   */
  private audioOptions(): AudioOption[] {
    if (this.pipeline.isMseActive()) return this.pipeline.mseAudioOptions();
    if (this.pipeline.isLunaActive()) return this.lunaAudioOptions().options;
    const list = this.options.getVideoElement()?.audioTracks;
    if (!list) return [];
    return mergeManifestNames(nativeAudioOptions(list), this.manifestAudio);
  }

  // Picker-facing options. When webOS collapses same-language renditions (the
  // native list is shorter than the manifest), surface every manifest rendition
  // but mark the hidden ones unavailable — the TV can't switch to them, so the
  // picker grays them rather than pretending. `available` assumes the manifest
  // lists the native-exposed renditions first (default / first-per-language).
  private displayAudioOptions(): Array<AudioOption & { available: boolean }> {
    const options = this.audioOptions();
    if (this.manifestAudio.length > options.length && !this.pipeline.isLunaActive()) {
      return this.manifestAudio.map((manifest, index) => ({
        index,
        name: manifest.name,
        lang: manifest.lang,
        isDefault: manifest.isDefault,
        // Mark the playing native track, not the manifest DEFAULT flag — a
        // non-conformant playlist can carry >1 DEFAULT=YES (collapsed alternates),
        // which would otherwise check several rows at once.
        active: index < options.length ? options[index].active : false,
        available: index < options.length,
      }));
    }
    return options.map(option => ({ ...option, available: true }));
  }

  /** Audio tracks for the picker. Labels prefer name, then language, then a position. */
  getAudioTracks(): AudioTrackOption[] {
    const options = this.displayAudioOptions();
    return options.map(option => ({
      index: option.index,
      label: this.audioOptionLabel(option, options),
      active: option.active,
      available: option.available,
    }));
  }

  /** Switch the active audio track and remember it for this channel. No-op for a
   *  grayed (unavailable) track — webOS can't switch to a collapsed rendition. */
  selectAudioTrack(index: number): void {
    const option = this.displayAudioOptions().find(item => item.index === index);
    if (!option || !option.available) return;
    if (this.pipeline.isLunaActive()) {
      this.switchLunaAudio(option);
      return;
    }
    if (this.pipeline.isMseActive()) {
      if (!this.pipeline.setMseAudioTrack(index)) return;
    } else {
      const list = this.options.getVideoElement()?.audioTracks;
      if (!list || index < 0 || index >= list.length) return;
      for (let i = 0; i < list.length; i++) list[i].enabled = (i === index);
    }
    this.rememberAudio(option);
    showToast(t('player.switchingAudio', { name: audioLabel(option) }));
  }

  // Luna names only what the manifest pairs one-to-one; otherwise a language
  // (as an endonym) or, when two unnamed tracks share it, a position.
  private audioOptionLabel(option: AudioOption, options: readonly AudioOption[]): string {
    if (!this.pipeline.isLunaActive() || option.name || !option.lang) return audioLabel(option);
    const key = languageKey(option.lang);
    const shared = options.some(other => other.index !== option.index && !other.name
      && (key ? languageKey(other.lang) === key : other.lang === option.lang));
    return shared ? audioLabel({ ...option, lang: '' }) : languageName(option.lang);
  }

  private lunaAudioOptions(): { options: AudioOption[]; naming: string } {
    const tracks = this.pipeline.lunaAudioTracks();
    const { renditions, naming } = mapLunaAudio(tracks, this.manifestAudio);
    const options = tracks.map(track => {
      const rendition = renditions?.[track.index];
      return {
        index: track.index,
        name: rendition?.name ?? '',
        lang: rendition?.lang || track.language,
        // UMS's pick stands in for the manifest DEFAULT, as on the native path.
        isDefault: track.selected,
        active: track.selected,
      };
    });
    return { options, naming };
  }

  // The saved pick is matched once UMS lists the audio and the manifest has
  // settled (its names may be what the pick saved), once per load.
  applyLunaAudioSelection(): void {
    if (!this.pipeline.isLunaActive() || this.lunaAudioReported || !this.manifestSettled) return;
    const { options, naming } = this.lunaAudioOptions();
    if (options.length < 2) return;
    this.lunaAudioReported = true;
    const pref = StorageService.getAudioPref(this.preferenceKey());
    // UMS may list ISO 639-2 codes where the pick saved a 2-letter one.
    const keyed = options.map(option => ({ ...option, lang: languageKey(option.lang) }));
    // Names paired by position are display-only: a wrong guess must not switch.
    const paired = naming !== 'order';
    const keyedPref = pref && paired ? { name: pref.name, lang: languageKey(pref.lang) } : null;
    const index = chooseAudioIndex(keyed, keyedPref);
    const matched = isPrefMatch(keyed.find(option => option.index === index), keyedPref);
    const pick = !pref ? 'none' : !paired ? 'unpaired' : matched ? 'saved' : 'missed';
    this.logAudioChoice('luna', options, pref, index);
    log.info('Luna audio tracks', 'event=audio.luna.tracks', this.options.playbackLabel(),
      `count=${String(options.length)}`, `manifest=${String(this.manifestAudio.length)}`,
      `naming=${naming}`, `pick=${pick}`, `index=${String(index)}`);
    const option = options.find(item => item.index === index);
    if (!matched || !option || option.active || this.lunaAudioPicked) return;
    this.switchLunaAudio(option, false);
  }

  // The menu reads UMS's selection, so a refused switch leaves the old track checked.
  private switchLunaAudio(option: AudioOption, user = true): void {
    const seq = ++this.lunaAudioSeq;
    if (user) {
      this.lunaAudioPicked = true;
      showToast(t('player.switchingAudio', {
        name: this.audioOptionLabel(option, this.lunaAudioOptions().options),
      }));
    }
    void this.pipeline.selectLunaAudio(option.index).then(ok => {
      if (ok && user && seq === this.lunaAudioSeq) this.rememberAudio(option);
    });
  }

  private rememberAudio(option: AudioOption): void {
    const key = this.preferenceKey();
    if (key) StorageService.setAudioPref(key, { name: option.name, lang: option.lang });
    log.info('audio: user picked', option.index, audioLabel(option),
      key ? '— saved to storage' : '(no channel key, not saved)');
  }

  // Report the storage read and the resolved track on every tune-in — even when
  // no switch is needed (the chosen track is already active) — so the default
  // pick and the pref lookup are both visible in the log.
  private logAudioChoice(
    path: string,
    options: AudioOption[],
    pref: AudioPref | null,
    index: number,
  ): void {
    const option = options.find(item => item.index === index);
    const label = option
      ? audioLabel(option)
      : t('player.audioFallback', { number: index + 1 });
    log.info(`audio: ${path} | tracks:`, options.length,
      '| storage pref:', pref ? (pref.name || pref.lang || '(unnamed)') : 'none',
      '| using:', index, label,
      isPrefMatch(option, pref) ? '(saved pref)' : '(stream default)');
  }

  // Re-apply the remembered choice on tune-in; with no saved pick the stream
  // default stands. hls.js drives its own rendition, so the two paths are split.
  applyHlsAudioSelection(): void {
    if (!this.pipeline.isMseActive()) return;
    const options = this.audioOptions();
    if (options.length < 2) return;
    const pref = StorageService.getAudioPref(this.preferenceKey());
    const index = chooseAudioIndex(options, pref);
    this.logAudioChoice('hls', options, pref, index);
    if (index >= 0) this.pipeline.setMseAudioTrack(index);
  }

  applyNativeAudioSelection(): void {
    if (this.pipeline.isMseActive()) return; // hls.js owns the rendition; videoEl exposes only the active one
    if (this.pipeline.isLunaActive()) return; // the element holds only the placeholder clip
    const list = this.options.getVideoElement()?.audioTracks;
    if (!list || list.length < 2) return;
    const options = this.audioOptions();
    const pref = StorageService.getAudioPref(this.preferenceKey());
    const index = chooseAudioIndex(options, pref);
    this.logAudioChoice('native', options, pref, index);
    if (index < 0 || list[index].enabled) return; // already active — don't disturb playback
    for (let i = 0; i < list.length; i++) list[i].enabled = (i === index);
  }

  /**
   * Normalized subtitle renditions of the active stream — from hls.js in the
   * desktop preview, or the native `HTMLMediaElement.textTracks` on webOS (whose
   * tracks can come back empty-named, so real labels are overlaid from the parsed
   * manifest — see the manifest handling in PlayerPipeline).
   */
  private subtitleOptions(): SubtitleOption[] {
    if (this.pipeline.isMseActive()) return this.pipeline.mseSubtitleOptions();
    // VOD: keep in-container tracks native. Sidecars are synthetic picker
    // options because their reusable addTextTrack renderer must stay hidden.
    if (this.options.getVod()) {
      const list = this.options.getVideoElement()?.textTracks;
      const native = list
        ? nativeSubtitleOptions(list)
          .filter(option => !this.ownsTextTrack(list[option.index]))
        : [];
      const sidecars = this.vodTextSidecars.map((sidecar, index) => ({
        index: VOD_SUBTITLE_BASE + index,
        name: sidecarName(sidecar),
        lang: sidecar.lang,
        isDefault: false,
        isForced: false,
        active: this.vodSubs.activeIndex === index,
      }));
      const ass = this.vodAssSidecars.map((sidecar, index) => ({
        index: ASS_SUBTITLE_BASE + index,
        name: sidecar.name,
        lang: sidecar.lang,
        isDefault: false,
        isForced: false,
        active: this.activeAssIndex === index,
      }));
      return native.concat(sidecars, ass);
    }
    // webOS native live/catch-up: in-manifest WebVTT is self-rendered (not surfaced
    // as switchable textTracks), so the choices are the parsed master renditions and
    // the active one is what we self-render.
    const options = manifestSubtitleOptions(this.manifestSubtitles, this.selfRenderIndex);
    const native = options.filter(option =>
      this.manifestSubtitles[option.index]?.dash?.kind === 'native');
    // The firmware compositor draws only the first native AdaptationSet,
    // whatever its role, so that is the one the menu can truthfully name.
    return options.filter(option =>
      this.manifestSubtitles[option.index]?.dash?.kind !== 'native'
      || option.index === native[0]?.index);
  }

  // Each displayed rendition has a distinct control path. Native DASH exposes
  // one compositor toggle because setSubtitleEnable cannot select a rendition.
  private displaySubtitleOptions(): Array<SubtitleOption & { available: boolean }> {
    return this.subtitleOptions().map(option => ({
      ...option,
      available: !this.unavailableSubs.has(option.index),
    }));
  }

  /** Subtitle tracks for the picker (the menu prepends its own "Off" row). On the
   *  webOS native path a single "Closed Captions" toggle is appended when the
   *  manifest declares in-band CEA-608/708 — drawn by the native compositor. */
  getSubtitleTracks(): SubtitleTrackOption[] {
    const tracks: SubtitleTrackOption[] = this.displaySubtitleOptions().map(option => ({
      index: option.index,
      label: subtitleLabel(option),
      active: option.active,
      available: option.available,
      detail: this.translationDetail(option.index),
      aiSource: this.translationSource(option.index),
    }));
    if (this.ccAvailable()) {
      tracks.push({
        index: CC_SUBTITLE_INDEX,
        label: closedCaptionLabel(this.manifestClosedCaptions),
        // A pick re-renders the menu before setSubtitleEnable answers.
        active: (this.ccPending ?? this.ccEnabled) && this.selfRenderIndex < 0,
        available: true,
      });
    }
    return tracks;
  }

  // In-band CC is offered only on webOS (setSubtitleEnable is a Luna verb),
  // native or Luna playback, and only when the master advertises CLOSED-CAPTIONS.
  private ccAvailable(): boolean {
    return isWebOS() && this.manifestClosedCaptions.length > 0;
  }

  /** Switch the active subtitle (index -1 = off, -2 = in-band CC) and remember it
   *  for this channel. No-op for a grayed (unavailable) track the platform didn't
   *  expose. CC and the other subtitle paths are mutually exclusive. */
  selectSubtitleTrack(index: number): void {
    if (index === CC_SUBTITLE_INDEX) {
      this.ccRefusedMediaId = '';
      this.subs.stop(); // self-render and the native compositor can't both draw
      this.dashSubs.stop();
      this.selfRenderIndex = -1;
      this.setNativeCC(true);
      this.rememberSubtitle({ off: false, cc: true, name: '', lang: '' });
      showToast(t('player.subtitlesTrack', {
        name: closedCaptionLabel(this.manifestClosedCaptions),
      }));
      return;
    }
    if (index === -1) {
      this.ccRefusedMediaId = '';
      this.setNativeCC(false);
      this.applySubtitleChoice(-1);
      this.rememberSubtitle({ off: true, name: '', lang: '' });
      showToast(t('player.subtitlesOff'));
      return;
    }
    const option = this.displaySubtitleOptions().find(item => item.index === index);
    if (!option || !option.available) return;
    this.ccRefusedMediaId = '';
    this.setNativeCC(false);
    this.subtitlePick = 'user';
    this.applySubtitleChoice(index);
    const entry = index >= VOD_SUBTITLE_BASE ? index - VOD_SUBTITLE_BASE : -1;
    const source = entry >= 0 ? this.vodSubs.sourceOf(entry) : -1;
    if (source >= 0) {
      const sidecar = this.vodTextSidecars[source];
      this.rememberSubtitle({ off: false, name: sidecarName(sidecar), lang: sidecar.lang, translateTo: option.lang });
    } else {
      this.rememberSubtitle({ off: false, name: option.name, lang: option.lang });
    }
    showToast(t('player.subtitlesTrack', { name: subtitleLabel(option) }));
  }

  // Toggle the native caption compositor (CEA-608/708, IMSC/stpp and wvtt) via Luna. Only
  // fires on a real state change of the current pipeline, and needs its mediaId — the
  // native element's once decoding starts, or on Luna playback the Luna pipeline's own
  // (the element's is the placeholder's). selectTrack is deliberately avoided:
  // it decode-freezes the video, so this is enable/disable only.
  private setNativeCC(enable: boolean): void {
    if (!isWebOS()) return;
    const luna = this.pipeline.isLunaActive();
    const mediaId = luna
      ? this.pipeline.lunaMediaId()
      : (this.options.getVideoElement() as (HTMLVideoElement & { mediaId?: string }) | null)?.mediaId;
    if (!mediaId) {
      if (enable) log.warn('CC: no mediaId yet — will retry on track/metadata events');
      return;
    }
    if (mediaId !== this.ccMediaId) {
      // A new pipeline starts with captions off; answers for the old one are stale.
      this.ccMediaId = mediaId;
      this.ccEnabled = false;
      this.ccPending = null;
      this.ccRequestSeq++;
    }
    if (this.ccPending === enable || (this.ccPending === null && enable === this.ccEnabled)) return;
    if (enable && mediaId === this.ccRefusedMediaId) return;
    if (!isLunaAvailable()) return;
    const requestSeq = ++this.ccRequestSeq;
    this.ccPending = enable;
    lunaRequest('luna://com.webos.media', {
      method: 'setSubtitleEnable',
      parameters: { mediaId, enable },
      onSuccess: () => {
        if (requestSeq !== this.ccRequestSeq) return;
        this.ccEnabled = enable;
        this.ccPending = null;
        log.info('CC: setSubtitleEnable', enable, 'ok');
      },
      onFailure: (error) => {
        if (requestSeq !== this.ccRequestSeq) return;
        this.ccPending = null;
        log.warn('CC: setSubtitleEnable failed:', JSON.stringify(error));
        if (luna) {
          log.warn('Luna subtitle compositor refused', 'event=subtitles.luna.compositor.failed',
            this.options.playbackLabel(), `enable=${String(enable)}`,
            `code=${String(typeof error.errorCode === 'number' ? error.errorCode : -1)}`);
          if (enable) {
            // Every buffering cycle replays `playing`; don't re-ask this pipeline.
            this.ccRefusedMediaId = mediaId;
            if (this.manifestSubtitles[this.selfRenderIndex]?.dash?.kind === 'native') {
              this.unavailableSubs.add(this.selfRenderIndex);
              this.selfRenderIndex = -1;
            }
          }
        }
        this.options.onChanged?.();
      },
    });
  }

  // Route a subtitle pick to the active engine (index -1 = off). stpp and wvtt
  // use the native compositor; the webOS native path self-renders the chosen WebVTT
  // rendition. selectTrack is never used — it decode-freezes the video on webOS.
  private applySubtitleChoice(index: number): void {
    this.applySubtitleChoiceRaw(index);
    this.applySubtitleOffset();
  }

  private applySubtitleChoiceRaw(index: number): void {
    if (this.pipeline.isMseActive()) {
      this.pipeline.setMseSubtitleTrack(index);
      return;
    }
    // VOD has three mutually exclusive paths: reusable SRT/WebVTT TextTrack,
    // ASS overlay, or native in-container track.
    if (this.options.getVod()) {
      const shownEntry = index >= VOD_SUBTITLE_BASE ? index - VOD_SUBTITLE_BASE : -1;
      // A translation stops when its subtitle is switched away; picking it again resumes.
      this.translations.forEach((job, entry) => { if (entry !== shownEntry) job.stop(); });
      const list = this.options.getVideoElement()?.textTracks;
      if (index >= VOD_SUBTITLE_BASE) {
        if (list) for (let i = 0; i < list.length; i++) {
          const track = list[i];
          // The renderer's own track lists no cues once disabled, so show() could not clear it.
          if (this.ownsTextTrack(track)) continue;
          if (track.kind === 'subtitles' || track.kind === 'captions') {
            track.mode = 'disabled';
          }
        }
        this.activeAssIndex = -1;
        this.assSubs.hide();
        void this.vodSubs.show(shownEntry);
        void this.runTranslation(shownEntry);
        return;
      }
      if (index >= ASS_SUBTITLE_BASE) {
        this.vodSubs.hide();
        if (list) for (let i = 0; i < list.length; i++) {
          const track = list[i];
          if (track.kind === 'subtitles' || track.kind === 'captions') {
            track.mode = 'disabled';
          }
        }
        const sidecar = this.vodAssSidecars[index - ASS_SUBTITLE_BASE];
        this.activeAssIndex = sidecar ? index - ASS_SUBTITLE_BASE : -1;
        if (sidecar) void this.assSubs.show(index - ASS_SUBTITLE_BASE);
        return;
      }
      this.vodSubs.hide();
      this.activeAssIndex = -1;
      this.assSubs.hide();
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
        track.mode = i === index ? 'showing' : 'disabled';
      }
      return;
    }
    const manifest = index >= 0 ? this.manifestSubtitles[index] : undefined;
    const video = this.options.getVideoElement();
    if (!manifest || !video || !this.masterUrl) {
      this.subs.stop();
      this.dashSubs.stop();
      this.setNativeCC(false);
      this.selfRenderIndex = -1;
      return;
    }
    this.selfRenderIndex = index;
    const want = {
      name: manifest.name,
      lang: manifest.lang,
    };
    if (manifest.dash?.kind === 'native') {
      this.subs.stop();
      this.dashSubs.stop();
      this.setNativeCC(true);
    } else if (manifest.dash?.kind === 'webvtt') {
      this.subs.stop();
      this.setNativeCC(false);
      const clock = this.pipeline.lunaClock();
      if (clock) {
        log.info('Luna subtitles self-rendered', 'event=subtitles.luna.start',
          this.options.playbackLabel(), `index=${String(index)}`,
          `count=${String(this.manifestSubtitles.length)}`, `pick=${this.subtitlePick}`, 'format=dash');
      }
      // Every reason DASH reports is permanent.
      const onUnavailable = clock || this.masterText !== undefined
        ? (reason: string) => this.lunaSubsUnavailable(index, reason, true)
        : undefined;
      void this.dashSubs.start(video, this.masterUrl, want, clock ?? undefined, this.masterText, onUnavailable);
    } else {
      this.dashSubs.stop();
      this.setNativeCC(false);
      const luna = this.lunaSubtitleOptions(index);
      if (luna) {
        log.info('Luna subtitles self-rendered', 'event=subtitles.luna.start',
          this.options.playbackLabel(), `index=${String(index)}`,
          `count=${String(this.manifestSubtitles.length)}`, `pick=${this.subtitlePick}`, 'format=hls');
        luna.masterText = this.masterText;
        void this.subs.start(video, this.masterUrl, want, luna);
      } else {
        void this.subs.start(video, this.masterUrl, want, { masterText: this.masterText });
      }
    }
  }

  // Luna plays behind a placeholder element, so cues follow Luna's clock, and
  // a failed header-less subtitle fetch stays silent. A rendition that can
  // never render moves the checkmark to Off without touching the saved pick.
  private lunaSubtitleOptions(index: number): HlsSubtitlesOptions | null {
    const clock = this.pipeline.lunaClock();
    if (!clock) return null;
    return {
      clock,
      onAnchor: (src, holdBackS) => {
        log.info('Luna subtitles anchored', 'event=subtitles.luna.anchor',
          this.options.playbackLabel(), `src=${src}`, `holdBackS=${String(holdBackS)}`);
      },
      onClockWait: waitedMs => {
        log.warn('Luna subtitles wait for the playback clock', 'event=subtitles.luna.clock.waiting',
          this.options.playbackLabel(), `waitedMs=${String(waitedMs)}`);
      },
      onUnavailable: reason => this.lunaSubsUnavailable(index, reason, isPermanentSubtitleFailure(reason)),
    };
  }

  private lunaSubsUnavailable(index: number, reason: string, permanent: boolean): void {
    const label = this.options.playbackLabel();
    // A service-read MPD also reaches the element after a Luna fallback;
    // only Luna playback logs its failures.
    const luna = this.pipeline.lunaClock() !== null;
    if (luna && (this.lunaSubsReported === 'none' || (permanent && this.lunaSubsReported === 'transient'))) {
      this.lunaSubsReported = permanent ? 'permanent' : 'transient';
      log.info('Subtitles unavailable on Luna playback', 'event=subtitles.luna.unavailable',
        label, 'stage=render', `reason=${reason}`);
    }
    if (!permanent || this.selfRenderIndex !== index) return;
    this.unavailableSubs.add(index);
    this.selfRenderIndex = -1;
    this.subs.stop();
    this.dashSubs.stop();
    if (luna) {
      log.info('Luna subtitle selection reset to Off', 'event=subtitles.luna.reset',
        label, `index=${String(index)}`, `reason=${reason}`);
    }
    this.options.onChanged?.();
  }

  /** Playback changed path mid-load; the next manifest restarts the remembered pick. */
  stopSelfRender(): void {
    this.unavailableSubs.clear();
    // The old pipeline's caption answers are stale; the new path starts off.
    this.ccRequestSeq++;
    this.ccPending = null;
    this.ccEnabled = false;
    this.ccMediaId = '';
    if (this.selfRenderIndex < 0 && !this.subs.active && !this.dashSubs.active) return;
    this.subs.stop();
    this.dashSubs.stop();
    this.selfRenderIndex = -1;
    log.info('Self-rendered subtitles stopped', 'event=subtitles.self_render.stopped',
      this.options.playbackLabel(), 'reason=path_change');
  }

  // Spec-correct tune-in default for self-rendered WebVTT: subtitles stay off
  // unless a rendition is FORCED, or the user saved a pick for this channel.
  // DEFAULT=YES does not auto-enable — per HLS it only marks the preferred
  // rendition once subtitles are on. A saved CC pick is applied separately.
  private applySelfRenderSelection(): void {
    if (this.pipeline.isMseActive()) return;
    const pref = StorageService.getSubtitlePref(this.preferenceKey());
    this.loadSubtitleOffset();
    if (pref?.cc) {
      this.applySubtitleChoice(-1);
      return;
    } // CC path owns it
    const options = this.subtitleOptions();
    const index = chooseSubtitleIndex(options, pref);
    this.logSubtitleChoice('self-render', options, pref, index);
    this.subtitlePick = pref && !pref.off ? 'saved' : 'forced';
    this.applySubtitleChoice(index);
  }

  private rememberSubtitle(pref: SubtitlePref): void {
    const key = this.preferenceKey();
    if (key) StorageService.setSubtitlePref(key, pref);
    log.info('subtitle: user picked',
      pref.off ? 'Off' : (pref.name || pref.lang || '(unnamed)'),
      key ? '— saved to storage' : '(no channel key, not saved)');
  }

  private logSubtitleChoice(
    path: string,
    options: SubtitleOption[],
    pref: SubtitlePref | null,
    index: number,
  ): void {
    const option = options.find(item => item.index === index);
    const label = index < 0
      ? t('common.off')
      : option
        ? subtitleLabel(option)
        : t('player.subtitleFallback', { number: index + 1 });
    const source = pref?.off
      ? '(off pref)'
      : isSubtitlePrefMatch(option, pref)
        ? '(saved pref)'
        : '(stream default)';
    log.info(`subtitle: ${path} | tracks:`, options.length,
      '| storage pref:',
      pref ? (pref.off ? 'off' : (pref.name || pref.lang || '(unnamed)')) : 'none',
      '| using:', index, label, source);
  }

  // Re-apply the remembered choice on tune-in. With no saved pick subtitles stay
  // off unless the stream marks one forced. hls.js drives its own rendition, so
  // the two paths are split like audio.
  applyHlsSubtitleSelection(): void {
    if (!this.pipeline.isMseActive()) return;
    const options = this.subtitleOptions();
    if (!options.length) return;
    const pref = StorageService.getSubtitlePref(this.preferenceKey());
    const index = chooseSubtitleIndex(options, pref);
    this.logSubtitleChoice('hls', options, pref, index);
    this.pipeline.setMseSubtitleTrack(index);
    this.loadSubtitleOffset();
  }

  // Re-apply a remembered subtitle choice on the native path once the pipeline/
  // manifest confirms tracks exist (fires on loadedmetadata, an addtrack event,
  // and after the manifest parse). VOD picks from the in-container textTracks;
  // live/catch-up WebVTT is handled by applySelfRenderSelection, CC below.
  applyNativeSubtitleSelection(): void {
    if (this.pipeline.isMseActive()) return; // hls.js owns the rendition and its native text tracks
    const pref = StorageService.getSubtitlePref(this.preferenceKey());
    if (this.options.getVod()) {
      // addTextTrack fires addtrack while the reusable sidecar renderer is being
      // created. Its selection is already authoritative; reapplying here can
      // mistake that internal track for an in-container option on older engines.
      if (this.vodSubs.activeIndex >= 0) return;
      const options = this.subtitleOptions();
      if (!options.length) return;
      const index = this.restoreTranslation(options, chooseSubtitleIndex(options, pref), pref);
      this.logSubtitleChoice('vod-native', options, pref, index);
      this.applySubtitleChoice(index);
      this.loadSubtitleOffset();
      return;
    }
    if (this.ccAvailable() && pref?.cc) {
      this.subs.stop(); // self-render and the native compositor can't both draw
      this.dashSubs.stop();
      this.selfRenderIndex = -1;
      this.setNativeCC(true);
      return;
    }
    const selected = this.manifestSubtitles[this.selfRenderIndex];
    if (selected?.dash?.kind === 'native') this.setNativeCC(true);
  }

  reapplyNativeSubtitleCompositor(): void {
    if (this.pipeline.isMseActive() || this.options.getVod()) return;
    const pref = StorageService.getSubtitlePref(this.preferenceKey());
    const selected = this.manifestSubtitles[this.selfRenderIndex];
    if ((this.ccAvailable() && pref?.cc) || selected?.dash?.kind === 'native') {
      this.setNativeCC(true);
    }
  }

  private preferenceKey(): string {
    return playbackPreferenceKey(this.options.getChannel(), this.options.getVod());
  }
}
