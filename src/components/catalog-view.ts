import type {
  Action,
  PlaylistEntry,
  ResumeEntry,
  ResumeKind,
  VodPlayback,
  WatchlistEntry,
  WatchlistKind,
} from '../types';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { FocusRing, ringShown } from '../navigation/focus-ring';
import { InputMode } from '../navigation/input-mode';
import { cleanUrl, cssUrl, html, inShownView, raw, Safe, withInstantScroll } from '../utils/dom';
import { syncTabBarOverArt } from './tab-bar';
import { backdropUrl } from '../utils/artwork';
import { categoryLockBadge, lockBadge } from './parental-badge';
import { SORT_ASCENDING_ICON, SORT_DESCENDING_ICON, SEE_ALL_ICON, REMOVE_ICON, CHECK_ICON, TRASH_ICON, PENCIL_ICON, SEARCH_ICON } from './icons';
import { foldSearchText } from '../utils/channel-search';
import { ConfirmationPrompt } from './confirmation-prompt';
import { backKey, okHint } from './key-hints';
import { showToast } from './toast';
import { dropdown, toggleDropdown, closeDropdown, commitDropdownOption } from './dropdown';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import {
  catalogParentalRequest,
  isResumeConcealed,
  isWatchlistConcealed,
  ParentalControlService,
} from '../services/parental-control';
import { CONFIG } from '../config';
import { getLocale, t } from '../i18n';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { createLogger } from '../utils/logger';
import {
  defaultSortDirection, isCatalogSort, sortCatalogItems,
  type CatalogSort, type CatalogSortDirection, type CatalogSortItem, type CatalogSortPreference,
} from '../utils/catalog-sort';

const log = createLogger('Catalog');

const SORT_DIRECTION_LABELS = {
  name: { asc: 'catalog.sortAToZ', desc: 'catalog.sortZToA' },
  added: { asc: 'catalog.sortOldest', desc: 'catalog.sortNewest' },
  year: { asc: 'catalog.sortOldest', desc: 'catalog.sortNewest' },
  rating: { asc: 'catalog.sortLowest', desc: 'catalog.sortHighest' },
} as const;

function sortDirectionLabel(by: Exclude<CatalogSort, 'default'>, direction: CatalogSortDirection): string {
  return t(SORT_DIRECTION_LABELS[by][direction]);
}

// The field's starting direction leads, so Newest sits before Oldest.
function sortDirections(by: CatalogSort): CatalogSortDirection[] {
  return defaultSortDirection(by) === 'asc' ? ['asc', 'desc'] : ['desc', 'asc'];
}

const CATALOG_GRID_COLUMN_STRIDE = 244;
const CATALOG_GRID_POSTER_WIDTH = 220;
const CATALOG_GRID_ROW_STRIDE = 395;
// A tile with a second caption line (a series' episode code) is one line taller.
const CATALOG_GRID_CAPTION_LINE = 24;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1760;
const CATALOG_GRID_VIEWPORT_HEIGHT = 900;
const CATEGORY_RAIL_STRIDE = 320;
const CATEGORY_RAIL_VIEWPORT = 1760;
// Enough skeleton posters to fill a rail's width while it loads.
const RAIL_PLACEHOLDER_TILES = 8;

// Matches the rail track's padding and its end spacer in catalog-view.css.
const RAIL_EDGE_GUTTER = 12;
// How far a stacked series tile's back cards reach past it (css/catalog-view.css).
const STACK_OVERHANG = 16;

export interface CatalogHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

// Which titles a category grid lists, by the viewer's marks.
export type CatalogShowFilter = 'all' | 'unwatched' | 'watched' | 'hidden';

interface GridFilter {
  query: string;
  genre: string;
  show: CatalogShowFilter;
}

const NO_FILTER: GridFilter = { query: '', genre: '', show: 'all' };
const FILTER_QUERY_DELAY_MS = 300;

// Provider genre fields list several genres in one string.
export function splitGenres(value: string | undefined): string[] {
  if (!value) return [];
  const genres: string[] = [];
  for (const part of value.split(/\s*[,/|;]\s*/)) {
    const genre = part.trim();
    if (genre && genres.indexOf(genre) < 0) genres.push(genre);
  }
  return genres;
}

type Mode = 'browse' | 'grid' | 'detail';

// A browse rail keeps its place from the start; its titles load once it
// nears the screen.
type RailState = 'pending' | 'loading' | 'loaded' | 'failed';

interface RailSlot<C, I> {
  category: C;
  state: RailState;
  items: I[];
}

export type CollectionKind = 'continue' | 'watchlist';

export interface CollectionEntry {
  id: string;
  key: string;
  tile: (managing: boolean) => Safe;
}

interface GridSource {
  count: number;
  keyAt: (index: number) => string;
  render: (index: number) => Safe;
}

interface BrowseReturn {
  el: HTMLElement;
  railKey: string;
  index: number;
}

// Tile keys repeat across rails (a resumed title is also in its category) and
// detail buttons across items, so a focus key names the mode and rail too.
interface CatalogKey {
  mode: Mode;
  rail: string;
  key: string;
}

function parseKey(key: string | null): CatalogKey | null {
  if (key === null) return null;
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3) return null;
    const [mode, rail, item] = parts as unknown[];
    if (mode !== 'browse' && mode !== 'grid' && mode !== 'detail') return null;
    if (typeof rail !== 'string' || typeof item !== 'string') return null;
    return { mode, rail, key: item };
  } catch {
    return null;
  }
}

function isScroller(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll';
}

// Shared browse/grid/detail machinery for the Xtream catalog sections (Movies,
// Series): a hero + poster rails browse view, a per-category poster grid, and a
// detail screen. One focus scope holds the focused tile or button across all
// modes, and a SpatialNav only picks the next one geometrically. Up at the top
// row hands off to the tab bar; Back walks detail -> grid -> browse -> Live.
// Each mode renders into its own stacked layer. Browse stays resident (hidden,
// not rebuilt) while a grid or detail is open, so Back finds its rails, scroll
// positions, and focused tile exactly as they were.
// Subclasses supply the catalog loaders, item accessors, and the detail
// rendering / playback specifics.
interface HeroArt { poster: string; backdrop: string }
// The art a detail shows: its backdrop or its poster card, by title.
interface DetailArt { title: string; backdrop: string; poster: string }
// Wait this long for a backdrop before trying the poster, as Chromium has no
// timeout for a stalled image; a late backdrop still replaces the poster.
const ART_SLOW_MS = 7000;
// Focus must rest this long on a tile before its hero backdrop loads, so a
// fast pass along a rail starts no downloads.
const HERO_ART_DELAY_MS = 400;

