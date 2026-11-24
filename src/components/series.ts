import { syncTabBarOverArt } from './tab-bar';
import type { Action, PlaylistEntry, SeriesCategory, SeriesItem, SeriesInfo, Episode, ResumeEntry, ResumeKind, SearchMeta, VodPlayback, VodQueueItem, WatchlistEntry } from '../types';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadSeriesCategories, loadSeries, loadSeriesInfo } from '../services/xtream-catalog';
import { xtreamEpisodeUrl, type XtreamCredentials } from '../utils/xtream-url';
import { CatalogView, type CatalogHandlers, type CollectionKind, type CollectionEntry, type TranslationTarget } from './catalog-view';
import { programDescription, programTitleLabel, programView, ProgramTranslation, type TranslationSource } from './program-translation';
import type { ProgramText } from '../services/epg-translation';
import { CHECK_ICON, HIDE_ICON, PLAY_ICON, REMOVE_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t, tp } from '../i18n';
import { VirtualList } from '../utils/virtual-list';

const EPISODE_GAP = 16;
const EPISODE_NO_PLOT_ESTIMATE = 138;
const EPISODE_PLOT_ESTIMATE = 216;
const EPISODE_OVERSCAN = 5;
// The whole detail page scrolls, so the fallback is the page viewport, not the
// space left under the header.
const EPISODE_VIEWPORT_FALLBACK = 984;
const SERIES_ENTRY = 'series:';
// Matches the label episodeLabel() writes: `Name — S1E3` or `Name — S1E3 — Title`;
// only legacy entries, saved without the series name or episode code, need it.
const EPISODE_LABEL = /^(.*?) — S(\d+)E(\d+)(?: — |$)/;

// The Series section: browse (Continue rail of resumed episodes + per-category
// rails + an "all categories" drill-in) → per-category poster grid → a detail
// screen with a season selector over an episode list. The browse/grid/nav
// machinery lives in CatalogView.
export class Series extends CatalogView<SeriesCategory, SeriesItem> {
  protected get kicker(): string { return t('common.series'); }
  protected readonly resumeKind: ResumeKind = 'episode';
  protected readonly continueCaptionLine = true;
  protected readonly parentalKind = 'series' as const;
  protected scopeName(): string { return 'series'; }
  protected get emptyMessage(): string { return t('catalog.noSeries'); }
  protected get gridEmptyMessage(): string { return t('catalog.noSeriesCategory'); }
  protected itemCount(count: number): string { return tp('catalog.seriesCount', count); }

  private currentSeries: SeriesItem | null = null;
  private placeBeforePlay: ResumeEntry | null = null;
  private currentInfo: SeriesInfo | null = null;
  private selectedSeason = 0;
  private detailLoading = false;
  private episodeFocusIndex = 0;
  private episodeSource: Episode[] | null = null;
  private watchedEpisodes = new Set<string>();
  private episodeList: { info: SeriesInfo; episodes: Episode[] } | null = null;
  private measuredEpisodes = new Set<number>();
  private detailController: AbortController | null = null;
  private readonly episodeVirtualizer = new VirtualList({
    overscan: EPISODE_OVERSCAN,
    fallbackViewportSize: EPISODE_VIEWPORT_FALLBACK,
  });
  private episodeScrollFrame: number | null = null;
  // A held key's reveal writes the list's offset without a smooth scroll.
  private instantEpisodeScroll = false;

  constructor(container: HTMLElement, handlers: CatalogHandlers) {
    super(container, handlers);
  }

  protected loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<SeriesCategory[]> {
    return loadSeriesCategories(account, signal);
  }
  protected loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<SeriesItem[]> {
    return loadSeries(account, categoryId, signal);
  }
  protected itemId(s: SeriesItem): string { return s.seriesId; }
  protected itemName(s: SeriesItem): string { return s.name; }
  protected itemPoster(s: SeriesItem): string { return s.poster; }
  protected itemBackdrop(s: SeriesItem): string { return s.backdrop ?? ''; }
  protected itemCategoryId(s: SeriesItem): string { return s.categoryId; }
  protected withCategoryId(s: SeriesItem, categoryId: string): SeriesItem { return { ...s, categoryId }; }
  protected itemGenre(s: SeriesItem): string { return s.genre ?? ''; }
  protected clearDetail(): void {
    this.detailController?.abort();
    this.detailController = null;
    this.currentSeries = null;
  }
  protected onRequestSessionReset(): void {
    this.detailController?.abort();
    this.detailController = null;
  }

  protected collectionEntries(kind: CollectionKind): CollectionEntry[] {
    if (kind === 'continue') {
      return this.continueEntries().map(entry => {
        const owner = entry.watchlistOwner;
        if (!owner) {
          return {
            id: entry.itemId, key: `r:${entry.itemId}`,
            tile: managing => this.resumeTile(entry, managing),
          };
        }
        return {
          id: SERIES_ENTRY + owner.itemId, key: `c:${owner.itemId}`,
          tile: managing => this.seriesResumeTile(entry, managing),
        };
      });
    }
    return this.visibleWatchlist('series').map(entry => {
      const series = this.watchlistEntryToSeries(entry);
      const key = `i:${series.categoryId}:${series.seriesId}`;
      return {
        id: entry.itemId, key,
        tile: managing => this.tile(series, this.removeMark(managing, key), managing),
      };
    });
  }

