import type { Action, CatchupInfo, Channel, PlaylistEntry, Programme, VodItem, SeriesItem } from '../types';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { InputMode } from '../navigation/input-mode';
import { fontScale, html, inShownView, raw, type Safe } from '../utils/dom';
import { liveSource, ProgramTranslation, programTitle, programView } from './program-translation';
import { channelLockBadge, seriesLockBadge, vodLockBadge } from './parental-badge';
import { morph } from '../utils/morph';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { ChannelCustomizationService } from '../services/channel-customization';
import { ReminderService } from '../services/reminder-service';
import { StorageService } from '../services/storage-service';
import { XtreamArchiveService } from '../services/xtream-archive';
import { catchupNeedsId, hasCatchup } from '../utils/catchup-url';
import { persistSearchIndexes } from '../services/search-index-store';
import {
  getSearchCatalogExpiresAt,
  loadAllSeries,
  loadAllVodStreams,
  onCatalogListRefreshed,
  syncAllSeries,
  syncAllVodStreams,
} from '../services/xtream-catalog';
import { sameCatalogConcealment } from '../utils/catalog-concealment';
import {
  expandedQueries,
  hasMultilingualSynonyms,
  transliterates,
  namesHaveScript,
  prepareNameSearchItems,
  prepareSearchItems,
  preparedHaveScript,
  rankExpanded,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  type PreparedNameSearchIndex,
  type PreparedSearchItem,
} from '../utils/channel-search';
import { SearchQueryExpansion } from './search-query-expansion';
import { expansionQuery } from '../services/search-expansion';
import { channelKey } from '../utils/channel';
import { formatDayLabel, formatTime } from '../utils/time';
import { showToast } from './toast';
import { CatchupResumePrompt } from './catchup-resume-prompt';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { getLocale, t } from '../i18n';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard, type VirtualScrollAxis } from '../utils/virtual-scroll';
import { runInFrameSlices } from '../utils/frame-slices';
import {
  appWorkerGeneration,
  retainAppWorker,
  runAppWorkerTask,
} from '../workers/app-worker-client';
import {
  catalogParentalRequest,
  isSeriesConcealed,
  isVodConcealed,
  liveParentalRequest,
  ParentalControlService,
} from '../services/parental-control';
import type {
  SearchCachedNames,
  SearchCacheRecord,
  SearchCatalogRecord,
  SearchIndexChunk,
  SearchIndexRequest,
  SearchIndexSource,
  SearchProgrammeRuns,
  SearchQueryRequest,
  SearchQueryResponse,
} from '../workers/tasks';
import {
  cachedChannelsRequest,
  cachedNamesRequest,
  channelDocument,
  ProgrammeRuns,
  sampleDocuments,
  selectCatalogItems,
} from './search-cache-source';
import { LlmService } from '../services/llm/llm-service';
import { LlmError } from '../services/llm/client';
import {
  askSearch,
  SEARCH_ASK_FEATURE,
  type AskFilter,
  type AskType,
} from '../services/ask-search/ask-query';
import { askPlan, askWeekday, askWindows } from '../services/ask-search/time-window';
import {
  askChannels,
  collectPrograms,
  interleave,
  namesByCount,
  narrowsPrograms,
  programDocument,
  programKey,
  rankNames,
  matchPrograms,
  rankPrograms,
  wantsType,
} from '../services/ask-search/execute';
import {
  askCatalogCategories,
  askMovies,
  askSeries,
  unlockedCategories,
  type AskCatalogCategories,
} from '../services/ask-search/catalog-source';
import { AI_ICON } from './icons';
import { ProgramGenres, genreLabel, programGenre, programGenreName } from '../services/program-genres';

const log = createLogger('Search');
const SEARCH_LIST_VIEWPORT = 420;
const SEARCH_RAIL_VIEWPORT = 1760;
const SEARCH_ROW_OVERSCAN = 6;
// A program row's height, as `.search-program-row` sets it in css/search.css,
// plus the 8px gap to the next row: the part that grows with the text size,
// and the part that doesn't.
const SEARCH_PROGRAM_ROW_TEXT = 69;
const SEARCH_PROGRAM_ROW_FIXED = 40;

// The guide's category, else the AI model's genre behind the AI mark.
function programGenreText(programme: Programme): Safe | string {
  if (programme.category) return html` · ${programme.category}`;
  const genre = programGenre(programme);
  return genre ? html` · <span class="ai-icon">${raw(AI_ICON)}</span>${genreLabel(genre)}` : '';
}

function programRowStride(scale: number): number {
  return SEARCH_PROGRAM_ROW_FIXED + SEARCH_PROGRAM_ROW_TEXT * scale;
}
const SEARCH_RAIL_OVERSCAN = 4;
// How often an AI search's filter runs again when the lists change under it.
const ASK_LIST_ATTEMPTS = 3;

export interface SearchHandlers {
  onRevealTabBar: () => void;
  // A result arrived after the remote waited in the box: let it go.
  onReleaseTabBar: () => void;
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

interface WorkerPrograms {
  channels: Channel[];
  // The guide the worker's programmes came from; results wait for a newer one.
  guideRevision: number;
  runChannels: Uint32Array;
  counts: Uint32Array;
  // The program index of each run's first programme.
  starts: Uint32Array;
  total: number;
}

function workerPrograms(channels: Channel[], guideRevision: number, runs: SearchProgrammeRuns): WorkerPrograms {
  const starts = new Uint32Array(runs.counts.length);
  let total = 0;
  for (let run = 0; run < runs.counts.length; run++) {
    starts[run] = total;
    total += runs.counts[run];
  }
  return { channels, guideRevision, runChannels: runs.channels, counts: runs.counts, starts, total };
}

// The guide this page holds must list the run's programmes as the worker's
// cache did; a run whose count changed shows none of its programmes.
function workerProgramAt(runs: WorkerPrograms, index: number): ProgramResult | null {
  if (index < 0 || index >= runs.total || !runs.starts.length) return null;
  let low = 0;
  let high = runs.starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (runs.starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  const channelIndex = runs.runChannels[low];
  const channel = runs.channels[channelIndex];
  const id = channel ? EpgService.findChannelId(channel) : null;
  const programmes = id ? EpgService.getProgrammes(id) : null;
  if (!programmes || programmes.length !== runs.counts[low]) return null;
  return { channel, channelIndex, programme: programmes[index - runs.starts[low]] };
}

// Saved guide mappings by channel index; mappings stay few, so this walks them.
function channelMappings(): Array<[number, string]> {
  const mappings: Array<[number, string]> = [];
  for (const [key, guideKey] of ChannelCustomizationService.epgMappings()) {
    for (const index of PlaylistService.indicesOfKey(key)) mappings.push([index, guideKey]);
  }
  return mappings;
}

const MATCH_SAMPLES = 16;

function sampleIndices(count: number): number[] {
  const indices: number[] = [];
  if (count <= 0) return indices;
  const step = count <= MATCH_SAMPLES ? 1 : (count - 1) / (MATCH_SAMPLES - 1);
  for (let i = 0; i < Math.min(count, MATCH_SAMPLES); i++) indices.push(Math.round(i * step));
  return indices;
}


type CatalogLoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: unknown };

interface CatalogSources {
  movies: boolean;
  series: boolean;
}

// Sources still on their way to the worker in this session.
interface PendingIndex {
  channels: boolean;
  programmes: boolean;
  catalog: boolean;
}

interface SourcePost {
  id: number;
  // Settles once this post stops sending chunks.
  sent: Promise<void>;
  result: Promise<boolean>;
}

// Ask mode: an AI search for the query, its filter shown above its results.
type AskView =
  | { phase: 'idle' }
  | { phase: 'loading'; query: string }
  | { phase: 'shown'; query: string; filter: AskFilter; catalog: AskCatalogCategories | null }
  | { phase: 'failed'; query: string; reason: string };

interface LocalIndexes {
  programs: PreparedSearchItem<ProgramResult>[];
  movies: PreparedNameSearchIndex<VodItem>;
  series: PreparedNameSearchIndex<SeriesItem>;
}

interface ResultLists {
  channels: Channel[];
  programs: ProgramResult[];
  movies: VodItem[];
  series: SeriesItem[];
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function captureCatalogLoad<T>(promise: Promise<T>): Promise<CatalogLoadResult<T>> {
  return promise.then(
    (data) => ({ ok: true, data }),
    (error: unknown) => ({ ok: false, error }),
  );
}

// A catalog the worker holds as a record: an empty list stands in for it, so
// identity checks still see a change, and answers carry the ranked items.
const recordLists = new WeakSet<unknown[]>();

function recordList<T>(): T[] {
  const list: T[] = [];
  recordLists.add(list);
  return list;
}

function isRecordList(list: unknown[]): boolean {
  return recordLists.has(list);
}

function sameCatalogRecord(left: SearchCatalogRecord | null, right: SearchCatalogRecord): boolean {
  return !!left && left.record.store === right.record.store && left.record.key === right.record.key
    && left.record.timestamp === right.record.timestamp
    && sameCatalogConcealment(left.concealment, right.concealment);
}

type CatalogSourceLoad<T> = { record: SearchCacheRecord; data: null } | { record: null; data: T[] };

// The synced record when the worker can hold the catalog, else the list.
async function loadCatalogSource<T>(
  account: PlaylistEntry,
  signal: AbortSignal,
  sync: (
    account: PlaylistEntry,
    signal: AbortSignal,
    pageLoadGate: () => Promise<void>,
  ) => Promise<SearchCacheRecord | null>,
  load: (account: PlaylistEntry, signal: AbortSignal) => Promise<T[]>,
  // A list landing on this thread holds it for seconds, so it waits for this.
  pageLoadGate: () => Promise<void>,
): Promise<CatalogSourceLoad<T>> {
  const record = await sync(account, signal, pageLoadGate);
  if (record) return { record, data: null };
  await pageLoadGate();
  return { record: null, data: await load(account, signal) };
}

// Record items the worker sent this epoch, by catalog index.
interface DeliveredItems {
  epoch: number;
  movies: Map<number, VodItem>;
  series: Map<number, SeriesItem>;
}

function deliveredItems(epoch: number): DeliveredItems {
  return { epoch, movies: new Map(), series: new Map() };
}

type RecordFallback = Array<{ name: string }> | 'synced' | 'replaced' | null;

function sameCacheRef(left: SearchCacheRecord, right: SearchCacheRecord): boolean {
  return left.store === right.store && left.key === right.key && left.timestamp === right.timestamp;
}

function sameCatalogSource(left: SearchCachedNames | null, right: SearchCachedNames | null): boolean {
  if (!left || !right || left.record.key !== right.record.key
    || left.record.timestamp !== right.record.timestamp || left.length !== right.length) return false;
  if (!left.selection || !right.selection) return left.selection === right.selection;
  if (left.selection.length !== right.selection.length) return false;
  for (let i = 0; i < left.selection.length; i++) {
    if (left.selection[i] !== right.selection[i]) return false;
  }
  return true;
}

// The Search section: one query box over Channels / Programs / Movies / Series.
// Results are relevance-ranked and capped; movies and series match the account's
// full catalogs, loaded once on open and cached.
// Up from the box reveals the tab bar; Back returns to Live. The global key
// handler ignores INPUT keydowns, so the box owns its own text input + focus-out
// keys.
export class Search {
  private nav: SpatialNav;
  readonly focusScope: FocusScope;
  private account: PlaylistEntry | null = null;
  private query = '';
  private allVod: VodItem[] = [];
  private allSeries: SeriesItem[] = [];
  private programIndex: ProgramResult[] = [];
  private programRuns = new ProgrammeRuns();
  // Programmes the worker matched to the channels itself; the page then holds
  // no program index and builds a result only when it is shown.
  private workerPrograms: WorkerPrograms | null = null;
  // The worker read this session's channels from the playlist cache, so it
  // can match them to the guide.
  private workerChannelsCached = false;
  // The page program index build in flight, which callers for the same lists join.
  private programBuild: {
    generation: number;
    channels: Channel[];
    guideRevision: number;
    done: Promise<boolean>;
  } | null = null;
  // The channel list and guide whose worker-matched programmes disagreed
  // with the guide shown; the page matches them itself while both last.
  private pageProgrammesFor: { channels: Channel[]; guideRevision: number } | null = null;
  // The catalog-cache selections behind allVod / allSeries, when available.
  private vodCache: SearchCachedNames | null = null;
  private seriesCache: SearchCachedNames | null = null;
  // The catalog records the worker holds for allVod / allSeries in record mode.
  private vodRecord: SearchCatalogRecord | null = null;
  private seriesRecord: SearchCatalogRecord | null = null;
  private delivered = deliveredItems(-1);
  // The worker generation that sent the delivered items.
  private deliveredWorker: number | null = null;
  // The query whose catalog results are shown; only the worker ranks a record.
  private catalogQuery: string | null = null;
  // The channel list whose documents the worker holds in this session.
  private workerChannels: Channel[] | null = null;
  private indexedChannels: Channel[] | null = null;
  private indexedGuideRevision: number | null = null;
  private loadedFor: string | null = null;
  private catalogExpiresAt = 0;
  private visibleChannels: Channel[] = [];
  private visiblePrograms: ProgramResult[] = [];
  private visibleMovies: VodItem[] = [];
  private visibleSeries: SeriesItem[] = [];
  private resumePrompt = new CatchupResumePrompt('prompt.search');
  private programVirtualizer = this.createVirtualizer(programRowStride(1), SEARCH_ROW_OVERSCAN, SEARCH_LIST_VIEWPORT);
  private programStride = programRowStride(1);
  // The text size the program rows were last sized for.
  private programTextSize: string | null = null;
  private readonly channelRailVirtualizer = this.createVirtualizer(240, SEARCH_RAIL_OVERSCAN, SEARCH_RAIL_VIEWPORT);
  private readonly movieVirtualizer = this.createVirtualizer(240, SEARCH_RAIL_OVERSCAN, SEARCH_RAIL_VIEWPORT);
  private readonly seriesVirtualizer = this.createVirtualizer(240, SEARCH_RAIL_OVERSCAN, SEARCH_RAIL_VIEWPORT);
  private scrollFrame: number | null = null;
  // The window each virtual rail last rendered; its cells sit at fixed
  // offsets, so a scroll inside the window needs no render.
  private readonly railWindows = new Map<string, string>();
  private queryFrame: number | null = null;
  private queryGeneration = 0;
  private queryPending = false;
  private readonly expansion = new SearchQueryExpansion(
    (key: string) => this.applyExpansion(key),
    (key: string) => this.moreWhenSettled === key,
  );
  // The other queries that added the results shown.
  private expandedTerms: string[] = [];
  // The normalized query whose settled ranking the worker said would try more.
  private moreWhenSettled: string | null = null;
  // The query generation an expansion reranks: its sections keep their order
  // and its render keeps the focused result in place.
  private expansionGeneration = -1;
  private sectionOrder: string[] = [];
  // Down/Enter handed focus over before the results existed; focus them once a query renders.
  private focusPending = false;
  private focusWaitingInBox = false;
  private catalogController: AbortController | null = null;
  // The load that stands in for a catalog record the worker could not read.
  private recordFallback: AbortController | null = null;
  // The session that already synced each record again after a failed read.
  private readonly resynced = { movies: -1, series: -1 };
  // A second caller in the same session shares the first one's fallback.
  private readonly fallbacks: {
    movies?: { sessionId: number; result: Promise<RecordFallback> };
    series?: { sessionId: number; result: Promise<RecordFallback> };
  } = {};
  // Shared by a reopen, so closing Search does not restart the load.
  private catalogLoad: { accountId: string; promise: Promise<CatalogSources> } | null = null;
  private catalogLoading = false;
  // Settles once this session's channels and programs are indexed.
  private catalogGate: Promise<unknown> = Promise.resolve();
  // A catalog load a reopen shares waits for the newest session's gate.
  private readonly awaitCatalogGate = async (): Promise<void> => {
    let gate: Promise<unknown>;
    do {
      gate = this.catalogGate;
      await gate;
    } while (gate !== this.catalogGate);
  };
  // The generation of the full query that replaces partial results, while in flight.
  private completingPartial: number | null = null;
  // A playlist load is running; refreshChannels() ends it once the load is done.
  private channelLoad = false;
  // Until every source is indexed, queries wait and the results show a hint.
  private pendingIndex: PendingIndex | null = null;
  // The worker's channels are empty until a channels-only repost lands.
  private channelRepost: { sessionId: number; done: Promise<void> } | null = null;
  private active = false;
  private programIndexGeneration = 0;
  private workerSession = 0;
  private workerIndexReady = false;
  // A post failed, so the worker may hold a partial index; the next query rebuilds it.
  private workerIndexLost = false;
  // Sources that settled without an index: answers leave them out until the rebuild.
  private lostSources: Partial<Record<keyof PendingIndex, true>> | null = null;
  // One rebuild of a lost index per session; queries meanwhile wait for it.
  private recovery: { sessionId: number; done: Promise<boolean> } | null = null;
  // A rebuild of the session's lost index failed: until `at`, its queries rank
  // on the main thread rather than post the whole index to that worker again.
  // `logged`: the failure was logged, and is not again until a rebuild succeeds.
  private recoveryRetry: {
    sessionId: number;
    at: number;
    generation: number | null;
    logged: boolean;
  } | null = null;
  // The catalog lists the worker ranks, which can trail allVod/allSeries
  // while a refresh is posted; worker indices map onto these.
  private indexedVod: VodItem[] = [];
  private indexedSeries: SeriesItem[] = [];
  // How this session's index reached the worker, for its diagnostic event.
  private indexStats = { startedAt: 0, hintAt: 0, persisted: 0, built: 0, posted: 0 };
  // The latest chunked post of each source; a source posts one sequence at a time.
  private sourcePosts: Partial<Record<SearchIndexSource, SourcePost>> = {};
  private sourcePostId = 0;
  private workerIndexedChannels: Channel[] | null = null;
  // Whether the posted channels were the whole list: a running load grows it
  // in place, so the same array may hold more by now.
  private workerChannelsComplete = false;
  private workerIndexedChannelsComplete = false;
  private workerIndexedGuideRevision: number | null = null;
  private workerIndexedAccountId: string | null = null;
  private workerIndexedGeneration: number | null = null;
  private workerResetGeneration: number | null = null;
  private workerIndexedVod: VodItem[] | null = null;
  private workerIndexedSeries: SeriesItem[] | null = null;
  private releaseWorker: (() => void) | null = null;
  private readonly scrollGuard = new VirtualScrollGuard();
  private ask: AskView = { phase: 'idle' };
  // Bumped by each AI search and each way out of one, so a late reply is dropped.
  private askSeq = 0;
  private askController: AbortController | null = null;
  // The query the AI last searched, whose action stays offered.
  private askUsedFor: string | null = null;
  private askNameCache: { key: string; list: Channel[]; channels: Channel[]; genres: string[] } | null = null;

