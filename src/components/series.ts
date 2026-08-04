import type { Action, PlaylistEntry, SeriesCategory, SeriesItem, SeriesInfo, Episode, ResumeEntry, ResumeKind, VodQueueItem, WatchlistEntry } from '../types';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadSeriesCategories, loadSeries, loadSeriesInfo } from '../services/xtream-catalog';
import { xtreamEpisodeUrl, type XtreamCredentials } from '../utils/xtream-url';
import { CatalogView, type CatalogHandlers } from './catalog-view';
import { PLAY_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t } from '../i18n';
import { VirtualList } from '../utils/virtual-list';

const EPISODE_GAP = 16;
const EPISODE_NO_PLOT_ESTIMATE = 138;
const EPISODE_PLOT_ESTIMATE = 216;
const EPISODE_OVERSCAN = 5;
// The whole detail page scrolls, so the fallback is the page viewport, not the
// space left under the header.
const EPISODE_VIEWPORT_FALLBACK = 984;

// The Series section: browse (Continue rail of resumed episodes + per-category
// rails + an "all categories" drill-in) → per-category poster grid → a detail
// screen with a season selector over an episode list. The browse/grid/nav
// machinery lives in CatalogView.
export class Series extends CatalogView<SeriesCategory, SeriesItem> {
  protected get kicker(): string { return t('common.series'); }
  protected readonly resumeKind: ResumeKind = 'episode';
  protected get emptyMessage(): string { return t('catalog.noSeries'); }
  protected get gridEmptyMessage(): string { return t('catalog.noSeriesCategory'); }

  private currentSeries: SeriesItem | null = null;
  private currentInfo: SeriesInfo | null = null;
  private selectedSeason = 0;
  private detailLoading = false;
  private episodeFocusIndex = 0;
  private episodeSource: Episode[] | null = null;
  private measuredEpisodes = new Set<number>();
  private readonly episodeVirtualizer = new VirtualList({
    overscan: EPISODE_OVERSCAN,
    fallbackViewportSize: EPISODE_VIEWPORT_FALLBACK,
  });
  private episodeScrollFrame: number | null = null;

  constructor(container: HTMLElement, handlers: CatalogHandlers) {
    super(container, handlers);
  }

  protected loadCategories(account: PlaylistEntry): Promise<SeriesCategory[]> { return loadSeriesCategories(account); }
  protected loadItems(account: PlaylistEntry, categoryId: string): Promise<SeriesItem[]> { return loadSeries(account, categoryId); }
  protected itemId(s: SeriesItem): string { return s.seriesId; }
  protected itemName(s: SeriesItem): string { return s.name; }
  protected itemPoster(s: SeriesItem): string { return s.poster; }
  protected itemCategoryId(s: SeriesItem): string { return s.categoryId; }
  protected clearDetail(): void { this.currentSeries = null; }

  protected continueRail(): Safe | '' {
    return this.resume.length
      ? this.rail(t('catalog.continueWatching'), this.resume.map((r) => this.resumeTile(r)))
      : '';
  }

  protected watchlistRail(): Safe | '' {
    const entries = StorageService.getWatchlist(this.account!.id, 'series');
    return entries.length
      ? this.rail(t('common.watchlist'), entries.map((entry) => this.tile(this.watchlistEntryToSeries(entry))))
      : '';
  }

