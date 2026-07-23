import type { PlaylistEntry, SeriesCategory, SeriesItem, SeriesInfo, Episode, ResumeEntry, ResumeKind, VodQueueItem, WatchlistEntry } from '../types';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadSeriesCategories, loadSeries, loadSeriesInfo } from '../services/xtream-catalog';
import { xtreamEpisodeUrl, type XtreamCredentials } from '../utils/xtream-url';
import { CatalogView } from './catalog-view';
import { PLAY_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t } from '../i18n';

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

  protected renderDetail(): void {
    const series = this.currentSeries;
    const a = this.account;
    if (!series || !a) return;
    const info = this.currentInfo;
    const episodes = info ? (info.episodesBySeason[this.selectedSeason] ?? []) : [];
    const prevKey = this.nav.focused?.getAttribute('data-key') ?? null;
    const watchlisted = StorageService.isWatchlisted(a.id, 'series', series.seriesId);

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
              : episodes.map((ep) => this.episodeRow(a.id, ep))}
          </div>
        ` : ''}
      </div>
    `);
    const restore = (prevKey && this.container.querySelector<HTMLElement>(`[data-focusable][data-key="${prevKey}"]`))
      || this.container.querySelector<HTMLElement>('[data-focusable]');
    this.nav.focus(restore);
  }
}
