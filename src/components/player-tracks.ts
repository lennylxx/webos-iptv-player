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
import { HlsSubtitles } from '../services/hls-subtitles';
import { VodSubtitles } from '../services/vod-subtitles';
import { AssSubtitles, isAssSidecar } from '../services/ass-subtitles';
import { getCachedSubtitle, setCachedSubtitle } from '../services/idb-cache';
import {
  audioLabel,
  chooseAudioIndex,
  isPrefMatch,
  mergeManifestNames,
  nativeAudioOptions,
} from '../utils/audio-tracks';
import {
  chooseSubtitleIndex,
  clampSubtitleOffset,
  closedCaptionLabel,
  formatSubtitleOffset,
  isSubtitlePrefMatch,
  manifestSubtitleOptions,
  nativeSubtitleOptions,
  shiftForeignTrack,
  subtitleLabel,
} from '../utils/subtitle-tracks';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { createLogger } from '../utils/logger';
import { $ } from '../utils/dom';
import { t } from '../i18n';
import { showToast } from './toast';
import { subtitleSearchService } from '../services/subtitle-search/subtitle-search-service';
import { SubtitleSearchOverlay } from './subtitle-search-overlay';
import { SubtitleOffsetOverlay } from './subtitle-offset-overlay';
import type {
  OnlineSubtitleResult,
  SubtitleQuery,
} from '../services/subtitle-search/types';
import type { PipelineManifest, PlayerPipeline } from './player-pipeline';

const log = createLogger('Player');
const isWebOS = /webOS|Web0S/i.test(navigator.userAgent);

// Picker sentinel for the in-band CEA-608/708 toggle. -1 is the synthetic "Off"
// row; -2 is the single closed-caption entry, drawn by the native compositor via
// setSubtitleEnable (channel selection is impossible — selectTrack decode-freezes).
const CC_SUBTITLE_INDEX = -2;

// Sentinel for the "Search online…" subtitle row, which opens the search overlay.
const SEARCH_ONLINE_INDEX = -3;

// Base for the synthetic picker indices of ASS/SSA sidecars, which can't surface
// as native <track>s (assjs draws them). Kept high so it never collides with a
// real textTracks index or the -1 Off / -2 CC sentinels; the i-th ASS sidecar is
// ASS_SUBTITLE_BASE + i.
export const ASS_SUBTITLE_BASE = 1000;

interface PlayerTracksOptions {
  getVideoElement: () => HTMLVideoElement | null;
  getChannel: () => Channel | null;
  getVod: () => VodPlayback | null;
}

export class PlayerTracks {
  private manifestAudio: ManifestAudio[] = []; // real track names parsed from the HLS master (webOS)
  private manifestSubtitles: ManifestSubtitle[] = []; // subtitle names parsed from the HLS master (webOS)
  private manifestClosedCaptions: ManifestClosedCaption[] = []; // CEA-608/708 declared in the HLS master (webOS)
  private ccEnabled = false; // live state of the native caption compositor (setSubtitleEnable)
  private selfRenderIndex = -1; // manifest subtitle rendition currently self-rendered (-1 = off)
  private masterUrl = ''; // HLS master URL of the active stream, for re-pointing self-render
  private subs = new HlsSubtitles(); // self-rendered subtitles on the webOS native path
  private vodSubs = new VodSubtitles(); // sidecar SRT/WebVTT tracks for VOD (Xtream)
  private assSubs = new AssSubtitles(); // sidecar ASS/SSA subtitles for VOD, drawn by assjs
  private vodAssSidecars: SidecarSubtitle[] = []; // the ASS/SSA sidecars of the current VOD item
  private activeAssIndex = -1; // index into vodAssSidecars currently shown (-1 = none)
  private subsOverlay: SubtitleSearchOverlay | null = null; // online subtitle search overlay
  private subtitleOffsetS = 0; // per-stream subtitle timing offset (seconds; + = later)
  private offsetOverlay: SubtitleOffsetOverlay | null = null;

  constructor(
    private pipeline: PlayerPipeline,
    private options: PlayerTracksOptions,
  ) {}

  resetForLoad(): void {
    this.manifestAudio = [];
    this.manifestSubtitles = [];
    this.manifestClosedCaptions = [];
    this.ccEnabled = false; // fresh pipeline — captions start off (608 doesn't auto-draw)
    this.selfRenderIndex = -1;
    this.masterUrl = '';
    this.subs.stop();
  }

