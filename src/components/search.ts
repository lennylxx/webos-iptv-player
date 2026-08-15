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
  prepareNameSearchItems,
  prepareSearchItems,
  rankPreparedNamesTopK,
  rankPreparedTopK,
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
import { runInFrameSlices } from '../utils/frame-slices';
import {
  isAppWorkerRunning,
  retainAppWorker,
  runAppWorkerTask,
} from '../workers/app-worker-client';
import type { SearchIndexRequest, SearchQueryResponse } from '../workers/tasks';

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

type CatalogLoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: unknown };

function captureCatalogLoad<T>(promise: Promise<T>): Promise<CatalogLoadResult<T>> {
  return promise.then(
    (data) => ({ ok: true, data }),
    (error: unknown) => ({ ok: false, error }),
  );
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
  private programIndex: ProgramResult[] = [];
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
  private queryPromise: Promise<void> | null = null;
  private queryPending = false;
  private catalogController: AbortController | null = null;
  private active = false;
  private programIndexGeneration = 0;
  private resultLimit: number = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
  private hasMoreResults = false;
  private workerSession = 0;
  private workerIndexReady = false;
  private workerIndexedChannels: Channel[] | null = null;
  private workerIndexedProgrammes: Record<string, Programme[]> | null = null;
  private workerIndexedAccountId: string | null = null;
  private workerIndexedVod: VodItem[] | null = null;
  private workerIndexedSeries: SeriesItem[] | null = null;
  private releaseWorker: (() => void) | null = null;
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
    this.active = true;
    if (!isAppWorkerRunning()) this.invalidateWorkerIndex();
    const reuseWorkerIndex = this.canReuseWorkerIndex(account);
    if (!this.releaseWorker) this.releaseWorker = retainAppWorker();
    this.cancelScheduledQuery();
    this.catalogController?.abort();
    this.catalogController = null;
    if (this.loadedFor !== account?.id) {
      this.allVod = [];
      this.allSeries = [];
      this.loadedFor = null;
    }
    this.account = account;
    this.query = '';
    this.resultLimit = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
    this.render();
    if (reuseWorkerIndex) return;

    const sessionId = ++this.workerSession;
    this.invalidateWorkerIndex();
    const workerReset = new Promise<boolean>((resolve, reject) => {
      requestAnimationFrame(() => {
        if (!this.active || sessionId !== this.workerSession) {
          resolve(false);
          return;
        }
        this.indexWorker({ sessionId, reset: true }).then(resolve, reject);
      });
    });
    let catalogLoad: Promise<void> | null = null;
    if (account) {
      this.catalogController = new AbortController();
      catalogLoad = this.loadCatalog(
        account,
        this.catalogController.signal,
        sessionId,
        workerReset,
      );
    }
    const reset = await workerReset;
    if (!reset || !this.active || sessionId !== this.workerSession) return;
    const channelsIndexed = await this.indexWorker({
      sessionId,
      channels: PlaylistService.channels.map(channel => [
        channel.name,
        channel.group,
        channel.sourceName ?? '',
      ]),
    });
    if (!channelsIndexed || !this.active || sessionId !== this.workerSession) return;
    await this.buildProgramIndex(false, sessionId);
    if (!this.active) return;
    const completedProgramGeneration = this.programIndexGeneration;
    if (this.query.trim()) await this.startQuery(++this.queryGeneration);
    await catalogLoad;
    if (!this.active
        || sessionId !== this.workerSession
        || completedProgramGeneration !== this.programIndexGeneration) return;
    if (!account || this.loadedFor === account.id) this.markWorkerIndexReady(account);
  }

  /** The tab bar's search box drives the query; re-render the results for it. */
  async setQuery(query: string): Promise<void> {
    this.cancelScheduledQuery();
    this.query = query;
    this.resultLimit = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
    if (!query.trim()) {
      this.clearResults();
      this.render();
      return;
    }
    await this.startQuery(this.queryGeneration);
  }

  scheduleQuery(query: string): void {
    this.query = query;
    this.resultLimit = CONFIG.XTREAM.SEARCH_INITIAL_RESULTS;
    const generation = ++this.queryGeneration;
    if (this.queryFrame !== null) cancelAnimationFrame(this.queryFrame);
    if (!query.trim()) {
      this.queryFrame = null;
      this.clearResults();
      this.render();
      return;
    }
    this.queryFrame = requestAnimationFrame(() => {
      this.queryFrame = null;
      if (generation !== this.queryGeneration) return;
      void this.startQuery(generation);
    });
  }

  async refreshPrograms(): Promise<void> {
    this.programIndexGeneration++;
    this.indexedChannels = null;
    this.indexedProgrammes = null;
    if (!this.active) return;
    await this.buildProgramIndex(true, this.workerSession);
    if (this.active && this.query.trim()) {
      await this.startQuery(++this.queryGeneration);
    }
  }

  dismissPrompt(): void {
    this.resumePrompt.hide();
  }

  deactivate(): void {
    this.active = false;
    this.programIndexGeneration++;
    this.catalogController?.abort();
    this.catalogController = null;
    this.releaseWorker?.();
    this.releaseWorker = null;
    this.queryPending = false;
    this.queryPromise = null;
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
  private async loadCatalog(
    account: PlaylistEntry,
    signal: AbortSignal,
    sessionId: number,
    workerReset: Promise<boolean>,
  ): Promise<void> {
    if (this.loadedFor === account.id) {
      if (!await workerReset) return;
      await this.indexWorker({
        sessionId,
        movies: this.allVod.map(item => item.name),
        series: this.allSeries.map(item => item.name),
      });
      return;
    }
    const [vod, series] = await Promise.all([
      captureCatalogLoad(loadAllVodStreams(account, signal)),
      captureCatalogLoad(loadAllSeries(account, signal)),
    ]);
    // A newer open() (account switch) superseded this load — discard the stale
    // result instead of clobbering the current account's catalog.
    if (signal.aborted || this.account?.id !== account.id) return;
    if (vod.ok) {
      this.allVod = vod.data;
    } else {
      log.error(
        'Movie search catalog load failed',
        'event=xtream.search.load.failed',
        'resource=movies',
        vod.error,
      );
    }
    if (series.ok) {
      this.allSeries = series.data;
    } else {
      log.error(
        'Series search catalog load failed',
        'event=xtream.search.load.failed',
        'resource=series',
        series.error,
      );
    }
    if (vod.ok && series.ok) {
      this.loadedFor = account.id;
      log.debug(
        'catalog loaded',
        vod.data.length,
        'movies,',
        series.data.length,
        'series',
      );
    }
    if (!await workerReset) return;
    const indexed = await this.indexWorker({
      sessionId,
      ...(vod.ok ? { movies: vod.data.map(item => item.name) } : {}),
      ...(series.ok ? { series: series.data.map(item => item.name) } : {}),
    });
    if (!indexed || signal.aborted || this.account?.id !== account.id) return;
    if (this.query.trim()) await this.startQuery(++this.queryGeneration);
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
    const focus = (): void => {
      const first = this.container.querySelector<HTMLElement>(
        '.search-results [data-focusable]',
      );
      if (first) this.nav.focus(first);
    };
    if (this.queryFrame !== null) {
      this.cancelScheduledQuery();
      void this.startQuery(this.queryGeneration).then(focus);
      return;
    }
    if (this.queryPromise) {
      void this.queryPromise.then(focus);
      return;
    }
    focus();
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
        <div class="catalog-rail-track search-virtual-rail ${
               key === 'channels-rail' ? 'search-channel-rail' : ''
             }"
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

  private async buildProgramIndex(force: boolean, sessionId: number): Promise<void> {
    if (!force
        && this.indexedChannels === PlaylistService.channels
        && this.indexedProgrammes === EpgService.programmes) {
      await this.indexProgrammes(sessionId);
      return;
    }
    const generation = ++this.programIndexGeneration;
    const channels = PlaylistService.channels;
    const programmesByChannel = EpgService.programmes;
    const programs: ProgramResult[] = [];
    let channelIndex = 0;
    let channelPrograms: Programme[] = [];
    let programmeIndex = 0;
    const shouldContinue = (): boolean =>
      this.active && generation === this.programIndexGeneration;
    const collected = await runInFrameSlices(() => {
      if (programmeIndex < channelPrograms.length) {
        programs.push({
          channel: channels[channelIndex - 1],
          channelIndex: channelIndex - 1,
          programme: channelPrograms[programmeIndex++],
        });
        return false;
      }
      if (channelIndex >= channels.length) return true;
      const channel = channels[channelIndex++];
      const epgId = EpgService.findChannelId(channel);
      channelPrograms = epgId ? programmesByChannel[epgId] ?? [] : [];
      programmeIndex = 0;
      return false;
    }, { shouldContinue });
    if (!collected) return;

    this.programIndex = programs;
    this.indexedChannels = channels;
    this.indexedProgrammes = programmesByChannel;
    await this.indexProgrammes(sessionId);
  }

  private indexProgrammes(sessionId: number): Promise<boolean> {
    return this.indexWorker({
      sessionId,
      programmes: this.programIndex.map(result => [
        result.programme.title,
        result.programme.category,
        result.programme.description,
        result.channel.name,
        result.channel.group,
      ]),
    });
  }

  private async indexWorker(request: SearchIndexRequest): Promise<boolean> {
    const response = await runAppWorkerTask('search.index', request);
    return response.accepted && request.sessionId === this.workerSession;
  }

  private startQuery(generation: number, preserveOffsets = false): Promise<void> {
    const promise = this.runWorkerQuery(generation, preserveOffsets).catch(error => {
      log.error(
        'Search result update failed',
        'event=search.results.update.failed',
        error,
      );
    });
    this.queryPromise = promise;
    void promise.then(() => {
      if (this.queryPromise === promise) this.queryPromise = null;
    });
    return promise;
  }

  private async runWorkerQuery(generation: number, preserveOffsets: boolean): Promise<void> {
    const query = this.query;
    const sessionId = this.workerSession;
    if (!query.trim()) return;
    if (!preserveOffsets) {
      this.queryPending = true;
      this.render();
    }
    let response: SearchQueryResponse | null;
    let recoveryAttempted = false;
    try {
      response = await runAppWorkerTask('search.query', {
        sessionId,
        query,
        limit: this.resultLimit,
        includeCatalog: !!this.account,
      });
    } catch (error) {
      if (generation !== this.queryGeneration || !this.active) return;
      log.error(
        'Search worker query failed; rebuilding its index',
        'event=search.worker.query.failed',
        'scope=unified',
        `session=${String(sessionId)}`,
        error,
      );
      recoveryAttempted = true;
      response = await this.recoverWorkerQuery(sessionId, query);
    }
    if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) {
      return;
    }
    if (!response && !recoveryAttempted) {
      log.error(
        'Search worker lost its index; rebuilding it',
        'event=search.worker.index.missing',
        'scope=unified',
        `session=${String(sessionId)}`,
      );
      response = await this.recoverWorkerQuery(sessionId, query);
    }
    if (!response) {
      log.warn(
        'Worker search failed; using main-thread fallback',
        'event=search.worker.fallback.used',
        'scope=unified',
        `session=${String(sessionId)}`,
      );
      response = this.queryLocally(query);
    }
    this.applyQueryResponse(response);
    this.queryPending = false;
    if (!preserveOffsets) this.resetVirtualOffsets();
    this.render();
  }

  private queryLocally(query: string): SearchQueryResponse {
    const channels = PlaylistService.searchLocalRanked(query, this.resultLimit);
    const programmes = rankPreparedTopK(
      prepareSearchItems(this.programIndex, result => [
        result.programme.title,
        result.programme.category,
        result.programme.description,
        result.channel.name,
        result.channel.group,
      ]),
      query,
      this.resultLimit,
    );
    const movies = this.account
      ? rankPreparedNamesTopK(prepareNameSearchItems(this.allVod), query, this.resultLimit)
      : { items: [], hasMore: false };
    const series = this.account
      ? rankPreparedNamesTopK(prepareNameSearchItems(this.allSeries), query, this.resultLimit)
      : { items: [], hasMore: false };
    return {
      channels: {
        indices: channels.items.map(channel => PlaylistService.indexOf(channel)),
        hasMore: channels.hasMore,
      },
      programmes: {
        indices: indicesOf(this.programIndex, programmes.items),
        hasMore: programmes.hasMore,
      },
      movies: {
        indices: indicesOf(this.allVod, movies.items),
        hasMore: movies.hasMore,
      },
      series: {
        indices: indicesOf(this.allSeries, series.items),
        hasMore: series.hasMore,
      },
    };
  }

  private async recoverWorkerQuery(
    sessionId: number,
    query: string,
  ): Promise<SearchQueryResponse | null> {
    try {
      const indexed = await this.indexWorker({
        sessionId,
        reset: true,
        channels: PlaylistService.channels.map(channel => [
          channel.name,
          channel.group,
          channel.sourceName ?? '',
        ]),
        programmes: this.programIndex.map(result => [
          result.programme.title,
          result.programme.category,
          result.programme.description,
          result.channel.name,
          result.channel.group,
        ]),
        movies: this.allVod.map(item => item.name),
        series: this.allSeries.map(item => item.name),
      });
      if (!indexed) return null;
      this.markWorkerIndexReady(this.account);
      const response = await runAppWorkerTask('search.query', {
        sessionId,
        query,
        limit: this.resultLimit,
        includeCatalog: !!this.account,
      });
      if (response) {
        log.info(
          'Search worker recovery completed',
          'event=search.worker.recovery.completed',
          'scope=unified',
          `session=${String(sessionId)}`,
        );
      }
      return response;
    } catch (error) {
      log.error(
        'Search worker recovery failed',
        'event=search.worker.recovery.failed',
        'scope=unified',
        `session=${String(sessionId)}`,
        error,
      );
      return null;
    }
  }

  private applyQueryResponse(response: SearchQueryResponse): void {
    this.visibleChannels = itemsAt(PlaylistService.channels, response.channels.indices);
    this.visiblePrograms = itemsAt(this.programIndex, response.programmes.indices);
    this.visibleMovies = itemsAt(this.allVod, response.movies.indices);
    this.visibleSeries = itemsAt(this.allSeries, response.series.indices);
    this.hasMoreResults = response.channels.hasMore || response.programmes.hasMore
      || response.movies.hasMore || response.series.hasMore;
  }

  private clearResults(): void {
    this.visibleChannels = [];
    this.visiblePrograms = [];
    this.visibleMovies = [];
    this.visibleSeries = [];
    this.hasMoreResults = false;
    this.queryPending = false;
    this.resetVirtualOffsets();
  }

  private canReuseWorkerIndex(account: PlaylistEntry | null): boolean {
    return this.workerIndexReady
      && this.workerIndexedChannels === PlaylistService.channels
      && this.workerIndexedProgrammes === EpgService.programmes
      && this.workerIndexedAccountId === (account?.id ?? null)
      && (!account
        || (this.loadedFor === account.id
          && this.workerIndexedVod === this.allVod
          && this.workerIndexedSeries === this.allSeries));
  }

  private markWorkerIndexReady(account: PlaylistEntry | null): void {
    this.workerIndexReady = true;
    this.workerIndexedChannels = PlaylistService.channels;
    this.workerIndexedProgrammes = EpgService.programmes;
    this.workerIndexedAccountId = account?.id ?? null;
    this.workerIndexedVod = this.allVod;
    this.workerIndexedSeries = this.allSeries;
    log.info(
      'Search worker index ready',
      'event=search.worker.index.ready',
      'scope=unified',
      `session=${String(this.workerSession)}`,
      `channels=${String(PlaylistService.channels.length)}`,
      `programmes=${String(this.programIndex.length)}`,
      `movies=${String(this.allVod.length)}`,
      `series=${String(this.allSeries.length)}`,
    );
  }

  private invalidateWorkerIndex(): void {
    const wasReady = this.workerIndexReady;
    this.workerIndexReady = false;
    this.workerIndexedChannels = null;
    this.workerIndexedProgrammes = null;
    this.workerIndexedAccountId = null;
    this.workerIndexedVod = null;
    this.workerIndexedSeries = null;
    if (wasReady) {
      log.debug(
        'Search worker index invalidated',
        'event=search.worker.index.released',
        'scope=unified',
        `session=${String(this.workerSession)}`,
      );
    }
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
          playlistIds: channel.playlistIds.slice(),
          epgSourceUrl: EpgService.getSourceUrl(channel) ?? undefined,
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
        epgSourceUrl: EpgService.getSourceUrl(channel) ?? undefined,
        resumeSecs,
      };
    }
    this.handlers.onPlayChannel(channelIndex, catchup);
  }

  private render(): void {
    const q = this.query.trim();
    const isXtream = !!this.account;

    const hasResults = this.visibleChannels.length > 0 || this.visiblePrograms.length > 0
      || this.visibleMovies.length > 0 || this.visibleSeries.length > 0;
    const hasMixedLists = !isXtream
      && this.visibleChannels.length > 0
      && this.visiblePrograms.length > 0;
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
    const resultsBody = !q || this.queryPending
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
      <div class="search-view ${isXtream ? '' : 'search-lists'} ${
        hasMixedLists ? 'search-lists-mixed' : ''
      }" data-nav-container data-search-query="${q}"
           data-search-pending="${this.queryPending ? 'true' : 'false'}">
        <div class="search-results">${resultsBody}</div>
      </div>
    `);
    this.restoreVirtualOffsets();
    this.nav.clearDetachedFocus();
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
      this.render();
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
    this.render();
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
    void this.startQuery(++this.queryGeneration, true);
    return true;
  }

  private cancelScheduledQuery(): void {
    this.queryGeneration++;
    if (this.queryFrame !== null) cancelAnimationFrame(this.queryFrame);
    this.queryFrame = null;
  }
}

function itemsAt<T>(items: T[], indices: number[]): T[] {
  const selected: T[] = [];
  for (const index of indices) {
    const item = items[index];
    if (item !== undefined) selected.push(item);
  }
  return selected;
}

function indicesOf<T>(items: T[], selected: T[]): number[] {
  const byItem = new Map<T, number>();
  for (let index = 0; index < items.length; index++) byItem.set(items[index], index);
  return selected.map(item => byItem.get(item) ?? -1);
}