  protected fallbackItem(seriesId: string): SeriesItem | null {
    const resumed = this.seriesResume(seriesId);
    if (resumed) return this.resumeToSeries(resumed);
    const entry = this.visibleWatchlist('series')
      .find((item) => item.itemId === seriesId);
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  protected heroFallback(): SeriesItem | null {
    const resumed = this.resume.find(entry => !!entry.watchlistOwner);
    if (resumed) return this.resumeToSeries(resumed);
    const entry = this.visibleWatchlist('series')[0];
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  // One entry per series, its latest episode; a legacy entry without an
  // owner stays on its own.
  private continueEntries(): ResumeEntry[] {
    const seen: Record<string, true> = {};
    return this.resume.filter(entry => {
      const owner = entry.watchlistOwner?.itemId;
      if (owner === undefined) return true;
      if (seen[owner]) return false;
      seen[owner] = true;
      return true;
    });
  }

  private seriesResume(seriesId: string): ResumeEntry | null {
    return this.resume.find(entry => entry.watchlistOwner?.itemId === seriesId) ?? null;
  }

  private resumeToSeries(entry: ResumeEntry): SeriesItem {
    const owner = entry.watchlistOwner!;
    // An entry saved before the owner carried the series' name and poster.
    if (!owner.name || !owner.poster) {
      const loaded = (this.itemsByCategory[entry.categoryId ?? ''] ?? [])
        .find(item => item.seriesId === owner.itemId);
      if (loaded) return loaded;
    }
    return {
      accountId: entry.accountId,
      seriesId: owner.itemId,
      name: owner.name || EPISODE_LABEL.exec(entry.name)?.[1] || entry.name,
      poster: owner.poster || entry.poster,
      rating: '',
      categoryId: entry.categoryId ?? '',
    };
  }

  protected clearContinueEntry(accountId: string, id: string): void {
    if (id.indexOf(SERIES_ENTRY) !== 0) {
      super.clearContinueEntry(accountId, id);
      return;
    }
    const seriesId = id.slice(SERIES_ENTRY.length);
    for (const entry of this.resume) {
      if (entry.watchlistOwner?.itemId === seriesId) super.clearContinueEntry(accountId, entry.itemId);
    }
  }

  private watchlistEntryToSeries(entry: WatchlistEntry): SeriesItem {
    return {
      accountId: entry.accountId,
      seriesId: entry.itemId,
      name: entry.name,
      poster: entry.poster,
      rating: entry.rating,
      categoryId: entry.categoryId,
    };
  }

  protected selectExtra(el: HTMLElement): boolean {
    if (el.dataset.action === 'watched') {
      this.markEpisodes(this.allEpisodes(), !this.seriesWatched());
      showToast(t(this.seriesWatched() ? 'catalog.markedWatched' : 'catalog.markedNotWatched'));
      return true;
    }
    if (el.dataset.action === 'season-watched') {
      const episodes = this.selectedEpisodes();
      const watched = !this.allWatched(episodes);
      this.markEpisodes(episodes, watched);
      showToast(t(watched ? 'catalog.seasonMarkedWatched' : 'catalog.seasonMarkedNotWatched'));
      return true;
    }
    if (el.dataset.episodeMark !== undefined) {
      this.toggleEpisode(el.dataset.episodeMark);
      return true;
    }
    if (el.dataset.action === 'hide' && this.currentSeries) {
      const on = this.toggleMark('hidden', this.currentSeries);
      showToast(t(on ? 'catalog.titleHidden' : 'catalog.titleUnhidden'));
      this.renderDetail();
      return true;
    }
    if (el.dataset.action === 'watchlist') { this.toggleWatchlist(); return true; }
    if (el.dataset.action === 'resume') { this.resumeSeries(); return true; }
    if (el.dataset.action === 'remove-resume') { this.removeSeriesResume(); return true; }
    if (el.dataset.resumeEpisode !== undefined) { this.playResume(el.dataset.resumeEpisode); return true; }
    if (el.dataset.season !== undefined) { this.selectSeason(Number(el.dataset.season)); return true; }
    if (el.dataset.episodeId !== undefined) { this.playEpisode(el.dataset.episodeId); return true; }
    return false;
  }

  protected refreshMarks(): void {
    super.refreshMarks();
    this.watchedEpisodes = this.account
      ? StorageService.catalogMarkIds(this.account.id, 'episode', 'watched') : new Set<string>();
    if (this.syncSeriesWatched()) super.refreshMarks();
  }

  // Green toggles the focused episode's watched mark, as it does a favorite.
  protected handleExtraAction(action: Action): boolean {
    if (action !== 'green' || this.mode !== 'detail') return false;
    const ep = this.episodeOfKey(this.focusedKey());
    if (!ep) return false;
    this.toggleEpisode(ep.id);
    return true;
  }

  private allEpisodes(): Episode[] {
    const info = this.currentInfo;
    if (!info) return [];
    if (this.episodeList?.info !== info) {
      const episodes: Episode[] = [];
      for (const season of info.seasons) {
        for (const ep of info.episodesBySeason[season] ?? []) episodes.push(ep);
      }
      this.episodeList = { info, episodes };
    }
    return this.episodeList.episodes;
  }

  private allWatched(episodes: Episode[]): boolean {
    return episodes.length > 0 && episodes.every(ep => this.watchedEpisodes.has(ep.id));
  }

  private seriesWatched(): boolean {
    return !!this.currentSeries && this.watchedIds.has(this.currentSeries.seriesId);
  }

  private toggleEpisode(episodeId: string): void {
    const ep = this.findEpisode(episodeId);
    if (!ep) return;
    const watched = !this.watchedEpisodes.has(ep.id);
    this.markEpisodes([ep], watched);
    showToast(t(watched ? 'catalog.markedWatched' : 'catalog.markedNotWatched'));
  }

  // Marking watched also drops the episodes' places in Continue Watching.
  private markEpisodes(episodes: Episode[], watched: boolean): void {
    const account = this.account;
    if (!account || !episodes.length) return;
    const ids = episodes.map(ep => ep.id);
    StorageService.setCatalogMarks(account.id, 'episode', ids, { watched });
    if (watched) {
      // From storage: Continue Watching leaves out a hidden series' places.
      const marked = new Set(ids);
      for (const entry of StorageService.getResumeList(account.id)) {
        if (entry.kind === 'episode' && marked.has(entry.itemId)) {
          StorageService.clearResume(account.id, 'episode', entry.itemId);
        }
      }
      this.refreshResume();
    }
    this.refreshMarks();
    this.renderDetail();
  }

  // A series counts as watched while every episode it lists is: a new
  // episode makes it unwatched again, the last one watched makes it watched.
  // True when it changed the series' mark.
  private syncSeriesWatched(): boolean {
    const account = this.account;
    const series = this.currentSeries;
    const episodes = this.allEpisodes();
    // An account switch refreshes marks before it drops the last account's detail.
    if (!account || !series || series.accountId !== account.id || this.mode !== 'detail'
        || this.detailLoading || !episodes.length) return false;
    const watched = this.allWatched(episodes);
    if (watched === this.watchedIds.has(series.seriesId)) return false;
    StorageService.setCatalogMark(account.id, 'series', series.seriesId, { watched });
    return true;
  }

  private toggleWatchlist(): void {
    const series = this.currentSeries;
    const account = this.account;
    if (!series || !account) return;
    const result = StorageService.toggleWatchlist({
      accountId: account.id,
      kind: 'series',
      itemId: series.seriesId,
      name: series.name,
      poster: this.currentInfo?.poster || series.poster,
      rating: this.currentInfo?.rating || series.rating,
      categoryId: series.categoryId,
      addedAt: Date.now(),
    });
    showToast(t(result === 'full' ? 'catalog.watchlistFull'
      : result === 'added' ? 'catalog.watchlistAdded' : 'catalog.watchlistRemoved'));
    this.renderDetail();
  }

  protected async openDetail(series: SeriesItem): Promise<void> {
    const account = this.account;
    if (!account || !this.requestSignal) return;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const signal = this.detailController.signal;
    this.currentSeries = series;
    this.refreshResume();
    this.enterDetail();
    this.currentInfo = null;
    this.selectedSeason = 0;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.detailLoading = true;
    this.renderDetail();
    try {
      this.currentInfo = await loadSeriesInfo(account, series.seriesId, signal);
    } catch (err) {
      if (!this.requestFailed('Series detail load', err, signal)) return;
      this.currentInfo = null;
    }
    if (this.mode === 'detail' && this.currentSeries === series) {
      this.detailLoading = false;
      const resumed = this.seriesResume(series.seriesId);
      const resumedSeason = resumed ? this.findEpisode(resumed.itemId)?.season : undefined;
      this.selectedSeason = resumedSeason ?? this.currentInfo?.seasons[0] ?? 0;
      this.refreshMarks();
      this.renderDetail();
    }
  }

  // Playback that moved the series' place into another season (auto-advance)
  // opens that season on Resume; an unchanged place leaves the page as it was.
  refreshPlaybackState(): void {
    const series = this.currentSeries;
    const before = this.placeBeforePlay;
    this.placeBeforePlay = null;
    if (this.mode === 'detail' && series) {
      this.refreshResume();
      const resumed = this.seriesResume(series.seriesId);
      const moved = !!resumed && (resumed.itemId !== before?.itemId || resumed.updatedAt !== before.updatedAt);
      const season = moved ? this.findEpisode(resumed!.itemId)?.season : undefined;
      if (season !== undefined && season !== this.selectedSeason) {
        this.selectedSeason = season;
        this.episodeFocusIndex = 0;
        this.episodeSource = null;
        const scroller = this.layer('detail').querySelector<HTMLElement>('.series-detail');
        if (scroller) scroller.scrollTop = 0;
        this.focusScope.track(null);
      }
    }
    super.refreshPlaybackState();
  }

  private playSeriesEpisode(req: Omit<VodPlayback, 'onBack'>): void {
    ProgramTranslation.release(this);
    const series = this.currentSeries;
    this.placeBeforePlay = series ? this.seriesResume(series.seriesId) : null;
    this.handlers.onPlayVod(req);
  }

  private selectSeason(season: number): void {
    this.selectedSeason = season;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.renderDetail();
  }

  private findEpisode(episodeId: string): Episode | null {
    const info = this.currentInfo;
    if (!info) return null;
    for (const season of info.seasons) {
      const ep = (info.episodesBySeason[season] ?? []).find((e) => e.id === episodeId);
      if (ep) return ep;
    }
    return null;
  }

  private episodeLabel(series: SeriesItem, ep: Episode): string {
    const code = `S${ep.season}E${ep.episode}`;
    return ep.title ? `${series.name} — ${code} — ${ep.title}` : `${series.name} — ${code}`;
  }

  private episodePlayback(series: SeriesItem, ep: Episode): VodQueueItem {
    const a = this.account!;
    return {
      url: xtreamEpisodeUrl(this.creds(), ep.id, ep.containerExtension || 'mp4'),
      title: this.episodeLabel(series, ep),
      poster: ep.poster || series.poster,
      accountId: a.id,
      itemId: ep.id,
      kind: 'episode',
      categoryId: series.categoryId,
      parentalItemId: series.seriesId,
      subtitles: ep.subtitles,
      searchMeta: {
        season: ep.season,
        episode: ep.episode,
        imdbId: this.currentInfo?.imdbId || undefined,
        tmdbId: this.currentInfo?.tmdbId || undefined,
      },
      episodeTitle: ep.title || undefined,
      watchlistOwner: {
        kind: 'series', itemId: series.seriesId, name: series.name,
        poster: this.currentInfo?.poster || series.poster,
      },
    };
  }

  private episodesAfter(episodeId: string, series: SeriesItem): VodQueueItem[] {
    const info = this.currentInfo;
    if (!info) return [];
    const episodes = info.seasons.reduce<Episode[]>(
      (all, season) => all.concat(info.episodesBySeason[season] ?? []), []);
    const index = episodes.findIndex((ep) => ep.id === episodeId);
    return index < 0 ? [] : episodes.slice(index + 1).map((ep) => this.episodePlayback(series, ep));
  }

  private episodesBefore(episodeId: string, series: SeriesItem): VodQueueItem[] {
    const info = this.currentInfo;
    if (!info) return [];
    const episodes = info.seasons.reduce<Episode[]>(
      (all, season) => all.concat(info.episodesBySeason[season] ?? []), []);
    const index = episodes.findIndex((ep) => ep.id === episodeId);
    return index < 0 ? [] : episodes.slice(0, index).map((ep) => this.episodePlayback(series, ep));
  }

  private playEpisode(episodeId: string): void {
    const ep = this.findEpisode(episodeId);
    const series = this.currentSeries;
    const a = this.account;
    if (!ep || !series || !a) return;
    const saved = StorageService.getResume(a.id, 'episode', ep.id);
    this.playSeriesEpisode({
      ...this.episodePlayback(series, ep),
      resumeSecs: saved ? saved.position : 0,
      holdsSeriesPlace: !!saved,
      episodeQueue: this.episodesAfter(ep.id, series),
      previousEpisodes: this.episodesBefore(ep.id, series),
    });
  }

  // An episode the series info no longer lists still resumes from its entry.
  private resumeSeries(): void {
    const series = this.currentSeries;
    const entry = series ? this.seriesResume(series.seriesId) : null;
    if (!entry) return;
    if (this.findEpisode(entry.itemId)) this.playEpisode(entry.itemId);
    else this.playResume(entry.itemId);
  }

  private removeSeriesResume(): void {
    const series = this.currentSeries;
    const a = this.account;
    if (!series || !a) return;
    this.clearContinueEntry(a.id, SERIES_ENTRY + series.seriesId);
    this.refreshResume();
    showToast(t('catalog.continueWatchingRemoved'));
    this.renderDetail();
  }

  private creds(): XtreamCredentials {
    const a = this.account!;
    return { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password };
  }

  // A Continue-rail tile carries only the resume entry (episode id + composed
  // label + poster + stored container extension), not the owning series, so it
  // resumes the episode directly using the stored ext (falling back to mp4).
  private playResume(episodeId: string): void {
    const a = this.account;
    const r = this.resume.find((e) => e.itemId === episodeId);
    if (!a || !r) return;
    this.playSeriesEpisode({
      url: xtreamEpisodeUrl(this.creds(), r.itemId, r.ext || 'mp4'),
      title: r.name,
      poster: r.poster,
      accountId: a.id,
      itemId: r.itemId,
      kind: 'episode',
      categoryId: r.categoryId,
      parentalItemId: r.watchlistOwner?.itemId,
      resumeSecs: r.position,
      holdsSeriesPlace: !!r.watchlistOwner,
      searchMeta: resumeSearchMeta(r),
      subtitles: [],
      episodeQueue: r.episodeQueue,
      watchlistOwner: r.watchlistOwner,
    });
  }

  private resumeTile(r: ResumeEntry, managing = false): Safe {
    return html`
      <div class="catalog-tile" ${raw(managing ? '' : 'data-focusable')} data-key="r:${r.itemId}" data-resume-episode="${r.itemId}">
        <div class="catalog-poster-wrap">${this.posterCell(r.name, r.poster)}${
          this.itemLockBadge(r.categoryId ?? '', r.watchlistOwner?.itemId ?? r.itemId)}${
          this.progressBar(r.position, r.duration)}${this.removeMark(managing, `r:${r.itemId}`)}</div>
        <div class="catalog-tile-name">${r.name}</div>
      </div>
    `;
  }

  private seriesResumeTile(r: ResumeEntry, managing = false): Safe {
    const series = this.resumeToSeries(r);
    const key = `c:${series.seriesId}`;
    const code = resumeEpisodeCode(r);
    return html`
      <div class="catalog-tile catalog-tile-stack" ${raw(managing ? '' : 'data-focusable')} data-key="${key}"
           data-item-id="${series.seriesId}" data-category-id="${series.categoryId}">
        <div class="catalog-poster-wrap">${this.posterCell(series.name, series.poster)}${
          this.itemLockBadge(series.categoryId, series.seriesId)}${
          this.progressBar(r.position, r.duration)}${this.removeMark(managing, key)}</div>
        <div class="catalog-tile-name">${series.name}</div>
        ${code ? html`<div class="catalog-tile-sub">${code}</div>` : ''}
      </div>
    `;
  }

  private seriesSource(): TranslationSource | null {
    const series = this.currentSeries;
    return series ? this.translationSource(series.categoryId, series.seriesId, series.name) : null;
  }

  // The series' own text once its info has come, or failed to: then its name alone.
  private seriesText(): ProgramText | null {
    const series = this.currentSeries;
    return series && !this.detailLoading ? { title: series.name, description: this.currentInfo?.plot ?? '' } : null;
  }

  protected translationHeader(): TranslationTarget | null {
    const source = this.seriesSource();
    const text = this.seriesText();
    return source && text ? { source, text } : null;
  }

  // The focused episode's text, or else the series' own.
  protected override translationTarget(): TranslationTarget | null {
    const source = this.seriesSource();
    const ep = this.episodeOfKey(this.focusedKey());
    return source && ep ? { source, text: episodeText(ep) } : this.translationHeader();
  }

  // A translated plot may take another line, so the shown rows are measured again.
  protected override onTranslationChanged(): void {
    this.measuredEpisodes.clear();
    this.renderDetail(false);
  }

  private episodeRow(accountId: string, ep: Episode, source: TranslationSource | null): Safe {
    const saved = StorageService.getResume(accountId, 'episode', ep.id);
    const view = programView(source, episodeText(ep));
    const mins = ep.durationSecs > 0 ? t('catalog.minutes', { count: Math.floor(ep.durationSecs / 60) }) : '';
    return html`
      <div class="episode-row" data-focusable data-key="ep:${ep.id}" data-episode-id="${ep.id}">
        <span class="episode-badge">${raw(PLAY_ICON)}</span>
        <div class="episode-body">
          <div class="episode-title">
            <span class="episode-num">E${ep.episode}</span>
            <span class="episode-name">${view.title}</span>${programTitleLabel(view)}
            ${saved && saved.position > 0 ? html`<span class="episode-resume">${t('common.resume')}</span>`
              : this.watchedEpisodes.has(ep.id)
                ? html`<span class="episode-watched">${t('catalog.watched')}</span>` : ''}
          </div>
          ${mins ? html`<div class="episode-meta">${mins}</div>` : ''}
          ${programDescription('episode-plot', view)}
        </div>
      </div>
    `;
  }

  private episodeMark(ep: Episode): Safe {
    const watched = this.watchedEpisodes.has(ep.id);
    const label = t(watched ? 'catalog.markNotWatched' : 'catalog.markWatched');
    return html`
      <button class="episode-mark ${watched ? 'watched' : ''}" data-focusable data-key="ep-mark:${ep.id}"
              data-episode-mark="${ep.id}" title="${label}" aria-label="${label}">${raw(CHECK_ICON)}</button>
    `;
  }

  // Art that loads later must not pull the episode list back to the focus.
  protected override onArtSettled(): void { this.renderDetail(false); }

  protected renderDetail(restoreFocus = true): void {
    const series = this.currentSeries;
    const a = this.account;
    if (!series || !a) return;
    const info = this.currentInfo;
    const episodes = info ? (info.episodesBySeason[this.selectedSeason] ?? []) : [];
    const seriesWatched = this.seriesWatched();
    const source = this.seriesSource();
    const view = programView(source, { title: series.name, description: info?.plot ?? '' });
    const seasonWatched = this.allWatched(episodes);
    const poster = info?.poster || series.poster;
    const year = info?.year ? String(info.year) : '';
    const mins = info && info.episodeRunTimeMins > 0
      ? t('catalog.minutes', { count: info.episodeRunTimeMins })
      : '';
    const meta = [year, mins, info?.genre, info?.rating || series.rating]
      .filter((value) => !!value);
    if (episodes !== this.episodeSource) {
      this.episodeSource = episodes;
      this.measuredEpisodes.clear();
      this.episodeVirtualizer.setItemSizes(episodes.map(ep =>
        ep.plot ? EPISODE_PLOT_ESTIMATE : EPISODE_NO_PLOT_ESTIMATE));
    }
    const focusedKey = this.focusedKey();
    const watchlisted = StorageService.isWatchlisted(a.id, 'series', series.seriesId);
    const hidden = this.hiddenIds.has(series.seriesId);
    const resumed = this.seriesResume(series.seriesId);
    const resumedCode = resumed ? resumeEpisodeCode(resumed) : '';
    const previousScroller = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    const previousEpisodes = this.layer('detail').querySelector<HTMLElement>('.series-episodes');
    this.episodeVirtualizer.setLeadingSize(
      this.episodeListStart(previousScroller, previousEpisodes),
    );
    if (restoreFocus && previousScroller) {
      this.episodeVirtualizer.setScrollOffset(previousScroller.scrollTop);
    }
    const episodeViewport = previousScroller?.clientHeight || EPISODE_VIEWPORT_FALLBACK;
    const focusedEpisodeIndex = focusedKey === null ? -1 : this.episodeIndexOf(focusedKey);
    if (restoreFocus && focusedEpisodeIndex >= 0) this.episodeFocusIndex = focusedEpisodeIndex;
    this.episodeFocusIndex = Math.max(0, Math.min(this.episodeFocusIndex, episodes.length - 1));
    if (restoreFocus && focusedEpisodeIndex >= 0 && episodes.length) {
      this.episodeVirtualizer.ensureVisible(this.episodeFocusIndex, episodeViewport);
    }
    const episodeRange = this.episodeVirtualizer.getRange(episodes.length, episodeViewport);

    const art = this.detailArt(`${a.id}|${series.seriesId}`, poster,
      this.titleBackdrop(a.id, series.seriesId, info?.backdrop, series.backdrop), this.detailLoading);

    // The backdrop sits outside the scroller, so the episodes scroll over it;
    // the poster card scrolls away with the header.
    morph(this.layer('detail'), html`
      ${this.detailBackdrop(art)}
      <div class="catalog-view series-detail" data-key="detail-scroller" data-nav-container>
        ${this.detailPoster(art)}
        <div class="series-detail-head">
          <div class="detail-body">
            <h1 class="detail-title">${view.title}</h1>
            ${this.titleLabel(view)}
            ${meta.length ? html`<div class="detail-meta">${meta.join('  ·  ')}</div>` : ''}
            ${programDescription('detail-plot', view)}
            ${info?.cast ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.cast')}</span> ${info.cast}</div>` : ''}
            ${info?.director ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.director')}</span> ${info.director}</div>` : ''}
            <div class="detail-actions" data-key="detail-actions" data-nav-container data-nav-straight data-nav-remember
                 data-nav-leave-left="" data-nav-leave-right="" data-nav-leave-down=".series-season-btn.active">
              ${resumed ? html`
                <button class="detail-btn detail-btn-primary" data-focusable data-key="resume" data-action="resume">
                  <span class="detail-btn-icon">${raw(PLAY_ICON)}</span><span>${
                    t(resumed.position > 0 ? 'common.resume' : 'catalog.play')}</span>
                  ${resumedCode ? html`<span class="detail-btn-code">${resumedCode}</span>` : ''}
                  ${this.resumeBar(resumed.position, resumed.duration)}
                </button>` : ''}
              ${this.detailIconRow('actions', [
                this.detailIconButton('watchlist', watchlistIcon(watchlisted),
                  t(watchlisted ? 'catalog.removeWatchlist' : 'catalog.addWatchlist'), watchlisted ? 'on' : ''),
                this.allEpisodes().length ? this.detailIconButton('watched', CHECK_ICON,
                  t(seriesWatched ? 'catalog.markNotWatched' : 'catalog.markWatched'), seriesWatched ? 'on' : '') : '',
                this.detailIconButton('hide', HIDE_ICON, t(hidden ? 'catalog.unhide' : 'catalog.hide'), hidden ? 'on' : ''),
                this.translateButton(source, this.seriesText()),
                resumed ? this.detailIconButton('remove-resume', REMOVE_ICON, t('catalog.removeContinueWatching'), 'danger') : '',
              ])}
            </div>
            ${this.detailLoading
              ? html`<p class="catalog-hint">${t('common.loading')}</p>`
              : !info
                ? html`<p class="catalog-hint">${t('catalog.loadEpisodesFailed')}</p>`
                : info.seasons.length === 0
                  ? html`<p class="catalog-hint">${t('catalog.noEpisodes')}</p>`
                  : html`
                  <div class="series-seasons" data-nav-container data-nav-straight data-nav-remember
                       data-nav-leave-left="" data-nav-leave-right=""
                       data-nav-leave-down=".series-episode-cell[data-episode-index='0'] .episode-row">
                    ${info.seasons.map((n) => html`
                      <button class="series-season-btn ${n === this.selectedSeason ? 'active' : ''}"
                              data-focusable data-key="season:${n}" data-season="${n}">${t('catalog.season', { number: n })}</button>
                    `)}
                    ${episodes.length ? this.detailIconRow('season', [this.detailIconButton('season-watched', CHECK_ICON,
                      t(seasonWatched ? 'catalog.markSeasonNotWatched' : 'catalog.markSeasonWatched'), seasonWatched ? 'on' : '')], false) : ''}
                  </div>
                `}
          </div>
        </div>
        ${info && info.seasons.length > 0 ? html`
          <div class="series-episodes" data-nav-container data-nav-remember data-nav-leave-up=".series-season-btn.active"
               data-nav-leave-left="" data-nav-leave-right="" data-nav-leave-down="">
            ${episodes.length === 0
              ? html`<p class="catalog-hint">${t('catalog.noSeasonEpisodes')}</p>`
              : html`
                <div class="series-episodes-spacer"
                     style="height:${this.episodeVirtualizer.getTotalSize(episodes.length)}px">
                  ${episodes.slice(episodeRange.start, episodeRange.end).map((ep, offset) => {
                    const index = episodeRange.start + offset;
                    return html`
                      <div class="series-episode-cell"
                           data-key="episode-cell:${ep.id}"
                           data-episode-index="${index}"
                           style="top:${this.episodeVirtualizer.getItemOffset(index)}px">
                        ${this.episodeRow(a.id, ep, source)}
                        ${this.episodeMark(ep)}
                      </div>
                    `;
                  })}
                </div>
              `}
          </div>
        ` : ''}
      </div>
    `);
    syncTabBarOverArt();
    const measuredSizes = Array.from(
      this.layer('detail').querySelectorAll<HTMLElement>('.series-episode-cell'),
    ).map(cell => ({
      cell,
      index: parseInt(cell.dataset.episodeIndex || '-1', 10),
    })).filter(item => item.index >= 0 && !this.measuredEpisodes.has(item.index))
      .map((item) => {
        this.measuredEpisodes.add(item.index);
        const row = item.cell.querySelector<HTMLElement>('.episode-row');
        return {
          index: item.index,
          size: row ? row.getBoundingClientRect().height + EPISODE_GAP : 0,
        };
      }).filter(item => item.index >= 0 && item.size > EPISODE_GAP);
    if (this.episodeVirtualizer.updateItemSizes(measuredSizes)) {
      this.renderDetail(restoreFocus);
      return;
    }
    const episodeList = this.layer('detail').querySelector<HTMLElement>('.series-episodes');
    const scroller = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    if (scroller) {
      this.episodeVirtualizer.setLeadingSize(this.episodeListStart(scroller, episodeList));
      this.scrollGuard.syncOffset(
        scroller,
        'vertical',
        this.episodeVirtualizer.scrollOffset,
        this.instantEpisodeScroll,
      );
    }
    this.refreshIconRows();
    if (restoreFocus) this.settleDetailFocus();
    this.syncTranslation();
  }

  private selectedEpisodes(): Episode[] {
    return this.currentInfo?.episodesBySeason[this.selectedSeason] ?? [];
  }

  private episodeIndexOf(key: string): number {
    const id = key.indexOf('ep:') === 0 ? key.slice(3) : key.indexOf('ep-mark:') === 0 ? key.slice(8) : null;
    return id === null ? -1 : this.selectedEpisodes().findIndex((ep) => ep.id === id);
  }

  private episodeOfKey(key: string | null): Episode | null {
    const index = key === null ? -1 : this.episodeIndexOf(key);
    return index < 0 ? null : this.selectedEpisodes()[index];
  }

  protected hasExtraKey(key: string): boolean {
    return this.episodeIndexOf(key) >= 0;
  }

  // An episode the list scrolled away renders again before it is shown.
  protected revealExtraKey(key: string, instant: boolean): boolean | null | undefined {
    const index = this.episodeIndexOf(key);
    if (index < 0 || this.layer('detail').querySelector(`[data-episode-index="${index}"]`)) {
      return undefined;
    }
    const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    const viewport = list?.clientHeight || EPISODE_VIEWPORT_FALLBACK;
    this.episodeFocusIndex = index;
    this.episodeVirtualizer.ensureVisible(index, viewport);
    if (instant) this.instantEpisodeScroll = true;
    try {
      this.renderDetail(false);
      // The render measured the rows the estimate had placed it by.
      if (this.episodeVirtualizer.ensureVisible(index, viewport)) this.renderDetail(false);
    } finally {
      this.instantEpisodeScroll = false;
    }
    return true;
  }

  protected moveExtraFocus(action: Action): boolean {
    if (this.mode !== 'detail') return false;
    const key = this.focusedKey();
    // A row is far wider than its mark, so geometry alone would pick the
    // detail actions above over the mark beside it.
    if (action === 'left' || action === 'right') {
      const onMark = key !== null && key.indexOf('ep-mark:') === 0;
      if (key === null || this.episodeIndexOf(key) < 0 || onMark !== (action === 'left')) return false;
      const cell = this.current()?.closest<HTMLElement>('.series-episode-cell');
      this.place(cell?.querySelector<HTMLElement>(onMark ? '.episode-row' : '.episode-mark') ?? null, 'key');
      return true;
    }
    if (action !== 'up' && action !== 'down') return false;
    // Down from the seasons enters at the first episode, which the list may
    // have scrolled away; mount it so the seasons' leave rule finds it.
    if (action === 'down' && this.current()?.closest('.series-seasons') && this.selectedEpisodes().length
        && !this.layer('detail').querySelector('[data-episode-index="0"]')) {
      const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
      this.episodeVirtualizer.ensureVisible(0, list?.clientHeight || EPISODE_VIEWPORT_FALLBACK);
      this.renderDetail(false);
      return false;
    }
    const current = key === null ? -1 : this.episodeIndexOf(key);
    if (current < 0) return false;
    const episodes = this.selectedEpisodes();
    const next = current + (action === 'up' ? -1 : 1);
    if (next < 0 || next >= episodes.length) return false;
    const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    this.episodeFocusIndex = next;
    this.episodeVirtualizer.ensureVisible(
      next,
      list?.clientHeight || EPISODE_VIEWPORT_FALLBACK,
    );
    this.renderDetail(false);
    // Up and Down keep to the column, the rows or their watched marks.
    const cell = this.layer('detail').querySelector<HTMLElement>(`[data-episode-index="${next}"]`);
    this.place(
      cell?.querySelector<HTMLElement>(key!.indexOf('ep-mark:') === 0 ? '.episode-mark' : '.episode-row') ?? null,
      'key',
    );
    return true;
  }

  protected handleExtraScroll(target: HTMLElement): boolean {
    if (this.mode !== 'detail' || !target.classList.contains('series-detail')) return false;
    const offset = this.scrollGuard.readUserOffset(target, 'vertical');
    if (offset === null) return true;
    this.episodeVirtualizer.setScrollOffset(offset);
    if (this.episodeScrollFrame === null) {
      this.episodeScrollFrame = requestAnimationFrame(() => {
        this.episodeScrollFrame = null;
        if (this.mode === 'detail') this.renderDetail(false);
      });
    }
    return true;
  }

  // Where the episode list starts inside the scrolling detail page, i.e. the
  // header the virtualizer has to skip before item 0. The page is positioned,
  // so it is the list's offsetParent and offsetTop is the in-content distance,
  // which stays correct while the page is scrolled.
  private episodeListStart(
    scroller: HTMLElement | null,
    list: HTMLElement | null,
  ): number {
    if (!scroller || !list) return 0;
    const top = list.offsetParent === scroller
      ? list.offsetTop
      : list.offsetTop - scroller.offsetTop;
    return Math.max(0, top);
  }
}

function episodeText(ep: Episode): ProgramText {
  return { title: ep.title, description: ep.plot };
}

function resumeSearchMeta(entry: ResumeEntry): SearchMeta | undefined {
  const ids: SearchMeta = {};
  if (entry.imdbId) ids.imdbId = entry.imdbId;
  if (entry.tmdbId) ids.tmdbId = entry.tmdbId;
  if (entry.season !== undefined && entry.episode !== undefined) {
    return { season: entry.season, episode: entry.episode, ...ids };
  }
  const label = EPISODE_LABEL.exec(entry.name);
  return label ? { season: Number(label[2]), episode: Number(label[3]), ...ids } : undefined;
}

function resumeEpisodeCode(entry: ResumeEntry): string {
  if (entry.season !== undefined && entry.episode !== undefined) return `S${entry.season} E${entry.episode}`;
  const label = EPISODE_LABEL.exec(entry.name);
  return label ? `S${label[2]} E${label[3]}` : '';
}