  applyManifest(manifest: PipelineManifest): void {
    this.manifestAudio = manifest.audio;
    this.manifestSubtitles = manifest.subtitles;
    this.manifestClosedCaptions = manifest.closedCaptions;
    this.masterUrl = manifest.masterUrl;
    if (manifest.audio.length) this.applyNativeAudioSelection();
    // Off unless FORCED or a saved pick (spec-correct — see applySelfRenderSelection).
    if (manifest.subtitles.length) this.applySelfRenderSelection();
    // Re-apply a saved CC choice now the manifest confirms captions exist.
    if (manifest.closedCaptions.length) this.applyNativeSubtitleSelection();
  }

  attachVod(vod: VodPlayback): void {
    const video = this.options.getVideoElement();
    if (!video) return;
    // Split sidecars: SRT/WebVTT render as native <track>s; ASS/SSA are drawn by
    // assjs into an overlay. Both after loadStream — it resets the <video>'s children.
    this.activeAssIndex = -1;
    this.vodAssSidecars = vod.subtitles.filter((s) => isAssSidecar(s.url));
    this.vodSubs.attach(video, vod.subtitles.filter((s) => !isAssSidecar(s.url)));
    this.assSubs.attach(video, video.parentElement ?? document.body, this.vodAssSidecars);
    void this.restoreOnlineSubtitle(vod);
  }

  suspend(): void {
    this.subs.stop();
  }

  stop(): void {
    this.subs.stop();
    this.vodSubs.clear();
    this.assSubs.destroy();
    this.vodAssSidecars = [];
    this.activeAssIndex = -1;
  }

  handleAction(action: Action): boolean {
    if (!this.subsOverlay?.visible) return false;
    this.subsOverlay.handleAction(action);
    return true;
  }

