import type { Action, CatchupInfo, Channel, PlaylistEntry, Programme, VodItem, SeriesItem } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { ReminderService } from '../services/reminder-service';
import { StorageService } from '../services/storage-service';
import { XtreamArchiveService } from '../services/xtream-archive';
import { loadAllVodStreams, loadAllSeries } from '../services/xtream-catalog';
import {
  prepareSearchItems,
  prepareNameSearchItems,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  type PreparedNameSearchIndex,
  type PreparedSearchItem,
} from '../utils/channel-search';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { formatDayLabel, formatTime } from '../utils/time';
import { showToast } from './toast';
import { CatchupResumePrompt } from './catchup-resume-prompt';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard, type VirtualScrollAxis } from '../utils/virtual-scroll';

const log = createLogger('Search');
const SEARCH_LIST_VIEWPORT = 420;
const SEARCH_RAIL_VIEWPORT = 1760;
const SEARCH_ROW_OVERSCAN = 6;
const SEARCH_RAIL_OVERSCAN = 4;

export interface SearchHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayChannel: (index: number, catchup?: CatchupInfo) => void;
  onOpenMovie: (account: PlaylistEntry, vod: VodItem) => void;
  onOpenSeries: (account: PlaylistEntry, series: SeriesItem) => void;
}

interface ProgramResult {
  channel: Channel;
  channelIndex: number;
  programme: Programme;
}

// The Search section: one query box over Channels / Programs / Movies / Series.
// Results are relevance-ranked and capped; movies and series match the account's
// full catalogs, loaded once on open and cached.
// Up from the box reveals the tab bar; Back returns to Live. The global key
// handler ignores INPUT keydowns, so the box owns its own text input + focus-out
// keys.
export class Search {
  private nav: SpatialNav;
  private account: PlaylistEntry | null = null;
  private query = '';
  private allVod: VodItem[] = [];
  private allSeries: SeriesItem[] = [];
  private programIndex: PreparedSearchItem<ProgramResult>[] = [];
  private vodIndex: PreparedNameSearchIndex<VodItem> = { items: [], values: [] };
  private seriesIndex: PreparedNameSearchIndex<SeriesItem> = { items: [], values: [] };
  private indexedChannels: Channel[] | null = null;
  private indexedProgrammes: Record<string, Programme[]> | null = null;
  private loadedFor: string | null = null;
  private visibleChannels: Channel[] = [];
  private visiblePrograms: ProgramResult[] = [];
  private visibleMovies: VodItem[] = [];
  private visibleSeries: SeriesItem[] = [];
  private resumePrompt = new CatchupResumePrompt();
  private readonly channelListVirtualizer = this.createVirtualizer(88, SEARCH_ROW_OVERSCAN, SEARCH_LIST_VIEWPORT);
  private readonly programVirtualizer = this.createVirtualizer(109, SEARCH_ROW_OVERSCAN, SEARCH_LIST_VIEWPORT);
  private readonly channelRailVirtualizer = this.createVirtualizer(240, SEARCH_RAIL_OVERSCAN, SEARCH_RAIL_VIEWPORT);
  private readonly movieVirtualizer = this.createVirtualizer(240, SEARCH_RAIL_OVERSCAN, SEARCH_RAIL_VIEWPORT);
  private readonly seriesVirtualizer = this.createVirtualizer(240, SEARCH_RAIL_OVERSCAN, SEARCH_RAIL_VIEWPORT);
  private scrollFrame: number | null = null;
  private queryFrame: number | null = null;
  private queryGeneration = 0;
  private resultLimit: number = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
  private hasMoreResults = false;
  private readonly scrollGuard = new VirtualScrollGuard();