  constructor(private container: HTMLElement, private handlers: SearchHandlers) {
    ProgramTranslation.subscribe(() => {
      if (this.active && inShownView(this.container)) this.render();
    });
    this.focusScope = Focus.register({
      id: 'view.search',
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.navKey(),
      resolve: (key) => this.resolveKey(key),
    });
    this.nav = new SpatialNav(container, undefined, { scope: this.focusScope });
    // Activate the result under the pointer by coordinate hit-test, so it lands
    // here regardless of D-pad focus; the container is marked `data-self-activate`
    // so the global click handler skips this subtree and doesn't double-fire.
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY));
    this.container.addEventListener('scroll', (e: Event) => this.onVirtualScroll(e), true);
    onCatalogListRefreshed((key, changed) => this.onCatalogRefreshed(key, changed));
  }

  private onPointerRelease(x: number, y: number): void {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    if (!el || !this.container.contains(el)) return;
    this.nav.focus(el, 'pointer');
    this.onSelect();
  }

  private navKey(): string | null {
    const el = this.nav.focused;
    return el && this.container.contains(el) ? el.dataset.key ?? null : null;
  }

  // A channel can show as both a tile and a row: the ring goes on the one
  // the nav holds.
  private resolveKey(key: string): HTMLElement | null {
    const el = this.nav.focused;
    if (el && this.container.contains(el) && el.dataset.key === key) return el;
    return Array.from(this.container.querySelectorAll<HTMLElement>('[data-focusable][data-key]'))
      .find((item) => item.dataset.key === key) ?? null;
  }

  async open(account: PlaylistEntry | null, query = ''): Promise<void> {
    this.active = true;
    // Another task may have started a new, empty worker since the index was built.
    const generation = appWorkerGeneration();
    if (generation === null || generation !== this.workerIndexedGeneration) {
      this.invalidateWorkerIndex();
    }
    const reuseWorkerIndex = this.canReuseWorkerIndex(account);
    if (!this.releaseWorker) this.releaseWorker = retainAppWorker();
    this.cancelScheduledQuery();
    if (this.catalogLoad && this.catalogLoad.accountId !== account?.id) this.abortCatalogLoad();
    if (this.loadedFor !== account?.id) {
      this.allVod = [];
      this.allSeries = [];
      this.vodCache = null;
      this.seriesCache = null;
      this.vodRecord = null;
      this.seriesRecord = null;
      this.loadedFor = null;
      this.catalogExpiresAt = 0;
    }
    // Reopened over the same search, as after a PIN or a list change: shown AI
    // results stay and run again on the new lists; only a running one stops.
    const ask = this.ask;
    const keep = ask.phase === 'shown' && account?.id === this.account?.id && ask.query === query.trim();
    this.account = account;
    if (!keep) this.cancelAsk();
    this.query = query;
    if (!reuseWorkerIndex) {
      this.pendingIndex = { channels: true, programmes: true, catalog: !!account };
      this.clearResults();
    }
    this.render();
    if (reuseWorkerIndex) {
      this.logIndexReady('reused');
      if (account && Date.now() >= this.catalogExpiresAt) this.refreshCatalogIndex(account);
      return;
    }

    const sessionId = ++this.workerSession;
    if (this.workerPrograms) {
      // They belong to the previous worker session; the page has no index yet.
      this.workerPrograms = null;
      this.indexedChannels = null;
      this.indexedGuideRevision = null;
    }
    this.invalidateWorkerIndex();
    this.workerIndexLost = false;
    this.lostSources = null;
    this.completingPartial = null;
    this.recoveryRetry = null;
    const now = Date.now();
    this.indexStats = { startedAt: now, hintAt: query.trim() ? now : 0, persisted: 0, built: 0, posted: 0 };
    this.workerChannels = null;
    const workerReset = new Promise<boolean>((resolve, reject) => {
      requestAnimationFrame(() => {
        if (!this.active || sessionId !== this.workerSession) {
          resolve(false);
          return;
        }
        this.indexWorker({ sessionId, reset: true }).then(resolve, reject);
      });
    });
    const primary = this.indexChannelsAndProgrammes(sessionId, workerReset).catch((error: unknown) => {
      if (sessionId !== this.workerSession) return;
      // Queries rebuild a lost index themselves; don't leave the hint up.
      log.error('Search index build failed', 'event=search.worker.index.failed', error);
      this.indexLost(sessionId, 'error', 'channels', 'programmes');
    });
    if (account) {
      this.catalogLoading = true;
      this.catalogGate = primary;
      // A list the page loads and posts holds the UI thread for seconds, so
      // channels and programs get indexed, and answer, first. The worker
      // loads and reads a catalog record off this thread meanwhile.
      const ahead = typeof Worker === 'undefined' ? primary : Promise.resolve();
      const catalogIndexed = ahead.then(() => {
        if (sessionId !== this.workerSession) return false;
        return this.loadCatalog(account).then(async (sources) => {
          if (!await workerReset || sessionId !== this.workerSession) return false;
          if (!isRecordList(this.allVod) || !isRecordList(this.allSeries)) await primary;
          if (sessionId !== this.workerSession) return false;
          return this.indexCatalog(sessionId, sources.movies, sources.series);
        });
      });
      const settled = (indexed: boolean): void => {
        if (sessionId !== this.workerSession) return;
        this.catalogLoading = false;
        if (indexed) this.indexSettled(sessionId, 'catalog');
        else this.indexLost(sessionId, 'rejected', 'catalog');
        this.applyPendingFocus();
      };
      catalogIndexed.then(settled, () => {
        if (sessionId !== this.workerSession) return;
        this.catalogLoading = false;
        this.indexLost(sessionId, 'error', 'catalog');
        this.applyPendingFocus();
      });
    }
    await primary;
  }

  private async indexChannelsAndProgrammes(
    sessionId: number,
    workerReset: Promise<boolean>,
  ): Promise<void> {
    const reset = await workerReset;
    if (!reset || !this.active || sessionId !== this.workerSession) return;
    const channels = PlaylistService.channels;
    const complete = PlaylistService.complete;
    let posted = false;
    const postChannels = (): Promise<boolean> => {
      posted = true;
      return this.postSource(
        sessionId,
        'channels',
        channels.length,
        index => channelDocument(channels[index]),
      );
    };
    const cachedChannels = cachedChannelsRequest(channels, PlaylistService.getChannelCacheSource());
    this.workerChannelsCached = false;
    const channelsIndexed = cachedChannels
      ? await this.indexWorkerFromCache({ sessionId, cachedChannels }, postChannels)
      : await postChannels();
    if (!channelsIndexed) {
      this.indexLost(sessionId, 'rejected', 'channels', 'programmes');
      return;
    }
    if (!this.active || sessionId !== this.workerSession) return;
    this.workerChannels = channels;
    this.workerChannelsComplete = complete;
    this.workerChannelsCached = !posted;
    this.indexSettled(sessionId, 'channels');
    this.programIndexDone(sessionId, await this.buildProgramIndex(false, sessionId));
  }

  /** The tab bar's search box drives the query; re-render the results for it. */
  async setQuery(query: string): Promise<void> {
    this.focusPending = false;
    this.cancelScheduledQuery();
    this.leaveAskFor(query);
    this.query = query;
    this.expansion.plan(query);
    if (!query.trim()) {
      this.clearResults();
      this.render();
      return;
    }
    await this.startQuery(this.queryGeneration);
  }

  scheduleQuery(query: string): void {
    this.focusPending = false;
    this.leaveAskFor(query);
    this.query = query;
    this.expansion.plan(query);
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
    this.indexedGuideRevision = null;
    if (!this.active) return;
    const sessionId = this.workerSession;
    // A settle this build caused runs the query itself; otherwise the
    // results shown may come from the index this build replaced. A build a
    // newer one replaced leaves the query to that one (#5).
    let requeried = false;
    try {
      const indexed = await this.buildProgramIndex(true, sessionId);
      const settling = this.queryGeneration;
      this.programIndexDone(sessionId, indexed);
      requeried = indexed === null || this.queryGeneration !== settling;
      // A reopen may reuse the worker's index for the guide it now holds.
      if (indexed && this.workerIndexReady && !this.workerIndexLost && sessionId === this.workerSession
        && this.indexedChannels === this.workerIndexedChannels) {
        this.workerIndexedGuideRevision = this.indexedGuideRevision;
      }
    } catch (error) {
      log.error('Search program index failed', 'event=search.worker.index.failed', 'scope=programmes', error);
      this.indexLost(sessionId, 'error', 'programmes');
    }
    if (!requeried && this.active && sessionId === this.workerSession && !this.pendingIndex
      && this.query.trim()) {
      await this.startQuery(++this.queryGeneration);
    }
  }

  beginChannelLoad(): void {
    this.channelLoad = true;
  }

  // Indexes the channels a load finished while Search was open. The results
  // on screen, their focus, and how many are shown stay until the query
  // reruns on the new list.
  async refreshChannels(): Promise<void> {
    this.channelLoad = false;
    if (!this.active) return;
    if (this.canReuseWorkerIndex(this.account)) {
      // The load left the list as it was; only the loading hint goes.
      this.render();
      return;
    }
    // A channel build in flight or a lost index starts over; a catalog or
    // guide still indexing carries on and settles the index itself.
    if (this.pendingIndex?.channels || this.workerIndexLost
      || (!this.pendingIndex && !this.workerIndexReady)) {
      this.queryPending = !!this.query.trim();
      await this.open(this.account, this.query);
      return;
    }
    const sessionId = this.workerSession;
    const repost = { sessionId, done: this.repostChannels(sessionId) };
    this.channelRepost = repost;
    try {
      await repost.done;
    } finally {
      if (this.channelRepost === repost) this.channelRepost = null;
    }
    if (!this.active || sessionId !== this.workerSession) return;
    if (!this.query.trim()) {
      this.render();
      return;
    }
    this.requery(true);
  }