  /** Dismiss the online subtitle-search overlay if it is open. Called on every
   *  view transition (App.showView) so it never lingers over another view or
   *  reappears when its player view is shown again. */
  closeSubtitleSearch(): void {
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

  subtitleOffsetOpen(): boolean {
    return this.offsetOverlay?.visible === true;
  }

  handleSubtitleOffsetAction(action: Action): void {
    this.offsetOverlay?.handleAction(action);
  }

  /** Dismiss the subtitle-sync adjuster (called on every view transition). */
  closeSubtitleOffset(): void {
    this.offsetOverlay?.close();
  }

  // Whether an offset-capable subtitle is currently active (a subtitle is on and it's a
  // path whose cues we can shift — not the native-compositor CC).
  private subtitleOffsetAvailable(): boolean {
    if (this.pipeline.isHlsActive()) return this.pipeline.hlsSubtitleOptions().some(o => o.active);
    if (this.ccEnabled) return false;
    if (this.options.getVod()) {
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
    this.vodSubs.setOffset(seconds);
    this.assSubs.setOffset(seconds);
    const list = this.options.getVideoElement()?.textTracks;
    if (list) for (let i = 0; i < list.length; i++) {
      const track = list[i];
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      if (this.subs.owns(track) || this.vodSubs.owns(track)) continue; // an engine already shifted these
      shiftForeignTrack(track, seconds);
    }
  }

  // Load the saved offset for the current stream and apply it (called on tune-in).
  private loadSubtitleOffset(): void {
    this.subtitleOffsetS = StorageService.getSubtitleOffset(
      this.preferenceKey(),
      this.legacyPreferenceKey(),
    );
    this.applySubtitleOffset();
  }

  private ensureSubsOverlay(): SubtitleSearchOverlay | null {
    if (this.subsOverlay) return this.subsOverlay;
    const container = $('#subtitle-search');
    if (!container) return null;
    this.subsOverlay = new SubtitleSearchOverlay(
      container,
      (result) => void this.applyOnlineSubtitle(result),
      () => { /* closed */ },
      (query) => void this.runSubtitleSearch(query),
    );
    return this.subsOverlay;
  }

  private buildSubtitleQuery(vod: VodPlayback): SubtitleQuery {
    const meta = vod.searchMeta ?? {};
    return {
      type: vod.kind === 'episode' ? 'episode' : 'movie',
      title: vod.title,
      imdbId: meta.imdbId,
      tmdbId: meta.tmdbId,
      year: meta.year,
      season: meta.season,
      episode: meta.episode,
    };
  }

  private async openSubtitleSearch(): Promise<void> {
    const overlay = this.ensureSubsOverlay();
    const vod = this.options.getVod();
    if (!overlay || !vod) return;
    overlay.setQuery(vod.title); // prefill the box with the detected title
    await this.runSubtitleSearch(null);
  }

  /** Run an online subtitle search and feed the overlay. `query === null` uses the
   *  structured keys (imdb/tmdb/title); a string is a manual free-form title that
   *  overrides them via `manualQuery`. Errors/empties stay on screen (no
   *  auto-close) so the persistent search box can be edited and retried. */
  private async runSubtitleSearch(query: string | null): Promise<void> {
    const overlay = this.ensureSubsOverlay();
    const vod = this.options.getVod();
    if (!overlay || !vod) return;
    if (query != null) overlay.setQuery(query);
    overlay.showStatus(t('subtitle.searching'));
    try {
      const base = this.buildSubtitleQuery(vod);
      const search = query != null ? { ...base, manualQuery: query } : base;
      const results = await subtitleSearchService.search(search);
      if (this.options.getVod() !== vod) return;
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
        const track = video ? this.vodSubs.addOnline(video, subtitle) : null;
        if (video && track) {
          const list = video.textTracks;
          let trackIndex = -1;
          for (let i = 0; i < list.length; i++) if (list[i] === track) trackIndex = i;
          if (trackIndex >= 0) this.applySubtitleChoice(trackIndex);
        }
      }
      this.rememberSubtitle({
        off: false,
        name: result.releaseName || result.language,
        lang: result.language,
      });
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
      if (video) this.vodSubs.addOnline(video, subtitle);
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
    if (this.pipeline.isHlsActive()) return this.pipeline.hlsAudioOptions();
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
    if (this.manifestAudio.length > options.length) {
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
    return this.displayAudioOptions().map(option => ({
      index: option.index,
      label: audioLabel(option),
      active: option.active,
      available: option.available,
    }));
  }

  /** Switch the active audio track and remember it for this channel. No-op for a
   *  grayed (unavailable) track — webOS can't switch to a collapsed rendition. */
  selectAudioTrack(index: number): void {
    const option = this.displayAudioOptions().find(item => item.index === index);
    if (!option || !option.available) return;
    if (this.pipeline.isHlsActive()) {
      if (!this.pipeline.setHlsAudioTrack(index)) return;
    } else {
      const list = this.options.getVideoElement()?.audioTracks;
      if (!list || index < 0 || index >= list.length) return;
      for (let i = 0; i < list.length; i++) list[i].enabled = (i === index);
    }
    this.rememberAudio(option);
    showToast(t('player.switchingAudio', { name: audioLabel(option) }));
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
    if (!this.pipeline.isHlsActive()) return;
    const options = this.audioOptions();
    if (options.length < 2) return;
    const pref = StorageService.getAudioPref(
      this.preferenceKey(),
      this.legacyPreferenceKey(),
    );
    const index = chooseAudioIndex(options, pref);
    this.logAudioChoice('hls', options, pref, index);
    if (index >= 0) this.pipeline.setHlsAudioTrack(index);
  }

  applyNativeAudioSelection(): void {
    if (this.pipeline.isHlsActive()) return; // hls.js owns the rendition; videoEl exposes only the active one
    const list = this.options.getVideoElement()?.audioTracks;
    if (!list || list.length < 2) return;
    const options = this.audioOptions();
    const pref = StorageService.getAudioPref(
      this.preferenceKey(),
      this.legacyPreferenceKey(),
    );
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
    if (this.pipeline.isHlsActive()) return this.pipeline.hlsSubtitleOptions();
    // VOD: in-container + SRT/WebVTT sidecars surface as switchable native
    // textTracks; ASS/SSA sidecars can't, so they're appended as synthetic
    // options at ASS_SUBTITLE_BASE + i (assjs draws them).
    if (this.options.getVod()) {
      const list = this.options.getVideoElement()?.textTracks;
      const native = list ? nativeSubtitleOptions(list) : [];
      const ass = this.vodAssSidecars.map((sidecar, index) => ({
        index: ASS_SUBTITLE_BASE + index,
        name: sidecar.name,
        lang: sidecar.lang,
        isDefault: false,
        isForced: false,
        active: this.activeAssIndex === index,
      }));
      return native.concat(ass);
    }
    // webOS native live/catch-up: in-manifest WebVTT is self-rendered (not surfaced
    // as switchable textTracks), so the choices are the parsed master renditions and
    // the active one is what we self-render.
    return manifestSubtitleOptions(this.manifestSubtitles, this.selfRenderIndex);
  }

  // Picker-facing options. Unlike audio — where webOS collapses same-language
  // renditions so unreachable ones are grayed (displayAudioOptions) — every
  // subtitle rendition is self-renderable, so all are selectable.
  private displaySubtitleOptions(): Array<SubtitleOption & { available: boolean }> {
    return this.subtitleOptions().map(option => ({ ...option, available: true }));
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
    }));
    if (this.ccAvailable()) {
      tracks.push({
        index: CC_SUBTITLE_INDEX,
        label: closedCaptionLabel(this.manifestClosedCaptions),
        active: this.ccEnabled,
        available: true,
      });
    }
    if (this.options.getVod() && subtitleSearchService.isAvailable()) {
      tracks.push({
        index: SEARCH_ONLINE_INDEX,
        label: t('player.searchOnline'),
        active: false,
        available: true,
      });
    }
    return tracks;
  }