  constructor(private container: HTMLElement, private handlers: SearchHandlers) {
    this.nav = new SpatialNav(container);
    this.container.addEventListener('mouseleave', () => this.nav.clearHighlight());
    // Activate the result under the pointer by coordinate hit-test, so it lands
    // here regardless of D-pad focus; the container is marked `data-self-activate`
    // so the global click handler skips this subtree and doesn't double-fire.
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY));
    this.container.addEventListener('scroll', (e: Event) => this.onVirtualScroll(e), true);
  }

  private onPointerRelease(x: number, y: number): void {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    if (!el || !this.container.contains(el)) return;
    this.nav.focus(el);
    this.onSelect();
  }

  async open(account: PlaylistEntry | null): Promise<void> {
    this.cancelScheduledQuery();
    this.account = account;
    this.query = '';
    this.resultLimit = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
    this.buildProgramIndex(false);
    this.render();
    if (account) await this.loadCatalog(account);
  }

  /** The tab bar's search box drives the query; re-render the results for it. */
  setQuery(query: string): void {
    this.cancelScheduledQuery();
    this.query = query;
    this.resultLimit = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
    this.render();
  }

  scheduleQuery(query: string): void {
    this.query = query;
    this.resultLimit = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
    const generation = ++this.queryGeneration;
    if (this.queryFrame !== null) cancelAnimationFrame(this.queryFrame);
    if (!query.trim()) {
      this.queryFrame = null;
      this.render();
      return;
    }
    this.queryFrame = requestAnimationFrame(() => {
      this.queryFrame = null;
      if (generation !== this.queryGeneration) return;
      this.render();
    });
  }

  refreshPrograms(): void {
    this.buildProgramIndex(true);
    if (this.query.trim()) this.render();
  }

  dismissPrompt(): void {
    this.resumePrompt.hide();
  }

  handleAction(action: Action): void {
    if (this.resumePrompt.visible) {
      this.resumePrompt.handleAction(action);
      return;
    }
    if (this.moveVirtualFocus(action)) return;
    switch (action) {
      case 'up':
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        return;
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.handlers.onBack();
        return;
      default:
        return;
    }
  }

  // Load the whole catalogs once per account (cached in IndexedDB), guarding
  // against account-switch races so a stale in-flight load can't clobber the
  // current account's catalog. Non-blocking: open() already rendered the box.
  private async loadCatalog(account: PlaylistEntry): Promise<void> {
    if (this.loadedFor === account.id) return;
    try {
      const [vod, series] = await Promise.all([loadAllVodStreams(account), loadAllSeries(account)]);
      // A newer open() (account switch) superseded this load — discard the stale
      // result instead of clobbering the current account's catalog.
      if (this.account?.id !== account.id) return;
      this.allVod = vod;
      this.allSeries = series;
      this.vodIndex = prepareNameSearchItems(vod);
      this.seriesIndex = prepareNameSearchItems(series);
      this.loadedFor = account.id;
      log.debug('catalog loaded', vod.length, 'movies,', series.length, 'series');
      if (this.query.trim()) this.render();
    } catch (err) {
      log.error('catalog load failed:', err);
    }
  }

  private onSelect(): void {
    const el = this.nav.focused;
    if (!el) return;
    if (el.classList.contains('search-input')) {
      const input = el as HTMLInputElement;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (el.dataset.channelIndex !== undefined) {
      this.handlers.onPlayChannel(parseInt(el.dataset.channelIndex, 10));
    } else if (el.dataset.programIndex !== undefined) {
      void this.activateProgram(parseInt(el.dataset.programIndex, 10));
    } else if (this.account && el.dataset.streamId !== undefined) {
      const v = this.allVod.find((x) => x.streamId === el.dataset.streamId);
      if (v) this.handlers.onOpenMovie(this.account, v);
    } else if (this.account && el.dataset.seriesId !== undefined) {
      const s = this.allSeries.find((x) => x.seriesId === el.dataset.seriesId);
      if (s) this.handlers.onOpenSeries(this.account, s);
    }
  }

  /** Move focus into the first result (called when the tab bar's search box
   *  hands off with Enter / Down). */
  focusFirstResult(): void {
    if (this.queryFrame !== null) {
      this.cancelScheduledQuery();
      this.render();
    }
    const first = this.container.querySelector<HTMLElement>('.search-results [data-focusable]');
    if (first) this.nav.focus(first);
  }

  private posterCell(name: string, poster: string): ReturnType<typeof html> {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  private virtualRail<T>(
    title: string,
    key: string,
    items: T[],
    virtualizer: VirtualList,
    renderItem: (item: T) => ReturnType<typeof html>,
  ): ReturnType<typeof html> {
    const viewport = this.container.querySelector<HTMLElement>(
      `[data-search-virtual="${key}"]`,
    )?.clientWidth || SEARCH_RAIL_VIEWPORT;
    const range = virtualizer.getRange(items.length, viewport);
    return html`
      <div class="catalog-rail">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track search-virtual-rail"
             data-search-virtual="${key}" data-search-axis="horizontal">
          <div class="search-virtual-rail-spacer"
               style="width:${virtualizer.getTotalSize(items.length)}px">
            ${items.slice(range.start, range.end).map((item, offset) => {
              const index = range.start + offset;
              return html`
                <div class="search-virtual-rail-cell"
                     data-key="${key}:${index}"
                     data-search-section="${key}" data-search-index="${index}"
                     style="left:${virtualizer.getItemOffset(index)}px">
                  ${renderItem(item)}
                </div>
              `;
            })}
          </div>
        </div>
      </div>
    `;
  }

  private virtualList<T>(
    title: string,
    key: string,
    items: T[],
    virtualizer: VirtualList,
    renderItem: (item: T, index: number) => ReturnType<typeof html>,
  ): ReturnType<typeof html> {
    const viewport = this.container.querySelector<HTMLElement>(
      `[data-search-virtual="${key}"]`,
    )?.clientHeight || SEARCH_LIST_VIEWPORT;
    const range = virtualizer.getRange(items.length, viewport);
    return html`
      <div class="search-virtual-section ${
        key === 'channels-list' ? 'search-channels' : key === 'programmes' ? 'search-programs' : ''
      }">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="search-virtual-scroll"
             data-search-virtual="${key}" data-search-axis="vertical">
          <div class="search-virtual-list-spacer"
               style="height:${virtualizer.getTotalSize(items.length)}px">
            ${items.slice(range.start, range.end).map((item, offset) => {
              const index = range.start + offset;
              return html`
                <div class="search-virtual-list-cell"
                     data-key="${key}:${index}"
                     data-search-section="${key}" data-search-index="${index}"
                     style="top:${virtualizer.getItemOffset(index)}px">
                  ${renderItem(item, index)}
                </div>
              `;
            })}
          </div>
        </div>
      </div>
    `;
  }

  private channelTile(ch: Channel): ReturnType<typeof html> {
    const idx = PlaylistService.indexOf(ch);
    return html`
      <div class="catalog-tile search-channel-tile" data-focusable data-key="ch:${String(idx)}"
           data-channel-index="${String(idx)}">
        <div class="catalog-poster-wrap">${this.posterCell(ch.name, ch.logo)}</div>
        <div class="catalog-tile-name">${ch.name}</div>
      </div>
    `;
  }

  // A vertical-list row (logo + name) used for the M3U-only channel results.
  private channelRow(ch: Channel): ReturnType<typeof html> {
    const idx = PlaylistService.indexOf(ch);
    return html`
      <div class="search-channel-row" data-focusable data-key="ch:${String(idx)}"
           data-channel-index="${String(idx)}">
        ${ch.logo
          ? html`<img class="search-row-logo" src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : html`<div class="search-row-logo search-row-logo-empty">${ch.name.charAt(0)}</div>`}
        <span class="search-row-name">${ch.name}</span>
      </div>
    `;
  }

  private movieTile(v: VodItem): ReturnType<typeof html> {
    return html`
      <div class="catalog-tile" data-focusable data-key="v:${v.streamId}" data-stream-id="${v.streamId}">
        <div class="catalog-poster-wrap">${this.posterCell(v.name, v.poster)}</div>
        <div class="catalog-tile-name">${v.name}</div>
      </div>
    `;
  }

  private seriesTile(s: SeriesItem): ReturnType<typeof html> {
    return html`
      <div class="catalog-tile" data-focusable data-key="s:${s.seriesId}" data-series-id="${s.seriesId}">
        <div class="catalog-poster-wrap">${this.posterCell(s.name, s.poster)}</div>
        <div class="catalog-tile-name">${s.name}</div>
      </div>
    `;
  }

  private buildProgramIndex(force: boolean): void {
    if (!force
        && this.indexedChannels === PlaylistService.channels
        && this.indexedProgrammes === EpgService.programmes) return;
    const programs: ProgramResult[] = [];
    for (let channelIndex = 0; channelIndex < PlaylistService.channels.length; channelIndex++) {
      const channel = PlaylistService.channels[channelIndex];
      const epgId = EpgService.findChannelId(channel);
      if (!epgId) continue;
      for (const programme of EpgService.programmes[epgId] ?? []) {
        programs.push({ channel, channelIndex, programme });
      }
    }
    this.programIndex = prepareSearchItems(programs, result => [
      result.programme.title,
      result.programme.category,
      result.programme.description,
      result.channel.name,
      result.channel.group,
    ]);
    this.indexedChannels = PlaylistService.channels;
    this.indexedProgrammes = EpgService.programmes;
  }

  private programRow(result: ProgramResult, index: number): ReturnType<typeof html> {
    const { channel, programme } = result;
    const now = Date.now();
    const state = programme.stop.getTime() <= now ? 'past' : programme.start.getTime() > now ? 'future' : 'live';
    const day = formatDayLabel(programme.start);
    const action = state === 'live'
      ? t('search.liveNow')
      : state === 'future'
        ? (ReminderService.has(channelKey(channel), programme.start.getTime()) ? t('search.reminderSet') : t('search.setReminder'))
        : XtreamArchiveService.isAvailable(channel, programme.start.getTime()) ? t('search.catchUp') : t('search.openChannel');
    return html`
      <div class="search-program-row state-${state}" data-focusable
           data-key="p:${String(result.channelIndex)}:${String(programme.start.getTime())}"
           data-program-index="${String(index)}">
        <div class="search-program-time">${day.weekday} ${day.date}<br>${formatTime(programme.start)}</div>
        <div class="search-program-body">
          <div class="search-program-title">${programme.title}</div>
          <div class="search-program-channel">${channel.name}${programme.category ? html` · ${programme.category}` : ''}</div>
        </div>
        <div class="search-program-action">${action}</div>
      </div>
    `;
  }

  private async activateProgram(index: number): Promise<void> {
    const result = this.visiblePrograms[index];
    if (!result) return;
    const { channel, programme } = result;
    const now = Date.now();
    if (programme.start.getTime() > now) {
      const key = channelKey(channel);
      const startMs = programme.start.getTime();
      if (ReminderService.has(key, startMs)) {
        ReminderService.remove(key, startMs);
        showToast(t('epg.reminderRemoved'));
      } else {
        ReminderService.add({
          channelKey: key,
          channelName: channel.name,
          title: programme.title,
          startMs,
          stopMs: programme.stop.getTime(),
        });
        showToast(t('epg.reminderSet'));
      }
      this.render();
      return;
    }

    if (programme.stop.getTime() <= now && channel.catchupAccountId && channel.catchupStreamId) {
      await XtreamArchiveService.load(channel);
      if (!XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
        showToast(t('epg.catchupUnavailable'));
        this.render();
        return;
      }
    }

    if (programme.stop.getTime() <= now &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
      const key = channelKey(channel);
      const startMs = programme.start.getTime();
      const progress = StorageService.getCatchupProgressList(
        key,
        undefined,
        legacyChannelKey(channel),
      )
        .find(entry => entry.progStart === startMs && !entry.completed);
      if (progress) {
        this.resumePrompt.show(programme.title, progress.position, {
          onResume: () => this.playProgram(result, progress.position),
          onStartOver: () => {
            StorageService.clearCatchupProgress(key, startMs);
            this.playProgram(result);
          },
          onCancel: () => { /* keep Search open */ },
        });
        return;
      }
    }
    this.playProgram(result);
  }

  private playProgram(result: ProgramResult, resumeSecs?: number): void {
    const { channel, channelIndex, programme } = result;
    let catchup: CatchupInfo | undefined;
    if (programme.stop.getTime() <= Date.now() &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
      catchup = {
        start: Math.floor(programme.start.getTime() / 1000),
        end: Math.floor(programme.stop.getTime() / 1000),
        title: programme.title,
        description: programme.description,
        icon: programme.icon,
        resumeSecs,
      };
    }
    this.handlers.onPlayChannel(channelIndex, catchup);
  }

  private render(recompute = true): void {
    const q = this.query.trim();
    const isXtream = !!this.account;
    if (recompute) {
      const channels = q
        ? PlaylistService.searchRanked(this.query, this.resultLimit)
        : { items: [], hasMore: false };
      const programs = q
        ? rankPreparedTopK(this.programIndex, this.query, this.resultLimit)
        : { items: [], hasMore: false };
      const movies = q && isXtream
        ? rankPreparedNamesTopK(this.vodIndex, this.query, this.resultLimit)
        : { items: [], hasMore: false };
      const series = q && isXtream
        ? rankPreparedNamesTopK(this.seriesIndex, this.query, this.resultLimit)
        : { items: [], hasMore: false };
      this.visibleChannels = channels.items;
      this.visiblePrograms = programs.items;
      this.visibleMovies = movies.items;
      this.visibleSeries = series.items;
      this.hasMoreResults = channels.hasMore || programs.hasMore
        || movies.hasMore || series.hasMore;
      this.resetVirtualOffsets();
    }

    const hasResults = this.visibleChannels.length > 0 || this.visiblePrograms.length > 0
      || this.visibleMovies.length > 0 || this.visibleSeries.length > 0;
    const channelSection = this.visibleChannels.length
      ? this.virtualList(
          t('common.channels'),
          'channels-list',
          this.visibleChannels,
          this.channelListVirtualizer,
          (ch) => this.channelRow(ch),
        )
      : '';
    const programSection = this.visiblePrograms.length
      ? this.virtualList(
          t('search.programs'),
          'programmes',
          this.visiblePrograms,
          this.programVirtualizer,
          (result, index) => this.programRow(result, index),
        )
      : '';

    // The results view is only shown while a query is typed (App.handleSearchQuery),
    // so the empty-query case renders nothing.
    // Xtream: horizontal poster rails for catalog results. M3U-only channels and
    // EPG programs use compact rows so their metadata remains readable.
    const resultsBody = !q
      ? html``
      : !hasResults
        ? html`<p class="catalog-hint search-empty">${t('search.empty')}</p>`
        : isXtream
          ? html`
                ${this.visibleChannels.length
                  ? this.virtualRail(
                      t('common.channels'),
                      'channels-rail',
                      this.visibleChannels,
                      this.channelRailVirtualizer,
                      (ch) => this.channelTile(ch),
                    )
                  : ''}
                ${programSection}
                ${this.visibleMovies.length
                  ? this.virtualRail(
                      t('common.movies'),
                      'movies',
                      this.visibleMovies,
                      this.movieVirtualizer,
                      (v) => this.movieTile(v),
                    )
                  : ''}
                ${this.visibleSeries.length
                  ? this.virtualRail(
                      t('common.series'),
                      'series',
                      this.visibleSeries,
                      this.seriesVirtualizer,
                      (s) => this.seriesTile(s),
                    )
                  : ''}
              `
          : html`
              ${channelSection}
              ${programSection}
            `;

    // The query box lives in the tab bar; this view renders results only.
    morph(this.container, html`
      <div class="search-view" data-nav-container>
        <div class="search-results">${resultsBody}</div>
      </div>
    `);
    this.restoreVirtualOffsets();
    if (!recompute) this.nav.clearDetachedFocus();
  }

  private createVirtualizer(
    itemSize: number,
    overscan: number,
    viewport: number,
  ): VirtualList {
    return new VirtualList({
      itemSize,
      overscan,
      fallbackViewportSize: viewport,
    });
  }

  private virtualizers(): Record<string, VirtualList> {
    return {
      'channels-list': this.channelListVirtualizer,
      programmes: this.programVirtualizer,
      'channels-rail': this.channelRailVirtualizer,
      movies: this.movieVirtualizer,
      series: this.seriesVirtualizer,
    };
  }

  private resetVirtualOffsets(): void {
    const virtualizers = this.virtualizers();
    Object.keys(virtualizers).forEach(key => virtualizers[key].setScrollOffset(0));
    this.container.querySelectorAll<HTMLElement>('[data-search-virtual]').forEach((el) => {
      const axis = el.dataset.searchAxis === 'horizontal' ? 'horizontal' : 'vertical';
      this.scrollGuard.syncOffset(el, axis, 0);
    });
  }

  private restoreVirtualOffsets(): void {
    const virtualizers = this.virtualizers();
    Object.keys(virtualizers).forEach((key) => {
      const el = this.container.querySelector<HTMLElement>(`[data-search-virtual="${key}"]`);
      if (!el) return;
      const offset = virtualizers[key].scrollOffset;
      const axis = el.dataset.searchAxis === 'horizontal' ? 'horizontal' : 'vertical';
      this.scrollGuard.syncOffset(el, axis, offset);
    });
  }

  private onVirtualScroll(event: Event): void {
    const target = event.target as HTMLElement;
    const key = target.dataset.searchVirtual;
    if (!key) return;
    const virtualizer = this.virtualizers()[key];
    if (!virtualizer) return;
    const axis: VirtualScrollAxis = target.dataset.searchAxis === 'horizontal'
      ? 'horizontal'
      : 'vertical';
    const offset = this.scrollGuard.readUserOffset(target, axis);
    if (offset === null) return;
    virtualizer.setScrollOffset(offset);
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      const viewport = axis === 'horizontal' ? target.clientWidth : target.clientHeight;
      const total = virtualizer.getTotalSize(this.resultCount(key));
      if (offset + viewport >= total - this.resultItemSize(key) * 2) {
        this.expandResults();
      }
      this.render(false);
    });
  }

  private moveVirtualFocus(action: Action): boolean {
    const focused = this.nav.focused;
    const cell = focused?.closest<HTMLElement>('[data-search-section]');
    const key = cell?.dataset.searchSection;
    const rawIndex = cell?.dataset.searchIndex;
    if (!key || rawIndex === undefined) return false;
    const horizontal = key === 'channels-rail' || key === 'movies' || key === 'series';
    if ((horizontal && action !== 'left' && action !== 'right')
        || (!horizontal && action !== 'up' && action !== 'down')) return false;
    let items = key === 'channels-list' || key === 'channels-rail'
      ? this.visibleChannels
      : key === 'programmes'
        ? this.visiblePrograms
        : key === 'movies'
          ? this.visibleMovies
          : this.visibleSeries;
    const current = parseInt(rawIndex, 10);
    let next = current + (action === 'left' || action === 'up' ? -1 : 1);
    if (next >= items.length && this.expandResults()) {
      items = key === 'channels-list' || key === 'channels-rail'
        ? this.visibleChannels
        : key === 'programmes'
          ? this.visiblePrograms
          : key === 'movies'
            ? this.visibleMovies
            : this.visibleSeries;
      next = current + 1;
    }
    if (next < 0 || next >= items.length) return false;
    const scroll = this.container.querySelector<HTMLElement>(`[data-search-virtual="${key}"]`);
    const virtualizer = this.virtualizers()[key];
    virtualizer.ensureVisible(
      next,
      horizontal
        ? scroll?.clientWidth || SEARCH_RAIL_VIEWPORT
        : scroll?.clientHeight || SEARCH_LIST_VIEWPORT,
    );
    this.render(false);
    this.nav.focus(
      this.container.querySelector<HTMLElement>(
        `[data-search-section="${key}"][data-search-index="${next}"] [data-focusable]`,
      ),
    );
    return true;
  }

  private resultCount(key: string): number {
    if (key === 'channels-list' || key === 'channels-rail') return this.visibleChannels.length;
    if (key === 'programmes') return this.visiblePrograms.length;
    if (key === 'movies') return this.visibleMovies.length;
    return this.visibleSeries.length;
  }

  private resultItemSize(key: string): number {
    if (key === 'channels-list') return 88;
    if (key === 'programmes') return 109;
    return 240;
  }

  private expandResults(): boolean {
    if (!this.hasMoreResults || this.resultLimit >= CONFIG.XTREAM.SEARCH_RESULT_CAP) {
      return false;
    }
    this.resultLimit = Math.min(
      CONFIG.XTREAM.SEARCH_RESULT_CAP,
      this.resultLimit * CONFIG.XTREAM.SEARCH_EXPANSION_FACTOR,
    );
    const offsets = Object.keys(this.virtualizers()).map(key => [
      key,
      this.virtualizers()[key].scrollOffset,
    ] as const);
    this.render();
    for (const [key, offset] of offsets) this.virtualizers()[key].setScrollOffset(offset);
    this.restoreVirtualOffsets();
    return true;
  }

  private cancelScheduledQuery(): void {
    this.queryGeneration++;
    if (this.queryFrame !== null) cancelAnimationFrame(this.queryFrame);
    this.queryFrame = null;
  }
}