  private async repostChannels(sessionId: number): Promise<void> {
    const channels = PlaylistService.channels;
    const complete = PlaylistService.complete;
    this.invalidateWorkerIndex();
    this.workerChannelsCached = false;
    const posted = await this.postSource(
      sessionId,
      'channels',
      channels.length,
      index => channelDocument(channels[index]),
    );
    if (sessionId !== this.workerSession) return;
    if (!posted) {
      this.workerIndexLost = true;
      return;
    }
    this.workerChannels = channels;
    this.workerChannelsComplete = complete;
    // Program results point at channel indexes, so they follow the new list.
    let programs = await this.buildProgramIndex(true, sessionId);
    // A guide that landed meanwhile restarted the build; the repost still
    // owns marking the index ready, so it builds again.
    while (programs === null && this.active && sessionId === this.workerSession) {
      programs = await this.buildProgramIndex(true, sessionId);
    }
    if (sessionId !== this.workerSession || programs === null) return;
    if (this.pendingIndex) {
      this.programIndexDone(sessionId, programs);
      return;
    }
    if (!programs) {
      this.workerIndexLost = true;
      return;
    }
    this.markWorkerIndexReady(this.account);
  }

  refreshLocks(): void {
    if (!this.container.querySelector('.search-view')) return;
    // A rule change can lock a name the shown AI filter picked: run it again.
    if (this.active && this.askShownFor(this.query)) {
      void this.startQuery(++this.queryGeneration);
      return;
    }
    this.render();
  }

  // Locked content was hidden or revealed: drop the rendered results at once,
  // since their indexes point into the old channel list, then search again.
  async refreshConcealment(): Promise<void> {
    this.invalidateCatalog();
    if (!this.active) return;
    this.queryPending = !!this.query.trim();
    await this.open(this.account, this.query);
  }

  invalidateCatalog(): void {
    this.abortCatalogLoad();
    this.pendingIndex = null;
    this.completingPartial = null;
    this.workerSession++;
    this.recoveryRetry = null;
    this.allVod = [];
    this.allSeries = [];
    this.vodCache = null;
    this.seriesCache = null;
    this.vodRecord = null;
    this.seriesRecord = null;
    this.delivered = deliveredItems(-1);
    this.loadedFor = null;
    this.nav.resetRecovery();
    this.clearResults();
    this.invalidateWorkerIndex();
  }

  dismissPrompt(): void {
    this.resumePrompt.hide();
  }

  private abortRecordFallback(): void {
    this.recordFallback?.abort();
    this.recordFallback = null;
  }

  /** Search shows again: rows rendered while translation was off elsewhere translate now. */
  syncTranslation(): void {
    if (this.active && ProgramTranslation.active && inShownView(this.container)) this.render();
  }

  /** Search no longer shows: what its rows showed is not sent. */
  releaseTranslation(): void {
    ProgramTranslation.release(this);
  }

  deactivate(): void {
    this.active = false;
    this.releaseTranslation();
    this.expansion.cancel();
    this.cancelAsk();
    this.abortRecordFallback();
    this.focusPending = false;
    this.programIndexGeneration++;
    this.recoveryRetry = null;
    this.releaseWorker?.();
    this.releaseWorker = null;
    this.queryPending = false;
    this.delivered = deliveredItems(-1);
  }

