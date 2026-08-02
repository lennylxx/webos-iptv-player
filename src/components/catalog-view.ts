import type { Action, PlaylistEntry, ResumeEntry, ResumeKind, VodPlayback } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { CONFIG } from '../config';
import { t } from '../i18n';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';

const CATALOG_GRID_COLUMN_STRIDE = 244;
const CATALOG_GRID_ROW_STRIDE = 395;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1760;
const CATALOG_GRID_VIEWPORT_HEIGHT = 900;
const CATEGORY_RAIL_STRIDE = 320;
const CATEGORY_RAIL_VIEWPORT = 1760;
const GRID_SNAP_DELAY_MS = 95;

export interface CatalogHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

type Mode = 'browse' | 'grid' | 'detail';

// Shared browse/grid/detail machinery for the Xtream catalog sections (Movies,
// Series): a hero + poster rails browse view, a per-category poster grid, and a
// detail screen, driven by one SpatialNav across all modes. Up at the top row
// hands off to the tab bar; Back walks detail -> grid -> browse -> Live.
// Subclasses supply the catalog loaders, item accessors, and the detail
// rendering / playback specifics.
export abstract class CatalogView<C extends { id: string; name: string }, I> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'browse';
  protected categories: C[] = [];
  protected railGroups: { category: C; items: I[] }[] = [];
  protected resume: ResumeEntry[] = [];
  protected itemsByCategory: Record<string, I[]> = {};
  protected gridCategory: C | null = null;
  protected deepLinkBack: (() => void) | null = null;
  private gridFocusIndex = 0;
  private readonly gridVirtualizer = new VirtualGrid({
    columnStride: CATALOG_GRID_COLUMN_STRIDE,
    rowStride: CATALOG_GRID_ROW_STRIDE,
    overscanRows: CATALOG_GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: CATALOG_GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: CATALOG_GRID_VIEWPORT_HEIGHT,
  });
  private gridScrollFrame: number | null = null;
  private readonly categoryVirtualizer = new VirtualList({
    itemSize: CATEGORY_RAIL_STRIDE,
    overscan: 4,
    fallbackViewportSize: CATEGORY_RAIL_VIEWPORT,
  });
  private categoryScrollFrame: number | null = null;
  protected readonly scrollGuard = new VirtualScrollGuard();
  private gridSnapTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(protected container: HTMLElement, protected handlers: CatalogHandlers) {
    this.nav = new SpatialNav(container, (el) => this.onFocusChanged(el));
    this.container.addEventListener('mouseleave', () => this.nav.clearHighlight());
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target as HTMLElement;
      if (this.handleExtraScroll(target)) return;
      if (this.mode === 'browse' && target.classList.contains('catalog-category-rail')) {
        const offset = this.scrollGuard.readUserOffset(target, 'horizontal');
        if (offset === null) return;
        this.categoryVirtualizer.setScrollOffset(offset);
        if (this.categoryScrollFrame === null) {
          this.categoryScrollFrame = requestAnimationFrame(() => {
            this.categoryScrollFrame = null;
            if (this.mode === 'browse') this.renderBrowse(false);
          });
        }
        return;
      }
      if (this.mode !== 'grid' || !target.classList.contains('catalog-grid')) return;
      const scrollTop = this.scrollGuard.readUserOffset(target, 'vertical');
      if (scrollTop === null) return;
      const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, scrollTop - this.gridTrackStart(target, track)),
      );
      this.scheduleGridSnap(target);
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'grid') this.renderGrid(false);
      });
    }, true);
  }

  // --- subclass configuration ---
  protected abstract readonly kicker: string;             // hero/grid label, e.g. 'Movies'
  protected abstract readonly resumeKind: ResumeKind;     // which resume entries this section owns
  protected abstract readonly emptyMessage: string;       // no catalog on the account
  protected abstract readonly gridEmptyMessage: string;   // empty category grid
  protected abstract loadCategories(account: PlaylistEntry): Promise<C[]>;
  protected abstract loadItems(account: PlaylistEntry, categoryId: string): Promise<I[]>;
  protected abstract itemId(item: I): string;
  protected abstract itemName(item: I): string;
  protected abstract itemPoster(item: I): string;
  protected abstract itemCategoryId(item: I): string;
  protected abstract openDetail(item: I): Promise<void>;
  protected abstract renderDetail(restoreFocus?: boolean): void;
  protected abstract clearDetail(): void;                 // drop detail state on deep-link back
  // Section-specific selects (play/resume/season/episode). Returns true if handled.
  protected abstract selectExtra(el: HTMLElement): boolean;
  protected moveExtraFocus(_action: Action): boolean { return false; }
  protected handleExtraScroll(_target: HTMLElement): boolean { return false; }
  // The Continue Watching rail (or '' when there is nothing to resume).
  protected abstract continueRail(): Safe | '';
  // The Watchlist rail (or '' when it is empty).
  protected abstract watchlistRail(): Safe | '';
  // A tile id that isn't in a loaded category (Continue/Watchlist); default none.
  protected fallbackItem(_id: string): I | null { return null; }
  // Hero when no rail item exists (Movies falls back to a resumed item); default none.
  protected heroFallback(): I | null { return null; }

  setAccount(account: PlaylistEntry): void { this.account = account; }

  refreshPlaybackState(): void {
    if (this.mode === 'detail') this.renderDetail();
  }

  async open(account: PlaylistEntry): Promise<void> {
    this.account = account;
    this.deepLinkBack = null;
    this.mode = 'browse';
    this.itemsByCategory = {};
    this.categoryVirtualizer.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.resume = StorageService.getResumeList(account.id).filter((e) => e.kind === this.resumeKind);
    this.renderLoading();
    const categories = await this.loadCategories(account);
    // A newer open() (account switch) superseded this load — discard it.
    if (this.account?.id !== account.id) return;
    this.categories = categories;
    const railCats = this.categories.slice(0, CONFIG.XTREAM.RAIL_CATEGORIES);
    const loaded = await Promise.all(railCats.map((c) => this.loadItems(account, c.id)));
    if (this.account?.id !== account.id) return;
    this.railGroups = railCats.map((category, i) => {
      this.itemsByCategory[category.id] = loaded[i];
      return { category, items: loaded[i].slice(0, CONFIG.XTREAM.RAIL_ITEMS) };
    });
    this.renderBrowse();
  }

  // Deep-link entry (from Search): open this item's detail directly. Back returns
  // to the caller via onDetailBack (no browse is loaded underneath).
  async openItem(account: PlaylistEntry, item: I, onDetailBack: () => void): Promise<void> {
    this.account = account;
    this.deepLinkBack = onDetailBack;
    await this.openDetail(item);
  }

  handleAction(action: Action): void {
    if (this.moveExtraFocus(action)) return;
    if (this.mode === 'browse' && (action === 'left' || action === 'right')
        && this.moveCategoryFocus(action)) return;
    if (this.mode === 'grid'
        && (action === 'up' || action === 'down' || action === 'left' || action === 'right')) {
      if (this.moveGridFocus(action)) return;
      if (action === 'up') this.handlers.onRevealTabBar();
      return;
    }
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
        this.onBack();
        return;
      default:
        return;
    }
  }

  private onBack(): void {
    if (this.mode === 'detail') {
      if (this.deepLinkBack) { const back = this.deepLinkBack; this.deepLinkBack = null; this.clearDetail(); back(); return; }
      this.gridCategory ? this.renderGrid() : this.renderBrowse();
      return;
    }
    if (this.mode === 'grid') { this.gridCategory = null; this.renderBrowse(); return; }
    this.handlers.onBack();
  }

  private onSelect(): void {
    const el = this.nav.focused;
    if (!el || !this.account) return;
    if (el.dataset.categoryId !== undefined && el.classList.contains('catalog-cat')) {
      void this.openGrid(el.dataset.categoryId);
      return;
    }
    if (this.selectExtra(el)) return;
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.categoryId ?? '', el.dataset.itemId);
      if (item) void this.openDetail(item);
    }
  }

  // Keep the browse hero (title + backdrop) in sync with the focused item tile.
  // Category tiles and non-browse modes leave the hero unchanged.
  private onFocusChanged(el: HTMLElement | null): void {
    const gridCell = el?.closest<HTMLElement>('[data-grid-index]');
    if (this.mode === 'grid' && gridCell?.dataset.gridIndex !== undefined) {
      this.gridFocusIndex = parseInt(gridCell.dataset.gridIndex, 10);
      return;
    }
    const categoryCell = el?.closest<HTMLElement>('[data-category-virtual-index]');
    if (this.mode === 'browse' && categoryCell) return;
    if (this.mode !== 'browse' || !el) return;
    const id = el.dataset.itemId;
    if (id === undefined) return;
    const item = this.findItem(el.dataset.categoryId ?? '', id);
    if (item) this.updateHero(this.itemName(item), this.itemPoster(item));
  }

  private updateHero(name: string, poster: string): void {
    const hero = this.container.querySelector<HTMLElement>('.catalog-hero');
    if (!hero) return;
    const title = this.container.querySelector<HTMLElement>('.catalog-hero-title');
    if (title) title.textContent = name; // textContent escapes untrusted names
    // Poster sits inside a CSS url('…') string; percent-encode the characters
    // that could break out of it (matches renderBrowse's heroBg).
    const bg = poster ? poster.replace(/["'()\\\s]/g, encodeURIComponent) : '';
    hero.style.backgroundImage = bg ? `url('${bg}')` : 'none';
  }

  protected findItem(categoryId: string, id: string): I | null {
    const inCat = this.itemsByCategory[categoryId] ?? [];
    return inCat.find((x) => this.itemId(x) === id) ?? this.fallbackItem(id);
  }

  private async openGrid(categoryId: string): Promise<void> {
    if (!this.account) return;
    this.gridCategory = this.categories.find((c) => c.id === categoryId) ?? null;
    if (!this.itemsByCategory[categoryId]) {
      this.renderLoading();
      this.itemsByCategory[categoryId] = await this.loadItems(this.account, categoryId);
    }
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.renderGrid();
  }

  protected posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  protected tile(item: I): Safe {
    const id = this.itemId(item);
    const cat = this.itemCategoryId(item);
    return html`
      <div class="catalog-tile" data-focusable data-key="i:${cat}:${id}"
           data-item-id="${id}" data-category-id="${cat}">
        <div class="catalog-poster-wrap">${this.posterCell(this.itemName(item), this.itemPoster(item))}</div>
        <div class="catalog-tile-name">${this.itemName(item)}</div>
      </div>
    `;
  }

  protected rail(title: string, items: Safe[]): Safe {
    return html`
      <div class="catalog-rail">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track">${items}</div>
      </div>
    `;
  }

  private renderLoading(): void {
    morph(this.container, html`
      <div class="catalog-view catalog-loading" data-nav-container>
        <p class="catalog-hint">${t('common.loading')}</p>
      </div>
    `);
  }

  protected renderBrowse(restoreFocus = true): void {
    this.mode = 'browse';
    this.resume = StorageService.getResumeList(this.account!.id).filter((e) => e.kind === this.resumeKind);
    const hero = this.railGroups[0]?.items[0] ?? this.heroFallback();
    const continueRail = this.continueRail();
    const watchlistRail = this.watchlistRail();
    const hasContent = this.categories.length > 0 || !!continueRail || !!watchlistRail;
    // A poster URL sits inside a CSS url('…') string, where the html escaper's
    // entity encoding is decoded before CSS parses it; percent-encode the
    // characters that could break out of the string.
    const heroBg = hero ? this.itemPoster(hero).replace(/["'()\\\s]/g, encodeURIComponent) : '';
    // Categories shown as their own poster rail; the "All Categories" rail lists
    // only the rest, so a category is never both a rail and a tile.
    const railCatIds: Record<string, true> = {};
    this.railGroups.forEach((r) => { railCatIds[r.category.id] = true; });
    const moreCats = this.categories.filter((c) => !railCatIds[c.id]);
    const previousCategoryRail = this.container.querySelector<HTMLElement>('.catalog-category-rail');
    if (restoreFocus && previousCategoryRail) {
      this.categoryVirtualizer.setScrollOffset(previousCategoryRail.scrollLeft);
    }
    const categoryViewport = previousCategoryRail?.clientWidth || CATEGORY_RAIL_VIEWPORT;
    const categoryRange = this.categoryVirtualizer.getRange(moreCats.length, categoryViewport);

    morph(this.container, html`
      <div class="catalog-view catalog-browse" data-nav-container>
        ${!hasContent
          ? html`<p class="catalog-hint catalog-empty">${this.emptyMessage}</p>`
          : html`
            <div class="catalog-hero" style="background-image: url('${heroBg}')">
              <div class="catalog-hero-scrim"></div>
            </div>
            <div class="catalog-hero-body">
              <div class="catalog-hero-kicker">${this.kicker}</div>
              <h1 class="catalog-hero-title">${hero ? this.itemName(hero) : this.kicker}</h1>
            </div>
            <div class="catalog-rails">
              <div class="catalog-rails-spacer"></div>
              <div class="catalog-rails-body">
                ${continueRail}
                ${watchlistRail}
                ${this.railGroups.map((r) => this.rail(r.category.name, r.items.map((it) => this.tile(it))))}
                ${moreCats.length ? html`
                  <div class="catalog-rail">
                    <h2 class="catalog-rail-title">${t('catalog.allCategories')}</h2>
                    <div class="catalog-rail-track catalog-category-rail">
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
                                     data-key="c:${c.id}" data-category-id="${c.id}">${c.name}</div>
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
    const categoryRail = this.container.querySelector<HTMLElement>('.catalog-category-rail');
    if (categoryRail) {
      this.scrollGuard.syncOffset(
        categoryRail,
        'horizontal',
        this.categoryVirtualizer.scrollOffset,
      );
    }
    if (restoreFocus) this.nav.focusFirst();
    else this.nav.clearDetachedFocus();
  }

  protected renderGrid(restoreFocus = true): void {
    this.mode = 'grid';
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    this.gridFocusIndex = Math.max(0, Math.min(this.gridFocusIndex, items.length - 1));
    const previousView = this.container.querySelector<HTMLElement>('.catalog-grid');
    const previousTrack = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    if (restoreFocus && previousView) {
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, previousView.scrollTop - this.gridTrackStart(previousView, previousTrack)),
      );
    }
    const viewportWidth = previousTrack?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const viewportHeight = previousView?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    if (restoreFocus && items.length) {
      this.gridVirtualizer.ensureVisible(this.gridFocusIndex, viewportWidth, viewportHeight);
    }
    const range = this.gridVirtualizer.getRange(items.length, viewportWidth, viewportHeight);
    morph(this.container, html`
      <div class="catalog-view catalog-grid" data-nav-container>
        <h1 class="catalog-grid-title">${cat ? cat.name : this.kicker}</h1>
        ${items.length === 0
          ? html`<p class="catalog-hint">${this.gridEmptyMessage}</p>`
          : html`
            <div class="catalog-grid-track"
                 style="height:${this.gridVirtualizer.getTotalSize(items.length, viewportWidth)}px">
              ${items.slice(range.start, range.end).map((it, offset) => {
                const index = range.start + offset;
                const position = this.gridVirtualizer.getItemPosition(index, range.columns);
                return html`
                  <div class="catalog-grid-cell"
                       data-key="grid:${this.itemId(it)}"
                       data-grid-index="${index}"
                       style="left:${position.left}px;top:${position.top}px">
                    ${this.tile(it)}
                  </div>
                `;
              })}
            </div>
          `}
      </div>
    `);
    const view = this.container.querySelector<HTMLElement>('.catalog-grid');
    const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    const viewOffset = this.gridVirtualizer.scrollOffset === 0
      ? 0
      : this.gridVirtualizer.scrollOffset + this.gridTrackStart(view, track);
    if (view) this.scrollGuard.syncOffset(view, 'vertical', viewOffset);
    if (restoreFocus) {
      const focused = this.container.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      );
      this.nav.focus(focused);
    } else this.nav.clearDetachedFocus();
  }

  private moveGridFocus(direction: Action & ('up' | 'down' | 'left' | 'right')): boolean {
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    if (!items.length) return false;
    const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    const view = this.container.querySelector<HTMLElement>('.catalog-grid');
    const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const next = this.gridVirtualizer.getAdjacentIndex(
      this.gridFocusIndex,
      direction,
      items.length,
      viewportWidth,
    );
    if (next === this.gridFocusIndex) return false;
    this.gridFocusIndex = next;
    this.gridVirtualizer.ensureVisible(
      next,
      viewportWidth,
      view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT,
    );
    this.renderGrid();
    return true;
  }

  private moveCategoryFocus(direction: 'left' | 'right'): boolean {
    const focused = this.nav.focused;
    const cell = focused?.closest<HTMLElement>('[data-category-virtual-index]');
    if (!cell) return false;
    const railCatIds: Record<string, true> = {};
    this.railGroups.forEach((group) => { railCatIds[group.category.id] = true; });
    const categories = this.categories.filter(category => !railCatIds[category.id]);
    const current = parseInt(cell.dataset.categoryVirtualIndex!, 10);
    const next = current + (direction === 'left' ? -1 : 1);
    if (next < 0 || next >= categories.length) return false;
    const rail = this.container.querySelector<HTMLElement>('.catalog-category-rail');
    this.categoryVirtualizer.ensureVisible(
      next,
      rail?.clientWidth || CATEGORY_RAIL_VIEWPORT,
    );
    this.renderBrowse(false);
    this.nav.focus(
      this.container.querySelector<HTMLElement>(
        `[data-category-virtual-index="${next}"] [data-focusable]`,
      ),
    );
    return true;
  }

  private scheduleGridSnap(view: HTMLElement): void {
    if (this.gridSnapTimer !== null) clearTimeout(this.gridSnapTimer);
    this.gridSnapTimer = setTimeout(() => {
      this.gridSnapTimer = null;
      if (this.mode !== 'grid') return;
      const category = this.gridCategory;
      const items = category ? (this.itemsByCategory[category.id] ?? []) : [];
      const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
      const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
      const viewportHeight = view.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
      const maxOffset = Math.max(
        0,
        this.gridVirtualizer.getTotalSize(items.length, viewportWidth) - viewportHeight,
      );
      const snapped = Math.min(
        maxOffset,
        Math.round(this.gridVirtualizer.scrollOffset / CATALOG_GRID_ROW_STRIDE)
          * CATALOG_GRID_ROW_STRIDE,
      );
      if (snapped === this.gridVirtualizer.scrollOffset) return;
      this.gridVirtualizer.setScrollOffset(snapped);
      this.renderGrid(false);
    }, GRID_SNAP_DELAY_MS);
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
