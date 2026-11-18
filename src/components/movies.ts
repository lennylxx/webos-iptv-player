import type { PlaylistEntry, VodCategory, VodItem, VodInfo, ResumeKind, WatchlistEntry, VodQueueItem } from '../types';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadVodCategories, loadVodStreams, loadVodInfo } from '../services/xtream-catalog';
import { xtreamVodUrl } from '../utils/xtream-url';
import { CatalogView, type CollectionKind, type CollectionEntry } from './catalog-view';
import { CHECK_ICON, HIDE_ICON, PLAY_ICON, REMOVE_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t, tp } from '../i18n';

// The Movies section: browse (Continue rail + per-category rails + an "all
// categories" drill-in) → per-category poster grid → a detail screen with
// Play / Resume. The browse/grid/nav machinery lives in CatalogView.
export class Movies extends CatalogView<VodCategory, VodItem> {
  protected get kicker(): string { return t('common.movies'); }
  protected readonly resumeKind: ResumeKind = 'vod';
  protected readonly parentalKind = 'vod' as const;
  protected scopeName(): string { return 'movies'; }
  protected get emptyMessage(): string { return t('catalog.noMovies'); }
  protected get gridEmptyMessage(): string { return t('catalog.noMoviesCategory'); }
  protected itemCount(count: number): string { return tp('catalog.movieCount', count); }

  private currentVod: VodItem | null = null;
  private currentInfo: VodInfo | null = null;
  private openedFromWatchlist = false;
  private detailController: AbortController | null = null;

  protected loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<VodCategory[]> {
    return loadVodCategories(account, signal);
  }
  protected loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<VodItem[]> {
    return loadVodStreams(account, categoryId, signal);
  }
  protected itemId(v: VodItem): string { return v.streamId; }
  protected itemName(v: VodItem): string { return v.name; }
  protected itemPoster(v: VodItem): string { return v.poster; }
  protected itemCategoryId(v: VodItem): string { return v.categoryId; }
  protected itemGenre(v: VodItem): string { return v.genre ?? ''; }
  protected clearDetail(): void {
    this.detailController?.abort();
    this.detailController = null;
    this.currentVod = null;
    this.openedFromWatchlist = false;
  }
  protected onRequestSessionReset(): void {
    this.detailController?.abort();
    this.detailController = null;
  }

  // Continue and Watchlist tiles may not be in a preloaded category, so
  // synthesize the minimal item needed to open their detail screen.
  protected fallbackItem(streamId: string): VodItem | null {
    return this.resumeToVod(streamId) ?? this.watchlistToVod(streamId);
  }
  protected heroFallback(): VodItem | null {
    return this.resumeToVod(this.resume[0]?.itemId ?? '')
      ?? this.watchlistToVod(this.visibleWatchlist('vod')[0]?.itemId ?? '');
  }

  private resumeToVod(streamId: string): VodItem | null {
    const r = this.resume.find((e) => e.itemId === streamId);
    if (!r) return null;
    return { accountId: r.accountId, streamId: r.itemId, name: r.name, poster: r.poster, rating: '', categoryId: r.categoryId ?? '', containerExtension: r.ext };
  }

  protected collectionEntries(kind: CollectionKind): CollectionEntry[] {
    if (kind === 'continue') {
      return this.resume.map(entry => {
        const vod = this.resumeToVod(entry.itemId)!;
        const key = `i:${vod.categoryId}:${vod.streamId}`;
        return {
          id: entry.itemId, key,
          tile: managing => this.tile(vod, html`
            ${this.progressBar(entry.position, entry.duration)}${this.removeMark(managing, key)}
          `, managing),
        };
      });
    }
    return this.visibleWatchlist('vod').map(entry => ({
      id: entry.itemId, key: `w:${entry.itemId}`,
      tile: managing => this.watchlistTile(entry, managing),
    }));
  }

  private watchlistTile(entry: WatchlistEntry, managing = false): Safe {
    const vod = this.watchlistEntryToVod(entry);
    return html`
      <div class="catalog-tile" ${raw(managing ? '' : 'data-focusable')} data-key="w:${vod.streamId}"
           data-item-id="${vod.streamId}" data-category-id="${vod.categoryId}"
           data-watchlist-item="${vod.streamId}">
        <div class="catalog-poster-wrap">${this.posterCell(vod.name, vod.poster)}${
          this.itemLockBadge(vod.categoryId, vod.streamId)}${this.watchedBadge(vod.streamId)}${
          this.removeMark(managing, `w:${vod.streamId}`)}</div>
        <div class="catalog-tile-name">${vod.name}</div>
      </div>
    `;
  }