  handleAction(action: Action): void {
    this.focusPending = false;
    if (this.resumePrompt.visible) {
      this.resumePrompt.handleAction(action);
      return;
    }
    if (isFocusMove(action) && this.nav.showConcealed()) return;
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
        if (this.ask.phase === 'loading' || this.ask.phase === 'shown') {
          this.exitAsk();
          return;
        }
        this.handlers.onBack();
        return;
      default:
        return;
    }
  }

  // Load the whole catalogs once per account (cached in IndexedDB). A reopen
  // shares the load in flight; only an account switch or a concealment change
  // aborts it, so a stale load can't clobber the current account's catalog.
  private loadCatalog(account: PlaylistEntry): Promise<CatalogSources> {
    if (this.loadedFor === account.id && Date.now() < this.catalogExpiresAt) {
      return Promise.resolve({ movies: true, series: true });
    }
    if (this.catalogLoad?.accountId === account.id) return this.catalogLoad.promise;
    const controller = new AbortController();
    this.catalogController = controller;
    const promise = this.fetchCatalog(account, controller.signal);
    const load = { accountId: account.id, promise };
    this.catalogLoad = load;
    const done = (): void => {
      if (this.catalogLoad === load) this.catalogLoad = null;
      if (this.catalogController === controller) this.catalogController = null;
    };
    promise.then(done, done);
    return promise;
  }

  private async fetchCatalog(account: PlaylistEntry, signal: AbortSignal): Promise<CatalogSources> {
    const [vod, series] = await Promise.all([
      captureCatalogLoad(loadCatalogSource(account, signal, syncAllVodStreams, loadAllVodStreams, this.awaitCatalogGate)),
      captureCatalogLoad(loadCatalogSource(account, signal, syncAllSeries, loadAllSeries, this.awaitCatalogGate)),
    ]);
    if (signal.aborted || this.account?.id !== account.id
      || this.catalogController?.signal !== signal) return { movies: false, series: false };
    const concealing = ParentalControlService.concealing;
    if (vod.ok && vod.data.record) {
      const record = {
        record: vod.data.record,
        concealment: ParentalControlService.catalogConcealment('vod', account.id),
      };
      if (!sameCatalogRecord(this.vodRecord, record)) this.allVod = recordList();
      this.vodRecord = record;
      this.vodCache = null;
    } else if (vod.ok && vod.data.data) {
      const visible = selectCatalogItems(vod.data.data, concealing, isVodConcealed);
      const cache = cachedNamesRequest(vod.data.data, visible.items, visible.selection);
      if (!sameCatalogSource(this.vodCache, cache)) this.allVod = visible.items;
      this.vodRecord = null;
      this.vodCache = cache;
    } else if (!vod.ok) {
      log.error(
        'Movie search catalog load failed',
        'event=xtream.search.load.failed',
        'resource=movies',
        vod.error,
      );
    }
    if (series.ok && series.data.record) {
      const record = {
        record: series.data.record,
        concealment: ParentalControlService.catalogConcealment('series', account.id),
      };
      if (!sameCatalogRecord(this.seriesRecord, record)) this.allSeries = recordList();
      this.seriesRecord = record;
      this.seriesCache = null;
    } else if (series.ok && series.data.data) {
      const visible = selectCatalogItems(series.data.data, concealing, isSeriesConcealed);
      const cache = cachedNamesRequest(series.data.data, visible.items, visible.selection);
      if (!sameCatalogSource(this.seriesCache, cache)) this.allSeries = visible.items;
      this.seriesRecord = null;
      this.seriesCache = cache;
    } else if (!series.ok) {
      log.error(
        'Series search catalog load failed',
        'event=xtream.search.load.failed',
        'resource=series',
        series.error,
      );
    }
    if (vod.ok && series.ok) {
      const expiresAt = await getSearchCatalogExpiresAt(account.id) ?? 0;
      if (signal.aborted || this.account?.id !== account.id
        || this.catalogController?.signal !== signal) return { movies: false, series: false };
      this.loadedFor = account.id;
      this.catalogExpiresAt = expiresAt;
      log.debug(
        'catalog loaded',
        vod.data.data?.length ?? 'record',
        'movies,',
        series.data.data?.length ?? 'record',
        'series',
      );
    }
    return { movies: vod.ok, series: series.ok };
  }

  private abortCatalogLoad(): void {
    this.abortRecordFallback();
    this.catalogController?.abort();
    this.catalogController = null;
    this.catalogLoad = null;
    this.catalogLoading = false;
  }

  // A stale catalog was served at once and has now been re-fetched: index the
  // new copy for an open Search, or leave it for the next open.
  private onCatalogRefreshed(key: string, changed = true): void {
    const account = this.account;
    if (!account || this.loadedFor !== account.id) return;
    if (key !== `${account.id}|vod_all` && key !== `${account.id}|series_all`) return;
    if (!changed) {
      void getSearchCatalogExpiresAt(account.id).then(expiresAt => {
        if (this.account?.id === account.id && this.loadedFor === account.id) {
          this.catalogExpiresAt = expiresAt ?? 0;
        }
      }).catch((error: unknown) => {
        log.error('Search catalog refresh failed', 'event=search.worker.index.failed', 'scope=catalog', error);
      });
      return;
    }
    this.loadedFor = null;
    this.catalogExpiresAt = 0;
    this.abortCatalogLoad();
    if (!this.active || this.pendingIndex) return;
    this.refreshCatalogIndex(account);
  }

  private refreshCatalogIndex(account: PlaylistEntry): void {
    const sessionId = this.workerSession;
    const refreshed = async (indexed: boolean, reason = 'rejected'): Promise<void> => {
      if (!this.active || sessionId !== this.workerSession || this.account?.id !== account.id) return;
      if (!indexed) this.indexLost(sessionId, reason, 'catalog');
      else if (this.workerIndexReady) this.markWorkerIndexReady(account);
      if (this.query.trim()) await this.startQuery(++this.queryGeneration);
    };
    void this.loadCatalog(account).then(async (sources) => {
      if (!this.active || sessionId !== this.workerSession || this.account?.id !== account.id) return;
      if (this.workerIndexLost) {
        // The rebuild re-reads the lists; a post of this copy could land after its own.
        if (this.query.trim()) await this.startQuery(++this.queryGeneration);
        return;
      }
      const movies = sources.movies && this.indexedVod !== this.allVod;
      const series = sources.series && this.indexedSeries !== this.allSeries;
      if (movies || series) await refreshed(await this.indexCatalog(sessionId, movies, series));
    }).catch(async (error: unknown) => {
      log.error('Search catalog refresh failed', 'event=search.worker.index.failed', 'scope=catalog', error);
      await refreshed(false, 'error');
    });
  }

  // null: a newer program index build took over and settles instead.
  private programIndexDone(sessionId: number, indexed: boolean | null): void {
    if (indexed) this.indexSettled(sessionId, 'programmes');
    else if (indexed === false) this.indexLost(sessionId, 'rejected', 'programmes');
  }

  // The sources are settled but the worker may hold a partial index: the
  // first query after the last pending source rebuilds it whole.
  private indexLost(sessionId: number, reason: string, ...sources: Array<keyof PendingIndex>): void {
    if (sessionId !== this.workerSession) return;
    for (const source of sources) {
      log.warn(
        'Search index incomplete; the next query rebuilds it',
        'event=search.index.lost',
        `session=${String(sessionId)}`,
        `source=${source}`,
        `reason=${reason}`,
      );
    }
    this.workerIndexLost = true;
    if (this.pendingIndex) {
      this.lostSources = { ...this.lostSources };
      for (const source of sources) this.lostSources[source] = true;
    }
    this.indexSettled(sessionId, ...sources);
  }

  private logIndexReady(mode: string): void {
    const stats = this.indexStats;
    const now = Date.now();
    const fields = mode === 'reused'
      ? []
      : [
        `persisted=${String(stats.persisted)}`,
        `built=${String(stats.built)}`,
        `posted=${String(stats.posted)}`,
        `elapsedMs=${String(now - stats.startedAt)}`,
        `hintMs=${String(stats.hintAt ? now - stats.hintAt : 0)}`,
      ];
    log.info(
      'Search index ready',
      'event=search.index.ready',
      `session=${String(this.workerSession)}`,
      `mode=${mode}`,
      `channels=${String(PlaylistService.channels.length)}`,
      `programmes=${String(this.programCount())}`,
      `items=${String(this.allVod.length + this.allSeries.length)}`,
      ...fields,
      `catalog=${this.vodRecord || this.seriesRecord ? 'record' : 'list'}`,
    );
  }

  private indexMode(): string {
    const stats = this.indexStats;
    if (this.workerIndexLost) return 'lost';
    if (stats.posted) return 'fallback';
    if (stats.built) return 'cache';
    return 'persisted';
  }

  private indexSettled(sessionId: number, ...sources: Array<keyof PendingIndex>): void {
    const pending = this.pendingIndex;
    if (!pending || sessionId !== this.workerSession) return;
    const wasPartial = this.partialIndex();
    for (const source of sources) pending[source] = false;
    if (pending.channels) return;
    if (pending.programmes || pending.catalog) {
      // Channels answer at once; programs and the catalog join as they land.
      if (this.active && this.query.trim()) this.requery(wasPartial);
      return;
    }
    this.pendingIndex = null;
    this.logIndexReady(this.indexMode());
    if (!this.workerIndexLost) this.markWorkerIndexReady(this.account);
    if (!this.active) return;
    if (!this.query.trim()) {
      this.render();
      return;
    }
    this.requery(wasPartial);
  }

  private requery(wasPartial: boolean): void {
    const generation = ++this.queryGeneration;
    if (!wasPartial) {
      void this.startQuery(generation);
      return;
    }
    // Keep the partial results on screen, and their focus, until the fuller set replaces them.
    this.completingPartial = generation;
    void this.startQuery(generation, true).then(() => {
      if (this.completingPartial === generation) this.completingPartial = null;
      if (generation !== this.queryGeneration) return;
      this.applyPendingFocus();
    });
  }

  // The playlist is still loading, or its full list is being indexed and
  // searched again: channel results may still change.
  private channelsArriving(): boolean {
    return this.channelLoad
      || this.channelRepost?.sessionId === this.workerSession
      || this.completingPartial !== null;
  }

  // Channels are searchable while programs or the catalog still load.
  private partialIndex(): boolean {
    const pending = this.pendingIndex;
    if (!pending || pending.channels || !(pending.programmes || pending.catalog)) return false;
    return !this.workerIndexLost || (!!this.lostSources && !this.lostSources.channels);
  }

  private onSelect(): void {
    const el = this.nav.focused;
    // A result a re-render removed opens nothing; the next arrow recovers focus.
    if (!el || !this.container.contains(el)) return;
    if (el.classList.contains('search-input')) {
      const input = el as HTMLInputElement;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (el.dataset.searchAsk !== undefined) {
      this.onAskAction(el);
      return;
    }
    // Only a query that opened something is worth remembering, not every keystroke.
    const query = this.query;
    if (el.dataset.channelIndex !== undefined) {
      const index = parseInt(el.dataset.channelIndex, 10);
      const channel = PlaylistService.channels[index];
      if (channel) rememberQuery(query, liveParentalRequest(channel));
      this.handlers.onPlayChannel(index);
    } else if (el.dataset.programIndex !== undefined) {
      void this.activateProgram(parseInt(el.dataset.programIndex, 10), query);
    } else if (this.account && el.dataset.streamId !== undefined) {
      const v = this.visibleMovies.find((x) => x.streamId === el.dataset.streamId);
      if (!v) return;
      rememberQuery(query, catalogParentalRequest('vod', { ...v, id: v.streamId }));
      this.handlers.onOpenMovie(this.account, v);
    } else if (this.account && el.dataset.seriesId !== undefined) {
      const s = this.visibleSeries.find((x) => x.seriesId === el.dataset.seriesId);
      if (!s) return;
      rememberQuery(query, catalogParentalRequest('series', { ...s, id: s.seriesId }));
      this.handlers.onOpenSeries(this.account, s);
    }
  }

  /** Move focus into the first result (called when the tab bar's search box
   *  hands off with Enter / Down). */
  focusFirstResult(): void {
    this.focusPending = true;
    this.focusWaitingInBox = false;
    if (this.queryFrame !== null) {
      this.cancelScheduledQuery();
      void this.startQuery(this.queryGeneration);
      return;
    }
    this.applyPendingFocus();
  }

  // Waits out superseded queries and a catalog still loading: only a render of
  // the latest query with something to focus completes the handoff.
  private applyPendingFocus(): void {
    if (!this.focusPending || !this.active || this.queryPending) return;
    // Enter from the box opens results; the AI search, which spends a
    // request, takes the focus only when there are none.
    const first = this.container.querySelector<HTMLElement>('.search-results [data-focusable]:not([data-search-ask])')
      ?? this.container.querySelector<HTMLElement>('.search-results [data-search-ask]');
    if (!first && (this.catalogLoading || this.pendingIndex || this.channelsArriving())) {
      // Wait in the search box, not on a blank screen, for the catalog or channels.
      if (!this.focusWaitingInBox) {
        this.focusWaitingInBox = true;
        this.handlers.onRevealTabBar();
      }
      return;
    }
    const waited = this.focusWaitingInBox;
    this.focusWaitingInBox = false;
    this.focusPending = false;
    // Nothing matched: keep the remote in the search box, not on a blank screen.
    if (!first) {
      if (!waited) this.handlers.onRevealTabBar();
      return;
    }
    if (waited) {
      // The remote moved on from the box meanwhile: don't pull it back.
      if (!document.activeElement?.classList.contains('tab-bar-search-input')) return;
      this.handlers.onReleaseTabBar();
    }
    this.nav.focus(first);
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
    this.railWindows.set(key, this.railWindow(items.length, range));
    // Left and Right stop at a section's ends; only Up and Down leave it.
    return html`
      <div class="catalog-rail" data-nav-container data-nav-leave-left="" data-nav-leave-right="">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track search-virtual-rail ${
               key === 'channels-rail' ? 'search-channel-rail' : ''
             }"
             data-edge-scroll data-search-virtual="${key}" data-search-axis="horizontal">
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
      <div class="search-virtual-section ${key === 'programmes' ? 'search-programs' : ''}" data-nav-container data-nav-leave-left="" data-nav-leave-right="">
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
        <div class="catalog-poster-wrap">${this.posterCell(ch.name, ch.logo)}${
          raw(channelLockBadge(ch))}</div>
        <div class="catalog-tile-name">${ch.name}</div>
      </div>
    `;
  }

  private movieTile(v: VodItem): ReturnType<typeof html> {
    return html`
      <div class="catalog-tile" data-focusable data-key="v:${v.streamId}" data-stream-id="${v.streamId}">
        <div class="catalog-poster-wrap">${this.posterCell(v.name, v.poster)}${
          raw(vodLockBadge(v))}</div>
        <div class="catalog-tile-name">${v.name}</div>
      </div>
    `;
  }

  private seriesTile(s: SeriesItem): ReturnType<typeof html> {
    return html`
      <div class="catalog-tile" data-focusable data-key="s:${s.seriesId}" data-series-id="${s.seriesId}">
        <div class="catalog-poster-wrap">${this.posterCell(s.name, s.poster)}${
          raw(seriesLockBadge(s))}</div>
        <div class="catalog-tile-name">${s.name}</div>
      </div>
    `;
  }

  private async buildProgramIndex(force: boolean, sessionId: number): Promise<boolean | null> {
    const matched = await this.matchProgrammesInWorker(sessionId);
    if (matched !== 'fallback') return matched;
    if (!force
        && !this.workerPrograms
        && this.indexedChannels === PlaylistService.channels
        && this.indexedGuideRevision === EpgService.guideRevision) {
      return this.indexProgrammes(sessionId);
    }
    if (!await this.collectProgramIndex()) return null;
    return this.indexProgrammes(sessionId);
  }

  // The worker matches the cached channels to the guide and indexes their
  // programmes, so the page walks no channel. 'fallback': the page builds
  // the program index itself.
  private async matchProgrammesInWorker(sessionId: number): Promise<boolean | null | 'fallback'> {
    const channels = PlaylistService.channels;
    let verdict = this.pageProgrammesFor;
    if (verdict && (verdict.channels !== channels || verdict.guideRevision !== EpgService.guideRevision)) {
      // Its channel list or guide is gone; don't keep the old list alive.
      this.pageProgrammesFor = verdict = null;
    }
    if (verdict || !this.workerChannelsCached || this.workerChannels !== channels || sessionId !== this.workerSession) {
      return 'fallback';
    }
    const sources = EpgService.searchGuideSources();
    if (!sources) return 'fallback';
    const generation = ++this.programIndexGeneration;
    const guideRevision = EpgService.guideRevision;
    const samples = sampleIndices(channels.length).map((index): [number, string, number] => {
      const [key, count] = EpgService.searchMatchSample(channels[index]);
      return [index, key, count];
    });
    let response;
    try {
      response = await runAppWorkerTask('search.index', {
        sessionId,
        guideProgrammes: { sources, mappings: channelMappings(), samples },
      });
    } catch {
      return 'fallback';
    }
    void persistSearchIndexes(response.persist);
    if (!this.active || generation !== this.programIndexGeneration) return null;
    if (!response.accepted || sessionId !== this.workerSession) return false;
    if (response.loaded) {
      this.indexStats.persisted += response.loaded.persisted;
      this.indexStats.built += response.loaded.built;
    }
    const runs = response.programmeRuns;
    if (!runs) {
      const reason = response.unresolved?.find(entry => entry.source === 'programmes')?.reason ?? 'no_runs';
      log.info(
        'Search guide matching unavailable in the worker; matching on the page',
        'event=search.worker.cache.fallback',
        `session=${String(sessionId)}`,
        'source=programmes',
        `reason=${reason}`,
      );
      return 'fallback';
    }
    this.workerPrograms = workerPrograms(channels, guideRevision, runs);
    this.programIndex = [];
    this.programRuns = new ProgrammeRuns();
    this.indexedChannels = channels;
    this.indexedGuideRevision = guideRevision;
    return true;
  }

  // Builds the page's own program index; false when a newer build took over.
  // A caller asking for the same lists joins the build still running, so two
  // retrying callers never keep replacing each other's build.
  private collectProgramIndex(): Promise<boolean> {
    const channels = PlaylistService.channels;
    const guideRevision = EpgService.guideRevision;
    const running = this.programBuild;
    if (running && running.generation === this.programIndexGeneration
      && running.channels === channels && running.guideRevision === guideRevision) {
      return running.done;
    }
    const generation = ++this.programIndexGeneration;
    const build = { generation, channels, guideRevision, done: this.buildPageProgramIndex(generation) };
    this.programBuild = build;
    const finished = (): void => {
      if (this.programBuild === build) this.programBuild = null;
    };
    build.done.then(finished, finished);
    return build.done;
  }

  private async buildPageProgramIndex(generation: number): Promise<boolean> {
    const channels = PlaylistService.channels;
    const guideRevision = EpgService.guideRevision;
    const programs: ProgramResult[] = [];
    const runs = new ProgrammeRuns();
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
      channelPrograms = epgId ? EpgService.getProgrammes(epgId) ?? [] : [];
      programmeIndex = 0;
      if (epgId && channelPrograms.length) {
        runs.add(channelIndex - 1, EpgService.programmeCacheOrigin(epgId), channelPrograms.length);
      }
      return false;
    }, { shouldContinue });
    if (!collected) return false;

    this.programIndex = programs;
    this.programRuns = runs;
    this.workerPrograms = null;
    this.indexedChannels = channels;
    this.indexedGuideRevision = guideRevision;
    return true;
  }

  // The page ranks or posts programmes itself only on a fallback path.
  // False when Search closed or a newer build took over meanwhile.
  private async ensureProgramIndex(): Promise<boolean> {
    const current = !this.workerPrograms
      && this.indexedChannels === PlaylistService.channels
      && this.indexedGuideRevision === EpgService.guideRevision;
    return current || this.collectProgramIndex();
  }

  private programCount(): number {
    return this.workerPrograms ? this.workerPrograms.total : this.programIndex.length;
  }

  private programsAt(indices: number[]): ProgramResult[] {
    const runs = this.workerPrograms;
    if (!runs) return itemsAt(this.programIndex, indices);
    // A newer guide is being matched; its refresh reruns the query.
    if (runs.guideRevision !== EpgService.guideRevision) return [];
    const results: ProgramResult[] = [];
    for (const index of indices) {
      const result = workerProgramAt(runs, index);
      if (result) results.push(result);
    }
    const missed = indices.length - results.length;
    const verdict = this.pageProgrammesFor;
    if (missed && !(verdict && verdict.channels === runs.channels && verdict.guideRevision === runs.guideRevision)) {
      // The worker read a guide that differs from the one shown; the page
      // matches these programmes itself, and a reopen must not reuse them (#1).
      this.pageProgrammesFor = { channels: runs.channels, guideRevision: runs.guideRevision };
      // A reopen must not reuse these programmes; this session keeps its index.
      this.workerIndexedGuideRevision = null;
      log.warn(
        'Search programme results did not match the guide; rebuilding them on the page',
        'event=search.programmes.stale',
        `session=${String(this.workerSession)}`,
        `missed=${String(missed)}`,
      );
      void this.refreshPrograms();
    }
    return results;
  }

  private indexProgrammes(sessionId: number): Promise<boolean> {
    const programs = this.programIndex;
    const postProgrammes = (): Promise<boolean> => this.postSource(
      sessionId,
      'programmes',
      programs.length,
      index => programDocument(programs[index]),
    );
    // Cached programme documents join the worker's channel documents, so
    // they must come from the very channel list the program index walked.
    const cachedProgrammes = this.workerChannels === this.indexedChannels
      && sessionId === this.workerSession
      ? this.programRuns.request(
        sampleDocuments(programs.length, index => programDocument(programs[index])),
      )
      : null;
    return cachedProgrammes
      ? this.indexWorkerFromCache({ sessionId, cachedProgrammes }, postProgrammes)
      : postProgrammes();
  }

  private async indexCatalog(sessionId: number, movies: boolean, series: boolean): Promise<boolean> {
    const vod = this.allVod;
    const allSeries = this.allSeries;
    // A newer refresh may have replaced a list; its own index adopts that one.
    const adopt = (sources: SearchIndexSource[]): void => {
      if (sessionId !== this.workerSession) return;
      if (sources.indexOf('movies') >= 0 && vod === this.allVod) this.indexedVod = vod;
      if (sources.indexOf('series') >= 0 && allSeries === this.allSeries) this.indexedSeries = allSeries;
    };
    const post = async (sources: SearchIndexSource[]): Promise<boolean> => {
      for (const source of sources) {
        let items: Array<{ name: string }> = source === 'movies' ? vod : allSeries;
        // A newer refresh replaced this list and posts its own; an older post
        // landing after it would leave the worker on the older list.
        if (items !== (source === 'movies' ? this.allVod : this.allSeries)) continue;
        if (isRecordList(items)) {
          const group = source === 'movies' ? 'movies' : 'series';
          const list = await this.leaveRecordMode(sessionId, group);
          if (list === 'replaced') continue;
          if (list === 'synced') {
            const record = group === 'movies' ? this.vodRecord : this.seriesRecord;
            if (!record) return false;
            const retry: SearchIndexRequest = group === 'movies'
              ? { sessionId, catalogMovies: record }
              : { sessionId, catalogSeries: record };
            if (!await this.indexWorkerFromCache(retry, post, adopt)) return false;
            continue;
          }
          if (!list) return false;
          items = list;
        }
        const names = items;
        const result = this.postSource(sessionId, source, names.length, index => names[index].name);
        const own = this.sourcePosts[source];
        if (!await result) return false;
        // A newer post replaced this one and shares its outcome, not its list.
        if (this.sourcePosts[source] === own && sessionId === this.workerSession) {
          if (source === 'movies') this.indexedVod = names as VodItem[];
          else this.indexedSeries = names as SeriesItem[];
        }
      }
      return true;
    };
    const request: SearchIndexRequest = { sessionId };
    const posted: SearchIndexSource[] = [];
    if (movies && this.vodRecord) request.catalogMovies = this.vodRecord;
    else if (movies && this.vodCache) request.cachedMovies = this.vodCache;
    else if (movies) posted.push('movies');
    if (series && this.seriesRecord) request.catalogSeries = this.seriesRecord;
    else if (series && this.seriesCache) request.cachedSeries = this.seriesCache;
    else if (series) posted.push('series');
    if (!request.cachedMovies && !request.cachedSeries
      && !request.catalogMovies && !request.catalogSeries) return post(posted);
    const cached = await this.indexWorkerFromCache(request, post, adopt);
    return cached && post(posted);
  }

  // The worker could not read the catalog record. Syncing it again once lets
  // the worker read or fetch it; failing that, the list loads here and its
  // names are posted. 'replaced': a newer load took over the source.
  private leaveRecordMode(sessionId: number, source: 'movies' | 'series'): Promise<RecordFallback> {
    const running = this.fallbacks[source];
    if (running && running.sessionId === sessionId) return running.result;
    const result = this.fallBack(sessionId, source);
    const entry = { sessionId, result };
    this.fallbacks[source] = entry;
    const done = (): void => { if (this.fallbacks[source] === entry) delete this.fallbacks[source]; };
    result.then(done, done);
    return result;
  }

  private async fallBack(sessionId: number, source: 'movies' | 'series'): Promise<RecordFallback> {
    const account = this.account;
    if (!account || !this.active) return null;
    const standIn = source === 'movies' ? this.allVod : this.allSeries;
    const current = (): boolean => sessionId === this.workerSession
      && (source === 'movies' ? this.allVod : this.allSeries) === standIn;
    const concealing = ParentalControlService.concealing;
    if (!this.recordFallback) this.recordFallback = new AbortController();
    const signal = this.recordFallback.signal;
    try {
      if (this.resynced[source] !== sessionId) {
        this.resynced[source] = sessionId;
        const record = await (source === 'movies' ? syncAllVodStreams : syncAllSeries)(
          account, signal, this.awaitCatalogGate,
        );
        if (!current()) return 'replaced';
        const failed = source === 'movies' ? this.vodRecord : this.seriesRecord;
        // The same reference would only fail the same way again.
        if (record && !(failed && sameCacheRef(failed.record, record))) {
          const kind = source === 'movies' ? 'vod' : 'series';
          const catalog = { record, concealment: ParentalControlService.catalogConcealment(kind, account.id) };
          if (source === 'movies') this.vodRecord = catalog;
          else this.seriesRecord = catalog;
          return 'synced';
        }
      }
      // A list landing on this thread waits for the channels and programs.
      await this.awaitCatalogGate();
      if (!current()) return 'replaced';
      if (source === 'movies') {
        const data = await loadAllVodStreams(account, signal);
        if (!current()) return 'replaced';
        this.allVod = selectCatalogItems(data, concealing, isVodConcealed).items;
        this.vodRecord = null;
        return this.allVod;
      }
      const data = await loadAllSeries(account, signal);
      if (!current()) return 'replaced';
      this.allSeries = selectCatalogItems(data, concealing, isSeriesConcealed).items;
      this.seriesRecord = null;
      return this.allSeries;
    } catch (error) {
      if (signal.aborted) return null;
      log.error('Search catalog load failed', 'event=xtream.search.load.failed', `resource=${source}`, error);
      return null;
    }
  }

  private async indexWorker(request: SearchIndexRequest): Promise<boolean> {
    const pending = runAppWorkerTask('search.index', request);
    // Record the worker that took the reset, not whichever one runs when the index is marked ready.
    const generation = appWorkerGeneration();
    const response = await pending;
    const accepted = response.accepted && request.sessionId === this.workerSession;
    if (accepted && request.reset) {
      this.workerResetGeneration = generation;
      this.indexedVod = [];
      this.indexedSeries = [];
    }
    return accepted;
  }

  // The worker reads the documents from IndexedDB; whatever it could not
  // read or verify is posted as plain arrays instead.
  private async indexWorkerFromCache(
    request: SearchIndexRequest,
    post: (sources: SearchIndexSource[]) => Promise<boolean>,
    loaded?: (sources: SearchIndexSource[]) => void,
  ): Promise<boolean> {
    const response = await runAppWorkerTask('search.index', request);
    void persistSearchIndexes(response.persist);
    if (!response.accepted || request.sessionId !== this.workerSession) return false;
    if (loaded) {
      const unresolved = (response.unresolved ?? []).map(entry => entry.source);
      const sources: SearchIndexSource[] = [];
      if ((request.cachedMovies || request.catalogMovies) && unresolved.indexOf('movies') < 0) sources.push('movies');
      if ((request.cachedSeries || request.catalogSeries) && unresolved.indexOf('series') < 0) sources.push('series');
      loaded(sources);
    }
    if (response.loaded) {
      this.indexStats.persisted += response.loaded.persisted;
      this.indexStats.built += response.loaded.built;
    }
    const unresolved = response.unresolved;
    if (!unresolved?.length) return true;
    for (const entry of unresolved) {
      log.info(
        'Search index cache unavailable; posting documents',
        'event=search.worker.cache.fallback',
        `session=${String(request.sessionId)}`,
        `source=${entry.source}`,
        `reason=${entry.reason}`,
      );
    }
    return post(unresolved.map(entry => entry.source));
  }

  // The worker stages one sequence per source, so posts of a source take
  // turns; one replaced by a newer post ends early and shares its outcome.
  private postSource(
    sessionId: number,
    source: SearchIndexSource,
    total: number,
    documentAt: (index: number) => string[] | string,
  ): Promise<boolean> {
    const previous = this.sourcePosts[source];
    if (total && this.pendingIndex && sessionId === this.workerSession) this.indexStats.posted++;
    let sent = (): void => undefined;
    const post: SourcePost = {
      id: ++this.sourcePostId,
      sent: new Promise<void>(resolve => { sent = resolve; }),
      result: Promise.resolve(false),
    };
    this.sourcePosts[source] = post;
    post.result = (async (): Promise<boolean> => {
      let posts: Promise<boolean>[] | null;
      try {
        if (previous) await previous.sent;
        posts = await this.postChunks(post.id, sessionId, source, total, documentAt);
      } finally {
        sent();
      }
      if (!posts) return this.sourcePosts[source]!.result;
      const accepted = await Promise.all(posts);
      return accepted.length > 0 && accepted.every(Boolean) && sessionId === this.workerSession;
    })();
    return post.result;
  }

  // Post a source in slices, one per frame, so no single message clones
  // enough text to stall an animation. null: a newer post replaced this one.
  private async postChunks(
    id: number,
    sessionId: number,
    source: SearchIndexSource,
    total: number,
    documentAt: (index: number) => string[] | string,
  ): Promise<Promise<boolean>[] | null> {
    const size = CONFIG.SEARCH.INDEX_CHUNK_SIZE;
    const posts: Promise<boolean>[] = [];
    let start = 0;
    do {
      if (start > 0) await nextFrame();
      if (this.sourcePosts[source]?.id !== id) {
        void Promise.all(posts).catch(() => undefined);
        return null;
      }
      if (sessionId !== this.workerSession) break;
      const end = Math.min(total, start + size);
      const chunk: SearchIndexChunk = { source, start, total };
      if (source === 'movies' || source === 'series') {
        const names: string[] = [];
        for (let index = start; index < end; index++) names.push(documentAt(index) as string);
        chunk.names = names;
      } else {
        const documents: string[][] = [];
        for (let index = start; index < end; index++) documents.push(documentAt(index) as string[]);
        chunk.documents = documents;
      }
      posts.push(this.indexWorker({ sessionId, chunk }));
      start = end;
    } while (start < total);
    return posts;
  }

  // Typing settled or AI alternatives arrived for the query shown: rank it
  // again, which only appends results and sections, so focus stays.
  private applyExpansion(key: string): void {
    // Shown AI results come from the AI's filter; the expansion waits for all results.
    if (!this.active || expansionQuery(this.query) !== key || this.askShownFor(this.query)) return;
    const preserveOffsets = !this.queryPending;
    this.cancelScheduledQuery();
    this.expansionGeneration = this.queryGeneration;
    void this.startQuery(this.queryGeneration, preserveOffsets);
  }

  // Where the focused result sits, when the keys drive a ring shown in the results.
  private focusAnchor(): { key: string; top: number } | null {
    if (Focus.owner() !== this.focusScope || InputMode.current !== 'keys' || this.focusScope.concealed) return null;
    const focused = this.nav.focused;
    const key = focused && this.container.contains(focused) ? focused.getAttribute('data-key') : null;
    return key && focused ? { key, top: focused.getBoundingClientRect().top } : null;
  }

  // Chromium 53 has no scroll anchoring: scroll a focused result that results
  // added above it pushed down back to where it was, when the view is
  // scrolled already or the result would leave it, and keep it above the hint.
  private keepFocusAnchor(anchor: { key: string; top: number }): void {
    const view = this.container.querySelector<HTMLElement>('.search-view');
    const moved = Array.prototype.filter.call(
      this.container.querySelectorAll('[data-key]'),
      (el: Element) => el.getAttribute('data-key') === anchor.key,
    )[0] as HTMLElement | undefined;
    if (!view || !moved) return;
    const box = moved.getBoundingClientRect();
    const bottom = view.getBoundingClientRect().bottom;
    const shift = box.top - anchor.top;
    if (shift && (view.scrollTop > 0 || box.bottom > bottom)) view.scrollTop += shift;
    // The hint's band can take the room the result sat in.
    const below = moved.getBoundingClientRect().bottom - bottom;
    if (below > 0) view.scrollTop += below;
  }

  private startQuery(generation: number, preserveOffsets = false): Promise<void> {
    return this.runWorkerQuery(generation, preserveOffsets).catch(error => {
      log.error(
        'Search result update failed',
        'event=search.results.update.failed',
        error,
      );
    });
  }

  private async runWorkerQuery(generation: number, preserveOffsets: boolean): Promise<void> {
    const repost = this.channelRepost;
    if (repost && repost.sessionId === this.workerSession) {
      // A new query must not leave the last one's results up to be picked.
      if (!preserveOffsets && this.query.trim()) {
        this.queryPending = true;
        this.render();
      }
      await repost.done;
      if (generation !== this.queryGeneration) return;
    }
    const query = this.query;
    const sessionId = this.workerSession;
    if (!query.trim()) return;
    const partial = this.partialIndex();
    if (this.pendingIndex && !partial) {
      // The ready index runs this query; until then the hint stands in.
      if (!this.indexStats.hintAt) this.indexStats.hintAt = Date.now();
      this.render();
      this.applyPendingFocus();
      return;
    }
    if (!preserveOffsets) {
      this.queryPending = true;
      this.render();
    }
    let response: SearchQueryResponse | null = null;
    let recoveryAttempted = false;
    // A rebuild failed recently: rank on the main thread, quietly, until the delay passes.
    let retryPending = false;
    const lists = this.indexedLists();
    try {
      if (this.workerIndexLost && !partial) {
        recoveryAttempted = true;
        retryPending = this.recoveryRetryPending(sessionId);
        if (!retryPending) response = await this.recoverWorkerQuery(sessionId, query, 'lost');
      } else {
        const pending = runAppWorkerTask('search.query', this.queryRequest({
          sessionId,
          query,
          limit: CONFIG.SEARCH.RESULTS,
          includeCatalog: !!this.account && !this.pendingIndex?.catalog && !this.lostSources?.catalog,
          includeProgrammes: !this.pendingIndex?.programmes && !this.lostSources?.programmes,
        }));
        const worker = appWorkerGeneration();
        response = await pending;
        this.keepDelivered(response, worker);
      }
    } catch (error) {
      if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) return;
      recoveryAttempted = true;
      retryPending = this.recoveryRetryPending(sessionId);
      if (!retryPending) {
        log.error(
          'Search worker query failed; rebuilding its index',
          'event=search.worker.query.failed',
          'scope=unified',
          `session=${String(sessionId)}`,
          error,
        );
        response = await this.recoverWorkerQuery(sessionId, query, 'query_failed');
      }
    }
    if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) {
      return;
    }
    if (!response && !recoveryAttempted) {
      retryPending = this.recoveryRetryPending(sessionId);
    }
    if (!response && !recoveryAttempted && !retryPending) {
      log.warn(
        'Search worker lost its index; rebuilding it',
        'event=search.worker.index.missing',
        'scope=unified',
        `session=${String(sessionId)}`,
      );
      response = await this.recoverWorkerQuery(sessionId, query, 'missing');
      if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) {
        return;
      }
    }
    // AI results stand until the query changes or the viewer leaves them.
    if (this.askShownFor(query) && await this.refreshAsk(generation, sessionId, preserveOffsets)) return;
    if (response && !sameLists(lists, this.indexedLists())) {
      // The lists changed under the reply, so its indices may not map onto them.
      return this.runWorkerQuery(generation, preserveOffsets);
    }
    if (response) {
      this.applyQueryResponse(response, this.indexedVod, this.indexedSeries);
      this.catalogQuery = query;
    } else {
      if (!retryPending) {
        log.warn(
          'Worker search failed; using main-thread fallback',
          'event=search.worker.fallback.used',
          'scope=unified',
          `session=${String(sessionId)}`,
        );
      }
      const movies = this.visibleMovies;
      const series = this.visibleSeries;
      if (!await this.ensureProgramIndex()) return;
      if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) return;
      this.applyQueryResponse(this.queryLocally(query), this.allVod, this.allSeries);
      // A record cannot rank here, so the worker's last answer to this query stands.
      if (this.catalogQuery === query) {
        if (isRecordList(this.allVod)) this.visibleMovies = movies;
        if (isRecordList(this.allSeries)) this.visibleSeries = series;
      } else {
        this.catalogQuery = null;
      }
    }
    this.queryPending = false;
    // The latest query's results are the fullest; no older partial one is pending.
    if (generation === this.queryGeneration) this.completingPartial = null;
    if (!preserveOffsets) this.resetVirtualOffsets();
    // Measured right before the render, so a key pressed while it ranked counts.
    const anchor = generation === this.expansionGeneration ? this.focusAnchor() : null;
    this.render();
    if (anchor) this.keepFocusAnchor(anchor);
    this.applyPendingFocus();
    // Typing settled while this unsettled ranking ran, so the settled one the
    // pause asked for found no answer to check yet: run it now.
    const settledKey = this.moreWhenSettled;
    if (settledKey !== null && this.expansion.settledOn(query)) {
      void Promise.resolve().then(() => this.applyExpansion(settledKey));
    }
  }

  // The page's lists prepared for ranking; one set serves several queries.
  private localIndexes(): LocalIndexes {
    return {
      programs: prepareSearchItems(this.programIndex, programDocument),
      movies: prepareNameSearchItems(this.allVod),
      series: prepareNameSearchItems(this.allSeries),
    };
  }

  private queryLocally(
    query: string,
    indexes: LocalIndexes = this.localIndexes(),
    strict = false,
  ): SearchQueryResponse {
    const { RESULTS, FUZZY_FILL } = CONFIG.SEARCH;
    const alternatives = this.expansion.alternativesFor(query);
    const settled = this.expansion.settledOn(query);
    const expanded = new Set<string>();
    const channels = rankExpanded(
      expandedQueries(query, alternatives, settled ? script => PlaylistService.localSearchHasScript(script) : null),
      RESULTS,
      q => PlaylistService.searchLocalRanked(q, RESULTS, undefined, FUZZY_FILL, settled, strict).items,
      expanded,
    );
    const programs = indexes.programs;
    const programmes = rankExpanded(
      expandedQueries(query, alternatives, settled ? script => preparedHaveScript(programs, script) : null),
      RESULTS,
      q => rankPreparedTopK(programs, q, RESULTS, FUZZY_FILL, settled, strict).items,
      expanded,
    );
    const names = <T extends { name: string }>(index: PreparedNameSearchIndex<T>): T[] => {
      if (!this.account) return [];
      return rankExpanded(
        expandedQueries(query, alternatives, settled ? script => namesHaveScript(index, script) : null),
        RESULTS,
        q => rankPreparedNamesTopK(index, q, RESULTS, strict).items,
        expanded,
      );
    };
    const response: SearchQueryResponse = {
      channels: { indices: channels.map(channel => PlaylistService.indexOf(channel)) },
      programmes: { indices: indicesOf(this.programIndex, programmes) },
      movies: { indices: indicesOf(this.allVod, names(indexes.movies)) },
      series: { indices: indicesOf(this.allSeries, names(indexes.series)) },
    };
    if (expanded.size) {
      response.expanded = [];
      expanded.forEach(term => response.expanded?.push(term));
    }
    if (!settled && (hasMultilingualSynonyms(query)
        || transliterates(query, script => PlaylistService.localSearchHasScript(script))
        || transliterates(query, script => preparedHaveScript(programs, script)))) {
      response.moreWhenSettled = true;
    }
    return response;
  }


  private queryRequest(request: SearchQueryRequest): SearchQueryRequest {
    // Every worker numbers its epochs from the start, so another worker's
    // epoch could match the kept one by chance.
    if (appWorkerGeneration() !== this.deliveredWorker) this.delivered = deliveredItems(-1);
    const alternatives = this.expansion.alternativesFor(request.query);
    if (alternatives) request.alternatives = alternatives;
    if (this.expansion.settledOn(request.query)) request.settled = true;
    const kept = this.delivered;
    const cap = CONFIG.SEARCH.DELIVERED_KEEP;
    // -1 past the cap: the worker starts a new epoch, so the page drops the
    // items that earlier queries left behind.
    request.delivered = {
      epoch: kept.epoch,
      movies: kept.movies.size > cap ? -1 : kept.movies.size,
      series: kept.series.size > cap ? -1 : kept.series.size,
    };
    return request;
  }

  // Every answer's record items are kept, even one a newer query superseded:
  // the worker counts them as sent.
  private keepDelivered(response: SearchQueryResponse | null, worker: number | null): void {
    const items = response?.items;
    if (!items) return;
    this.deliveredWorker = worker;
    if (items.epoch !== this.delivered.epoch) this.delivered = deliveredItems(items.epoch);
    const kept = this.delivered;
    for (const [index, item] of items.movies) kept.movies.set(index, item);
    for (const [index, item] of items.series) kept.series.set(index, item);
  }

  private indexedLists(): unknown[] {
    return [PlaylistService.channels, this.workerPrograms ?? this.programIndex, this.indexedVod, this.indexedSeries];
  }

  private async recoverWorkerQuery(
    sessionId: number,
    query: string,
    reason: string,
  ): Promise<SearchQueryResponse | null> {
    const startedAt = Date.now();
    try {
      let recovery = this.recovery;
      const owner = !recovery || recovery.sessionId !== sessionId;
      if (!recovery || owner) {
        const rebuilt = this.rebuildWorkerIndex(sessionId);
        const current = { sessionId, done: rebuilt };
        const clear = (): void => {
          if (this.recovery === current) this.recovery = null;
        };
        // Recorded before any query waiting on the rebuild resumes.
        const failed = (): void => this.recoveryFailed(sessionId);
        rebuilt.then(done => { if (!done) failed(); }, failed);
        current.done.then(clear, clear);
        this.recovery = current;
        recovery = current;
      }
      if (!await recovery.done) return null;
      const pending = runAppWorkerTask('search.query', this.queryRequest({
        sessionId,
        query,
        limit: CONFIG.SEARCH.RESULTS,
        includeCatalog: !!this.account,
      }));
      const worker = appWorkerGeneration();
      const response = await pending;
      this.keepDelivered(response, worker);
      if (response && owner) {
        log.info(
          'Search worker recovery completed',
          'event=search.worker.recovery.completed',
          'scope=unified',
          `session=${String(sessionId)}`,
          `reason=${reason}`,
          `elapsedMs=${String(Date.now() - startedAt)}`,
        );
      }
      return response;
    } catch (error) {
      const retry = this.recoveryRetry;
      if (retry?.sessionId === sessionId) {
        if (retry.logged) return null;
        retry.logged = true;
      }
      log.error(
        'Search worker recovery failed',
        'event=search.worker.recovery.failed',
        'scope=unified',
        `session=${String(sessionId)}`,
        `reason=${reason}`,
        error,
      );
      return null;
    }
  }

  private recoveryRetryPending(sessionId: number): boolean {
    const retry = this.recoveryRetry;
    // A new worker replaced the one the rebuild failed on, so it may succeed now.
    return !!retry
      && retry.sessionId === sessionId
      && retry.generation === appWorkerGeneration()
      && performance.now() < retry.at;
  }

  private recoveryFailed(sessionId: number): void {
    if (sessionId !== this.workerSession) return;
    const retry = this.recoveryRetry;
    this.recoveryRetry = {
      sessionId,
      at: performance.now() + CONFIG.SEARCH.INDEX_RETRY_DELAY_MS,
      generation: appWorkerGeneration(),
      logged: retry?.sessionId === sessionId && retry.logged,
    };
  }

  private async rebuildWorkerIndex(sessionId: number): Promise<boolean> {
    // Its reset would wipe the newer session's index.
    if (sessionId !== this.workerSession) return false;
    // Partial until every source below is in: no refresh may mark it ready
    // or a reopen reuse it, and queries wait for this rebuild.
    this.invalidateWorkerIndex();
    this.workerIndexLost = true;
    this.lostSources = null;
    this.workerChannelsCached = false;
    if (!await this.indexWorker({ sessionId, reset: true })) return false;
    // Any list may be replaced meanwhile, and a newer post of a source may
    // carry an older list: post until the worker holds the current lists,
    // each from this rebuild's own post.
    // A guide refresh may restart the build; only a close or a new session ends it.
    let built = await this.ensureProgramIndex();
    while (!built && this.active && sessionId === this.workerSession) built = await this.ensureProgramIndex();
    if (!built || sessionId !== this.workerSession) return false;
    const posted: Partial<Record<SearchIndexSource, { list: unknown[]; post?: SourcePost }>> = {};
    let channels: Channel[];
    let channelsComplete = false;
    let changed: boolean;
    do {
      changed = false;
      const current = PlaylistService.channels;
      const programs = this.programIndex;
      const movies = this.allVod;
      const series = this.allSeries;
      channels = current;
      channelsComplete = PlaylistService.complete;
      const sources: Array<[SearchIndexSource, unknown[], (index: number) => string[] | string]> = [
        ['channels', current, index => channelDocument(current[index])],
        ['programmes', programs, index => programDocument(programs[index])],
        ['movies', movies, index => movies[index].name],
        ['series', series, index => series[index].name],
      ];
      for (const [source, list, documentAt] of sources) {
        const last = posted[source];
        if (last && last.list === list && last.post === this.sourcePosts[source]) continue;
        changed = true;
        if (isRecordList(list)) {
          // The worker reads the record again, or a fallback posts the loaded
          // list; either way the list it adopted is what it now holds.
          if (!await this.indexCatalog(sessionId, source === 'movies', source === 'series')
            || sessionId !== this.workerSession) return false;
          posted[source] = {
            list: source === 'movies' ? this.indexedVod : this.indexedSeries,
            post: this.sourcePosts[source],
          };
          continue;
        }
        const result = this.postSource(sessionId, source, list.length, documentAt);
        const post = this.sourcePosts[source];
        if (!await result || sessionId !== this.workerSession) return false;
        posted[source] = { list, post };
        if (this.sourcePosts[source] !== post) continue;
        if (source === 'movies') this.indexedVod = movies;
        if (source === 'series') this.indexedSeries = series;
      }
    } while (changed);
    // A post lost meanwhile left its source changed, so the loop reposted it.
    this.workerIndexLost = false;
    this.recoveryRetry = null;
    this.workerChannels = channels;
    this.workerChannelsComplete = channelsComplete;
    this.markWorkerIndexReady(this.account);
    // A worker match it superseded never settles the programmes itself.
    if (this.pendingIndex?.programmes) this.indexSettled(sessionId, 'programmes');
    return true;
  }

  private applyQueryResponse(
    response: SearchQueryResponse,
    vod: VodItem[],
    series: SeriesItem[],
  ): void {
    this.expandedTerms = response.expanded ?? [];
    this.moreWhenSettled = response.moreWhenSettled ? expansionQuery(this.query) : null;
    this.showResults(this.resultsOf(response, vod, series));
  }

  private resultsOf(response: SearchQueryResponse, vod: VodItem[], series: SeriesItem[]): ResultLists {
    // An answer from another epoch indexes items this page no longer keeps.
    const kept = response.items?.epoch === this.delivered.epoch ? this.delivered : null;
    return {
      channels: itemsAt(PlaylistService.channels, response.channels.indices),
      programs: this.programsAt(response.programmes.indices),
      movies: isRecordList(vod)
        ? (kept ? keptAt(kept.movies, response.movies.indices) : [])
        : itemsAt(vod, response.movies.indices),
      series: isRecordList(series)
        ? (kept ? keptAt(kept.series, response.series.indices) : [])
        : itemsAt(series, response.series.indices),
    };
  }

  private showResults(results: ResultLists): void {
    this.visibleChannels = results.channels;
    this.visiblePrograms = results.programs;
    this.visibleMovies = results.movies;
    this.visibleSeries = results.series;
  }

  private clearResults(): void {
    this.catalogQuery = null;
    this.moreWhenSettled = null;
    this.expandedTerms = [];
    this.sectionOrder = [];
    this.visibleChannels = [];
    this.visiblePrograms = [];
    this.visibleMovies = [];
    this.visibleSeries = [];
    this.queryPending = false;
    this.resetVirtualOffsets();
  }

  private canReuseWorkerIndex(account: PlaylistEntry | null): boolean {
    return this.workerIndexReady
      && !this.workerIndexLost
      && this.workerIndexedChannels === PlaylistService.channels
      && this.workerIndexedChannelsComplete
      && PlaylistService.complete
      && this.workerIndexedGuideRevision === EpgService.guideRevision
      && this.workerIndexedAccountId === (account?.id ?? null)
      && (!account
        || (this.loadedFor === account.id
          && this.workerIndexedVod === this.allVod
          && this.workerIndexedSeries === this.allSeries));
  }

  private markWorkerIndexReady(account: PlaylistEntry | null): void {
    this.workerIndexReady = true;
    // What the worker holds: the channels posted and the guide data the
    // posted program index was built from, which can trail the services'.
    this.workerIndexedChannels = this.workerChannels;
    this.workerIndexedChannelsComplete = this.workerChannelsComplete;
    this.workerIndexedGuideRevision = this.indexedChannels === this.workerChannels
      ? this.indexedGuideRevision
      : null;
    this.workerIndexedAccountId = account?.id ?? null;
    this.workerIndexedGeneration = this.workerResetGeneration;
    // What the worker holds, which trails allVod/allSeries while a refresh posts.
    this.workerIndexedVod = this.indexedVod;
    this.workerIndexedSeries = this.indexedSeries;
    log.info(
      'Search worker index ready',
      'event=search.worker.index.ready',
      'scope=unified',
      `session=${String(this.workerSession)}`,
      `channels=${String(PlaylistService.channels.length)}`,
      `programmes=${String(this.programCount())}`,
      `movies=${String(this.allVod.length)}`,
      `series=${String(this.allSeries.length)}`,
    );
  }

  private invalidateWorkerIndex(): void {
    const wasReady = this.workerIndexReady;
    this.workerIndexReady = false;
    this.workerIndexedChannels = null;
    this.workerIndexedChannelsComplete = false;
    this.workerIndexedGuideRevision = null;
    this.workerIndexedAccountId = null;
    this.workerIndexedGeneration = null;
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
        : XtreamArchiveService.isAvailable(channel, programme.start.getTime(), Date.now(), programme.catchupId) ? t('search.catchUp') : t('search.openChannel');
    return html`
      <div class="search-program-row state-${state}" data-focusable
           data-key="p:${String(result.channelIndex)}:${String(programme.start.getTime())}"
           data-program-index="${String(index)}">
        <div class="search-program-time">${day.weekday} ${day.date}<br>${formatTime(programme.start)}</div>
        <div class="search-program-body">
          <div class="search-program-title">${programTitle(programView(liveSource(channel), programme))}</div>
          <div class="search-program-channel">${channel.name}${programGenreText(programme)}</div>
        </div>
        <div class="search-program-action">${action}</div>
      </div>
    `;
  }

  private async activateProgram(index: number, query: string): Promise<void> {
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

    // A stream id alone, kept for every Xtream channel, is no catch-up.
    if (programme.stop.getTime() <= now && channel.catchupAccountId && channel.catchupStreamId
      && hasCatchup(channel) && (!!programme.catchupId || !catchupNeedsId(channel))) {
      await XtreamArchiveService.load(channel);
      if (!XtreamArchiveService.isAvailable(channel, programme.start.getTime(), Date.now(), programme.catchupId)) {
        showToast(t('epg.catchupUnavailable'));
        this.render();
        return;
      }
    }

    if (programme.stop.getTime() <= now &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime(), Date.now(), programme.catchupId)) {
      const key = channelKey(channel);
      const startMs = programme.start.getTime();
      const progress = StorageService.getCatchupProgressList(key)
        .find(entry => entry.progStart === startMs && !entry.completed);
      if (progress) {
        this.resumePrompt.show(programme.title, progress.position, {
          onResume: () => this.playProgram(result, query, progress.position),
          onStartOver: () => {
            StorageService.clearCatchupProgress(key, startMs);
            this.playProgram(result, query);
          },
          onCancel: () => { /* keep Search open */ },
        });
        return;
      }
    }
    this.playProgram(result, query);
  }

  private playProgram(result: ProgramResult, query: string, resumeSecs?: number): void {
    const { channel, channelIndex, programme } = result;
    rememberQuery(query, liveParentalRequest(channel));
    let catchup: CatchupInfo | undefined;
    if (programme.stop.getTime() <= Date.now() &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime(), Date.now(), programme.catchupId)) {
      catchup = {
        start: Math.floor(programme.start.getTime() / 1000),
        end: Math.floor(programme.stop.getTime() / 1000),
        title: programme.title,
        description: programme.description,
        icon: programme.icon,
        ...(programme.catchupId ? { catchupId: programme.catchupId } : {}),
        epgSourceUrl: EpgService.getSourceUrl(channel) ?? undefined,
        resumeSecs,
      };
    }
    this.handlers.onPlayChannel(channelIndex, catchup);
  }

  // The program rows on screen translate once the results stop changing; a
  // pending query shows none, so typing sends nothing.
  private showTranslations(): void {
    const scroller = this.container.querySelector<HTMLElement>('[data-search-virtual="programmes"]');
    if (!scroller || !ProgramTranslation.active || !this.active || !inShownView(this.container)) {
      this.releaseTranslation();
      return;
    }
    const viewport = scroller.clientHeight || SEARCH_LIST_VIEWPORT;
    const range = this.programVirtualizer.getVisibleRange(this.visiblePrograms.length, viewport);
    ProgramTranslation.show(this, this.visiblePrograms.slice(range.start, range.end)
      .map(result => ({ source: liveSource(result.channel), text: result.programme })));
  }

  private render(): void {
    this.syncProgramStride();
    const q = this.query.trim();
    const hasResults = this.visibleChannels.length > 0 || this.visiblePrograms.length > 0
      || this.visibleMovies.length > 0 || this.visibleSeries.length > 0;
    const programSection = this.visiblePrograms.length
      ? this.virtualList(
          t('search.programs'),
          'programmes',
          this.visiblePrograms,
          this.programVirtualizer,
          (result, index) => this.programRow(result, index),
        )
      : '';

    // Channels, movies, and series are horizontal tile rails; EPG programs use
    // compact rows so their metadata remains readable.
    const partial = this.partialIndex();
    const moreComing = partial || this.channelsArriving();
    const sectionsShown = (): Array<ReturnType<typeof html>> => {
      const sections: Record<string, ReturnType<typeof html>> = {};
      if (this.visibleChannels.length) {
        sections['channels-rail'] = this.virtualRail(
          t('common.channels'),
          'channels-rail',
          this.visibleChannels,
          this.channelRailVirtualizer,
          (ch) => this.channelTile(ch),
        );
      }
      if (programSection) sections.programmes = programSection;
      if (this.visibleMovies.length) {
        sections.movies = this.virtualRail(
          t('common.movies'),
          'movies',
          this.visibleMovies,
          this.movieVirtualizer,
          (v) => this.movieTile(v),
        );
      }
      if (this.visibleSeries.length) {
        sections.series = this.virtualRail(
          t('common.series'),
          'series',
          this.visibleSeries,
          this.seriesVirtualizer,
          (s) => this.seriesTile(s),
        );
      }
      this.placeSections(Object.keys(sections));
      return this.sectionOrder.map(key => sections[key]);
    };
    const askShown = this.askShownFor(q);
    const settled = !this.pendingIndex && !this.queryPending && !this.channelsArriving();
    // Kept up while the results it replaced or restored load, so its focus holds.
    const askHeld = this.ask.phase !== 'idle' || this.askUsedFor === q;
    const askBar = q && (askShown || ((settled || askHeld) && this.askOffered(q)))
      ? this.askBar(q)
      : '';
    const resultsBody = !q
      ? html``
      : askShown
        ? (hasResults ? html`${sectionsShown()}` : html`<p class="catalog-hint search-empty">${
            this.pendingIndex || this.queryPending ? t('search.preparing') : t('search.empty')
          }</p>`)
      : this.pendingIndex && (!partial || (!hasResults && !this.queryPending))
        ? html`<p class="catalog-hint search-empty">${t('search.preparing')}</p>`
      : this.queryPending
        ? html``
        : !hasResults && this.channelsArriving()
        ? html`<p class="catalog-hint search-loading-more">${t('common.loading')}</p>`
        : !hasResults
        ? html`<p class="catalog-hint search-empty">${t('search.empty')}</p>`
        : html`${sectionsShown()}`;

    // AI results come from the AI's filter, not the expanded query, so its note stays hidden.
    const hinted = !!q && hasResults && !askShown && !this.queryPending && this.expandedTerms.length > 0;
    // The query box lives in the tab bar; this view renders results only.
    morph(this.container, html`
      <div class="search-view ${hinted ? 'search-view-hinted' : ''}" data-nav-container data-search-query="${q}"
           data-search-pending="${this.queryPending ? 'true' : 'false'}"
           data-search-partial="${moreComing ? 'true' : 'false'}">
        <div class="search-results">${askBar}${resultsBody}${!askShown && moreComing && q && hasResults && !this.queryPending
          ? html`<p class="catalog-hint search-loading-more">${t('common.loading')}</p>`
          : ''}</div>
      </div>
      ${hinted
        ? html`<p class="catalog-hint search-expanded" data-key="search-expanded">${t('search.includingResults', {
          terms: this.expandedTerms.join(t('common.listSeparator')),
        })}</p>`
        : ''}
    `);
    this.restoreVirtualOffsets();
    this.showTranslations();
  }

  private static readonly SECTION_ORDER = ['channels-rail', 'programmes', 'movies', 'series'];

  // Sections keep their place while an expansion reranks the query; one it
  // adds comes after them, so nothing appears above focus.
  private placeSections(present: string[]): void {
    const fresh = Search.SECTION_ORDER.filter(key => present.indexOf(key) >= 0);
    if (this.queryGeneration !== this.expansionGeneration) {
      this.sectionOrder = fresh;
      return;
    }
    const kept = this.sectionOrder.filter(key => present.indexOf(key) >= 0);
    this.sectionOrder = kept.concat(fresh.filter(key => kept.indexOf(key) < 0));
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

  // Program rows grow with the text size, so their stride follows it. Reading
  // the computed style is costly; redo it only when the text size changes.
  private syncProgramStride(): void {
    const textSize = document.documentElement.dataset.textSize ?? '';
    if (textSize === this.programTextSize) return;
    this.programTextSize = textSize;
    const stride = programRowStride(fontScale());
    if (stride === this.programStride) return;
    const offset = this.programVirtualizer.scrollOffset * stride / this.programStride;
    this.programVirtualizer = this.createVirtualizer(stride, SEARCH_ROW_OVERSCAN, SEARCH_LIST_VIEWPORT);
    this.programVirtualizer.setScrollOffset(offset);
    this.programStride = stride;
  }

  private virtualizers(): Record<string, VirtualList> {
    this.syncProgramStride();
    return {
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
      const latest = this.scrollGuard.readUserOffset(target, axis);
      if (latest !== null) virtualizer.setScrollOffset(latest);
      if (axis === 'horizontal' && this.railWindows.get(key) === this.railWindow(
        this.resultCount(key),
        virtualizer.getRange(this.resultCount(key), target.clientWidth || SEARCH_RAIL_VIEWPORT),
      )) return;
      this.render();
    });
  }

  private railWindow(count: number, range: { start: number; end: number }): string {
    return `${String(count)}:${String(range.start)}:${String(range.end)}`;
  }

  private moveVirtualFocus(action: Action): boolean {
    const focused = this.nav.focused;
    // Focus a re-render removed recovers through the nav first.
    if (!focused || !this.container.contains(focused)) return false;
    const cell = focused.closest<HTMLElement>('[data-search-section]');
    const key = cell?.dataset.searchSection;
    const rawIndex = cell?.dataset.searchIndex;
    if (!key || rawIndex === undefined) return false;
    const horizontal = key === 'channels-rail' || key === 'movies' || key === 'series';
    if ((horizontal && action !== 'left' && action !== 'right')
        || (!horizontal && action !== 'up' && action !== 'down')) return false;
    const next = parseInt(rawIndex, 10) + (action === 'left' || action === 'up' ? -1 : 1);
    if (next < 0 || next >= this.resultCount(key)) return false;
    const scroll = this.container.querySelector<HTMLElement>(`[data-search-virtual="${key}"]`);
    const virtualizer = this.virtualizers()[key];
    virtualizer.ensureVisible(
      next,
      horizontal
        ? this.railContentWidth(scroll)
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

  // Item offsets start after the rail's padding, so a tile kept in view
  // rests on the left keyline and clears the right edge's ring gutter.
  private railContentWidth(rail: HTMLElement | null): number {
    if (!rail?.clientWidth) return SEARCH_RAIL_VIEWPORT;
    const style = getComputedStyle(rail);
    return rail.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  }

  private resultCount(key: string): number {
    if (key === 'channels-rail') return this.visibleChannels.length;
    if (key === 'programmes') return this.visiblePrograms.length;
    if (key === 'movies') return this.visibleMovies.length;
    return this.visibleSeries.length;
  }

  private askShownFor(query: string): boolean {
    return this.ask.phase === 'shown' && this.ask.query === query.trim();
  }

  // Offered for every settled query, and kept for one the AI already searched.
  private askOffered(query: string): boolean {
    if (!LlmService.isReady(SEARCH_ASK_FEATURE)) return false;
    // A query the AI already searched keeps its button while the index rebuilds.
    if (this.ask.phase !== 'idle' || this.askUsedFor === query) return true;
    return !this.pendingIndex;
  }

  // A compact action at the right of the results' first line: beside the first
  // section heading, or beside the AI summary or failure note when one shows.
  private askBar(query: string): ReturnType<typeof html> {
    const ask = this.ask;
    const mine = ask.phase !== 'idle' && ask.query === query;
    const shown = mine && ask.phase === 'shown';
    const loading = mine && ask.phase === 'loading';
    const line = mine && ask.phase === 'shown'
      ? this.askSummary(ask.filter)
      : mine && ask.phase === 'failed'
        ? (ask.reason === 'cap' || ask.reason === 'quota' ? t('search.aiLimit') : t('search.aiFailed'))
        : '';
    return html`
      <div class="search-ask" data-key="ask-bar" data-nav-container
           data-nav-leave-left="" data-nav-leave-right="" data-search-ask-state="${ask.phase}">
        ${line ? html`<p class="search-ask-line ${shown ? 'search-ask-summary' : 'search-ask-note'}">${
          shown ? html`<span class="catalog-action-icon">${raw(AI_ICON)}</span>` : ''}${line}</p>` : ''}
        <div class="search-ask-anchor">
          <button class="btn catalog-collection-button search-ask-action" type="button"
                  data-focusable data-key="ask"
                  data-search-ask="${shown ? 'exit' : loading ? 'loading' : 'run'}">
            ${shown ? '' : html`<span class="catalog-action-icon">${raw(AI_ICON)}</span>`}
            <span class="search-ask-label">${
              shown ? t('search.aiShowAll') : loading ? t('search.aiLoading') : t('search.aiAction', { query })
            }</span>
          </button>
        </div>
      </div>
    `;
  }

  private askSummary(filter: AskFilter): string {
    const typeLabels: Record<AskType, string> = {
      channel: t('common.channels'),
      program: t('search.programs'),
      movie: t('common.movies'),
      series: t('common.series'),
    };
    // The section headings already name the kinds of results, so the kinds
    // show only when the AI understood nothing else.
    const parts: string[] = [];
    // A group and a genre of the same name (both "Sports") are named once; both still filter.
    const named = new Set<string>();
    for (const label of [...filter.groups, ...filter.categories, ...filter.genres]) {
      const key = label.trim().toLowerCase();
      if (named.has(key)) continue;
      named.add(key);
      parts.push(label);
    }
    const time = askTimeLabel(filter);
    if (time) parts.push(time);
    for (const keyword of filter.keywords) parts.push(t('search.aiQuoted', { text: keyword }));
    if (!parts.length) for (const type of filter.types) parts.push(typeLabels[type]);
    return [t('search.aiSearch'), ...parts].join(' · ');
  }

  private onAskAction(el: HTMLElement): void {
    const action = el.dataset.searchAsk;
    if (action === 'run') void this.runAsk();
    else if (action === 'exit') this.exitAsk();
  }

  private cancelAsk(): void {
    this.askSeq++;
    this.askController?.abort();
    this.askController = null;
    this.ask = { phase: 'idle' };
  }

  // A new query leaves the AI search of the old one.
  private leaveAskFor(query: string): void {
    const trimmed = query.trim();
    if (this.askUsedFor !== null && this.askUsedFor !== trimmed) this.askUsedFor = null;
    if (this.ask.phase !== 'idle' && this.ask.query !== trimmed) this.cancelAsk();
  }

  private exitAsk(): void {
    const shown = this.ask.phase === 'shown';
    this.cancelAsk();
    if (!shown) {
      this.render();
      return;
    }
    this.clearResults();
    this.render();
    // The focused result may not be among all results; the button stays.
    const button = this.container.querySelector<HTMLElement>('[data-search-ask]');
    if (button) this.nav.focus(button);
    else this.handlers.onRevealTabBar();
    void this.startQuery(++this.queryGeneration);
  }

  private async runAsk(): Promise<void> {
    const query = this.query.trim();
    if (!query) return;
    this.cancelAsk();
    const seq = this.askSeq;
    const controller = new AbortController();
    this.askController = controller;
    this.askUsedFor = query;
    const sessionId = this.workerSession;
    const account = this.account;
    const current = (): boolean => seq === this.askSeq && this.active
      && sessionId === this.workerSession && this.query.trim() === query;
    const stopped = (): void => {
      log.info('AI search canceled', 'event=search.ask.outcome', 'outcome=cancelled');
    };
    this.ask = { phase: 'loading', query };
    this.render();
    const types: AskType[] = account ? ['channel', 'program', 'movie', 'series'] : ['channel', 'program'];
    let filter: AskFilter | null = null;
    try {
      const catalog = account ? await askCatalogCategories(account, controller.signal) : null;
      const names = current() ? await this.askNames(current) : null;
      if (!names || !current()) return stopped();
      const reply = await askSearch(query, types, {
        groups: namesByCount(names.channels.map(channel => channel.group)),
        categories: catalog ? catalog.names : [],
        genres: names.genres,
      }, controller.signal);
      if (!current()) return stopped();
      filter = reply.filter;
      const results = await this.askResults(filter, account, catalog, sessionId, controller.signal, current);
      if (!results || !current()) return stopped();
      this.ask = { phase: 'shown', query, filter, catalog };
      this.askController = null;
      this.showResults(results);
      this.queryPending = false;
      this.resetVirtualOffsets();
      this.render();
      this.rememberAsk(query, results);
      const count = results.channels.length + results.programs.length
        + results.movies.length + results.series.length;
      log.info(
        'AI search applied',
        'event=search.ask.outcome',
        `outcome=${count ? 'results' : 'empty'}`,
        `types=${String(filter.types.length)}`,
        `filters=${String(filter.groups.length + filter.categories.length + filter.genres.length)}`,
        `time=${filter.time}`,
        `keywords=${String(filter.keywords.length)}`,
        `dropped=${String(reply.dropped)}`,
        `cached=${reply.cached ? 1 : 0}`,
        `results=${String(count)}`,
      );
    } catch (error) {
      if (!current()) return stopped();
      const reason = error instanceof LlmError ? error.reason : filter ? 'results' : 'error';
      this.askController = null;
      this.ask = { phase: 'failed', query, reason };
      this.render();
      log.warn('AI search failed', 'event=search.ask.outcome', 'outcome=failed', `reason=${reason}`);
    }
  }

  // An AI search is a search the viewer ran, so it joins recent searches,
  // unless it showed PIN-guarded content.
  private rememberAsk(query: string, results: ResultLists): void {
    if (ParentalControlService.enabled) {
      const guarded = results.channels.some(channel => ParentalControlService.protects(liveParentalRequest(channel)))
        || results.programs.some(result => ParentalControlService.protects(liveParentalRequest(result.channel)))
        || results.movies.some(item => ParentalControlService.protects(
          catalogParentalRequest('vod', { ...item, id: item.streamId })))
        || results.series.some(item => ParentalControlService.protects(
          catalogParentalRequest('series', { ...item, id: item.seriesId })));
      if (guarded) return;
    }
    StorageService.addSearchHistory(query);
  }

  // Channels whose groups and guide may be named to the AI, never hidden or
  // locked ones whether or not they show right now, and their guide genres by
  // how many programs carry them. Kept while the channels, the guide, and the
  // rules stay; the genres take a walk over the guide, a channel at a time.
  private async askNames(current: () => boolean): Promise<{ channels: Channel[]; genres: string[] } | null> {
    const key = [
      EpgService.guideRevision,
      EpgService.mappingRevision,
      ProgramGenres.revision,
      // The AI genres are named in the UI language.
      getLocale(),
      ParentalControlService.rulesRevision,
      ParentalControlService.enabled ? 1 : 0,
      // A source locked again changes no rule, only the approved list.
      ParentalControlService.approvedSources.join(','),
      StorageService.getShowHiddenChannels() ? 1 : 0,
    ].join('|');
    const cached = this.askNameCache;
    if (cached && cached.key === key && cached.list === PlaylistService.channels) return cached;
    const list = PlaylistService.channels;
    let channels = PlaylistService.getEpgEligibleChannels();
    if (ParentalControlService.enabled) {
      channels = channels.filter(channel => !ParentalControlService.protects(liveParentalRequest(channel)));
    }
    const categories: string[] = [];
    const listed = new Set<string>();
    let index = 0;
    const done = await runInFrameSlices(() => {
      if (index >= channels.length) return true;
      const id = EpgService.findChannelId(channels[index++]);
      if (!id || listed.has(id)) return false;
      listed.add(id);
      for (const programme of EpgService.getProgrammes(id) ?? []) {
        const genre = programGenreName(programme);
        if (genre) categories.push(genre);
      }
      return false;
    }, { shouldContinue: current });
    if (!done) return null;
    const names = { key, list, channels, genres: namesByCount(categories) };
    this.askNameCache = names;
    return names;
  }

  // The results a filter names, from the lists Search holds once they stop
  // changing under it; null once `current` says they are no longer wanted.
  private async askResults(
    filter: AskFilter,
    account: PlaylistEntry | null,
    catalog: AskCatalogCategories | null,
    sessionId: number,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<ResultLists | null> {
    // Without the worker's index, the page's own program index stands in; it
    // is built first so building it does not count as the lists changing.
    if (this.workerIndexLost && !await this.ensureProgramIndex()) return null;
    for (let attempt = 0; attempt < ASK_LIST_ATTEMPTS; attempt++) {
      const lists = this.indexedLists();
      const results = await this.askResultsOnce(filter, account, catalog, sessionId, signal, current);
      if (!results || sameLists(lists, this.indexedLists())) return results;
    }
    throw new Error('Search lists kept changing');
  }

  private async askResultsOnce(
    filter: AskFilter,
    account: PlaylistEntry | null,
    catalog: AskCatalogCategories | null,
    sessionId: number,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<ResultLists | null> {
    const now = Date.now();
    const limit = CONFIG.SEARCH.RESULTS;
    const windows = askWindows(filter.time, filter.fromHour, filter.toHour, now);
    const timed = !!windows;
    const wants = (type: AskType): boolean => wantsType(filter, type, timed);
    const channelList = PlaylistService.channels;
    const channels = wants('channel') ? askChannels(channelList, filter, limit) : [];
    let programs: ProgramResult[] | null = [];
    if (wants('program')) {
      programs = null;
      if (narrowsPrograms(filter, windows)) {
        const collector = collectPrograms({
          channels: channelList,
          guideId: channel => EpgService.findChannelId(channel),
          programmes: id => EpgService.getProgrammes(id),
          genre: programGenreName,
        }, filter, windows);
        if (!await runInFrameSlices(collector.step, { shouldContinue: current })) return null;
        const matcher = matchPrograms(collector.candidates, filter.keywords);
        if (!await runInFrameSlices(matcher.step, { shouldContinue: current })) return null;
        programs = rankPrograms(collector.candidates, matcher.matched, filter, now, limit);
      }
    }
    const named = !!account && !!catalog && filter.categories.length > 0;
    const held = !!account && this.loadedFor === account.id;
    const [movies, series] = await Promise.all([
      named && wants('movie') && account && catalog
        ? askMovies(account, catalog, filter.categories,
          held && !isRecordList(this.allVod) ? this.allVod : null, signal)
        : Promise.resolve(null),
      named && wants('series') && account && catalog
        ? askSeries(account, catalog, filter.categories,
          held && !isRecordList(this.allSeries) ? this.allSeries : null, signal)
        : Promise.resolve(null),
    ]);
    const results: ResultLists = {
      channels: channels ?? [],
      programs: programs ?? [],
      movies: movies ? rankNames(movies, filter.keywords, true, limit) : [],
      series: series ? rankNames(series, filter.keywords, true, limit) : [],
    };
    // Kinds no name or time narrows are searched by the keywords alone.
    const byKeyword = {
      channels: channels === null,
      programs: programs === null,
      movies: wants('movie') && !!account && !movies,
      series: wants('series') && !!account && !series,
    };
    if (filter.keywords.length && (byKeyword.channels || byKeyword.programs || byKeyword.movies || byKeyword.series)) {
      const found = await this.keywordResults(filter.keywords, sessionId);
      if (!found) return null;
      if (byKeyword.channels) results.channels = found.channels;
      if (byKeyword.programs) results.programs = found.programs;
      if (byKeyword.movies) results.movies = found.movies;
      if (byKeyword.series) results.series = found.series;
    }
    return results;
  }

  // Each keyword through today's search, merged so every keyword shows; null
  // when the session moved on.
  private async keywordResults(keywords: string[], sessionId: number): Promise<ResultLists | null> {
    const repost = this.channelRepost;
    if (repost && repost.sessionId === sessionId) await repost.done;
    const lists: ResultLists[] = [];
    let indexes: LocalIndexes | null = null;
    for (const keyword of keywords) {
      if (sessionId !== this.workerSession) return null;
      let response: SearchQueryResponse | null = null;
      if (!this.workerIndexLost) {
        try {
          const pending = runAppWorkerTask('search.query', this.queryRequest({
            sessionId,
            query: keyword,
            limit: CONFIG.SEARCH.RESULTS,
            includeCatalog: !!this.account && !this.pendingIndex?.catalog && !this.lostSources?.catalog,
            includeProgrammes: !this.pendingIndex?.programmes && !this.lostSources?.programmes,
            strict: true,
          }));
          const worker = appWorkerGeneration();
          response = await pending;
          this.keepDelivered(response, worker);
        } catch {
          response = null;
        }
      }
      if (response) {
        lists.push(this.resultsOf(response, this.indexedVod, this.indexedSeries));
        continue;
      }
      // Without the worker's index, the page ranks the keyword itself, as a
      // search does; the AI reply is not thrown away.
      if (!await this.ensureProgramIndex() || sessionId !== this.workerSession) return null;
      if (!indexes) indexes = this.localIndexes();
      lists.push(this.resultsOf(this.queryLocally(keyword, indexes, true), this.allVod, this.allSeries));
    }
    const limit = CONFIG.SEARCH.RESULTS;
    return {
      channels: interleave(lists.map(list => list.channels), limit),
      // Each answer builds its own program results, so a program two keywords
      // find arrives twice as different objects.
      programs: interleave(lists.map(list => list.programs), limit, programKey),
      movies: interleave(lists.map(list => list.movies), limit),
      series: interleave(lists.map(list => list.series), limit),
    };
  }

  // The lists changed under shown AI results: the stored filter runs again on
  // them, without asking the AI, so no result points at a moved channel.
  private async refreshAsk(generation: number, sessionId: number, preserveOffsets: boolean): Promise<boolean> {
    const ask = this.ask;
    if (ask.phase !== 'shown') return false;
    const current = (): boolean => this.ask === ask && generation === this.queryGeneration
      && sessionId === this.workerSession && this.active;
    this.askController?.abort();
    const controller = new AbortController();
    this.askController = controller;
    let results: ResultLists | null = null;
    try {
      // A name locked or gone since the AI picked it leaves the filter.
      const names = await this.askNames(current);
      if (names) {
        const groups = new Set(names.channels.map(channel => channel.group.trim()));
        const catalog = ask.catalog && this.account ? unlockedCategories(this.account, ask.catalog) : ask.catalog;
        ask.catalog = catalog;
        const before = ask.filter;
        ask.filter = {
          ...ask.filter,
          groups: ask.filter.groups.filter(group => groups.has(group)),
          genres: ask.filter.genres.filter(genre => names.genres.indexOf(genre) >= 0),
          categories: ask.filter.categories.filter(name => !!catalog && catalog.names.indexOf(name) >= 0),
        };
        const named = (filter: AskFilter): number => filter.groups.length + filter.categories.length + filter.genres.length;
        // A filter left with neither names nor keywords would show everything.
        results = named(before) > 0 && !named(ask.filter) && !ask.filter.keywords.length
          ? { channels: [], programs: [], movies: [], series: [] }
          : await this.askResults(ask.filter, this.account, catalog, sessionId, controller.signal, current);
      }
    } catch {
      results = null;
    }
    if (this.askController === controller) this.askController = null;
    if (!current()) return true;
    if (!results) {
      log.warn('AI search results could not be updated', 'event=search.ask.outcome', 'outcome=failed', 'reason=results');
      this.ask = { phase: 'failed', query: ask.query, reason: 'results' };
      return false;
    }
    this.showResults(results);
    this.queryPending = false;
    if (!preserveOffsets) this.resetVirtualOffsets();
    this.render();
    this.applyPendingFocus();
    return true;
  }

  private cancelScheduledQuery(): void {
    this.queryGeneration++;
    if (this.queryFrame !== null) cancelAnimationFrame(this.queryFrame);
    this.queryFrame = null;
  }
}

function sameLists(before: unknown[], after: unknown[]): boolean {
  return before.every((list, index) => list === after[index]);
}

function itemsAt<T>(items: T[], indices: number[]): T[] {
  const selected: T[] = [];
  for (const index of indices) {
    const item = items[index];
    if (item !== undefined) selected.push(item);
  }
  return selected;
}

function keptAt<T>(items: Map<number, T>, indices: number[]): T[] {
  const selected: T[] = [];
  for (const index of indices) {
    const item = items.get(index);
    if (item !== undefined) selected.push(item);
  }
  return selected;
}

function indicesOf<T>(items: T[], selected: T[]): number[] {
  const byItem = new Map<T, number>();
  for (let index = 0; index < items.length; index++) byItem.set(items[index], index);
  return selected.map(item => byItem.get(item) ?? -1);
}

// A query that led to PIN-guarded content stays out of recent searches, which
// anyone can see once the session is locked again (or the PIN was canceled).
function rememberQuery(query: string, request: Parameters<typeof ParentalControlService.protects>[0]): void {
  if (!ParentalControlService.protects(request)) StorageService.addSearchHistory(query);
}

const WEEKDAY_LABELS = [
  'weekday.0', 'weekday.1', 'weekday.2', 'weekday.3', 'weekday.4', 'weekday.5', 'weekday.6',
] as const;

function hourLabel(hour: number): string {
  return `${hour < 10 ? '0' : ''}${String(hour)}:00`;
}

function askTimeLabel(filter: AskFilter): string {
  let day = '';
  switch (filter.time) {
    case 'any': break;
    case 'now': return t('search.liveNow');
    case 'today': day = t('common.today'); break;
    case 'tonight': day = t('search.timeTonight'); break;
    case 'tomorrow': day = t('common.tomorrow'); break;
    case 'yesterday': day = t('search.timeYesterday'); break;
    case 'weekend': day = t('search.timeWeekend'); break;
    case 'this_week': day = t('search.timeThisWeek'); break;
    default: day = t(WEEKDAY_LABELS[askWeekday(filter.time)]);
  }
  // Tonight with no hours names its own; a range a clock change skips names none.
  const now = Date.now();
  const plan = filter.fromHour < 0 && filter.toHour < 0
    ? null
    : askPlan(filter.time, filter.fromHour, filter.toHour, now);
  const windows = askWindows(filter.time, filter.fromHour, filter.toHour, now);
  if (!plan || (windows && !windows.length)) return day;
  const hours = plan.hours;
  const single = filter.fromHour >= 0
    && (filter.toHour === filter.fromHour || (filter.fromHour === 24 && filter.toHour < 0));
  const label = single
    ? hourLabel(hours[0] % 24)
    : `${hourLabel(hours[0] % 24)}–${hourLabel(hours[1] > 24 ? hours[1] - 24 : hours[1])}`;
  return day ? `${day} ${label}` : label;
}