export abstract class CatalogView<C extends { id: string; name: string }, I extends CatalogSortItem> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'browse';
  protected categories: C[] = [];
  private railSlots: RailSlot<C, I>[] = [];
  // Bumped by open(): a rail load from an earlier browse never lands.
  private railGeneration = 0;
  private railAccountId: string | null = null;
  private railRequests: Record<string, { promise: Promise<I[]>; signal: AbortSignal }> = {};
  // A rail settled while browse was hidden or its sort menu open.
  private railsDirty = false;
  protected resume: ResumeEntry[] = [];
  protected itemsByCategory: Record<string, I[]> = {};
  private serverItemsByCategory: Record<string, I[]> = {};
  private sort: CatalogSortPreference = { by: 'default', direction: 'asc' };
  private resetBrowseRailOffsets = false;
  private browseSortReturn: string | null = null;
  protected gridCategory: C | null = null;
  private collection: CollectionKind | null = null;
  private managing = false;
  private readonly clearPrompt: ConfirmationPrompt;
  protected deepLinkBack: (() => void) | null = null;
  private gridFocusIndex = 0;
  private gridReturnKey: string | null = null;
  private readonly art = new Map<string, 'loading' | 'loaded' | 'failed'>();
  // Backdrops still loading after ART_SLOW_MS: the poster is tried meanwhile.
  private readonly slowArt = new Set<string>();
  // The art behind the browse hero, so a backdrop that loads later swaps in.
  private heroArt: HeroArt | null = null;
  private heroTimer: ReturnType<typeof setTimeout> | null = null;
  private heroTimerUrl = '';
  private heldHero: { name: string; background: string; art: HeroArt | null } | null = null;
  // The art the open detail shows, kept until its replacement has loaded,
  // and the URLs it waits on, so only their loads re-render it.
  private detailArtShown: DetailArt | null = null;
  private detailArtUrls: string[] = [];
  private detailCandidateUrls: string[] = [];
  // Each opened title's backdrop by account and id, so reopening it paints the
  // backdrop before its details load instead of flashing the poster card.
  private readonly itemBackdrops = new Map<string, string>();
  // The browse tile that opened a grid or detail, refocused on Back.
  private readonly gridVirtualizers = [0, CATALOG_GRID_CAPTION_LINE].map(extra => new VirtualGrid({
    columnStride: CATALOG_GRID_COLUMN_STRIDE,
    rowStride: CATALOG_GRID_ROW_STRIDE + extra,
    overscanRows: CATALOG_GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: CATALOG_GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: CATALOG_GRID_VIEWPORT_HEIGHT,
  }));
  private get gridVirtualizer(): VirtualGrid {
    return this.gridVirtualizers[this.hasCaptionLine() ? 1 : 0];
  }
  private hasCaptionLine(): boolean {
    return this.collection === 'continue' && this.continueCaptionLine;
  }
  // Continue tiles carry a second caption line.
  protected readonly continueCaptionLine: boolean = false;
  private gridScrollFrame: number | null = null;
  private readonly categoryVirtualizer = new VirtualList({
    itemSize: CATEGORY_RAIL_STRIDE,
    overscan: 4,
    fallbackViewportSize: CATEGORY_RAIL_VIEWPORT,
  });
  private categoryScrollFrame: number | null = null;
  private railsScrollFrame: number | null = null;
  // The All categories window last rendered; its cells sit at fixed offsets,
  // so a scroll inside the window needs no render.
  private categoryWindow = '';
  protected readonly scrollGuard = new VirtualScrollGuard();
  private requestController: AbortController | null = null;
  private readonly layers: Record<Mode, HTMLElement>;
  private browseReturn: BrowseReturn | null = null;
  private gridRequest = 0;
  private browseStale = false;
  readonly focusScope: FocusScope;
  // How the element SpatialNav is picking was asked for; null only follows it.
  private pickVia: Via | null = null;
  private lastRevealKey: string | null = null;
  private lastRevealAt = 0;
  private lastRevealInstant = false;
  private filter: GridFilter = NO_FILTER;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private heldName: HTMLElement | null = null;
  private heldNameTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly iconNameFits = new Map<string, { key: string; width: number }>();
  private openedName: { row: HTMLElement; at: number } | null = null;
  private instantRow: HTMLElement | null = null;
  private instantSwaps = 0;
  private filtered: { source: I[]; key: string; items: I[] } | null = null;
  private gridGenres: string[] = [];
  // Per source list, so a big category is split and folded once, not per render.
  private genreCache = new WeakMap<I[], string[]>();
  private foldedNames = new WeakMap<I[], Record<string, string>>();
  private itemGenres = new WeakMap<I, string[]>();
  private hiddenGenres = new WeakMap<I[], { hidden: Set<string>; genres: string[] }>();
  private sortedByCategory: Record<string, I[]> = {};
  // The control the pointer rests on while the search box keeps the caret.
  private notedKey: string | null = null;
  protected watchedIds = new Set<string>();
  protected hiddenIds = new Set<string>();

  constructor(protected container: HTMLElement, protected handlers: CatalogHandlers) {
    const layer = (mode: Mode): HTMLElement => {
      const el = document.createElement('div');
      el.className = `catalog-layer catalog-layer-${mode}`;
      if (mode !== 'browse') el.classList.add('catalog-layer-hidden');
      container.appendChild(el);
      return el;
    };
    this.layers = { browse: layer('browse'), grid: layer('grid'), detail: layer('detail') };
    this.nav = new SpatialNav(container, (el) => this.onFocusChanged(el), { follow: false });
    this.nav.setRestrict(this.layers.browse);
    this.clearPrompt = new ConfirmationPrompt(`prompt.${this.scopeName()}.collection`);
    this.focusScope = Focus.register({
      id: `${this.scopeName()}.catalog`,
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.defaultKey(),
      resolve: (key) => this.resolveKey(key),
      has: (key) => this.hasKey(key),
      reveal: (key) => this.revealKey(key),
      concealOnLeave: true,
      // A caret left in the category search keeps the arrows from the next owner;
      // the control the pointer rested on is no longer picked as the caret goes.
      onRelease: () => {
        this.notedKey = null;
        this.filterInput()?.blur();
      },
    });
    this.container.addEventListener('input', (e: Event) => {
      const input = e.target as HTMLInputElement;
      if (!input.classList.contains('catalog-filter-input')) return;
      if (this.filterTimer) clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.filterTimer = null;
        this.commitQuery(input.value);
      }, FILTER_QUERY_DELAY_MS);
    });
    // The key handler leaves a text field its keys, so the field owns its ways out.
    this.container.addEventListener('keydown', (e: KeyboardEvent) => {
      const input = e.target as HTMLInputElement;
      if (!input.classList.contains('catalog-filter-input')) return;
      const back = e.key === 'Escape' || e.keyCode === CONFIG.KEYS.BACK;
      const up = e.key === 'ArrowUp' || e.keyCode === CONFIG.KEYS.UP;
      const down = e.key === 'ArrowDown' || e.keyCode === CONFIG.KEYS.DOWN;
      const enter = e.key === 'Enter' || e.keyCode === CONFIG.KEYS.ENTER;
      if (!back && !up && !down && !enter) return;
      e.preventDefault();
      e.stopPropagation();
      this.flushQuery(input);
      this.notedKey = null;
      input.blur();
      this.place(input, 'key');
      if (up) {
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
      } else if ((down || enter) && this.gridSource().count) {
        this.gridFocusIndex = 0;
        this.revealGridIndex(0);
        const first = this.layers.grid.querySelector<HTMLElement>('[data-grid-index="0"] [data-focusable]');
        if (first) this.place(first, 'key');
      }
    });
    // The pointer lights a tile or button where it rests, without scrolling.
    this.container.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.hasAttribute('data-focusable') || !this.layers[this.mode].contains(target)) return;
      const menu = this.openSortMenu();
      if (menu && !menu.contains(target)) return;
      // The caret keeps the keys; the ring follows the pointer once it leaves.
      const caret = this.filterInput();
      if (caret && document.activeElement === caret && target !== caret) {
        this.notedKey = this.keyFor(target);
        return;
      }
      this.place(target, 'pointer');
    });
    this.container.addEventListener('focusout', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('catalog-filter-input')) return;
      // However the caret left, the field's text is what the grid shows.
      this.flushQuery(e.target as HTMLInputElement);
      const noted = this.notedKey;
      this.notedKey = null;
      const el = noted !== null ? this.resolveKey(noted) : null;
      if (el) this.place(el, 'pointer');
    });
    this.container.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.catalog-sort, [data-collection-manage], [data-collection-see-all], [data-collection-action]')) return;
      const el = target.closest<HTMLElement>('[data-focusable]');
      if (!el || !this.layers[this.mode].contains(el)) return;
      this.place(el, 'pointer');
      this.onSelect();
      // Closing the sort menu by clicking its trigger shows rails that landed under it.
      this.flushRailUpdates();
    });
    document.addEventListener('click', (e: MouseEvent) => {
      const menu = this.openSortMenu();
      if (menu && !menu.contains(e.target as Node)) {
        this.dismissSort(null);
        this.flushRailUpdates();
      }
    }, true);
    // A ring the pointer left stays off; the next key only shows it again.
    this.container.addEventListener('nav:unhover', (e: Event) => {
      const target = e.target as HTMLElement;
      if (this.notedKey !== null && this.notedKey === this.keyFor(target)) this.notedKey = null;
      // A field with the caret keeps its ring.
      const caret = this.filterInput();
      if (caret && target === caret && document.activeElement === caret) return;
      if (target === this.current()) {
        if (target.classList.contains('detail-icon-btn')) this.holdName(target);
        this.focusScope.conceal();
      }
    });
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target as HTMLElement;
      if (this.handleExtraScroll(target)) return;
      if (this.mode === 'browse' && target.classList.contains('catalog-rails')) {
        // Measuring every rail per scroll event would lay out ~60 times a second.
        if (this.railsScrollFrame === null) {
          this.railsScrollFrame = requestAnimationFrame(() => {
            this.railsScrollFrame = null;
            this.requestNearRails();
          });
        }
        return;
      }
      if (this.mode === 'browse' && target.classList.contains('catalog-category-rail')) {
        const offset = this.scrollGuard.readUserOffset(target, 'horizontal');
        if (offset === null) return;
        this.categoryVirtualizer.setScrollOffset(offset);
        if (this.categoryScrollFrame === null) {
          this.categoryScrollFrame = requestAnimationFrame(() => {
            this.categoryScrollFrame = null;
            if (this.mode === 'browse') {
              const latest = this.scrollGuard.readUserOffset(target, 'horizontal');
              if (latest !== null) this.categoryVirtualizer.setScrollOffset(latest);
              if (this.categoryWindow !== this.categoryWindowFor(target.clientWidth)) {
                this.renderBrowse(false);
              }
            }
          });
        }
        return;
      }
      if (this.mode !== 'grid' || !target.classList.contains('catalog-grid')) return;
      const scrollTop = this.scrollGuard.readUserOffset(target, 'vertical');
      if (scrollTop === null) return;
      const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, scrollTop - this.gridTrackStart(target, track)),
      );
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'grid') this.renderGrid(false, true);
      });
    }, true);
  }

  // --- subclass configuration ---
  // The focus scope's prefix, e.g. 'movies'; a method, as the constructor reads it.
  protected abstract scopeName(): string;
  protected abstract readonly kicker: string;             // hero/grid label, e.g. 'Movies'
  protected abstract readonly resumeKind: ResumeKind;     // which resume entries this section owns
  protected abstract readonly emptyMessage: string;       // no catalog on the account
  protected abstract readonly gridEmptyMessage: string;   // empty category grid
  protected abstract loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<C[]>;
  protected abstract loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]>;
  protected abstract itemId(item: I): string;
  protected abstract itemName(item: I): string;
  protected abstract itemPoster(item: I): string;
  protected abstract itemBackdrop(item: I): string;
  protected abstract itemCategoryId(item: I): string;
  protected abstract itemGenre(item: I): string;
  protected abstract itemCount(count: number): string;
  protected abstract readonly parentalKind: 'vod' | 'series';
  protected abstract openDetail(item: I): Promise<void>;
  protected abstract renderDetail(restoreFocus?: boolean): void;
  protected abstract clearDetail(): void;                 // drop detail state on deep-link back
  // Section-specific selects (play/resume/season/episode). Returns true if handled.
  protected abstract selectExtra(el: HTMLElement): boolean;
  protected moveExtraFocus(_action: Action): boolean { return false; }
  // A color key the section acts on; true when handled.
  protected handleExtraAction(_action: Action): boolean { return false; }
  // A detail key the subclass virtualizes: whether it is still listed, and
  // bringing it into view (true when that scrolled, null when nothing had to).
  protected hasExtraKey(_key: string): boolean { return false; }
  protected revealExtraKey(_key: string, _instant: boolean): boolean | null | undefined {
    return undefined;
  }
  protected handleExtraScroll(_target: HTMLElement): boolean { return false; }
  protected onRequestSessionReset(): void {}
  protected abstract collectionEntries(kind: CollectionKind): CollectionEntry[];
  // A tile id that isn't in a loaded category (Continue/Watchlist); default none.
  protected fallbackItem(_id: string): I | null { return null; }
  // Hero when no rail item exists (Movies falls back to a resumed item); default none.
  protected heroFallback(): I | null { return null; }

  // The active mode's layer; hidden layers keep their DOM but never take focus.
  protected layer(mode: Mode = this.mode): HTMLElement {
    return this.layers[mode];
  }

  protected showLayer(mode: Mode): void {
    if (mode !== this.mode) this.dismissSort(null);
    if (this.mode === 'browse' && mode !== 'browse') {
      this.leaveBrowse();
      if (this.heroTimer !== null) clearTimeout(this.heroTimer);
      this.heroTimer = null;
    }
    this.mode = mode;
    (Object.keys(this.layers) as Mode[]).forEach((key) => {
      this.layers[key].classList.toggle('catalog-layer-hidden', key !== mode);
    });
    this.nav.setRestrict(this.layers[mode]);
    syncTabBarOverArt();
  }

  // Keys embed provider ids, so compare rather than build a selector from them.
  protected focusableByKey(root: HTMLElement, key: string): HTMLElement | null {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-focusable][data-key]'))
      .find((el) => el.getAttribute('data-key') === key) ?? null;
  }

  protected clearLayer(mode: Mode): void {
    if (mode === 'grid') this.gridReturnKey = null;
    morph(this.layers[mode], html``);
  }

  // Detail entry for subclasses: remembers where browse focus was first.
  protected enterDetail(): void {
    // A failure may have been a dropped connection: opening a title retries.
    this.art.forEach((state, url) => { if (state === 'failed') this.art.delete(url); });
    if (this.mode === 'grid') this.gridReturnKey = this.focusedKey();
    this.showLayer('detail');
    // A new item's detail starts on its first button.
    this.focusScope.track(null);
  }

  // --- focus ---

  private keyFor(el: HTMLElement): string {
    const rail = el.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
    return JSON.stringify([this.mode, rail, el.getAttribute('data-key') ?? '']);
  }

  // The focused item's own data-key, while the focus belongs to the shown mode.
  protected focusedKey(): string | null {
    const parsed = parseKey(this.focusScope.focusKey);
    return parsed && parsed.mode === this.mode ? parsed.key : null;
  }

  // The element that holds the focus, if it is rendered in the shown mode.
  protected current(): HTMLElement | null {
    const key = this.focusScope.focusKey;
    return key === null ? null : this.resolveKey(key);
  }

  private resolveKey(key: string): HTMLElement | null {
    const parsed = parseKey(key);
    if (!parsed || parsed.mode !== this.mode) return null;
    const layer = this.layers[parsed.mode];
    const rail = parsed.rail
      ? Array.from(layer.querySelectorAll<HTMLElement>('[data-rail-key]'))
        .find((el) => el.dataset.railKey === parsed.rail) ?? null
      : layer;
    return rail ? this.focusableByKey(rail, parsed.key) : null;
  }

  private defaultKey(): string | null {
    const first = this.nav.first();
    return first ? this.keyFor(first) : null;
  }

  // Keys the virtualized grid, category rail, or episode list may not render.
  private hasKey(key: string): boolean {
    const parsed = parseKey(key);
    if (!parsed || parsed.mode !== this.mode) return false;
    if (parsed.mode === 'grid') return this.gridIndexOf(parsed.key) >= 0;
    if (parsed.mode === 'browse') {
      return parsed.rail === 'all-categories' && this.categoryIndexOf(parsed.key) >= 0;
    }
    return this.hasExtraKey(parsed.key);
  }

  private gridIndexOf(key: string): number {
    const source = this.gridSource();
    for (let index = 0; index < source.count; index++) {
      if (source.keyAt(index) === key) return index;
    }
    return -1;
  }

  private gridSource(): GridSource {
    if (this.collection) {
      const entries = this.collectionEntries(this.collection);
      return {
        count: entries.length,
        keyAt: index => entries[index].key,
        render: index => entries[index].tile(this.managing),
      };
    }
    const items = this.gridItems();
    return {
      count: items.length,
      keyAt: index => `i:${this.itemCategoryId(items[index])}:${this.itemId(items[index])}`,
      render: index => this.tile(items[index]),
    };
  }

  private categoryIndexOf(key: string): number {
    return this.categories.findIndex((c) => `c:${c.id}` === key);
  }

  // Keeps the focus in view; a virtualized list scrolls its window first.
  private revealKey(key: string): boolean | null {
    const parsed = parseKey(key);
    if (!parsed || parsed.mode !== this.mode) return null;
    const now = Date.now();
    if (key !== this.lastRevealKey) {
      // A held key steps instantly, so the focus never outruns its scroll.
      this.lastRevealInstant = this.lastRevealAt !== 0
        && now - this.lastRevealAt <= CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;
      this.lastRevealKey = key;
      this.lastRevealAt = now;
    } else if (now - this.lastRevealAt > CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS) {
      // A later input that only reveals the same key scrolls smoothly again.
      this.lastRevealInstant = false;
    }
    const instant = this.lastRevealInstant;
    let scrolled = false;
    // The grid's window owns its scroll offset; it alone brings a cell in.
    if (parsed.mode === 'grid' && this.gridIndexOf(parsed.key) >= 0) {
      return this.revealGridIndex(this.gridIndexOf(parsed.key)) ? true : null;
    }
    if (parsed.mode === 'browse' && parsed.rail === 'all-categories') {
      scrolled = this.revealCategoryIndex(this.categoryIndexOf(parsed.key));
    } else if (parsed.mode === 'detail') {
      const extra = this.revealExtraKey(parsed.key, instant);
      if (extra !== undefined) return extra;
    }
    const el = this.resolveKey(key);
    if (el && this.revealElement(el, instant)) scrolled = true;
    return scrolled ? true : null;
  }

  // Compares against the window's recorded offset, not the live scrollTop,
  // which lags a smooth scroll the last step started. Past the scroll
  // guard's two frames, the rest of that scroll reads as a user scroll and
  // moves the recorded offset with it.
  private revealGridIndex(index: number): boolean {
    if (index < 0) return false;
    this.gridFocusIndex = index;
    const view = this.layers.grid.querySelector<HTMLElement>('.catalog-grid');
    const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
    if (!this.gridVirtualizer.ensureVisible(
      index,
      track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH,
      view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT,
    )) return false;
    this.renderGrid(false);
    return true;
  }

  private revealCategoryIndex(index: number): boolean {
    if (index < 0) return false;
    const rail = this.layers.browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (!this.categoryVirtualizer.ensureVisible(index, this.categoryRailContentWidth(rail))) {
      return false;
    }
    this.renderBrowse(false);
    return true;
  }

  // Scrolls each scroller around `el` just enough to show it whole; a rail
  // tile also keeps a gutter beside it. True when anything scrolled.
  private revealElement(el: HTMLElement, instant: boolean): boolean {
    const r = el.getBoundingClientRect();
    let scrolled = false;
    for (let n = el.parentElement; n && n !== this.container; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (n === el.parentElement && n.classList.contains('catalog-rail-track')) {
        if (this.revealRailGutter(el, instant)) scrolled = true;
      }
      if (!isScroller(style.overflowY) || n.scrollHeight <= n.clientHeight) continue;
      const box = n.getBoundingClientRect();
      const top = box.top + n.clientTop;
      const bottom = top + n.clientHeight;
      let delta = 0;
      if (r.top < top) delta = r.top - top;
      else if (r.bottom > bottom) delta = Math.min(r.bottom - bottom, r.top - top);
      if (Math.abs(delta) < 1) continue;
      const target = n.scrollTop + delta;
      const scroller = n;
      if (instant) withInstantScroll([scroller], () => { scroller.scrollTop = target; });
      else scroller.scrollTop = target;
      scrolled = true;
    }
    return scrolled;
  }

  // Follows the element SpatialNav picked into the focus scope.
  protected place(el: HTMLElement | null, via: Via | null): void {
    this.pick(via, () => this.nav.focus(el));
  }

  private pick(via: Via | null, fn: () => void): void {
    const outer = this.pickVia;
    this.pickVia = via;
    try {
      fn();
    } finally {
      this.pickVia = outer;
    }
  }

  // How a render that settles focus on its own asks for it: in keys mode it
  // may bring it into view, otherwise it lights it where it is. Under a
  // surface that owns the keys it only follows the focus.
  private placementVia(): Via | null {
    if (Focus.owner() !== this.focusScope) return null;
    return InputMode.current === 'keys' ? 'key' : 'pointer';
  }

  // A focus request reaches the scope only while it owns the keys; otherwise
  // the scope just follows it, so no reveal waits for later.
  private request(key: string | null, via: Via | null): void {
    // A pointer request never reveals, so it may wait for the keys.
    if (via === 'pointer' && Focus.owner() !== this.focusScope) {
      this.focusScope.focus(key, via);
      return;
    }
    if (via === null || Focus.owner() !== this.focusScope) {
      this.focusScope.track(key);
      return;
    }
    this.focusScope.focus(key, via);
    Focus.flush();
  }

  // Detail info lands, or a button changes: keep a key that is still there,
  // else start on the first button. A button that vanished only moves the
  // key, so a ring the pointer hid stays hidden.
  protected settleDetailFocus(): void {
    if (this.current()) return;
    this.pick(this.focusScope.focusKey === null ? this.placementVia() : null, () => {
      if (!this.nav.focusFirst()) this.nav.focus(null);
    });
  }

  // Back into the section from the tab bar: the focus Up left, in view.
  resumeFocus(): void {
    // Back from the tab bar repaints the ring by key, past onFocusChanged.
    if (this.mode === 'detail') this.fitIconNames();
    this.focusScope.focus(this.focusScope.focusKey, 'resume');
  }

  // SpatialNav picks from where the scope's focus is, which a fallback may have moved.
  private syncNav(): void {
    const el = this.current();
    if (el && el !== this.nav.focused) this.place(el, null);
  }

  // After the pointer left, the first key only shows where focus is.
  private ringHidden(): boolean {
    const el = this.current();
    return !!el && Focus.owner() === this.focusScope && !FocusRing.deferred && !ringShown(el);
  }

  private leaveBrowse(): void {
    const el = this.current();
    if (!el || !this.layers.browse.contains(el)) return;
    const rail = el.closest<HTMLElement>('[data-rail-key]');
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    this.browseReturn = {
      el,
      railKey: rail?.dataset.railKey ?? '',
      index: Math.max(0, tiles.indexOf(el)),
    };
  }

  // Back lands on the tile browse was left from. A tile that is gone (e.g. a
  // title removed from the Watchlist) hands focus to its neighbor in the same
  // rail, and a rail that is gone falls back to the first tile.
  private restoreBrowseFocus(): void {
    const origin = this.browseReturn;
    this.browseReturn = null;
    const browse = this.layers.browse;
    const via = this.placementVia();
    if (origin && origin.el.isConnected && browse.contains(origin.el)) {
      this.place(origin.el, via);
      return;
    }
    // Rail keys embed provider category ids, so compare rather than build a selector.
    const rail = origin?.railKey
      ? Array.from(browse.querySelectorAll<HTMLElement>('[data-rail-key]'))
        .find((el) => el.dataset.railKey === origin.railKey) ?? null
      : null;
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    if (origin && tiles.length) {
      this.place(tiles[Math.min(origin.index, tiles.length - 1)], via);
      return;
    }
    this.place(browse.querySelector<HTMLElement>('.catalog-tile[data-focusable]') ?? this.nav.first(), via);
  }

  setAccount(account: PlaylistEntry): void {
    if (this.account?.id !== account.id) {
      this.clearPrompt.hide();
      this.dismissSort(null);
      this.requestController?.abort();
      this.onRequestSessionReset();
      this.nav.resetRecovery();
    }
    this.account = account;
    this.refreshMarks();
  }

  protected get requestSignal(): AbortSignal | null {
    return this.requestController?.signal ?? null;
  }

  protected requestFailed(context: string, err: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    log.error(
      `${context} failed`,
      'event=xtream.view.load.failed',
      `operation=${context.toLowerCase().replace(/\s+/g, '_')}`,
      err,
    );
    return true;
  }

  private beginRequests(): AbortSignal {
    this.requestController?.abort();
    this.onRequestSessionReset();
    this.requestController = new AbortController();
    return this.requestController.signal;
  }

  refreshPlaybackState(): void {
    this.refreshMarks();
    if (this.mode === 'detail') {
      this.refreshResume();
      this.renderDetail();
    } else if (this.mode === 'grid') this.renderGrid();
    else {
      this.leaveBrowse();
      this.renderBrowseHeld();
      this.restoreBrowseFocus();
    }
  }

  deactivate(): void {
    if (this.heroTimer !== null) clearTimeout(this.heroTimer);
    this.heroTimer = null;
    this.clearPrompt.hide();
    this.dismissSort(null);
    this.requestController?.abort();
    this.requestController = null;
    this.onRequestSessionReset();
  }

  async open(account: PlaylistEntry): Promise<void> {
    this.clearPrompt.hide();
    this.collection = null;
    this.managing = false;
    this.dismissSort(null);
    const signal = this.beginRequests();
    this.account = account;
    this.refreshMarks();
    this.deepLinkBack = null;
    this.browseReturn = null;
    this.browseStale = false;
    this.clearLayer('grid');
    this.clearLayer('detail');
    this.categories = [];
    this.railSlots = [];
    this.railGeneration++;
    this.railAccountId = account.id;
    this.railRequests = {};
    this.railsDirty = false;
    this.itemsByCategory = {};
    this.serverItemsByCategory = {};
    this.sortedByCategory = {};
    this.sort = StorageService.getCatalogSort(this.parentalKind);
    this.browseSortReturn = null;
    this.resetBrowseRailOffsets = false;
    this.gridCategory = null;
    this.categoryVirtualizer.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.resume = this.visibleResume(account.id);
    this.clearLayer('browse');
    this.renderLoading('browse');
    try {
      const categories = await this.loadCategories(account, signal);
      if (signal.aborted || this.account?.id !== account.id) return;
      this.categories = categories.filter(category => !ParentalControlService.isCategoryConcealed({
        kind: this.parentalKind === 'vod' ? 'vod-category' : 'series-category',
        accountId: account.id,
        categoryId: category.id,
      }));
      this.railSlots = this.categories.slice(0, CONFIG.XTREAM.RAIL_CATEGORIES)
        .map((category): RailSlot<C, I> => ({ category, state: 'pending', items: [] }));
      // Each rail fills in as it lands; only the rails on screen and the next
      // one below load now, the rest as browsing nears them.
      this.renderBrowse();
      const initial = Object.keys(this.railRequests).map(id => this.railRequests[id].promise);
      await Promise.all(initial.map(promise => promise.then(() => undefined, () => undefined)));
    } catch (err) {
      if (signal.aborted) return;
      log.error(
        'Catalog browse load failed',
        'event=xtream.view.load.failed',
        'operation=browse',
        err,
      );
      if (this.account?.id === account.id) this.renderBrowse();
    }
  }

  // Deep-link entry (from Search): open this item's detail directly. Back returns
  // to the caller via onDetailBack (no browse is loaded underneath).
  async openItem(account: PlaylistEntry, item: I, onDetailBack: () => void): Promise<void> {
    this.beginRequests();
    // Showing this detail; deep-link Back recomputes whether browse is stale.
    this.browseStale = false;
    if (this.account && this.account.id !== account.id
        && this.layers.browse.querySelector('.catalog-view')) {
      this.gridCategory = null;
      this.collection = null;
      this.managing = false;
      this.browseReturn = null;
      this.clearLayer('grid');
      morph(this.layers.browse, this.loadingMarkup());
    }
    this.account = account;
    this.refreshMarks();
    this.deepLinkBack = onDetailBack;
    await this.openDetail(item);
  }

  // A Search deep link opens over whatever this section last showed. Put that
  // back, so showing the section again never lands on an empty detail layer.
  // A detail the deep link replaced is not restored: Back skips to its grid or
  // browse.
  private restoreBeneathDeepLink(): void {
    if ((this.gridCategory || this.collection) && this.layers.grid.querySelector('.catalog-grid')) {
      this.renderGrid();
      return;
    }
    this.gridCategory = null;
    this.clearLayer('grid');
    if (this.layers.browse.querySelector('.catalog-browse')) {
      this.renderBrowse();
      return;
    }
    // The deep link aborted a browse load (or switched accounts). Reload it
    // only if the section is shown again (ensureLoaded), not behind Search.
    this.browseStale = !!this.layers.browse.querySelector('.catalog-loading');
    this.showLayer('browse');
    // Nothing to land on until browse loads; the detail's key is gone.
    if (parseKey(this.focusScope.focusKey)?.mode !== 'browse') this.focusScope.track(null);
  }

  // For re-showing the section without open(), e.g. when Search closes: reload
  // an interrupted browse, or one left on an account no longer active.
  ensureLoaded(account: PlaylistEntry | null): void {
    if (!account) return;
    if (!this.browseStale && this.account?.id === account.id) {
      // Browse may have rendered while hidden, when no rail could be measured.
      this.requestNearRails();
      this.repaintArt();
      return;
    }
    log.debug(
      'Catalog browse reloading',
      'event=xtream.view.reload',
      'operation=browse',
      `mode=${this.parentalKind}`,
      `reason=${this.browseStale ? 'stale' : 'account'}`,
    );
    void this.open(account);
  }

  // Search is closing over this section: drop a deep-linked detail it left
  // here and show what it opened over.
  leaveDeepLink(): void {
    if (!this.deepLinkBack) return;
    this.beginRequests();
    this.deepLinkBack = null;
    this.clearDetail();
    this.restoreBeneathDeepLink();
    this.clearLayer('detail');
  }

  handleAction(action: Action): void {
    this.syncNav();
    if ((isFocusMove(action) || (action === 'select' && this.openSortMenu())) && this.ringHidden()) {
      this.request(this.focusScope.focusKey, 'key');
      return;
    }
    this.pickVia = 'key';
    try {
      this.route(action);
    } finally {
      this.pickVia = null;
    }
    this.flushRailUpdates();
  }

  private route(action: Action): void {
    const menu = this.openSortMenu();
    if (menu) {
      if (action === 'back' || action === 'left') this.dismissSort('key');
      else if (action === 'select') this.onSelect();
      else if (action === 'up' || action === 'down') this.nav.move(action);
      return;
    }
    const current = this.current();
    const sortRow = current?.closest<HTMLElement>('.catalog-sort, .catalog-collection-actions');
    const horizontalRegion = sortRow ?? (this.mode === 'browse'
      ? current?.closest<HTMLElement>('.catalog-rail-track:not(.catalog-category-rail)') : null);
    if (horizontalRegion && (action === 'left' || action === 'right')) {
      this.nav.setRestrict(horizontalRegion);
      this.nav.move(action);
      this.nav.setRestrict(this.layers[this.mode]);
      return;
    }
    if (sortRow && action === 'down') {
      if (this.mode === 'grid') this.revealGridIndex(this.gridFocusIndex);
      const target = this.mode === 'grid'
        ? this.layers.grid.querySelector<HTMLElement>(
          `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
        )
        : (this.browseSortReturn ? this.resolveKey(this.browseSortReturn) : null)
          ?? this.layers.browse.querySelector<HTMLElement>(
            '[data-rail-key^="cat:"] .catalog-tile[data-focusable], .catalog-category-rail .catalog-cat[data-focusable]',
          );
      if (target) {
        this.place(target, 'key');
        return;
      }
    }
    if (this.moveExtraFocus(action)) return;
    if (this.mode === 'browse' && (action === 'left' || action === 'right')
        && this.moveCategoryFocus(action)) return;
    if (this.mode === 'grid'
        && (action === 'up' || action === 'down' || action === 'left' || action === 'right')) {
      if (this.current()?.closest('.catalog-sort, .catalog-collection-actions')) {
        if (!this.nav.move(action) && action === 'up') this.handlers.onRevealTabBar();
        return;
      }
      if (this.moveGridFocus(action)) return;
      if (action === 'up' && !this.nav.move('up')) this.handlers.onRevealTabBar();
      return;
    }
    switch (action) {
      case 'up': {
        const origin = this.focusScope.focusKey;
        const firstCategory = this.mode === 'browse' ? this.layers.browse.querySelector(
          '[data-rail-key^="cat:"], [data-rail-key="all-categories"]',
        ) : null;
        if (firstCategory && current?.closest('.catalog-rail') === firstCategory) {
          const trigger = this.layers.browse.querySelector<HTMLElement>('.catalog-sort .dropdown-trigger');
          if (trigger) {
            this.place(trigger, 'key');
            this.browseSortReturn = origin;
            return;
          }
        }
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        else if (this.mode === 'browse' && !sortRow && this.current()?.closest('.catalog-sort')) {
          this.browseSortReturn = origin;
        }
        return;
      }
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.onBack();
        return;
      default:
        this.handleExtraAction(action);
        return;
    }
  }

  private onBack(): void {
    if (this.mode === 'detail') {
      this.clearDetail();
      if (this.deepLinkBack) {
        const back = this.deepLinkBack;
        this.deepLinkBack = null;
        this.restoreBeneathDeepLink();
        this.clearLayer('detail');
        back();
        return;
      }
      this.gridCategory || this.collection ? this.renderGrid() : this.returnToBrowse();
      this.clearLayer('detail');
      return;
    }
    if (this.mode === 'grid') {
      if (this.managing) {
        this.setManaging(false);
        return;
      }
      this.gridCategory = null;
      this.collection = null;
      this.returnToBrowse();
      this.clearLayer('grid');
      return;
    }
    this.handlers.onBack();
  }

  // Browse shows again holding its rails still, though rails that landed or
  // dropped out (Watchlist, Continue Watching, failed) changed above them.
  private returnToBrowse(): void {
    this.renderBrowseHeld();
    this.restoreBrowseFocus();
  }

  private onSelect(): void {
    const el = this.current();
    if (!el || !this.account) return;
    if (el.closest('.catalog-sort')) {
      const direction = el.dataset.sortDirection;
      if (direction === 'asc' || direction === 'desc') {
        this.applySort({
          by: this.sort.by,
          direction,
        }, direction);
        return;
      }
      if (el.classList.contains('catalog-filter-input')) {
        (el as HTMLInputElement).focus();
        return;
      }
      const dd = el.closest<HTMLElement>('.dropdown');
      if (el.hasAttribute('data-dropdown-trigger') && dd) {
        if (this.openSortMenu()) this.dismissSort(this.placementVia());
        else {
          this.nav.setRestrict(dd.querySelector<HTMLElement>('.dropdown-menu'));
          this.pick(this.placementVia(), () => toggleDropdown(this.container, this.nav, dd));
        }
      } else if (dd && el.dataset.dropdownValue !== undefined && /-grid-(genre|show)$/.test(dd.id)) {
        const value = el.dataset.dropdownValue;
        commitDropdownOption(el);
        this.nav.setRestrict(this.layers[this.mode]);
        const anchor = `#${dd.id} .dropdown-trigger`;
        if (dd.id.slice(-6) === '-genre') {
          this.applyFilter({ genre: value === 'all' ? '' : this.gridGenres[Number(value.slice(1))] ?? '' }, anchor);
        } else {
          this.applyFilter({ show: value as CatalogShowFilter }, anchor);
        }
      } else if (isCatalogSort(el.dataset.dropdownValue)) {
        const value = el.dataset.dropdownValue;
        commitDropdownOption(el);
        this.nav.setRestrict(this.layers[this.mode]);
        this.applySort(value === this.sort.by
          ? this.sort : { by: value, direction: defaultSortDirection(value) });
      }
      return;
    }
    if (this.selectCollection(el)) return;
    if (el.dataset.categoryId !== undefined
        && (el.classList.contains('catalog-cat') || el.classList.contains('catalog-see-all'))) {
      void this.openGrid(el.dataset.categoryId);
      return;
    }
    if (this.selectExtra(el)) return;
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.categoryId ?? '', el.dataset.itemId);
      if (item) void this.openDetail(item);
    }
  }

  private selectCollection(el: HTMLElement): boolean {
    const manage = el.dataset.collectionManage;
    const seeAll = el.dataset.collectionSeeAll;
    const kind = manage ?? seeAll;
    if (kind === 'continue' || kind === 'watchlist') {
      this.gridCategory = null;
      this.collection = kind;
      this.managing = manage !== undefined;
      this.gridRequest++;
      this.clearLayer('grid');
      this.gridFocusIndex = 0;
      this.gridVirtualizer.setScrollOffset(0);
      this.renderGrid();
      return true;
    }
    const action = el.dataset.collectionAction;
    if (!this.collection || this.mode !== 'grid') return false;
    if (action === 'manage' || action === 'done') {
      this.setManaging(action === 'manage');
      return true;
    }
    if (action === 'clear') {
      this.confirmClear();
      return true;
    }
    const cell = el.closest<HTMLElement>('[data-grid-index]');
    if (this.managing && action === 'remove' && cell) {
      const index = Number(cell.dataset.gridIndex);
      const entries = this.collectionEntries(this.collection);
      const entry = entries[index];
      if (!entry) return true;
      this.removeCollectionEntry(this.collection, entry.id);
      if (entries.length === 1) {
        this.leaveCollection();
        return true;
      }
      this.gridFocusIndex = Math.min(index, entries.length - 2);
      this.renderGrid(false);
      this.revealGridIndex(this.gridFocusIndex);
      this.place(this.layers.grid.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      ), this.placementVia());
      return true;
    }
    return false;
  }

  private removeCollectionEntry(kind: CollectionKind, id: string): void {
    const account = this.account;
    if (!account) return;
    if (kind === 'continue') {
      this.clearContinueEntry(account.id, id);
      this.resume = this.visibleResume(account.id);
    } else {
      StorageService.removeWatchlist(account.id, this.parentalKind, id);
    }
  }

  // A Continue entry's id is its resume item, unless a subclass groups several under one tile.
  protected clearContinueEntry(accountId: string, id: string): void {
    StorageService.clearResume(accountId, this.resumeKind, id);
  }

  private setManaging(managing: boolean): void {
    if (!this.collection) return;
    this.managing = managing;
    this.renderGrid(false);
    this.place(this.layers.grid.querySelector<HTMLElement>(managing
      ? `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`
      : '[data-collection-action="manage"]'), this.placementVia());
  }

  private leaveCollection(): void {
    this.collection = null;
    this.managing = false;
    this.renderBrowse();
    this.clearLayer('grid');
  }

  private confirmClear(): void {
    const kind = this.collection;
    const account = this.account;
    const returnKey = this.focusScope.focusKey;
    if (!kind || !account) return;
    this.clearPrompt.show({
      title: t(kind === 'continue' ? 'catalog.clearContinueWatchingTitle' : 'settings.clearWatchlistTitle'),
      message: t(kind === 'continue' ? 'catalog.clearContinueWatchingMessage' : 'catalog.clearWatchlistMessage', {
        account: account.name, section: this.kicker,
      }),
      confirmLabel: t('common.clearAll'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        if (this.account?.id !== account.id || this.collection !== kind) return;
        // Only the visible list is cleared; concealed titles stay untouched.
        this.collectionEntries(kind).forEach(entry => this.removeCollectionEntry(kind, entry.id));
        this.leaveCollection();
        showToast(t(kind === 'continue' ? 'catalog.continueWatchingCleared' : 'catalog.watchlistCleared'));
      },
      onCancel: () => {
        if (InputMode.current === 'keys') this.request(returnKey, 'back');
      },
    });
  }

  private collectionTitle(kind: CollectionKind): string {
    return t(kind === 'continue' ? 'catalog.continueWatching' : 'common.watchlist');
  }

  private collectionRail(kind: CollectionKind): Safe | '' {
    const entries = this.collectionEntries(kind);
    if (!entries.length) return '';
    return html`
      <div class="catalog-rail" data-key="rail:${kind}" data-rail-key="${kind}">
        <div class="catalog-rail-head">
          <h2 class="catalog-rail-title">${this.collectionTitle(kind)}</h2>
          <button class="btn catalog-collection-button catalog-collection-manage" type="button"
                  data-self-activate data-focusable data-key="manage:${kind}" data-collection-manage="${kind}">
            <span class="catalog-action-icon">${raw(PENCIL_ICON)}</span>
            <span>${t('parental.manage')}</span>
          </button>
        </div>
        <div class="catalog-rail-track" data-edge-scroll>
          ${entries.slice(0, CONFIG.XTREAM.RAIL_ITEMS).map(entry => entry.tile(false))}
          ${entries.length > CONFIG.XTREAM.RAIL_ITEMS ? html`
            <div class="catalog-tile catalog-see-all" data-self-activate data-focusable
                 data-key="all:${kind}" data-collection-see-all="${kind}">
              <div class="catalog-poster-wrap catalog-see-all-card">
                ${raw(SEE_ALL_ICON)}
                <div class="catalog-see-all-label">${t('catalog.seeAll')}</div>
                <div class="catalog-see-all-count">${this.itemCount(entries.length)}</div>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  protected removeMark(managing: boolean, key: string): Safe | '' {
    return managing ? html`
      <button class="catalog-remove-mark" type="button" data-self-activate data-focusable data-key="${key}"
              data-collection-action="remove" aria-label="${t('common.remove')}">${raw(REMOVE_ICON)}</button>
    ` : '';
  }

  protected progressBar(position: number, duration: number): Safe | '' {
    if (duration <= 0) return '';
    const percent = Math.max(2, Math.min(100, Math.round(position / duration * 100)));
    return html`<div class="catalog-progress"><div class="catalog-progress-fill" style="width:${percent}%"></div></div>`;
  }

  protected resumeBar(position: number, duration: number): Safe | '' {
    if (position <= 0 || duration <= 0) return '';
    const percent = Math.max(2, Math.min(100, Math.round(position / duration * 100)));
    return html`<span class="detail-btn-progress"><span style="width:${percent}%"></span></span>`;
  }

  // Every name in a row opens to its longest one's width. As one closes and
  // the next opens, whatever slides under a resting pointer is still the
  // button it was on: its circle or its name. A row is measured again only
  // when its names, the language, or the text size change.
  protected fitIconNames(): void {
    const textSize = document.documentElement.dataset.textSize ?? '';
    const pending: Array<{ row: HTMLElement; id: string; key: string; width: number }> = [];
    for (const row of Array.from(this.layers.detail.querySelectorAll<HTMLElement>('.detail-icon-row'))) {
      const id = row.dataset.row ?? '';
      const names = Array.from(row.querySelectorAll<HTMLElement>('.detail-icon-name'));
      const key = `${getLocale()}|${textSize}|${names.map((name) => name.textContent).join('|')}`;
      const fit = this.iconNameFits.get(id);
      if (fit?.key === key && row.style.getPropertyValue('--name-width')) continue;
      // The text's own extent, never the label's box, which the last fit sized.
      let width = 0;
      for (const name of names) width = Math.max(width, name.getBoundingClientRect().width);
      if (width > 0) pending.push({ row, id, key, width: Math.ceil(width) });
    }
    for (const { row, id, key, width } of pending) {
      this.iconNameFits.set(id, { key, width });
      row.style.setProperty('--name-width', `${width}px`);
    }
  }

  // After a detail render: fit the names, and put back the state a re-render
  // strips with the template's classes (a held name, an instant switch).
  protected refreshIconRows(): void {
    this.fitIconNames();
    if (this.heldName?.isConnected) this.heldName.classList.add('name-held');
    if (this.instantRow?.isConnected) this.instantRow.classList.add('names-instant');
  }

  // A name still opening when the next one in its row takes focus switches
  // at once: the two would slide at different speeds and the row's width
  // would dip for a moment under a resting pointer.
  private swapNames(el: HTMLElement): void {
    const row = el.parentElement;
    if (!row) return;
    const now = Date.now();
    const last = this.openedName;
    this.openedName = { row, at: now };
    if (!last || last.row !== row || now - last.at >= CONFIG.NAVIGATION.ICON_NAME_SLIDE_MS) return;
    this.instantRow?.classList.remove('names-instant');
    this.instantRow = row;
    row.classList.add('names-instant');
    // Only the latest swap ends the instant switch, after its own two frames.
    const swap = ++this.instantSwaps;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (swap !== this.instantSwaps) return;
      row.classList.remove('names-instant');
      this.instantRow = null;
    }));
  }

  // A pointer slipping off a round action onto nothing keeps its name open a
  // moment; the next focus closes it at once, as the new name opens.
  private holdName(el: HTMLElement): void {
    this.releaseName();
    el.classList.add('name-held');
    this.heldName = el;
    this.heldNameTimer = setTimeout(() => this.releaseName(), CONFIG.NAVIGATION.ICON_NAME_HOLD_MS);
  }

  private releaseName(): void {
    if (this.heldNameTimer) clearTimeout(this.heldNameTimer);
    this.heldNameTimer = null;
    this.heldName?.classList.remove('name-held');
    this.heldName = null;
  }

  // The row's circles and its longest name decide a wrap; the last fit rides
  // in the template so a re-render keeps it. A row that wraps below the
  // playback buttons is a nav container of its own, so Right from Resume
  // stays on Resume's line, and is entered at its first button, never the
  // destructive one nearest below Play; one sharing a line with its
  // neighbours (the season mark) is not.
  protected detailIconRow(id: string, buttons: Array<Safe | ''>, ownLine = true): Safe {
    const shown = buttons.filter((button): button is Safe => button !== '');
    const fit = this.iconNameFits.get(id);
    const width = fit ? `;--name-width:${fit.width}px` : '';
    return html`<div class="detail-icon-row" ${raw(ownLine ? 'data-nav-container data-nav-straight data-nav-enter="first" data-nav-remember' : '')} data-row="${id}"
      style="--icon-count:${shown.length}${width}">${shown}</div>`;
  }

  // A round detail action; its name shows beside it while it has focus.
  protected detailIconButton(key: string, icon: string, label: string, state: 'on' | 'danger' | '' = ''): Safe {
    return html`
      <button class="detail-icon-btn ${state}" data-focusable data-nav-rect data-key="${key}" data-action="${key}" aria-label="${label}">
        <span class="detail-icon-circle">${raw(icon)}</span><span class="detail-icon-label"><span class="detail-icon-name">${label}</span></span>
      </button>
    `;
  }

  // SpatialNav picked `el`: hand it to the scope, and keep the browse hero
  // (title + backdrop) in sync with the focused item tile. Category tiles and
  // non-browse modes leave the hero unchanged.
  private onFocusChanged(el: HTMLElement | null): void {
    this.releaseName();
    if (el?.classList.contains('detail-icon-btn')) {
      this.fitIconNames();
      this.swapNames(el);
    } else {
      this.openedName = null;
    }
    if (this.mode === 'browse' && !el?.closest('.catalog-sort')) this.browseSortReturn = null;
    this.request(el ? this.keyFor(el) : null, this.pickVia);
    const gridCell = el?.closest<HTMLElement>('[data-grid-index]');
    if (this.mode === 'grid' && gridCell?.dataset.gridIndex !== undefined) {
      this.gridFocusIndex = parseInt(gridCell.dataset.gridIndex, 10);
      return;
    }
    const categoryCell = el?.closest<HTMLElement>('[data-category-virtual-index]');
    if (this.mode === 'browse' && categoryCell) return;
    if (this.mode !== 'browse' || !el) return;
    this.requestNearRails();
    this.heroFromTile(el);
  }

  private heroFromTile(el: HTMLElement): void {
    if (el.dataset.resumeEpisode !== undefined) {
      const entry = this.resume.find(entry => entry.itemId === el.dataset.resumeEpisode);
      if (entry) this.updateHero(entry.name, entry.poster);
      return;
    }
    const id = el.dataset.itemId;
    if (id === undefined) return;
    const item = this.findItem(el.dataset.categoryId ?? '', id);
    if (item) this.updateHero(this.itemName(item), this.itemPoster(item), this.itemBackdrop(item));
  }

  // A tile flush with the rail's scrollport would clip its focus ring; keep a
  // gutter visible beside it. True when the rail scrolled.
  private revealRailGutter(el: HTMLElement, instant: boolean): boolean {
    const track = el.parentElement;
    if (!track || !track.classList.contains('catalog-rail-track')) return false;
    const start = el.getBoundingClientRect().left - track.getBoundingClientRect().left
      - track.clientLeft + track.scrollLeft;
    const end = start + el.offsetWidth
      + (el.classList.contains('catalog-tile-stack') ? STACK_OVERHANG : 0);
    const current = track.scrollLeft;
    // A tile leaving on the left lines up with the rail's keyline, not the
    // screen edge the track bleeds to.
    const lead = Math.max(RAIL_EDGE_GUTTER, parseFloat(getComputedStyle(track).paddingLeft) || 0);
    let target: number;
    if (start - lead < current) target = Math.max(0, start - lead);
    else if (end + RAIL_EDGE_GUTTER > current + track.clientWidth) {
      target = end + RAIL_EDGE_GUTTER - track.clientWidth;
    } else return false;
    if (Math.abs(target - current) < 1) return false;
    // A tile already in view only needs an instant nudge; otherwise retarget
    // the running smooth scroll so it moves once.
    if (instant || (start >= current && end <= current + track.clientWidth)) {
      withInstantScroll([track], () => { track.scrollLeft = target; });
    } else {
      track.scrollLeft = target;
    }
    return true;
  }

  private updateHero(name: string, poster: string, backdrop = ''): void {
    const hero = this.layers.browse.querySelector<HTMLElement>('.catalog-hero');
    if (!hero) return;
    const title = this.layers.browse.querySelector<HTMLElement>('.catalog-hero-title');
    if (title) title.textContent = name; // textContent escapes untrusted names
    this.heroArt = { poster, backdrop };
    const bg = this.heroUrl(this.heroArt);
    hero.style.backgroundImage = bg ? `url('${bg}')` : 'none';
  }

  // The hero shows a title's wide backdrop once it has loaded, and its
  // poster, which its tile has already fetched, until then or if it fails.
  // The backdrop starts loading only once focus rests on the title.
  private heroUrl(art: HeroArt): string {
    const url = this.heroBackdrop(art);
    // A re-render of the same hero keeps its wait running.
    if (this.heroTimer === null || this.heroTimerUrl !== url) {
      if (this.heroTimer !== null) clearTimeout(this.heroTimer);
      this.heroTimer = null;
      if (url && !this.art.has(url)) {
        this.heroTimerUrl = url;
        this.heroTimer = setTimeout(() => {
          this.heroTimer = null;
          this.artState(url);
        }, HERO_ART_DELAY_MS);
      }
    }
    return cssUrl(url && this.art.get(url) === 'loaded' ? url : art.poster);
  }

  // The hero always takes the compact 1280px backdrop.
  private heroBackdrop(art: HeroArt): string {
    return art.backdrop ? backdropUrl(cleanUrl(art.backdrop), true) : '';
  }

  // A backdrop loaded for the hero on screen: swap it in for the poster.
  private refreshHeroArt(): void {
    const hero = this.layers.browse.querySelector<HTMLElement>('.catalog-hero');
    if (!hero || !this.heroArt) return;
    const bg = this.heroUrl(this.heroArt);
    hero.style.backgroundImage = bg ? `url('${bg}')` : 'none';
  }

  // Concealed titles are dropped at load, so every rail, grid, and hero built
  // from these lists stays free of them without per-render checks.
  private async loadVisibleItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]> {
    const items = await this.loadItems(account, categoryId, signal);
    if (!ParentalControlService.concealing) return items;
    return items.filter(item => !ParentalControlService.isConcealed(
      catalogParentalRequest(this.parentalKind, {
        accountId: account.id,
        categoryId: this.itemCategoryId(item) || categoryId,
        name: this.itemName(item),
        id: this.itemId(item),
      }),
    ));
  }

  private setCategoryItems(categoryId: string, items: I[]): void {
    this.serverItemsByCategory[categoryId] = items;
    delete this.sortedByCategory[categoryId];
    this.itemsByCategory[categoryId] = this.visibleItems(categoryId);
  }

  // A category's titles in the chosen order; sorted once per order, not per mark.
  private sortedItems(categoryId: string): I[] {
    let sorted = this.sortedByCategory[categoryId];
    if (!sorted) {
      sorted = sortCatalogItems(
        this.serverItemsByCategory[categoryId] ?? [], this.sort.by, getLocale(), this.sort.direction,
      );
      this.sortedByCategory[categoryId] = sorted;
    }
    return sorted;
  }

  // ...without the ones the viewer hid.
  private visibleItems(categoryId: string): I[] {
    const sorted = this.sortedItems(categoryId);
    return this.hiddenIds.size ? sorted.filter(item => !this.hiddenIds.has(this.itemId(item))) : sorted;
  }

  private rebuildItems(resort = false): void {
    if (resort) this.sortedByCategory = {};
    Object.keys(this.serverItemsByCategory).forEach(id => {
      this.itemsByCategory[id] = this.visibleItems(id);
    });
    this.railSlots.forEach(slot => {
      if (slot.state === 'loaded') {
        slot.items = this.itemsByCategory[slot.category.id].slice(0, CONFIG.XTREAM.RAIL_ITEMS);
      }
    });
    this.filtered = null;
  }

  // The viewer's watched and hidden titles of this section's account.
  protected refreshMarks(): void {
    const account = this.account;
    const hidden = account
      ? StorageService.catalogMarkIds(account.id, this.parentalKind, 'hidden') : new Set<string>();
    this.watchedIds = account
      ? StorageService.catalogMarkIds(account.id, this.parentalKind, 'watched') : new Set<string>();
    const changed = hidden.size !== this.hiddenIds.size
      || Array.from(hidden).some(id => !this.hiddenIds.has(id));
    this.hiddenIds = hidden;
    this.filtered = null;
    if (changed) {
      this.rebuildItems();
      this.refreshResume();
    }
  }

  // Flips the shown title's watched or hidden mark; true when it is now set.
  protected toggleMark(flag: 'watched' | 'hidden', item: I): boolean {
    const account = this.account;
    if (!account) return false;
    const id = this.itemId(item);
    const on = !(flag === 'watched' ? this.watchedIds : this.hiddenIds).has(id);
    StorageService.setCatalogMark(account.id, this.parentalKind, id, { [flag]: on });
    this.refreshMarks();
    return on;
  }

  protected watchedBadge(id: string): Safe | '' {
    return this.watchedIds.has(id)
      ? html`<span class="catalog-watched-badge" title="${t('catalog.watched')}">${raw(CHECK_ICON)}</span>`
      : '';
  }

  private flushQuery(input: HTMLInputElement): void {
    if (!this.filterTimer) return;
    clearTimeout(this.filterTimer);
    this.filterTimer = null;
    this.commitQuery(input.value);
  }

  // Off the grid the query is only kept, for the grid to show when it returns.
  private commitQuery(query: string): void {
    if (this.mode === 'grid') this.applyFilter({ query }, null);
    else {
      this.filter = { ...this.filter, query };
      this.filtered = null;
    }
  }

  private filtersActive(): boolean {
    const f = this.filter;
    return !!(f.query.trim() || f.genre || f.show !== 'all');
  }

  private filterInput(): HTMLInputElement | null {
    return this.layers.grid.querySelector<HTMLInputElement>('.catalog-filter-input');
  }

  // The category grid's titles after the viewer's genre, show, and search filters.
  private gridItems(): I[] {
    const cat = this.gridCategory;
    if (!cat) return [];
    let f = this.filter;
    const base = f.show === 'hidden'
      ? this.serverItemsByCategory[cat.id] ?? []
      : this.itemsByCategory[cat.id] ?? [];
    let key = JSON.stringify([cat.id, f, this.sort]);
    if (this.filtered && this.filtered.source === base && this.filtered.key === key) {
      return this.filtered.items;
    }
    // A genre whose last title the viewer hid is no longer offered, so it stops filtering.
    if (f.genre && this.categoryGenres(cat.id, f.show).indexOf(f.genre) < 0) {
      f = this.filter = { ...f, genre: '' };
      key = JSON.stringify([cat.id, f, this.sort]);
    }
    const query = foldSearchText(f.query.trim());
    let items = f.show === 'hidden'
      ? this.sortedItems(cat.id).filter(item => this.hiddenIds.has(this.itemId(item)))
      : base;
    if (f.genre) items = items.filter(item => this.genresOf(item).indexOf(f.genre) >= 0);
    if (f.show === 'watched') items = items.filter(item => this.watchedIds.has(this.itemId(item)));
    if (f.show === 'unwatched') items = items.filter(item => !this.watchedIds.has(this.itemId(item)));
    if (query) {
      const all = this.sortedItems(cat.id);
      let folded = this.foldedNames.get(all);
      if (!folded) {
        const names: Record<string, string> = {};
        for (const item of all) names[this.itemId(item)] = foldSearchText(this.itemName(item));
        folded = names;
        this.foldedNames.set(all, folded);
      }
      const byId = folded;
      items = items.filter(item => (byId[this.itemId(item)] ?? '').indexOf(query) >= 0);
    }
    this.filtered = { source: base, key, items };
    return items;
  }

  // The genres of the titles Show lists: the visible ones, or the hidden ones.
  private categoryGenres(categoryId: string, show: CatalogShowFilter): string[] {
    if (show === 'hidden') {
      const server = this.serverItemsByCategory[categoryId] ?? [];
      const cached = this.hiddenGenres.get(server);
      if (cached && cached.hidden === this.hiddenIds) return cached.genres;
      const genres = this.collectGenres(server.filter(item => this.hiddenIds.has(this.itemId(item))));
      this.hiddenGenres.set(server, { hidden: this.hiddenIds, genres });
      return genres;
    }
    const items = this.itemsByCategory[categoryId] ?? [];
    let genres = this.genreCache.get(items);
    if (!genres) {
      genres = this.collectGenres(items);
      this.genreCache.set(items, genres);
    }
    return genres;
  }

  private collectGenres(items: I[]): string[] {
    const seen: Record<string, true> = {};
    const genres: string[] = [];
    for (const item of items) {
      for (const genre of this.genresOf(item)) {
        if (!seen[genre]) {
          seen[genre] = true;
          genres.push(genre);
        }
      }
    }
    return genres.sort((a, b) => a.localeCompare(b, getLocale()));
  }


  private genresOf(item: I): string[] {
    let genres = this.itemGenres.get(item);
    if (!genres) {
      genres = splitGenres(this.itemGenre(item));
      this.itemGenres.set(item, genres);
    }
    return genres;
  }

  private applyFilter(patch: Partial<GridFilter>, anchor: string | null): void {
    this.filter = { ...this.filter, ...patch };
    this.filtered = null;
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.renderGrid(false);
    if (!anchor) return;
    // Clearing the genre can drop the Genre dropdown itself; Show is always there.
    const el = this.layer().querySelector<HTMLElement>(anchor)
      ?? this.layer().querySelector(`#${this.scopeName()}-grid-show`)?.querySelector<HTMLElement>('.dropdown-trigger')
      ?? null;
    this.place(el, this.placementVia());
  }

  private filterControls(): Safe {
    const cat = this.gridCategory;
    const genres = cat ? this.categoryGenres(cat.id, this.filter.show) : [];
    this.gridGenres = genres;
    const genreIndex = genres.indexOf(this.filter.genre);
    const show: Array<{ value: CatalogShowFilter; label: string }> = [
      { value: 'all', label: t('catalog.showAll') },
      { value: 'unwatched', label: t('catalog.showNotWatched') },
      { value: 'watched', label: t('catalog.showWatched') },
      { value: 'hidden', label: t('catalog.showHidden') },
    ];
    return html`
      ${genres.length > 1 || this.filter.genre ? html`
        <div class="catalog-filter-group catalog-filter-genre">
          <span class="catalog-sort-label">${t('catalog.genre')}</span>
          ${dropdown(`${this.scopeName()}-grid-genre`, [
            { value: 'all', label: t('catalog.allGenres') },
            ...genres.map((genre, index) => ({ value: `g${String(index)}`, label: genre })),
          ], genreIndex >= 0 ? `g${String(genreIndex)}` : 'all')}
        </div>
      ` : ''}
      <div class="catalog-filter-group">
        <span class="catalog-sort-label">${t('catalog.show')}</span>
        ${dropdown(`${this.scopeName()}-grid-show`, show, this.filter.show)}
      </div>
      <label class="catalog-filter-search">
        <span class="catalog-filter-icon">${raw(SEARCH_ICON)}</span>
        <input type="text" class="settings-input catalog-filter-input" data-focusable
               data-key="filter-query" value="${this.filter.query}"
               placeholder="${t('catalog.searchCategory')}">
      </label>
    `;
  }

  private openSortMenu(): HTMLElement | null {
    return this.layers[this.mode].querySelector<HTMLElement>('.catalog-sort .dropdown.open');
  }

  private dismissSort(via: Via | null): void {
    const menu = this.openSortMenu();
    if (!menu) return;
    this.nav.setRestrict(this.layers[this.mode]);
    this.pick(via, () => closeDropdown(this.nav, menu));
  }

  private applySort(sort: CatalogSortPreference, direction?: CatalogSortDirection): void {
    const changed = sort.by !== this.sort.by || sort.direction !== this.sort.direction;
    const applied = changed && StorageService.setCatalogSort(this.parentalKind, sort);
    if (applied) {
      this.sort = sort;
      this.browseSortReturn = null;
      this.rebuildItems(true);
      this.gridFocusIndex = 0;
      this.gridVirtualizer.setScrollOffset(0);
      this.resetBrowseRailOffsets = true;
    }
    if (this.mode === 'grid') this.renderGrid(false);
    else this.renderBrowse(false);
    this.place(this.layer().querySelector<HTMLElement>(direction
      ? `[data-sort-direction="${direction}"]` : '.catalog-sort .dropdown-trigger'), this.placementVia());
  }

  protected refreshResume(): void {
    if (this.account) this.resume = this.visibleResume(this.account.id);
  }

  private visibleResume(accountId: string): ResumeEntry[] {
    return StorageService.getResumeList(accountId)
      .filter(entry => entry.kind === this.resumeKind && !isResumeConcealed(entry)
        && !this.hiddenIds.has((this.resumeKind === 'vod' ? entry.itemId : entry.watchlistOwner?.itemId) ?? ''));
  }

  protected visibleWatchlist(kind: WatchlistKind): WatchlistEntry[] {
    return StorageService.getWatchlist(this.account!.id, kind)
      .filter(entry => !isWatchlistConcealed(entry) && !this.hiddenIds.has(entry.itemId));
  }

  protected findItem(categoryId: string, id: string): I | null {
    const inCat = this.serverItemsByCategory[categoryId] ?? this.itemsByCategory[categoryId] ?? [];
    return inCat.find((x) => this.itemId(x) === id) ?? this.fallbackItem(id);
  }

  private async openGrid(categoryId: string): Promise<void> {
    if (!this.account) return;
    const account = this.account;
    const signal = this.requestSignal;
    if (!signal || signal.aborted) return;
    this.collection = null;
    this.managing = false;
    this.gridCategory = this.categories.find((c) => c.id === categoryId) ?? null;
    this.filter = NO_FILTER;
    this.filtered = null;
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = null;
    const request = ++this.gridRequest;
    this.clearLayer('grid');
    if (!this.itemsByCategory[categoryId]) {
      this.renderLoading('grid');
      try {
        const inflight = this.railRequests[categoryId];
        const items = await (inflight && !inflight.signal.aborted
          ? inflight.promise
          : this.loadVisibleItems(account, categoryId, signal));
        if (signal.aborted || this.account?.id !== account.id) return;
        this.setCategoryItems(categoryId, items);
      } catch (err) {
        if (signal.aborted) return;
        log.error(
          'Catalog category load failed',
          'event=xtream.view.load.failed',
          'operation=category',
          `mode=${this.parentalKind}`,
          err,
        );
      }
      if (signal.aborted || this.account?.id !== account.id) return;
      // Back (or another category) may have superseded this grid meanwhile.
      if (this.mode !== 'grid' || request !== this.gridRequest) {
        log.debug(
          'Catalog category load superseded',
          'event=xtream.view.load.superseded',
          'operation=category',
          `mode=${this.parentalKind}`,
          `reason=${this.mode !== 'grid' ? 'left' : 'replaced'}`,
        );
        return;
      }
      this.clearLayer('grid');
    }
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.renderGrid();
  }

  // A title's backdrop: the first that has not failed of the details' own,
  // the one that loaded on an earlier open, and the catalog list's. Keyed by
  // account, as providers reuse ids.
  protected titleBackdrop(accountId: string, id: string, info: string | undefined, listed: string | undefined): string {
    const key = `${accountId}|${id}`;
    const candidates = [info, this.itemBackdrops.get(key), listed].filter((b): b is string => !!b);
    // A skipped candidate that settles later re-renders the detail too.
    this.detailCandidateUrls = candidates.map(b => backdropUrl(cleanUrl(b)));
    // A failed or stalled candidate is skipped, unless its compact copy loaded.
    const usable = (b: string): boolean => {
      const url = backdropUrl(cleanUrl(b));
      return (this.art.get(url) !== 'failed' && !this.slowArt.has(url))
        || this.art.get(backdropUrl(cleanUrl(b), true)) === 'loaded';
    };
    const backdrop = candidates.find(usable) ?? '';
    if (backdrop && this.art.get(backdropUrl(cleanUrl(backdrop))) === 'loaded') this.itemBackdrops.set(key, backdrop);
    return backdrop;
  }

  // The art a detail shows. The copy never waits for it: the backdrop loads
  // first, and only if it is missing, fails, or stalls is the poster tried
  // (not while details that may name a backdrop are still loading). Each shows
  // only once loaded, so a dead link leaves no art rather than a broken image,
  // and what is on screen stays until its replacement has loaded.
  protected detailArt(title: string, poster: string, backdrop: string, pending: boolean): DetailArt {
    const b = backdrop ? backdropUrl(cleanUrl(backdrop)) : '';
    const p = cleanUrl(poster);
    this.detailArtUrls = [b, p].filter(Boolean);
    let next: DetailArt | null = null;
    const bs = b ? this.artState(b) : 'none';
    // The hero's compact copy, if it loaded, stands in while the original loads
    // and stays if the original fails.
    const compact = b ? backdropUrl(cleanUrl(backdrop), true) : '';
    if (bs === 'loaded') next = { title, backdrop: b, poster: '' };
    else if ((bs === 'loading' || bs === 'failed') && compact !== b && this.art.get(compact) === 'loaded') {
      next = { title, backdrop: compact, poster: '' };
    }
    else if ((bs === 'none' || bs === 'failed' || this.slowArt.has(b)) && !pending) {
      const ps = p ? this.artState(p) : 'none';
      if (ps === 'loaded') next = { title, backdrop: '', poster: p };
      else if (ps !== 'loading') next = { title, backdrop: '', poster: '' };
    }
    const shown = this.detailArtShown?.title === title ? this.detailArtShown : null;
    this.detailArtShown = next ?? shown;
    return this.detailArtShown ?? { title, backdrop: '', poster: '' };
  }

  // The backdrop layer, outside the scroller: it fills the view and reaches up
  // under the tab bar. Keyed, so the scroller after it keeps its node while
  // the poster card comes and goes.
  protected detailBackdrop(art: DetailArt): Safe {
    const bg = cssUrl(art.backdrop);
    return html`
      ${bg
        ? html`<div class="detail-backdrop" data-key="detail-backdrop" data-under-tab-bar
                    style="background-image: url('${bg}')"></div>`
        : html`<div class="detail-backdrop" data-key="detail-backdrop" data-under-tab-bar></div>`}
      <div class="detail-backdrop-scrim" data-key="detail-scrim"></div>
    `;
  }

  // The poster card at the right.
  protected detailPoster(art: DetailArt): Safe | '' {
    return art.poster ? html`
      <div class="detail-poster-art" data-key="detail-poster"><img class="catalog-poster" src="${art.poster}" alt=""></div>` : '';
  }

  // A preloaded image settled: show what changed without moving the page.
  protected onArtSettled(): void { this.renderDetail(); }

  // Art that settled while the view was covered shows once it is shown again.
  private repaintArt(): void {
    if (this.mode === 'detail') this.onArtSettled();
    else if (this.mode === 'browse') this.refreshHeroArt();
  }

  // Whether an image has loaded, preloading it on first ask. A dead link
  // shows nothing useful (a CSS background has no error event, an <img> a
  // broken icon), so art shows only once it has loaded.
  private artState(url: string): 'none' | 'loading' | 'loaded' | 'failed' {
    if (!url) return 'none';
    const known = this.art.get(url);
    if (known) return known;
    this.art.set(url, 'loading');
    const img = new Image();
    const slow = setTimeout(() => {
      if (this.art.get(url) !== 'loading') return;
      this.slowArt.add(url);
      this.artChanged(url, 'failed');
    }, ART_SLOW_MS);
    const settle = (state: 'loaded' | 'failed') => () => {
      clearTimeout(slow);
      this.art.set(url, state);
      this.slowArt.delete(url);
      this.artChanged(url, state);
    };
    img.onload = settle('loaded');
    img.onerror = settle('failed');
    img.src = url;
    return 'loading';
  }

  // Re-render only for art the shown screen uses; a hidden view (the player
  // over it) re-renders when it shows again.
  private artChanged(url: string, state: 'loaded' | 'failed'): void {
    if (!inShownView(this.layers[this.mode])) return;
    if (this.mode === 'detail') {
      if (this.detailArtUrls.indexOf(url) >= 0 || this.detailCandidateUrls.indexOf(url) >= 0) this.onArtSettled();
    } else if (this.mode === 'browse' && state === 'loaded' && this.heroArt
        && this.heroBackdrop(this.heroArt) === url) {
      this.refreshHeroArt();
    }
  }

  protected posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  protected itemLockBadge(categoryId: string, id: string): Safe {
    return raw(lockBadge(ParentalControlService.lockState(
      catalogParentalRequest(this.parentalKind, {
        accountId: this.account?.id ?? '',
        categoryId,
        name: '',
        id,
      }),
    )));
  }

  // Lock badges follow the unlock session without changing what is listed.
  refreshLocks(): void {
    if (!this.layer().querySelector('.catalog-view')) return;
    if (this.mode === 'browse') this.renderBrowse(false);
    else if (this.mode === 'grid') this.renderGrid(false);
  }

  protected tile(item: I, overlay: Safe | '' = '', managing = false): Safe {
    const id = this.itemId(item);
    const cat = this.itemCategoryId(item);
    return html`
      <div class="catalog-tile" ${raw(managing ? '' : 'data-focusable')} data-key="i:${cat}:${id}"
           data-item-id="${id}" data-category-id="${cat}">
        <div class="catalog-poster-wrap">${this.posterCell(this.itemName(item), this.itemPoster(item))}${
          this.itemLockBadge(cat, id)}${this.watchedBadge(id)}${overlay}</div>
        <div class="catalog-tile-name">${this.itemName(item)}</div>
      </div>
    `;
  }

  // A rail shows the first RAIL_ITEMS titles; a trailing tile opens the full grid.
  private categoryRail(group: { category: C; items: I[] }): Safe {
    const id = group.category.id;
    const total = this.itemsByCategory[id]?.length ?? group.items.length;
    const tiles = group.items.map((it) => this.tile(it));
    // A category with hidden titles keeps a way to its grid, where Show: Hidden lists them.
    const hidden = (this.serverItemsByCategory[id]?.length ?? total) > total;
    if (total > group.items.length || hidden) {
      tiles.push(html`
        <div class="catalog-tile catalog-see-all" data-focusable data-key="all:${id}"
             data-category-id="${id}">
          <div class="catalog-poster-wrap catalog-see-all-card">
            ${raw(categoryLockBadge(this.parentalKind, this.account!.id, id))}
            ${raw(SEE_ALL_ICON)}
            <div class="catalog-see-all-label">${t('catalog.seeAll')}</div>
            <div class="catalog-see-all-count">${this.itemCount(total)}</div>
          </div>
        </div>
      `);
    }
    return this.rail(`cat:${id}`, group.category.name, tiles);
  }

  // A loading rail keeps a loaded rail's title, height, and tile columns, so
  // Up and Down from any column step onto it rather than past it.
  private placeholderRail(category: C): Safe {
    const id = category.id;
    const tiles = Array.from({ length: RAIL_PLACEHOLDER_TILES }, (_, index) => html`
      <div class="catalog-tile catalog-tile-placeholder" data-focusable
           data-key="pending:${id}:${String(index)}" aria-hidden="true">
        <div class="catalog-poster-wrap"></div>
        <div class="catalog-tile-name">${raw('&nbsp;')}</div>
      </div>
    `);
    return html`
      <div class="catalog-rail" data-key="rail:cat:${id}" data-rail-key="cat:${id}" data-rail-pending
           aria-busy="true">
        <h2 class="catalog-rail-title">${category.name}</h2>
        <div class="catalog-rail-track" data-edge-scroll>${tiles}</div>
      </div>
    `;
  }

  // The hero follows the first rail that has landed; while an earlier rail
  // still loads it waits, so it changes once rather than per rail.
  private leadingHero(): I | null {
    for (const slot of this.railSlots) {
      if (this.railHidden(slot)) continue;
      if (slot.state !== 'loaded') break;
      // A rail whose titles are all hidden stays in browse but has no hero.
      if (slot.items.length) return slot.items[0];
    }
    return this.heroFallback();
  }

  // A rail that failed or came back empty is left out of browse.
  private railHidden(slot: RailSlot<C, I>): boolean {
    return slot.state === 'failed' || (slot.state === 'loaded' && !slot.items.length
      && !(this.serverItemsByCategory[slot.category.id]?.length));
  }

  // Once some categories have no rail, "All Categories" lists every category,
  // rails included, so it is the one complete index of the catalog.
  private allCategoriesShown(): boolean {
    return this.categories.length > this.railSlots.length
      || this.railSlots.some(slot => this.railHidden(slot));
  }

  // Loads the rails on screen, the first one below it, and the one after the
  // focused rail, so D-pad, pointer, and wheel browsing all reach loaded rails.
  // Without a layout to measure, only the first rail loads.
  private requestNearRails(): void {
    if (this.mode !== 'browse' || !this.account || this.railAccountId !== this.account.id) return;
    if (!this.railSlots.some(slot => slot.state === 'pending')) return;
    const signal = this.requestSignal;
    if (!signal || signal.aborted) return;
    const rails = this.layers.browse.querySelector<HTMLElement>('.catalog-browse .catalog-rails');
    if (!rails) return;
    const wanted: RailSlot<C, I>[] = [];
    const slotFor = (railKey: string | undefined): RailSlot<C, I> | undefined =>
      this.railSlots.find(slot => `cat:${slot.category.id}` === railKey);
    const view = rails.getBoundingClientRect();
    if (view.height > 0) {
      const shown = Array.from(rails.querySelectorAll<HTMLElement>('[data-rail-key]'));
      for (const rail of shown) {
        const slot = slotFor(rail.dataset.railKey);
        const top = rail.getBoundingClientRect().top;
        if (slot) wanted.push(slot);
        if (top >= view.bottom) break;
      }
    } else {
      const first = this.railSlots.find(slot => !this.railHidden(slot));
      if (first) wanted.push(first);
    }
    const focused = parseKey(this.focusScope.focusKey);
    if (focused?.mode === 'browse') {
      const index = this.railSlots.findIndex(slot => `cat:${slot.category.id}` === focused.rail);
      if (index >= 0) {
        wanted.push(this.railSlots[index]);
        const next = this.railSlots.slice(index + 1).find(slot => !this.railHidden(slot));
        if (next) wanted.push(next);
      }
    }
    wanted.forEach(slot => {
      if (slot.state === 'pending') this.startRailLoad(slot, this.account!, signal);
    });
  }

  private startRailLoad(slot: RailSlot<C, I>, account: PlaylistEntry, signal: AbortSignal): void {
    const id = slot.category.id;
    const generation = this.railGeneration;
    slot.state = 'loading';
    const promise = this.loadVisibleItems(account, id, signal);
    this.railRequests[id] = { promise, signal };
    const live = (): boolean => generation === this.railGeneration
      && this.account?.id === account.id && this.railSlots.indexOf(slot) >= 0;
    promise.then((items) => {
      if (!live()) return;
      if (this.railRequests[id]?.promise === promise) delete this.railRequests[id];
      if (signal.aborted) {
        slot.state = 'pending';
        this.requestNearRails();
        return;
      }
      // A grid may have loaded this category meanwhile; it keeps its list.
      if (!this.serverItemsByCategory[id]) this.setCategoryItems(id, items);
      slot.items = this.itemsByCategory[id].slice(0, CONFIG.XTREAM.RAIL_ITEMS);
      slot.state = 'loaded';
      this.railSettled();
    }, (err: unknown) => {
      if (!live()) return;
      if (this.railRequests[id]?.promise === promise) delete this.railRequests[id];
      // A canceled rail loads again once browse is shown and near it.
      if (signal.aborted) {
        slot.state = 'pending';
        this.requestNearRails();
        return;
      }
      log.error(
        'Catalog rail load failed',
        'event=xtream.view.load.failed',
        'operation=rail',
        `mode=${this.parentalKind}`,
        err,
      );
      slot.state = 'failed';
      this.railSettled();
    });
  }

  private railSettled(): void {
    const slots = this.railSlots;
    if (slots.every(slot => slot.state === 'loaded' || slot.state === 'failed')) {
      const failed = slots.filter(slot => slot.state === 'failed').length;
      const empty = slots.filter(slot => slot.state === 'loaded' && !slot.items.length).length;
      const kept = slots.length - failed - empty;
      if (kept < slots.length) {
        log.warn(
          'Catalog rails partially loaded',
          'event=xtream.view.rails.partial',
          `mode=${this.parentalKind}`,
          `kept=${String(kept)}`,
          `failed=${String(failed)}`,
          `empty=${String(empty)}`,
          `total=${String(slots.length)}`,
        );
      }
    }
    this.railsDirty = true;
    this.flushRailUpdates();
  }

  // Shows the rails that landed, if browse is on screen and no sort menu is
  // open; a hidden browse shows them when it renders again.
  private flushRailUpdates(): void {
    if (!this.railsDirty || this.mode !== 'browse' || this.openSortMenu()) return;
    const browse = this.layers.browse;
    if (!browse.querySelector('.catalog-browse .catalog-rails')) return;
    const focused = parseKey(this.focusScope.focusKey);
    const railOrder = Array.from(browse.querySelectorAll<HTMLElement>('[data-rail-key]'));
    const picked = this.pickedHero();
    this.renderBrowseHeld();
    if (picked) this.restoreHero(picked);
    const key = this.focusScope.focusKey;
    if (focused?.mode === 'browse' && focused.key.indexOf('pending:') === 0 && key !== null
        && !this.resolveKey(key)) {
      // Without revealing a ring the pointer hid.
      this.place(this.landingAfterRails(railOrder, focused) ?? this.nav.first(), null);
    } else {
      const el = this.current();
      if (el && browse.contains(el)) this.heroFromTile(el);
    }
  }

  // The hero a focused title put up in place of the leading one, which a
  // rail landing re-render keeps whatever the focus rests on.
  private pickedHero(): { name: string; background: string; art: HeroArt | null } | null {
    const hero = this.layers.browse.querySelector<HTMLElement>('.catalog-hero');
    const name = this.layers.browse.querySelector('.catalog-hero-title')?.textContent ?? '';
    if (!hero) return null;
    const leading = this.leadingHero();
    // The section name is what the hero shows before any rail has a title.
    if (name === this.kicker || (leading && name === this.itemName(leading))) return null;
    return { name, background: hero.style.backgroundImage, art: this.heroArt };
  }

  private restoreHero(picked: { name: string; background: string; art: HeroArt | null }): void {
    const hero = this.layers.browse.querySelector<HTMLElement>('.catalog-hero');
    const title = this.layers.browse.querySelector<HTMLElement>('.catalog-hero-title');
    this.heroArt = picked.art;
    // Recomputed, so a backdrop that loaded while the view was covered shows.
    const bg = picked.art ? this.heroUrl(picked.art) : '';
    if (hero) hero.style.backgroundImage = picked.art ? (bg ? `url('${bg}')` : 'none') : picked.background;
    if (title) title.textContent = picked.name;
  }

  // Renders browse holding what is on screen still while a rail above it
  // drops out or shows up, as Chromium 53 has no scroll anchoring and
  // .catalog-rails turns it off everywhere else. If the top rail itself dropped out, the first remaining rail
  // below it holds still. A hidden layer is only invisible, so it measures.
  private renderBrowseHeld(): void {
    const rails = this.layers.browse.querySelector<HTMLElement>('.catalog-browse .catalog-rails');
    const railOrder = rails ? Array.from(rails.querySelectorAll<HTMLElement>('[data-rail-key]')) : [];
    const top = rails ? rails.getBoundingClientRect().top : 0;
    const first = railOrder.findIndex(rail => rail.getBoundingClientRect().bottom > top);
    const candidates = first < 0 ? [] : railOrder.slice(first)
      .map(rail => ({ rail, top: rail.getBoundingClientRect().top }));
    // So the hero's backdrop wait runs on instead of restarting for the
    // leading title in between.
    this.heldHero = this.pickedHero();
    try {
      this.renderBrowse(false);
    } finally {
      this.heldHero = null;
    }
    const held = candidates.find(c => c.rail.isConnected);
    // At the top, a rail added above shows rather than pushing what was there.
    if (!rails || !held || rails.scrollTop === 0) return;
    const delta = held.rail.getBoundingClientRect().top - held.top;
    if (Math.abs(delta) >= 1) {
      const target = rails.scrollTop + delta;
      withInstantScroll([rails], () => { rails.scrollTop = target; });
    }
  }

  // The skeleton the focus held became titles, came back empty, or its rail
  // failed. The focus keeps its column on that rail, else takes the first
  // title of the next rail down (All Categories included), else the nearest
  // one above.
  private landingAfterRails(before: HTMLElement[], focused: CatalogKey): HTMLElement | null {
    const after = Array.from(this.layers.browse.querySelectorAll<HTMLElement>('[data-rail-key]'));
    const index = before.findIndex(rail => rail.dataset.railKey === focused.rail);
    let start = 0;
    for (let i = index; i >= 0; i--) {
      if (!before[i].isConnected) continue;
      start = after.indexOf(before[i]) + (i === index ? 0 : 1);
      break;
    }
    const column = Number(focused.key.slice(focused.key.lastIndexOf(':') + 1)) || 0;
    const tilesOf = (rail: HTMLElement): HTMLElement[] =>
      Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'));
    for (let i = start; i < after.length; i++) {
      const tiles = tilesOf(after[i]);
      if (!tiles.length) continue;
      return after[i].dataset.railKey === focused.rail ? tiles[Math.min(column, tiles.length - 1)] : tiles[0];
    }
    for (let i = start - 1; i >= 0; i--) {
      const tiles = tilesOf(after[i]);
      if (tiles.length) return tiles[0];
    }
    return null;
  }

  protected rail(key: string, title: string, items: Safe[]): Safe {
    return html`
      <div class="catalog-rail" data-key="rail:${key}" data-rail-key="${key}">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track" data-edge-scroll>${items}</div>
      </div>
    `;
  }

  private loadingMarkup(): Safe {
    return html`
      <div class="catalog-view catalog-loading" data-nav-container>
        <p class="catalog-hint">${t('common.loading')}</p>
      </div>
    `;
  }

  private renderLoading(mode: Mode): void {
    this.showLayer(mode);
    // Drop focus from the hidden layer so OK can't reselect it meanwhile.
    this.place(null, this.placementVia());
    morph(this.layers[mode], this.loadingMarkup());
  }

  private sortControls(): Safe {
    const by = this.sort.by;
    return html`
      <div class="catalog-sort" data-nav-container data-self-activate>
        <span class="catalog-sort-label">${t('catalog.sortBy')}</span>
        ${dropdown(`${this.scopeName()}-${this.mode}-sort`, [
          { value: 'default', label: t('catalog.sortDefault') },
          { value: 'name', label: t('settings.name') },
          { value: 'added', label: t('catalog.sortAdded') },
          { value: 'rating', label: t('catalog.sortRating') },
          { value: 'year', label: t('catalog.sortYear') },
        ], by)}
        ${by !== 'default' ? html`
          <div class="toggle-group" role="radiogroup"
               aria-label="${sortDirections(by).map(direction => sortDirectionLabel(by, direction)).join(' / ')}">
            ${sortDirections(by).map(direction => html`
              <button class="toggle-option catalog-sort-direction${direction === this.sort.direction ? ' active' : ''}"
                      type="button" role="radio" aria-checked="${direction === this.sort.direction}"
                      data-focusable data-key="sort-direction:${by}:${direction}" data-sort-direction="${direction}">
                <span class="catalog-sort-direction-icon">${raw(direction === 'asc'
                  ? SORT_ASCENDING_ICON : SORT_DESCENDING_ICON)}</span>
                <span>${sortDirectionLabel(by, direction)}</span>
              </button>
            `)}
          </div>
        ` : ''}
        ${this.mode === 'grid' && !this.collection ? this.filterControls() : ''}
      </div>
    `;
  }

  protected renderBrowse(restoreFocus = true): void {
    this.dismissSort(null);
    this.showLayer('browse');
    const browse = this.layers.browse;
    this.resume = this.visibleResume(this.account!.id);
    const hero = this.leadingHero();
    const continueRail = this.collectionRail('continue');
    const watchlistRail = this.collectionRail('watchlist');
    const hasContent = this.categories.length > 0 || !!continueRail || !!watchlistRail;
    // A held re-render keeps the title focus put up in place of the leading one.
    const picked = this.heldHero;
    this.heroArt = picked?.art
      ?? (hero ? { poster: this.itemPoster(hero), backdrop: this.itemBackdrop(hero) } : null);
    const heroBg = this.heroArt ? this.heroUrl(this.heroArt) : '';
    const heroName = picked?.art ? picked.name : hero ? this.itemName(hero) : this.kicker;
    // Once some categories have no rail, "All Categories" lists every category,
    // rails included, so it is the one complete index of the catalog.
    const moreCats = this.allCategoriesShown() ? this.categories : [];
    const previousCategoryRail = browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (restoreFocus && previousCategoryRail) {
      this.categoryVirtualizer.setScrollOffset(previousCategoryRail.scrollLeft);
    }
    const categoryViewport = previousCategoryRail?.clientWidth || CATEGORY_RAIL_VIEWPORT;
    const categoryRange = this.categoryVirtualizer.getRange(moreCats.length, categoryViewport);
    this.categoryWindow = `${String(moreCats.length)}:${String(categoryRange.start)}:${String(categoryRange.end)}`;

    morph(browse, html`
      <div class="catalog-view catalog-browse" data-nav-container>
        ${!hasContent
          ? html`<p class="catalog-hint catalog-empty">${this.emptyMessage}</p>`
          : html`
            <div class="catalog-hero" data-under-tab-bar style="background-image: url('${heroBg}')">
              <div class="catalog-hero-scrim"></div>
            </div>
            <div class="catalog-hero-body">
              <div class="catalog-hero-kicker">${this.kicker}</div>
              <h1 class="catalog-hero-title">${heroName}</h1>
            </div>
            <div class="catalog-rails">
              <div class="catalog-rails-spacer"></div>
              <div class="catalog-rails-body">
                ${continueRail}
                ${watchlistRail}
                ${this.categories.length ? this.sortControls() : ''}
                ${this.railSlots.map((slot) => {
                  if (this.railHidden(slot)) return '';
                  return slot.state === 'loaded' ? this.categoryRail(slot) : this.placeholderRail(slot.category);
                })}
                ${moreCats.length ? html`
                  <div class="catalog-rail" data-key="rail:all-categories"
                       data-rail-key="all-categories">
                    <h2 class="catalog-rail-title">${t('catalog.allCategories')}</h2>
                    <div class="catalog-rail-track catalog-category-rail" data-edge-scroll>
                      <div class="catalog-category-rail-spacer"
                           style="width:${this.categoryVirtualizer.getTotalSize(moreCats.length)}px">
                        ${moreCats.slice(categoryRange.start, categoryRange.end)
                          .map((c, offset) => {
                            const index = categoryRange.start + offset;
                            return html`
                              <div class="catalog-category-rail-cell"
                                   data-key="category-cell:${c.id}"
                                   data-category-virtual-index="${index}"
                                   style="left:${this.categoryVirtualizer.getItemOffset(index)}px">
                                <div class="catalog-cat" data-focusable
                                     data-key="c:${c.id}" data-category-id="${c.id}">${
                                  raw(categoryLockBadge(this.parentalKind, this.account!.id, c.id))
                                }${c.name}</div>
                              </div>
                            `;
                          })}
                      </div>
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>
          `}
      </div>
    `);
    const categoryRail = browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (categoryRail) {
      this.scrollGuard.syncOffset(
        categoryRail,
        'horizontal',
        this.categoryVirtualizer.scrollOffset,
      );
    }
    if (this.resetBrowseRailOffsets) {
      browse.querySelectorAll<HTMLElement>(
        '[data-rail-key^="cat:"] .catalog-rail-track',
      ).forEach(track => this.scrollGuard.syncOffset(track, 'horizontal', 0));
      this.resetBrowseRailOffsets = false;
    }
    syncTabBarOverArt();
    if (restoreFocus) this.restoreBrowseFocus();
    this.railsDirty = false;
    this.requestNearRails();
  }

  private collectionActions(width: number): Safe {
    return html`
      <div class="catalog-collection-actions" style="width:${width}px" data-nav-container data-self-activate>
        ${this.managing ? html`
          <button class="btn btn-primary catalog-collection-button" type="button" data-focusable
                  data-key="collection:done" data-collection-action="done">
            <span class="catalog-action-icon">${raw(CHECK_ICON)}</span>
            <span>${t('channel.editDone')}</span>
          </button>
          <button class="btn catalog-collection-button catalog-collection-clear" type="button" data-focusable
                  data-key="collection:clear" data-collection-action="clear">
            <span class="catalog-action-icon">${raw(TRASH_ICON)}</span>
            <span>${t('common.clearAll')}</span>
          </button>
        ` : html`
          <button class="btn catalog-collection-button catalog-collection-manage" type="button" data-focusable
                  data-key="collection:manage" data-collection-action="manage">
            <span class="catalog-action-icon">${raw(PENCIL_ICON)}</span>
            <span>${t('parental.manage')}</span>
          </button>
        `}
      </div>
    `;
  }

  // `followView`: the window follows a user scroll, whose offset stays as is;
  // above the first row the window's offset is 0 while the view's is not.
  protected renderGrid(restoreFocus = true, followView = false): void {
    this.dismissSort(null);
    this.showLayer('grid');
    const gridLayer = this.layers.grid;
    const cat = this.gridCategory;
    const kind = this.collection;
    if (kind && this.account) this.resume = this.visibleResume(this.account.id);
    const source = this.gridSource();
    const count = source.count;
    if (kind && count === 0) {
      this.leaveCollection();
      return;
    }
    if (restoreFocus) {
      const focused = parseKey(this.focusScope.focusKey);
      const key = this.gridReturnKey ?? (focused?.mode === 'grid' ? focused.key : null);
      if (kind && key) {
        const index = this.gridIndexOf(key);
        if (index >= 0) this.gridFocusIndex = index;
      }
      this.gridReturnKey = null;
    }
    this.gridFocusIndex = Math.max(0, Math.min(this.gridFocusIndex, count - 1));
    const previousView = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const previousTrack = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    if (restoreFocus && previousView) {
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, previousView.scrollTop - this.gridTrackStart(previousView, previousTrack)),
      );
    }
    const viewportWidth = previousTrack?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const viewportHeight = previousView?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    if (restoreFocus && count) {
      this.gridVirtualizer.ensureVisible(this.gridFocusIndex, viewportWidth, viewportHeight);
    }
    const range = this.gridVirtualizer.getRange(count, viewportWidth, viewportHeight);
    const actionWidth = this.gridVirtualizer.getItemPosition(range.columns - 1, range.columns).left
      + CATALOG_GRID_POSTER_WIDTH;
    const cells: Safe[] = [];
    for (let index = range.start; index < range.end; index++) {
      const position = this.gridVirtualizer.getItemPosition(index, range.columns);
      cells.push(html`
        <div class="catalog-grid-cell" data-key="grid:${source.keyAt(index)}" data-grid-index="${index}"
             style="left:${position.left}px;top:${position.top}px">${source.render(index)}</div>
      `);
    }
    const managing = !!kind && this.managing;
    morph(gridLayer, html`
      <div class="catalog-view catalog-grid${managing ? ' catalog-managing' : ''}${
        this.hasCaptionLine() ? ' catalog-grid-captioned' : ''}" data-nav-container>
        <h1 class="catalog-grid-title">${kind ? html`
          ${this.collectionTitle(kind)} <span class="catalog-grid-count">${this.itemCount(count)}</span>
        ` : cat ? cat.name : this.kicker}</h1>
        ${kind ? this.collectionActions(actionWidth) : this.sortControls()}
        ${count === 0
          ? html`<p class="catalog-hint">${kind
            ? t(kind === 'continue' ? 'catalog.continueWatchingEmpty' : 'catalog.watchlistEmpty')
            : this.filtersActive() ? t('catalog.noFilterMatches')
              : cat && (this.serverItemsByCategory[cat.id] ?? []).length ? t('catalog.allHidden')
                : this.gridEmptyMessage}</p>`
          : html`
            <div class="catalog-grid-track"
                 style="height:${this.gridVirtualizer.getTotalSize(count, viewportWidth)}px">${cells}
            </div>
          `}
      </div>
      ${managing ? html`
        <div class="edit-hints catalog-manage-hints">
          ${okHint(t('common.remove'))}
          <span class="edit-hint">${backKey()}<span>${t('channel.editDone')}</span></span>
        </div>
      ` : ''}
    `);
    const view = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const track = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    const viewOffset = this.gridVirtualizer.scrollOffset === 0
      ? 0
      : this.gridVirtualizer.scrollOffset + this.gridTrackStart(view, track);
    // A view already showing the window's offset keeps its own: above the
    // first row every position maps to 0, and an update in place must not
    // move it.
    if (view && !followView) {
      const shown = Math.max(0, view.scrollTop - this.gridTrackStart(view, track));
      this.scrollGuard.syncOffset(
        view,
        'vertical',
        !restoreFocus && shown === this.gridVirtualizer.scrollOffset ? view.scrollTop : viewOffset,
      );
    }
    if (restoreFocus) {
      const focused = gridLayer.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      );
      this.place(focused ?? gridLayer.querySelector<HTMLElement>('[data-focusable]'), this.placementVia());
    }
  }

  private moveGridFocus(direction: Action & ('up' | 'down' | 'left' | 'right')): boolean {
    const count = this.gridSource().count;
    if (!count) return false;
    const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
    const view = this.layers.grid.querySelector<HTMLElement>('.catalog-grid');
    const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const next = this.gridVirtualizer.getAdjacentIndex(
      this.gridFocusIndex,
      direction,
      count,
      viewportWidth,
    );
    if (next === this.gridFocusIndex) return false;
    this.gridFocusIndex = next;
    const viewportHeight = view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    // Measured against the window's recorded offset, as revealGridIndex is,
    // which a smooth scroll still moves once the guard's frames pass.
    const scrolled = this.gridVirtualizer.ensureVisible(next, viewportWidth, viewportHeight);
    if (!scrolled && this.gridScrollFrame === null) {
      const cell = this.layers.grid.querySelector<HTMLElement>(
        `[data-grid-index="${next}"] [data-focusable]`,
      );
      // Same window and same offset: renderGrid() would morph byte-identical
      // markup, since tiles carry no focus state - the scope owns the class.
      // The channel list already moves focus this way (moveVirtualFocus).
      if (cell) {
        this.place(cell, 'key');
        return true;
      }
    }
    this.renderGrid(false);
    this.place(
      this.layers.grid.querySelector<HTMLElement>(`[data-grid-index="${next}"] [data-focusable]`),
      'key',
    );
    return true;
  }

  private categoryWindowFor(viewport: number): string {
    const count = this.allCategoriesShown() ? this.categories.length : 0;
    const range = this.categoryVirtualizer.getRange(count, viewport || CATEGORY_RAIL_VIEWPORT);
    return `${String(count)}:${String(range.start)}:${String(range.end)}`;
  }

  // The cells sit inside the rail's padding, which bleeds under the margin.
  private categoryRailContentWidth(rail: HTMLElement | null): number {
    if (!rail?.clientWidth) return CATEGORY_RAIL_VIEWPORT;
    const style = getComputedStyle(rail);
    return rail.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  }

  private moveCategoryFocus(direction: 'left' | 'right'): boolean {
    const parsed = parseKey(this.focusScope.focusKey);
    if (!parsed || parsed.mode !== 'browse' || parsed.rail !== 'all-categories') return false;
    const categories = this.categories;
    const current = this.categoryIndexOf(parsed.key);
    if (current < 0) return false;
    const next = current + (direction === 'left' ? -1 : 1);
    // At either end, stay put: SpatialNav would jump to another rail's tile.
    if (next < 0 || next >= categories.length) return true;
    const rail = this.layers.browse.querySelector<HTMLElement>('.catalog-category-rail');
    this.categoryVirtualizer.ensureVisible(next, this.categoryRailContentWidth(rail));
    this.renderBrowse(false);
    this.place(
      this.layers.browse.querySelector<HTMLElement>(
        `[data-category-virtual-index="${next}"] [data-focusable]`,
      ),
      'key',
    );
    return true;
  }

  private gridTrackStart(
    view: HTMLElement | null,
    track: HTMLElement | null,
  ): number {
    if (!view || !track) return 0;
    return Math.max(
      0,
      track.getBoundingClientRect().top
        - view.getBoundingClientRect().top
        + view.scrollTop,
    );
  }
}