  // In-band CC is offered only on the native pipeline (setSubtitleEnable is a
  // webOS Luna verb) and only when the master advertises CLOSED-CAPTIONS.
  private ccAvailable(): boolean {
    return isWebOS && this.manifestClosedCaptions.length > 0;
  }

  /** Switch the active subtitle (index -1 = off, -2 = in-band CC) and remember it
   *  for this channel. No-op for a grayed (unavailable) track the platform didn't
   *  expose. CC and the other subtitle paths are mutually exclusive. */
  selectSubtitleTrack(index: number): void {
    if (index === SEARCH_ONLINE_INDEX) {
      void this.openSubtitleSearch();
      return;
    }
    if (index === CC_SUBTITLE_INDEX) {
      this.subs.stop(); // self-render and the native compositor can't both draw
      this.selfRenderIndex = -1;
      this.setNativeCC(true);
      this.rememberSubtitle({ off: false, cc: true, name: '', lang: '' });
      showToast(t('player.subtitlesTrack', {
        name: closedCaptionLabel(this.manifestClosedCaptions),
      }));
      return;
    }
    if (index === -1) {
      this.setNativeCC(false);
      this.applySubtitleChoice(-1);
      this.rememberSubtitle({ off: true, name: '', lang: '' });
      showToast(t('player.subtitlesOff'));
      return;
    }
    const option = this.displaySubtitleOptions().find(item => item.index === index);
    if (!option || !option.available) return;
    this.setNativeCC(false);
    this.applySubtitleChoice(index);
    this.rememberSubtitle({ off: false, name: option.name, lang: option.lang });
    showToast(t('player.subtitlesTrack', { name: subtitleLabel(option) }));
  }

  // Toggle the native caption compositor (CEA-608/708, also IMSC) via Luna. Only
  // fires on a real state change, and needs the pipeline's mediaId — exposed on
  // the native element once decoding starts. selectTrack is deliberately avoided:
  // it decode-freezes the video, so this is enable/disable only.
  private setNativeCC(enable: boolean): void {
    if (!isWebOS || enable === this.ccEnabled) return;
    const video = this.options.getVideoElement() as
      (HTMLVideoElement & { mediaId?: string }) | null;
    const mediaId = video?.mediaId;
    if (!mediaId) {
      if (enable) log.warn('CC: no mediaId yet — will retry on track/metadata events');
      return;
    }
    const webOSWindow = window as unknown as {
      webOS?: { service?: { request?: (uri: string, opts: {
        method: string;
        parameters: unknown;
        onSuccess?: (response: unknown) => void;
        onFailure?: (error: unknown) => void;
      }) => void } };
    };
    const request = webOSWindow.webOS?.service?.request;
    if (!request) return;
    request('luna://com.webos.media', {
      method: 'setSubtitleEnable',
      parameters: { mediaId, enable },
      onSuccess: () => log.info('CC: setSubtitleEnable', enable, 'ok'),
      onFailure: (error) =>
        log.warn('CC: setSubtitleEnable failed:', JSON.stringify(error)),
    });
    this.ccEnabled = enable;
  }

  // Route a subtitle pick to the active engine (index -1 = off). hls.js (preview)
  // drives its own rendition; the webOS native path self-renders the chosen WebVTT
  // rendition. selectTrack is never used — it decode-freezes the video on webOS.
  private applySubtitleChoice(index: number): void {
    this.applySubtitleChoiceRaw(index);
    this.applySubtitleOffset();
  }