  private watchlistToVod(streamId: string): VodItem | null {
    const entry = this.visibleWatchlist('vod')
      .find((item) => item.itemId === streamId);
    return entry ? this.watchlistEntryToVod(entry) : null;
  }

  private watchlistEntryToVod(entry: WatchlistEntry): VodItem {
    return {
      accountId: entry.accountId,
      streamId: entry.itemId,
      name: entry.name,
      poster: entry.poster,
      rating: entry.rating,
      categoryId: entry.categoryId,
      containerExtension: entry.containerExtension ?? 'mp4',
    };
  }

  protected selectExtra(el: HTMLElement): boolean {
    if (el.dataset.action === 'remove-resume' && this.account && this.currentVod) {
      StorageService.clearResume(this.account.id, 'vod', this.currentVod.streamId);
      showToast(t('catalog.continueWatchingRemoved'));
      this.renderDetail();
      return true;
    }
    if (el.dataset.watchlistItem !== undefined) {
      const vod = this.watchlistToVod(el.dataset.watchlistItem);
      if (vod) void this.openDetail(vod, true);
      return true;
    }
    if (el.dataset.action === 'play' || el.dataset.action === 'resume') {
      this.play(el.dataset.action === 'resume');
      return true;
    }
    if (el.dataset.action === 'watchlist') {
      this.toggleWatchlist();
      return true;
    }
    if ((el.dataset.action === 'watched' || el.dataset.action === 'hide') && this.currentVod) {
      const flag = el.dataset.action === 'watched' ? 'watched' : 'hidden';
      const on = this.toggleMark(flag, this.currentVod);
      // A title marked watched leaves Continue Watching, as one played to the end does.
      if (flag === 'watched' && on && this.account) {
        StorageService.clearResume(this.account.id, 'vod', this.currentVod.streamId);
        this.refreshResume();
      }
      showToast(t(flag === 'watched'
        ? on ? 'catalog.markedWatched' : 'catalog.markedNotWatched'
        : on ? 'catalog.titleHidden' : 'catalog.titleUnhidden'));
      this.renderDetail();
      return true;
    }
    return false;
  }

  private toggleWatchlist(): void {
    const vod = this.currentVod;
    const account = this.account;
    if (!vod || !account) return;
    const result = StorageService.toggleWatchlist({
      accountId: account.id,
      kind: 'vod',
      itemId: vod.streamId,
      name: vod.name,
      poster: this.currentInfo?.poster || vod.poster,
      rating: vod.rating,
      categoryId: vod.categoryId,
      containerExtension: vod.containerExtension,
      addedAt: Date.now(),
    });
    showToast(t(result === 'full' ? 'catalog.watchlistFull'
      : result === 'added' ? 'catalog.watchlistAdded' : 'catalog.watchlistRemoved'));
    this.renderDetail();
  }

  protected async openDetail(vod: VodItem, fromWatchlist = false): Promise<void> {
    const account = this.account;
    if (!account || !this.requestSignal) return;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const signal = this.detailController.signal;
    this.openedFromWatchlist = fromWatchlist;
    this.currentVod = vod;
    this.enterDetail();
    this.currentInfo = null;
    this.renderDetail();
    try {
      this.currentInfo = await loadVodInfo(account, vod.streamId, signal);
    } catch (err) {
      if (!this.requestFailed('Movie detail load', err, signal)) return;
      this.currentInfo = null;
    }
    if (this.mode === 'detail' && this.currentVod === vod) this.renderDetail();
  }

  private play(resume: boolean): void {
    const vod = this.currentVod;
    const a = this.account;
    if (!vod || !a) return;
    const saved = StorageService.getResume(a.id, 'vod', vod.streamId);
    this.handlers.onPlayVod({
      url: this.vodUrl(vod),
      title: vod.name,
      poster: this.currentInfo?.poster || vod.poster,
      accountId: a.id,
      itemId: vod.streamId,
      kind: 'vod',
      categoryId: vod.categoryId,
      resumeSecs: resume && saved ? saved.position : 0,
      subtitles: this.currentInfo?.subtitles ?? [],
      watchlistQueue: this.openedFromWatchlist ? this.movieWatchlistQueue(vod.streamId) : undefined,
      searchMeta: {
        imdbId: this.currentInfo?.imdbId || undefined,
        tmdbId: this.currentInfo?.tmdbId || undefined,
        year: this.currentInfo?.year || undefined,
      },
    });
  }