  protected fallbackItem(seriesId: string): SeriesItem | null {
    const entry = StorageService.getWatchlist(this.account!.id, 'series')
      .find((item) => item.itemId === seriesId);
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  protected heroFallback(): SeriesItem | null {
    const entry = StorageService.getWatchlist(this.account!.id, 'series')[0];
    return entry ? this.watchlistEntryToSeries(entry) : null;
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
    if (el.dataset.action === 'watchlist') { this.toggleWatchlist(); return true; }
    if (el.dataset.resumeEpisode !== undefined) { this.playResume(el.dataset.resumeEpisode); return true; }
    if (el.dataset.season !== undefined) { this.selectSeason(Number(el.dataset.season)); return true; }
    if (el.dataset.episodeId !== undefined) { this.playEpisode(el.dataset.episodeId); return true; }
    return false;
  }

  private toggleWatchlist(): void {
    const series = this.currentSeries;
    const account = this.account;
    if (!series || !account) return;
    const added = StorageService.toggleWatchlist({
      accountId: account.id,
      kind: 'series',
      itemId: series.seriesId,
      name: series.name,
      poster: series.poster,
      rating: series.rating,
      categoryId: series.categoryId,
      addedAt: Date.now(),
    });
    showToast(t(added ? 'catalog.watchlistAdded' : 'catalog.watchlistRemoved'));
    this.renderDetail();
  }

  protected async openDetail(series: SeriesItem): Promise<void> {
    if (!this.account) return;
    this.currentSeries = series;
    this.mode = 'detail';
    this.currentInfo = null;
    this.selectedSeason = 0;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.detailLoading = true;
    this.renderDetail();
    this.currentInfo = await loadSeriesInfo(this.account, series.seriesId);
    if (this.mode === 'detail' && this.currentSeries === series) {
      this.detailLoading = false;
      this.selectedSeason = this.currentInfo?.seasons[0] ?? 0;
      this.renderDetail();
    }
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
      subtitles: ep.subtitles,
      searchMeta: { season: ep.season, episode: ep.episode },
      watchlistOwner: { kind: 'series', itemId: series.seriesId },
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

  private playEpisode(episodeId: string): void {
    const ep = this.findEpisode(episodeId);
    const series = this.currentSeries;
    const a = this.account;
    if (!ep || !series || !a) return;
    const saved = StorageService.getResume(a.id, 'episode', ep.id);
    this.handlers.onPlayVod({
      ...this.episodePlayback(series, ep),
      resumeSecs: saved ? saved.position : 0,
      episodeQueue: this.episodesAfter(ep.id, series),
    });
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
    this.handlers.onPlayVod({
      url: xtreamEpisodeUrl(this.creds(), r.itemId, r.ext || 'mp4'),
      title: r.name,
      poster: r.poster,
      accountId: a.id,
      itemId: r.itemId,
      kind: 'episode',
      resumeSecs: r.position,
      subtitles: [],
      episodeQueue: r.episodeQueue,
      watchlistOwner: r.watchlistOwner,
    });
  }

  private resumeTile(r: ResumeEntry): Safe {
    return html`
      <div class="catalog-tile" data-focusable data-key="r:${r.itemId}" data-resume-episode="${r.itemId}">
        <div class="catalog-poster-wrap">${this.posterCell(r.name, r.poster)}</div>
        <div class="catalog-tile-name">${r.name}</div>
      </div>
    `;
  }

  private episodeRow(accountId: string, ep: Episode): Safe {
    const saved = StorageService.getResume(accountId, 'episode', ep.id);
    const mins = ep.durationSecs > 0 ? t('catalog.minutes', { count: Math.floor(ep.durationSecs / 60) }) : '';
    return html`
      <div class="episode-row" data-focusable data-key="ep:${ep.id}" data-episode-id="${ep.id}">
        <span class="episode-badge">${raw(PLAY_ICON)}</span>
        <div class="episode-body">
          <div class="episode-title">
            <span class="episode-num">E${ep.episode}</span>
            <span class="episode-name">${ep.title}</span>
            ${saved ? html`<span class="episode-resume">${t('common.resume')}</span>` : ''}
          </div>
          ${mins ? html`<div class="episode-meta">${mins}</div>` : ''}
          ${ep.plot ? html`<p class="episode-plot">${ep.plot}</p>` : ''}
        </div>
      </div>
    `;
  }

  protected renderDetail(restoreFocus = true): void {
    const series = this.currentSeries;
    const a = this.account;
    if (!series || !a) return;
    const info = this.currentInfo;
    const episodes = info ? (info.episodesBySeason[this.selectedSeason] ?? []) : [];
    if (episodes !== this.episodeSource) {
      this.episodeSource = episodes;
      this.measuredEpisodes.clear();
      this.episodeVirtualizer.setItemSizes(episodes.map(ep =>
        ep.plot ? EPISODE_PLOT_ESTIMATE : EPISODE_NO_PLOT_ESTIMATE));
    }
    const prevKey = this.nav.focused?.getAttribute('data-key') ?? null;
    const watchlisted = StorageService.isWatchlisted(a.id, 'series', series.seriesId);
    const previousScroller = this.container.querySelector<HTMLElement>('.series-detail');
    const previousEpisodes = this.container.querySelector<HTMLElement>('.series-episodes');
    this.episodeVirtualizer.setLeadingSize(
      this.episodeListStart(previousScroller, previousEpisodes),
    );
    if (restoreFocus && previousScroller) {
      this.episodeVirtualizer.setScrollOffset(previousScroller.scrollTop);
    }
    const episodeViewport = previousScroller?.clientHeight || EPISODE_VIEWPORT_FALLBACK;
    const focusedEpisodeIndex = this.nav.focused
      ?.closest<HTMLElement>('[data-episode-index]')
      ?.dataset.episodeIndex;
    if (restoreFocus && focusedEpisodeIndex !== undefined) {
      this.episodeFocusIndex = parseInt(focusedEpisodeIndex, 10);
    }
    this.episodeFocusIndex = Math.max(0, Math.min(this.episodeFocusIndex, episodes.length - 1));
    if (restoreFocus && prevKey?.indexOf('ep:') === 0 && episodes.length) {
      this.episodeVirtualizer.ensureVisible(this.episodeFocusIndex, episodeViewport);
    }
    const episodeRange = this.episodeVirtualizer.getRange(episodes.length, episodeViewport);

    morph(this.container, html`
      <div class="catalog-view series-detail" data-nav-container>
        <div class="series-detail-head">
          <div class="detail-poster-wrap series-detail-poster">${this.posterCell(series.name, series.poster)}</div>
          <div class="detail-body">
            <h1 class="detail-title">${series.name}</h1>
            ${series.rating ? html`<div class="detail-meta">${series.rating}</div>` : ''}
            <div class="detail-actions">
              <button class="detail-btn" data-focusable data-key="watchlist" data-action="watchlist">
                <span class="detail-btn-icon">${raw(watchlistIcon(watchlisted))}</span>
                ${t(watchlisted ? 'catalog.removeWatchlist' : 'catalog.addWatchlist')}
              </button>
            </div>
            ${this.detailLoading
              ? html`<p class="catalog-hint">${t('common.loading')}</p>`
              : !info
                ? html`<p class="catalog-hint">${t('catalog.loadEpisodesFailed')}</p>`
                : info.seasons.length === 0
                  ? html`<p class="catalog-hint">${t('catalog.noEpisodes')}</p>`
                  : html`
                  <div class="series-seasons">
                    ${info.seasons.map((n) => html`
                      <button class="series-season-btn ${n === this.selectedSeason ? 'active' : ''}"
                              data-focusable data-key="season:${n}" data-season="${n}">${t('catalog.season', { number: n })}</button>
                    `)}
                  </div>
                `}
          </div>
        </div>
        ${info && info.seasons.length > 0 ? html`
          <div class="series-episodes">
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
                        ${this.episodeRow(a.id, ep)}
                      </div>
                    `;
                  })}
                </div>
              `}
          </div>
        ` : ''}
      </div>
    `);
    const measuredSizes = Array.from(
      this.container.querySelectorAll<HTMLElement>('.series-episode-cell'),
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
    const episodeList = this.container.querySelector<HTMLElement>('.series-episodes');
    const scroller = this.container.querySelector<HTMLElement>('.series-detail');
    if (scroller) {
      this.episodeVirtualizer.setLeadingSize(this.episodeListStart(scroller, episodeList));
      this.scrollGuard.syncOffset(
        scroller,
        'vertical',
        this.episodeVirtualizer.scrollOffset,
      );
    }
    if (!restoreFocus) {
      this.nav.clearDetachedFocus();
      return;
    }
    const restore = (prevKey && this.container.querySelector<HTMLElement>(`[data-focusable][data-key="${prevKey}"]`))
      || this.container.querySelector<HTMLElement>('[data-focusable]');
    this.nav.focus(restore);
  }

  protected moveExtraFocus(action: Action): boolean {
    if (this.mode !== 'detail' || (action !== 'up' && action !== 'down')) return false;
    const focused = this.nav.focused;
    const rawIndex = focused?.closest<HTMLElement>('[data-episode-index]')?.dataset.episodeIndex;
    if (rawIndex === undefined) return false;
    const episodes = this.currentInfo?.episodesBySeason[this.selectedSeason] ?? [];
    const current = parseInt(rawIndex, 10);
    const next = current + (action === 'up' ? -1 : 1);
    if (next < 0 || next >= episodes.length) return false;
    const list = this.container.querySelector<HTMLElement>('.series-detail');
    this.episodeFocusIndex = next;
    this.episodeVirtualizer.ensureVisible(
      next,
      list?.clientHeight || EPISODE_VIEWPORT_FALLBACK,
    );
    this.renderDetail(false);
    this.nav.focus(
      this.container.querySelector<HTMLElement>(
        `[data-episode-index="${next}"] [data-focusable]`,
      ),
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
  // header the virtualizer has to skip before item 0. Both share an
  // offsetParent (the page is statically positioned), so the difference is the
  // in-content distance and stays correct while the page is scrolled.
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