  private applySubtitleChoiceRaw(index: number): void {
    if (this.pipeline.isHlsActive()) {
      this.pipeline.setHlsSubtitleTrack(index);
      return;
    }
    // VOD: an ASS/SSA sidecar (index >= ASS_SUBTITLE_BASE) is drawn by assjs;
    // otherwise toggle the native textTrack modes directly (index -1 = all off).
    // One path draws at a time, so each disables the other.
    if (this.options.getVod()) {
      const list = this.options.getVideoElement()?.textTracks;
      if (index >= ASS_SUBTITLE_BASE) {
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
      this.activeAssIndex = -1;
      this.assSubs.hide();
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
        track.mode = i === index ? 'showing' : 'disabled';
      }
      if (index >= 0 && list[index]) {
        void this.vodSubs.ensureLoaded(list[index]); // lazy-load a sidecar's cues
      }
      return;
    }
    const manifest = index >= 0 ? this.manifestSubtitles[index] : undefined;
    const video = this.options.getVideoElement();
    if (!manifest || !video || !this.masterUrl) {
      this.subs.stop();
      this.selfRenderIndex = -1;
      return;
    }
    this.selfRenderIndex = index;
    void this.subs.start(video, this.masterUrl, {
      name: manifest.name,
      lang: manifest.lang,
    });
  }

  // Spec-correct tune-in default for self-rendered WebVTT: subtitles stay off
  // unless a rendition is FORCED, or the user saved a pick for this channel.
  // DEFAULT=YES does not auto-enable — per HLS it only marks the preferred
  // rendition once subtitles are on. A saved CC pick is applied separately.
  private applySelfRenderSelection(): void {
    if (this.pipeline.isHlsActive()) return;
    const pref = StorageService.getSubtitlePref(
      this.preferenceKey(),
      this.legacyPreferenceKey(),
    );
    this.loadSubtitleOffset();
    if (pref?.cc) {
      this.applySubtitleChoice(-1);
      return;
    } // CC path owns it
    const options = manifestSubtitleOptions(
      this.manifestSubtitles,
      this.selfRenderIndex,
    );
    const index = chooseSubtitleIndex(options, pref);
    this.logSubtitleChoice('self-render', options, pref, index);
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
    if (!this.pipeline.isHlsActive()) return;
    const options = this.subtitleOptions();
    if (!options.length) return;
    const pref = StorageService.getSubtitlePref(
      this.preferenceKey(),
      this.legacyPreferenceKey(),
    );
    const index = chooseSubtitleIndex(options, pref);
    this.logSubtitleChoice('hls', options, pref, index);
    this.pipeline.setHlsSubtitleTrack(index);
    this.loadSubtitleOffset();
  }

  // Re-apply a remembered subtitle choice on the native path once the pipeline/
  // manifest confirms tracks exist (fires on loadedmetadata, an addtrack event,
  // and after the manifest parse). VOD picks from the in-container textTracks;
  // live/catch-up WebVTT is handled by applySelfRenderSelection, CC below.
  applyNativeSubtitleSelection(): void {
    if (this.pipeline.isHlsActive()) return; // hls.js owns the rendition and its native text tracks
    const pref = StorageService.getSubtitlePref(
      this.preferenceKey(),
      this.legacyPreferenceKey(),
    );
    if (this.options.getVod()) {
      const options = this.subtitleOptions();
      if (!options.length) return;
      const index = chooseSubtitleIndex(options, pref);
      this.logSubtitleChoice('vod-native', options, pref, index);
      this.applySubtitleChoice(index);
      this.loadSubtitleOffset();
      return;
    }
    if (this.ccAvailable() && pref?.cc) {
      this.subs.stop(); // self-render and the native compositor can't both draw
      this.selfRenderIndex = -1;
      this.setNativeCC(true);
    }
  }

  private preferenceKey(): string {
    const vod = this.options.getVod();
    if (vod) return `vod:${vod.accountId}:${vod.kind}:${vod.itemId}`;
    const channel = this.options.getChannel();
    return channel ? channelKey(channel) : '';
  }

  private legacyPreferenceKey(): string {
    if (this.options.getVod()) return '';
    const channel = this.options.getChannel();
    return channel ? legacyChannelKey(channel) : '';
  }
}