  private movieWatchlistQueue(streamId: string): VodQueueItem[] {
    const entries = this.visibleWatchlist('vod');
    const index = entries.findIndex((entry) => entry.itemId === streamId);
    if (index < 0) return [];
    return entries.slice(index + 1).map((entry) => {
      const vod = this.watchlistEntryToVod(entry);
      return {
        url: this.vodUrl(vod),
        title: vod.name,
        poster: vod.poster,
        accountId: vod.accountId,
        itemId: vod.streamId,
        kind: 'vod',
        categoryId: vod.categoryId,
        subtitles: [],
      };
    });
  }

  private vodUrl(vod: VodItem): string {
    const a = this.account!;
    return xtreamVodUrl(
      { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password },
      vod.streamId,
      vod.containerExtension || 'mp4',
    );
  }

  protected renderDetail(): void {
    const vod = this.currentVod;
    const a = this.account;
    if (!vod || !a) return;
    const info = this.currentInfo;
    const saved = StorageService.getResume(a.id, 'vod', vod.streamId);
    const poster = info?.poster || vod.poster;
    const year = info ? (info.releaseDate.match(/\d{4}/) || [''])[0] : '';
    const mins = info && info.durationSecs > 0
      ? t('catalog.minutes', { count: Math.floor(info.durationSecs / 60) })
      : '';
    const meta = [year, mins, info?.genre, vod.rating].filter((s) => !!s);
    const watchlisted = StorageService.isWatchlisted(a.id, 'vod', vod.streamId);
    const watched = this.watchedIds.has(vod.streamId);
    const hidden = this.hiddenIds.has(vod.streamId);

    morph(this.layer('detail'), html`
      <div class="catalog-view movies-detail" data-nav-container>
        <div class="detail-poster-wrap">${this.posterCell(vod.name, poster)}</div>
        <div class="detail-body">
          <h1 class="detail-title">${vod.name}</h1>
          <div class="detail-meta">${meta.join('  ·  ')}</div>
          ${info?.plot ? html`<p class="detail-plot">${info.plot}</p>` : ''}
          ${info?.cast ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.cast')}</span> ${info.cast}</div>` : ''}
          ${info?.director ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.director')}</span> ${info.director}</div>` : ''}
          <div class="detail-actions" data-nav-container data-nav-straight data-nav-remember
               data-nav-leave-left="" data-nav-leave-right="" data-nav-leave-down="">
            ${saved ? html`
              <button class="detail-btn detail-btn-primary" data-focusable data-key="resume" data-action="resume">
                <span class="detail-btn-icon">${raw(PLAY_ICON)}</span><span>${t('common.resume')}</span>
                ${this.resumeBar(saved.position, saved.duration)}
              </button>` : ''}
            <button class="detail-btn ${saved ? '' : 'detail-btn-primary'}" data-focusable data-key="play" data-action="play">
              <span class="detail-btn-icon">${raw(PLAY_ICON)}</span><span>${t(saved ? 'catalog.playFromStart' : 'catalog.play')}</span>
            </button>
            ${this.detailIconRow('actions', [
              this.detailIconButton('watchlist', watchlistIcon(watchlisted),
                t(watchlisted ? 'catalog.removeWatchlist' : 'catalog.addWatchlist'), watchlisted ? 'on' : ''),
              this.detailIconButton('watched', CHECK_ICON,
                t(watched ? 'catalog.markNotWatched' : 'catalog.markWatched'), watched ? 'on' : ''),
              this.detailIconButton('hide', HIDE_ICON, t(hidden ? 'catalog.unhide' : 'catalog.hide'), hidden ? 'on' : ''),
              saved ? this.detailIconButton('remove-resume', REMOVE_ICON, t('catalog.removeContinueWatching'), 'danger') : '',
            ])}
          </div>
        </div>
      </div>
    `);
    this.refreshIconRows();
    this.settleDetailFocus();
  }
}
