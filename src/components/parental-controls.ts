import type {
  Action,
  CatalogCategoryTarget,
  CatalogItemTarget,
  Channel,
  LiveChannelTarget,
  LiveGroupTarget,
  ParentalItemTarget,
  ParentalParentTarget,
  ParentalUnlockDuration,
  PlaylistEntry,
  SeriesCategory,
  SeriesItem,
  VodCategory,
  VodItem,
} from '../types';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, Tier, type FocusScope, type Via } from '../navigation/focus-scope';
import { InputMode } from '../navigation/input-mode';
import { isHovered } from '../navigation/focus-ring';
import { StorageService } from '../services/storage-service';
import { PlaylistService } from '../services/playlist-service';
import { channelKey, groupDisplayLabel } from '../utils/channel';
import { isSourceEnabled } from '../utils/playlist';
import {
  loadAllSeries,
  loadAllVodStreams,
  loadSeries,
  loadSeriesCategories,
  loadVodCategories,
  loadVodStreams,
} from '../services/xtream-catalog';
import { ParentalControlService, liveParentalRequest, parentalTargetKey } from '../services/parental-control';
import { t, tp } from '../i18n';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { LOCK_ICON } from './icons';
import { doneHint, keyHint, okHint } from './key-hints';
import { AccountSwitcher } from './account-switcher';
import { lockBadge } from './parental-badge';
import { sourceToggle, toggleGroup } from './toggle-controls';
import { ConfirmationPrompt } from './confirmation-prompt';
import { showToast } from './toast';
import { isAdultGroupName } from './group-icon';

const log = createLogger('ParentalControls');

// A 58px row plus its 6px bottom margin; the list's 4px top padding sits above row 0.
const ROW_STRIDE = 64;
const LIST_PADDING = 4;
const LIST_OVERSCAN = 8;
const FALLBACK_LIST_HEIGHT = 600;

type ListKind = 'group' | 'item';
// The on/off switch is shared markup without a key of its own.
const ENABLED_KEY = 'parental-enabled';

function rowKey(kind: ListKind, key: string): string {
  return `${kind}|${key}`;
}

type SourceKind = 'live' | 'vod' | 'series';

interface SourceEntry {
  key: string;
  kind: SourceKind;
  account: PlaylistEntry;
}

interface GroupEntry {
  key: string;
  name: string;
  count: number | null;
  // Adult by name or source metadata; offered for locking, never locked silently.
  suggested: boolean;
  target: ParentalParentTarget;
  ruleKey?: string;
  // Live groups know their channels up front, so a partial lock can show a count.
  members: ItemEntry[] | null;
}

interface ItemEntry {
  key: string;
  name: string;
  target: ParentalItemTarget;
  ruleKey?: string;
  // A channel merged from several sources is locked by any of its groups.
  parents?: Array<LiveGroupTarget | CatalogCategoryTarget>;
}

interface RuleSummary {
  lockedGroups: number;
  suggestions: GroupEntry[];
  mixedGroups: Set<string>;
  exceptions: number;
}

function groupTarget(group: GroupEntry): LiveGroupTarget | CatalogCategoryTarget {
  return group.target as LiveGroupTarget | CatalogCategoryTarget;
}

// Built on first use: most rows of a 50,000-row catalog never need it.
function ruleKey(entry: GroupEntry | ItemEntry): string {
  return entry.ruleKey ?? (entry.ruleKey = parentalTargetKey(entry.target));
}

function itemTarget(item: ItemEntry): LiveChannelTarget | CatalogItemTarget {
  return item.target as LiveChannelTarget | CatalogItemTarget;
}

function sameInputs(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// Playlist conventions for adult entries: `adult="1"` or a `parent-code`.
function isAdultChannel(channel: Channel): boolean {
  const attributes = channel.sourceAttributes;
  return !!attributes && (attributes.adult === '1' || !!attributes['parent-code']);
}

export class ParentalControls {
  readonly focusScope: FocusScope;
  private readonly accountMenuScope: FocusScope;
  private nav: SpatialNav;
  // Only a key moves the current group; the pointer only highlights a row.
  private via: Via = 'key';
  // The pointer left the focused control: the next key only shows it again.
  private concealed = false;
  private sources: SourceEntry[] = [];
  private groups: GroupEntry[] = [];
  private items: ItemEntry[] = [];
  private sourceIndex = 0;
  private kind: SourceKind = 'live';
  private liveKey = '';
  private xtreamId = '';
  private switcher: AccountSwitcher | null = null;
  // Which column the color keys act on; it survives the pointer moving onto the legend.
  private focusArea: 'group' | 'item' = 'group';
  // The current group survives focus leaving the column (Magic Remote pointer
  // on the legend), so the blue key and the item column always have a target.
  private groupIndex = -1;
  private groupsLoading = false;
  private itemsLoading = false;
  private itemsGroupKey: string | null = null;
  private itemsLoad: Promise<void> | null = null;
  private itemsTimer: ReturnType<typeof setTimeout> | null = null;
  private itemsController: AbortController | null = null;
  private requestController: AbortController | null = null;
  // Item rule key -> owning group key, so "Mixed" holds for every group, not
  // only the one whose items are loaded.
  private memberGroups = new Map<string, string>();
  private memberGroupsRevision = 0;
  private groupSummaryCache: (Omit<RuleSummary, 'exceptions'> & { inputs: unknown[] }) | null = null;
  private exceptionCache: { inputs: unknown[]; exceptions: number } | null = null;
  private lockedCounts = new WeakMap<ItemEntry[], { revision: number; locked: number }>();
  private groupsByKeyFor: GroupEntry[] | null = null;
  private groupsByKey = new Map<string, GroupEntry>();
  private tab: 'rules' | 'options' = 'rules';
  private readonly confirmationPrompt = new ConfirmationPrompt('prompt.parental');
  private readonly groupVirtualizer = new VirtualList({
    itemSize: ROW_STRIDE,
    overscan: LIST_OVERSCAN,
    fallbackViewportSize: FALLBACK_LIST_HEIGHT,
  });
  private readonly itemVirtualizer = new VirtualList({
    itemSize: ROW_STRIDE,
    overscan: LIST_OVERSCAN,
    fallbackViewportSize: FALLBACK_LIST_HEIGHT,
  });
  private readonly scrollGuard = new VirtualScrollGuard();
  private scrollFrame: number | null = null;

  constructor(
    private container: HTMLElement,
    private onBack: () => void,
    private onChangePin: (done: () => void) => void = () => {},
    private onCreatePin: (done: () => void) => void = () => {},
  ) {
    this.nav = new SpatialNav(container, el => this.onFocusChange(el), { follow: false });
    this.focusScope = Focus.register({
      id: 'view.parental-controls',
      root: container,
      defaultKey: () => this.defaultKey(),
      resolve: key => this.resolveKey(key),
      // A row a wheel scroll unmounted is still focused; a key brings it back.
      has: key => this.rowOf(key) !== null,
      reveal: key => this.revealRow(key),
    });
    this.accountMenuScope = Focus.register({
      id: 'parental.account_menu',
      root: () => this.container.querySelector<HTMLElement>('.parental-account-slot'),
      restrict: 'self-only',
      tier: Tier.overlay,
      onAction: action => this.handleAction(action),
    });
    // Pointer hover only highlights a control; it must not change the current
    // group, or reaching the footer hints would select every row it crosses.
    this.container.addEventListener('nav:hover', (event: Event) => {
      const el = event.target as HTMLElement;
      if (el.hasAttribute('data-focusable')) this.pick(el, 'pointer');
    });
    this.container.addEventListener('nav:unhover', (event: Event) => {
      if (event.target !== this.focusedElement()) return;
      this.concealed = true;
      this.focusScope.conceal();
      Focus.flush();
    });
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const clicked = event.target as HTMLElement;
      // The account switcher handles its own slot, and a click elsewhere
      // only dismisses its open menu.
      if (this.switcher?.menuOpen) return;
      if (clicked.closest('.parental-account-slot')) {
        // Runs before the switcher's own listener opens the menu.
        if (clicked.closest('.account-avatar')) this.hideAvatarRing();
        return;
      }
      const target = clicked.closest<HTMLElement>('[data-focusable]');
      if (!target) return;
      const group = target.dataset.parentalGroup;
      const selecting = group !== undefined && Number(group) !== this.groupIndex;
      // A click is a deliberate choice, so its items load without the D-pad debounce.
      if (selecting) this.setCurrentGroup(Number(group), true);
      this.pick(target, 'pointer');
      if (!selecting) this.activate(target);
    });
    this.container.addEventListener('scroll', (event: Event) => {
      const list = event.target;
      if (!(list instanceof HTMLElement)) return;
      const kind = list.dataset.parentalList;
      if (kind !== 'group' && kind !== 'item') return;
      const virtualizer = this.virtualizer(kind);
      const offset = this.scrollGuard.readUserOffset(list, 'vertical');
      if (offset === null || Math.abs(offset - virtualizer.scrollOffset) < 1) return;
      virtualizer.setScrollOffset(offset);
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.render();
      });
    }, true);
  }

  open(): void {
    ParentalControlService.setRevealAll(true);
    // Channels hidden by customization can be shown again from Settings, so
    // they must be reviewed and adopted too.
    PlaylistService.setIncludeHidden(true);
    this.requestController?.abort();
    this.sources = this.buildSources();
    for (const source of this.sources) {
      if (source.kind === 'live') this.adoptLiveSource(source.account);
    }
    const accounts = this.xtreamAccounts();
    if (!accounts.some(account => account.id === this.xtreamId)) {
      const selected = StorageService.getSelectedXtreamAccountId();
      this.xtreamId = (accounts.find(account => account.id === selected) ?? accounts[0])?.id ?? '';
    }
    this.switcher?.closeMenu();
    this.focusArea = 'group';
    this.tab = 'rules';
    this.nav.focused = null;
    this.concealed = false;
    this.focusScope.focus(null, 'resume');
    this.groups = [];
    this.resetItems();
    const index = this.sourceIndexFor(this.kind);
    this.render();
    if (index >= 0) void this.selectSource(index, true);
  }

  dismissPrompt(): void {
    this.confirmationPrompt.hide();
    this.switcher?.closeMenu();
  }

  // Leaving stops catalog loads so they neither render nor take focus later.
  close(): void {
    log.info('Parental manager closed', 'event=parental.manager.closed',
      `loading=${String(this.requestController !== null)}`);
    PlaylistService.setIncludeHidden(false);
    this.dismissPrompt();
    this.requestController?.abort();
    this.requestController = null;
    this.resetItems();
  }

  handleAction(action: Action): void {
    if (this.confirmationPrompt.visible) {
      this.confirmationPrompt.handleAction(action);
      return;
    }
    if (this.switcher?.menuOpen) {
      if (action === 'yellow') this.switcher.closeMenu();
      else this.switcher.handleAction(action);
      return;
    }
    if (action === 'back' || action === 'yellow') {
      this.onBack();
      return;
    }
    if (isFocusMove(action) || action === 'select') {
      this.via = 'key';
      // A row scrolled out of the DOM comes back first, so the key acts on it.
      this.syncNav();
      // After the pointer left, the first key only shows where focus is.
      if (this.concealed && this.nav.focused) {
        this.concealed = false;
        this.focusScope.focus(this.focusScope.focusKey, 'key');
        Focus.flush();
        return;
      }
    }
    if (action === 'left' || action === 'right') {
      if (!this.hopColumn(action)) this.nav.move(action);
      return;
    }
    if (action === 'up' || action === 'down') {
      if (!this.moveInList(action === 'up' ? -1 : 1)) this.nav.move(action);
      return;
    }
    if (action === 'select') {
      if (this.nav.focused) this.activate(this.nav.focused);
      return;
    }
    if (this.tab !== 'rules') return;
    if (action === 'red' || action === 'green') {
      this.colorAction(action);
      return;
    }
    if (action === 'blue') {
      void this.clearCurrentExceptions();
    }
  }

  private showTab(tab: 'rules' | 'options'): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.render();
    this.focusKey(`parental-tab:${tab}`);
  }

  private confirmRemoveAll(): void {
    this.confirmationPrompt.show({
      title: t('parental.removeAllTitle'),
      message: t('parental.removeAllMessage'),
      confirmLabel: t('parental.removeAll'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        ParentalControlService.clearRules();
        showToast(t('parental.allRemoved'));
        this.render();
        this.focusKey('parental-remove-all');
      },
      onCancel: () => this.focusKey('parental-remove-all'),
    });
  }

  private commitOption(el: HTMLElement, toggle: string): void {
    const value = el.dataset.value ?? '';
    if (toggle === 'parental-conceal') {
      ParentalControlService.setConcealMode(value === 'hide-locked' ? 'hide-locked' : 'show-locked');
    } else {
      ParentalControlService.setUnlockDuration(value as ParentalUnlockDuration);
    }
    this.render();
    this.focusKey(el.dataset.key ?? '');
  }

  private buildSources(): SourceEntry[] {
    const sources: SourceEntry[] = [];
    for (const account of StorageService.getPlaylists()) {
      sources.push({
        key: `live:${account.id}`,
        kind: 'live',
        account,
      });
      if (account.source === 'xtream') {
        sources.push({ key: `vod:${account.id}`, kind: 'vod', account });
        sources.push({ key: `series:${account.id}`, kind: 'series', account });
      }
    }
    return sources;
  }

  // A loaded playlist only: adopting one with no groups yet would unlock it.
  private adoptLiveSource(
    account: PlaylistEntry,
    groups: Array<LiveGroupTarget | CatalogCategoryTarget> = this.liveGroupTargets(account.id),
  ): void {
    if (!groups.length || !isSourceEnabled(account)) return;
    ParentalControlService.adoptSource('live', account.id, groups);
  }

  private liveGroupTargets(playlistId: string): LiveGroupTarget[] {
    return PlaylistService.getGroupsForPlaylist(playlistId).map(name => ({
      kind: 'live-group',
      playlistId,
      groupKey: PlaylistService.getGroupKeyForDisplay(name),
    }));
  }

  private xtreamAccounts(): PlaylistEntry[] {
    return this.sources.filter(source => source.kind === 'vod').map(source => source.account);
  }

  private sourceIndexFor(kind: SourceKind): number {
    const key = kind === 'live' ? this.liveKey : `${kind}:${this.xtreamId}`;
    const index = this.sources.findIndex(source => source.key === key);
    if (index >= 0) return index;
    return this.sources.findIndex(source => source.kind === 'live');
  }

  private selectKind(kind: SourceKind): void {
    if (kind === this.kind) return;
    const index = this.sourceIndexFor(kind);
    if (index >= 0) void this.selectSource(index);
  }

  private selectAccount(id: string): void {
    this.xtreamId = id;
    this.render();
    const index = this.sources.findIndex(source => source.key === `${this.kind}:${id}`);
    if (index >= 0 && index !== this.sourceIndex) void this.selectSource(index);
  }

  private async selectSource(index: number, focusGroups = false): Promise<void> {
    const source = this.sources[index];
    if (!source) return;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    this.sourceIndex = index;
    this.kind = source.kind;
    if (source.kind === 'live') this.liveKey = source.key;
    if (source.account.source === 'xtream') this.xtreamId = source.account.id;
    this.groups = [];
    this.groupVirtualizer.setScrollOffset(0);
    this.memberGroups = new Map();
    this.memberGroupsRevision++;
    this.resetItems();
    this.groupsLoading = true;
    this.render();
    try {
      if (source.kind === 'live') {
        this.groups = PlaylistService.getGroupsForPlaylist(source.account.id).map(name => {
          const groupKey = PlaylistService.getGroupKeyForDisplay(name);
          const channels = PlaylistService.getByGroup(`source:${name}`, source.account.id);
          const key = `live:${source.account.id}:${groupKey}`;
          const members = channels.map(channel => this.liveItem(channel));
          for (const member of members) this.setMemberGroup(ruleKey(member), key);
          const target: LiveGroupTarget = { kind: 'live-group', playlistId: source.account.id, groupKey };
          return {
            key,
            name: groupDisplayLabel(name),
            count: channels.length,
            suggested: isAdultGroupName(name) || channels.some(isAdultChannel),
            target,
                  members,
          };
        });
        this.adoptLiveSource(source.account, this.groupTargets());
      } else {
        const categories = source.kind === 'vod'
          ? await loadVodCategories(source.account, controller.signal)
          : await loadSeriesCategories(source.account, controller.signal);
        if (controller.signal.aborted) return;
        this.groups = categories.map(category => this.catalogGroup(source, category));
        if (this.groups.length) {
          ParentalControlService.adoptSource(source.kind, source.account.id, this.groupTargets());
        }
        void this.mapCatalogMembers(source, controller.signal);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        log.error('Parental category load failed', 'event=parental.manager.load.failed',
          'stage=groups', `source=${source.key}`, err);
      }
    } finally {
      if (!controller.signal.aborted) {
        log.info('Parental source opened', 'event=parental.manager.source',
          `source=${source.key}`, `enabled=${String(isSourceEnabled(source.account))}`,
          `groups=${this.groups.length}`,
          `approved=${String(ParentalControlService.sourceApproved(source.kind, source.account.id))}`);
        this.groupsLoading = false;
        if (this.groups.length) {
          this.groupIndex = 0;
          void this.loadItems(0);
        }
        this.render();
        if (focusGroups) this.focusColumn('group');
      }
    }
  }

  // Catalog item rules don't record their category, so map them through the
  // full catalog, which is fetched only when the account has item rules.
  private async mapCatalogMembers(source: SourceEntry, signal: AbortSignal): Promise<void> {
    const prefix = parentalTargetKey({
      kind: source.kind === 'vod' ? 'vod-item' : 'series-item',
      accountId: source.account.id,
      itemId: '',
    });
    if (!ParentalControlService.itemRuleEntries().some(([key]) => key.startsWith(prefix))) return;
    try {
      const table = source.kind === 'vod'
        ? await loadAllVodStreams(source.account, signal)
        : await loadAllSeries(source.account, signal);
      if (signal.aborted) return;
      for (let i = 0; i < table.length; i++) {
        const item = table.item(i)!;
        const entry = source.kind === 'vod'
          ? this.vodItem(item as VodItem)
          : this.seriesItem(item as SeriesItem);
        const key = ruleKey(entry);
        if (!this.memberGroups.has(key)) {
          this.setMemberGroup(key, `${source.kind}:${source.account.id}:${item.categoryId}`);
        }
      }
      this.render();
    } catch (err) {
      if (!signal.aborted) {
        log.error('Parental catalog mapping failed', 'event=parental.manager.load.failed',
          'stage=mapping', `source=${source.key}`, err);
      }
    }
  }

  private catalogGroup(
    source: SourceEntry,
    category: VodCategory | SeriesCategory,
  ): GroupEntry {
    const target: CatalogCategoryTarget = {
      kind: source.kind === 'vod' ? 'vod-category' : 'series-category',
      accountId: source.account.id,
      categoryId: category.id,
    };
    return {
      key: `${source.kind}:${source.account.id}:${category.id}`,
      name: category.name,
      count: null,
      suggested: isAdultGroupName(category.name),
      target,
      members: null,
    };
  }

  private resetItems(): void {
    if (this.itemsTimer) clearTimeout(this.itemsTimer);
    this.itemsTimer = null;
    this.itemsController?.abort();
    this.itemsController = null;
    this.itemsLoad = null;
    this.itemsGroupKey = null;
    this.itemsLoading = false;
    this.groupIndex = -1;
    this.items = [];
    this.itemVirtualizer.setScrollOffset(0);
  }

  private onFocusChange(el: HTMLElement | null): void {
    if (!el) return;
    const data = el.dataset;
    const area = data.parentalItem !== undefined ? 'item'
      : data.parentalGroup !== undefined || data.parentalSuggest !== undefined
        || data.parentalSource !== undefined ? 'group' : null;
    const areaChanged = area !== null && area !== this.focusArea;
    if (area) this.focusArea = area;
    const index = this.via === 'key' ? data.parentalGroup : undefined;
    const rendered = index !== undefined && this.setCurrentGroup(Number(index));
    if (areaChanged && !rendered) this.render();
    const key = this.keyOf(el);
    // Only the owner of the keys shows its focus; otherwise it is noted for
    // when the keys come back.
    if (Focus.owner() !== this.focusScope) {
      this.focusScope.track(key);
      return;
    }
    this.concealed = false;
    this.focusScope.focus(key, this.via);
    Focus.flush();
  }

  private pick(el: HTMLElement, via: Via): void {
    this.via = via;
    try {
      this.nav.focus(el);
    } finally {
      this.via = 'key';
    }
  }

  // A category and a title can share an id, so row keys name their list.
  private keyOf(el: HTMLElement): string | null {
    const key = el.dataset.key;
    if (key === undefined) return el.classList.contains('source-toggle') ? ENABLED_KEY : null;
    if (el.dataset.parentalGroup !== undefined) return rowKey('group', key);
    return el.dataset.parentalItem !== undefined ? rowKey('item', key) : key;
  }

  // The focusable element a key names; the account slot stands for its avatar.
  private findKey(key: string): HTMLElement | null {
    if (key === ENABLED_KEY) return this.container.querySelector<HTMLElement>('.source-toggle');
    const row = /^(group|item)\|(.*)$/.exec(key);
    const selector = row ? `[data-parental-${row[1]}]` : '[data-key]';
    const name = row ? row[2] : key;
    for (const el of Array.from(this.container.querySelectorAll<HTMLElement>(selector))) {
      if (el.dataset.key === name) return el.hasAttribute('data-focusable') ? el : null;
    }
    return null;
  }

  private resolveKey(key: string): HTMLElement | null {
    const el = this.findKey(key);
    if (el?.dataset.parentalAvatar === undefined) return el;
    return el.querySelector<HTMLElement>('.account-avatar');
  }

  // Hidden before the menu renders: hiding clears every ring in the view,
  // the menu's own highlight included.
  private hideAvatarRing(): void {
    this.focusScope.conceal();
    Focus.flush();
  }

  private focusedElement(): HTMLElement | null {
    const key = this.focusScope.focusKey;
    return key !== null ? this.findKey(key) : null;
  }

  private defaultKey(): string | null {
    if (this.tab === 'rules') {
      const group = this.groups[this.groupIndex] ?? this.groups[0];
      if (group && this.findKey(rowKey('group', group.key))) return rowKey('group', group.key);
    }
    return `parental-tab:${this.tab}`;
  }

  // The list and index of a row key, mounted or not.
  private rowOf(key: string): { kind: ListKind; index: number } | null {
    const row = /^(group|item)\|(.*)$/.exec(key);
    if (!row || this.tab !== 'rules') return null;
    const kind = row[1] as ListKind;
    const index = (kind === 'group' ? this.groups : this.items).findIndex(entry => entry.key === row[2]);
    return index >= 0 ? { kind, index } : null;
  }

  private revealRow(key: string): boolean {
    const row = this.rowOf(key);
    if (!row || !this.virtualizer(row.kind).ensureVisible(row.index, this.listViewport(row.kind))) {
      return false;
    }
    this.render();
    return true;
  }

  // Points the nav at the focused control, mounting a row scrolled out of the DOM.
  private syncNav(): void {
    const key = this.focusScope.focusKey;
    if (key === null) return;
    let el = this.findKey(key);
    const row = el ? null : this.rowOf(key);
    if (row) {
      this.virtualizer(row.kind).ensureVisible(row.index, this.listViewport(row.kind));
      this.render();
      el = this.findKey(key);
    }
    if (el) this.nav.focused = el;
  }

  private setCurrentGroup(index: number, immediate = false): boolean {
    const group = this.groups[index];
    if (!group || index === this.groupIndex) return false;
    this.groupIndex = index;
    this.itemsController?.abort();
    this.itemsLoad = null;
    this.itemsGroupKey = null;
    this.items = [];
    this.itemVirtualizer.setScrollOffset(0);
    this.itemsLoading = true;
    if (immediate) {
      void this.loadItems(index);
      return true;
    }
    this.render();
    if (this.itemsTimer) clearTimeout(this.itemsTimer);
    // Debounced so scrolling through catalog categories doesn't fetch each one.
    this.itemsTimer = setTimeout(() => {
      this.itemsTimer = null;
      void this.loadItems(index);
    }, CONFIG.PARENTAL_ITEMS_DELAY_MS);
    return true;
  }

  private loadItems(index: number): Promise<void> {
    const source = this.sources[this.sourceIndex];
    const group = this.groups[index];
    if (!source || !group) return Promise.resolve();
    if (this.itemsTimer) clearTimeout(this.itemsTimer);
    this.itemsTimer = null;
    if (this.itemsGroupKey === group.key && this.itemsLoad) return this.itemsLoad;
    this.itemsController?.abort();
    const controller = new AbortController();
    this.itemsController = controller;
    this.itemsGroupKey = group.key;
    this.items = [];
    this.itemVirtualizer.setScrollOffset(0);
    this.itemsLoading = true;
    this.render();
    const startedAt = Date.now();
    this.itemsLoad = (async () => {
      try {
        let items: ItemEntry[];
        if (source.kind === 'live') {
          const target = group.target as LiveGroupTarget;
          const display = PlaylistService.getGroupsForPlaylist(source.account.id)
            .find(name => PlaylistService.getGroupKeyForDisplay(name) === target.groupKey);
          const channels = display
            ? PlaylistService.getByGroup(`source:${display}`, source.account.id)
            : [];
          items = channels.map(channel => this.liveItem(channel));
        } else {
          const categoryId = (group.target as CatalogCategoryTarget).categoryId;
          items = source.kind === 'vod'
            ? (await loadVodStreams(source.account, categoryId, controller.signal))
              .map(item => this.vodItem(item))
            : (await loadSeries(source.account, categoryId, controller.signal))
              .map(item => this.seriesItem(item));
        }
        if (!controller.signal.aborted) {
          log.info('Parental items loaded', 'event=parental.manager.items',
            `source=${source.key}`, `items=${items.length}`,
            `elapsedMs=${Date.now() - startedAt}`);
          this.items = items;
          // Only ruled items feed the summaries; a rule set later maps its item then.
          if (ParentalControlService.hasItemRules()) {
            for (const item of items) {
              const key = ruleKey(item);
              if (ParentalControlService.itemRuleByKey(key)) this.setMemberGroup(key, group.key);
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          log.error('Parental item load failed', 'event=parental.manager.load.failed',
            'stage=items', `source=${source.key}`, `group=${group.key}`, err);
        }
      } finally {
        if (!controller.signal.aborted) {
          this.itemsLoading = false;
          this.render();
        }
      }
    })();
    return this.itemsLoad;
  }

  private liveItem(channel: Channel): ItemEntry {
    const key = channelKey(channel);
    const target: LiveChannelTarget = { kind: 'live-channel', channelKey: key };
    return {
      key: `live:${key}`,
      name: channel.name,
      target,
      parents: liveParentalRequest(channel).parents,
    };
  }

  private vodItem(item: VodItem): ItemEntry {
    const target: CatalogItemTarget = { kind: 'vod-item', accountId: item.accountId, itemId: item.streamId };
    return {
      key: `vod:${item.accountId}:${item.streamId}`,
      name: item.name,
      target,
    };
  }

  private seriesItem(item: SeriesItem): ItemEntry {
    const target: CatalogItemTarget = { kind: 'series-item', accountId: item.accountId, itemId: item.seriesId };
    return {
      key: `series:${item.accountId}:${item.seriesId}`,
      name: item.name,
      target,
    };
  }

  private activate(el: HTMLElement): void {
    if (el.dataset.parentalBack !== undefined) {
      this.onBack();
      return;
    }
    const color = el.dataset.parentalAction;
    if (color === 'red' || color === 'green') {
      this.colorAction(color);
      return;
    }
    if (el.dataset.parentalAvatar !== undefined) {
      this.hideAvatarRing();
      this.switcher?.openMenu();
      return;
    }
    const toggle = el.closest('.toggle-group')?.id;
    const kind = el.dataset.value;
    if (toggle === 'parental-kind' && (kind === 'live' || kind === 'vod' || kind === 'series')) {
      this.selectKind(kind);
      return;
    }
    if (el.dataset.parentalAction === 'blue') {
      void this.clearCurrentExceptions();
      return;
    }
    if (el.dataset.parentalSuggest !== undefined) {
      this.lockSuggested();
      return;
    }
    if (el.dataset.parentalChangePin !== undefined) {
      this.onChangePin(() => {
        showToast(t('parental.pinChanged'));
        this.focusKey('parental-change-pin');
      });
      return;
    }
    const tab = el.dataset.parentalTab;
    if (tab === 'rules' || tab === 'options') {
      this.showTab(tab);
      return;
    }
    if (toggle === 'parental-conceal' || toggle === 'parental-duration') {
      this.commitOption(el, toggle);
      return;
    }
    if (el.dataset.parentalRemoveAll !== undefined) {
      this.confirmRemoveAll();
      return;
    }
    if (el.classList.contains('source-toggle')) {
      const refresh = () => {
        this.render();
        this.focusSelector('.source-toggle');
      };
      if (ParentalControlService.enabled) {
        ParentalControlService.disable();
        refresh();
      } else {
        this.onCreatePin(refresh);
      }
      return;
    }
    const sourceIndex = el.dataset.parentalSource;
    if (sourceIndex !== undefined) {
      void this.selectSource(Number(sourceIndex));
      return;
    }
    const groupIndex = el.dataset.parentalGroup;
    if (groupIndex !== undefined) {
      const group = this.groups[Number(groupIndex)];
      if (!group) return;
      ParentalControlService.setGroupProtected(groupTarget(group), !this.isGroupLocked(group));
      this.render();
      return;
    }
    const itemIndex = el.dataset.parentalItem;
    if (itemIndex !== undefined) {
      const item = this.items[Number(itemIndex)];
      const group = this.groups[this.groupIndex];
      if (!item || !group) return;
      ParentalControlService.setItemLocked(
        itemTarget(item),
        this.itemParents(item, group),
        !this.isItemLocked(item, group),
      );
      this.setMemberGroup(ruleKey(item), group.key);
      this.render();
      // A keyed morph keeps the row; a late refocus would undo keys pressed since.
      const key = rowKey('item', item.key);
      if (!this.nav.focused || this.keyOf(this.nav.focused) !== key) this.focusKey(key);
      return;
    }
  }

  private colorAction(color: 'red' | 'green'): void {
    if (this.focusArea === 'item' && this.groups[this.groupIndex]) {
      void this.setCurrentGroupContents(color === 'red');
    } else if (color === 'red') {
      this.protectAllGroups();
    } else {
      this.unlockAllGroups();
    }
  }

  // Locks or unlocks the whole group and drops its exceptions.
  private async setCurrentGroupContents(locked: boolean): Promise<void> {
    const group = this.groups[this.groupIndex];
    if (!group) return;
    await this.loadItems(this.groupIndex);
    if (this.groups[this.groupIndex]?.key !== group.key) return;
    ParentalControlService.setGroupProtected(groupTarget(group), locked);
    ParentalControlService.clearItemRules(this.items.map(itemTarget));
    this.render();
  }

  private groupTargets(): Array<LiveGroupTarget | CatalogCategoryTarget> {
    return this.groups.map(groupTarget);
  }

  private protectAllGroups(): void {
    if (!this.groups.length) return;
    ParentalControlService.setGroupsProtected(this.groupTargets(), true);
    this.render();
  }

  private unlockAllGroups(): void {
    const source = this.sources[this.sourceIndex];
    if (!source || !this.groups.length) return;
    const channelKeys = source.kind === 'live'
      ? PlaylistService.getByGroup('builtin:all', source.account.id).map(channelKey)
      : [];
    ParentalControlService.clearSourceRules(source.kind, source.account.id, channelKeys);
    this.render();
  }

  // Only items with a rule feed the summary, so only they invalidate it.
  private setMemberGroup(itemKey: string, groupKey: string): void {
    if (this.memberGroups.get(itemKey) === groupKey) return;
    this.memberGroups.set(itemKey, groupKey);
    if (ParentalControlService.itemRuleByKey(itemKey)) this.memberGroupsRevision++;
  }

  private pendingSuggestions(): GroupEntry[] {
    return this.ruleSummary().suggestions;
  }

  // Each pass is O(groups) or O(items); at catalog scale that would dominate
  // every key press, so each reruns only when its own inputs change.
  private ruleSummary(): RuleSummary {
    const revision = ParentalControlService.rulesRevision;
    const groupInputs: unknown[] = [this.groups, this.memberGroupsRevision, revision];
    let groups = this.groupSummaryCache;
    if (!groups || !sameInputs(groups.inputs, groupInputs)) {
      let lockedGroups = 0;
      const suggestions: GroupEntry[] = [];
      for (const group of this.groups) {
        if (this.isGroupLocked(group)) lockedGroups++;
        else if (group.suggested) suggestions.push(group);
      }
      groups = { inputs: groupInputs, lockedGroups, suggestions, mixedGroups: this.computeMixedGroups() };
      this.groupSummaryCache = groups;
    }
    const currentGroup = this.groups[this.groupIndex];
    const itemInputs: unknown[] = [this.items, currentGroup, this.itemsLoading, revision];
    let items = this.exceptionCache;
    if (!items || !sameInputs(items.inputs, itemInputs)) {
      items = { inputs: itemInputs, exceptions: this.countExceptions(currentGroup) };
      this.exceptionCache = items;
    }
    return { ...groups, exceptions: items.exceptions };
  }

  private countExceptions(group: GroupEntry | undefined): number {
    if (!group || this.itemsLoading) return 0;
    const groupLocked = this.isGroupLocked(group);
    const inherited = ParentalControlService.parentsLocked([groupTarget(group)]);
    if (!group.members) {
      // Catalog items inherit only from this category, so only their rules
      // (and every loaded item maps to it) can differ from it.
      let ruled = 0;
      let count = 0;
      for (const [key, rule] of ParentalControlService.itemRuleEntries()) {
        if (this.memberGroups.get(key) !== group.key) continue;
        ruled++;
        if ((rule === 'protect') !== groupLocked) count++;
      }
      return inherited === groupLocked ? count : count + this.items.length - ruled;
    }
    let count = 0;
    for (const item of this.items) {
      const rule = ParentalControlService.itemRuleByKey(ruleKey(item));
      const locked = rule ? rule === 'protect'
        : item.parents ? ParentalControlService.parentsLocked(item.parents) : inherited;
      if (locked !== groupLocked) count++;
    }
    return count;
  }

  private lockSuggested(): void {
    const groups = this.pendingSuggestions();
    if (!groups.length) return;
    ParentalControlService.setGroupsProtected(groups.map(groupTarget), true);
    this.render();
    this.focusColumn('group');
  }

  private async clearCurrentExceptions(): Promise<void> {
    const group = this.groups[this.groupIndex];
    if (!group) return;
    await this.loadItems(this.groupIndex);
    if (this.groups[this.groupIndex]?.key !== group.key) return;
    ParentalControlService.clearItemRules(this.items.map(itemTarget));
    this.render();
  }

  // Exceptions are item rules that differ from their group's lock; a stale
  // rule matching the group is harmless and doesn't count.
  private computeMixedGroups(): Set<string> {
    const mixed = new Set<string>();
    const rules = ParentalControlService.itemRuleEntries();
    if (!rules.length) return mixed;
    if (this.groupsByKeyFor !== this.groups) {
      this.groupsByKeyFor = this.groups;
      this.groupsByKey = new Map(this.groups.map(group => [group.key, group]));
    }
    for (const [key, rule] of rules) {
      const groupKey = this.memberGroups.get(key);
      const group = groupKey === undefined ? undefined : this.groupsByKey.get(groupKey);
      if (group && !mixed.has(group.key) && (rule === 'allow') === this.isGroupLocked(group)) {
        mixed.add(group.key);
      }
    }
    return mixed;
  }

  private hasExceptions(group: GroupEntry): boolean {
    return this.ruleSummary().mixedGroups.has(group.key);
  }

  private groupState(group: GroupEntry): string {
    if (this.hasExceptions(group)) {
      if (!group.members) return t('parental.partlyLocked');
      return t('parental.lockedOf', { locked: this.lockedCount(group, group.members), total: group.members.length });
    }
    return t(this.isGroupLocked(group) ? 'parental.locked' : 'parental.notLocked');
  }

  private lockedCount(group: GroupEntry, members: ItemEntry[]): number {
    const revision = ParentalControlService.rulesRevision;
    const cached = this.lockedCounts.get(members);
    if (cached?.revision === revision) return cached.locked;
    const locked = members.filter(member => this.isItemLocked(member, group)).length;
    this.lockedCounts.set(members, { revision, locked });
    return locked;
  }

  private isGroupLocked(group: GroupEntry): boolean {
    return ParentalControlService.groupProtectedByKey(ruleKey(group));
  }

  private isItemLocked(item: ItemEntry, group: GroupEntry | undefined): boolean {
    return ParentalControlService.itemLocked(itemTarget(item), this.itemParents(item, group));
  }

  private itemParents(
    item: ItemEntry,
    group: GroupEntry | undefined,
  ): Array<LiveGroupTarget | CatalogCategoryTarget> {
    return item.parents ?? (group ? [groupTarget(group)] : []);
  }

  private render(): void {
    const currentGroup = this.groups[this.groupIndex];
    const tabs: Array<{ id: 'rules' | 'options'; label: string }> = [
      { id: 'rules', label: t('parental.tabLocks') },
      { id: 'options', label: t('parental.tabOptions') },
    ];
    const inItems = this.focusArea === 'item' && !!currentGroup;
    morph(this.container, html`
      <div class="parental-view">
        <header class="parental-header">
          <div class="parental-heading">
            <h2>${t('settings.parentalControls')}</h2>
            <div class="playlist-tabs parental-tabs" data-nav-container>
              ${tabs.map(tab => html`
                <div class="playlist-tab ${tab.id === this.tab ? 'active' : ''}"
                     data-focusable data-key="parental-tab:${tab.id}"
                     data-parental-tab="${tab.id}">${tab.label}</div>
              `)}
            </div>
          </div>
          ${this.renderAccount()}
        </header>
        ${this.tab === 'rules' ? this.renderRules(currentGroup) : this.renderOptions()}
        <div class="edit-hints parental-hints">
          ${this.tab === 'rules' ? html`
            ${okHint(t('parental.toggleLock'))}
            ${keyHint('red', inItems ? t('parental.lockAllIn', { name: currentGroup.name }) : t('parental.lockAll'),
              'parental:red', { 'data-parental-action': 'red' })}
            ${keyHint('green', inItems ? t('parental.unlockAllIn', { name: currentGroup.name }) : t('parental.unlockAll'),
              'parental:green', { 'data-parental-action': 'green' })}
            ${currentGroup && this.hasExceptions(currentGroup)
              ? keyHint('blue', t('parental.clearSeparate', { name: currentGroup.name }),
                'parental:blue', { 'data-parental-action': 'blue' })
              : ''}
          ` : ''}
          ${doneHint('parental:back', { 'data-parental-back': '' })}
        </div>
      </div>
    `);
    this.syncListScroll('group');
    this.syncListScroll('item');
    this.mountAccount();
  }

  // The slot stays mounted (hidden when unused) so the AccountSwitcher that
  // owns its DOM is created once.
  private renderAccount(): Safe {
    const current = this.tab === 'rules' ? this.currentAccount() : undefined;
    return html`
      <div class="parental-account ${current ? '' : 'hidden'}" data-nav-container>
        <span class="parental-account-name">${current?.name ?? ''}</span>
        <div class="parental-account-slot" data-key="parental-account-slot" data-morph-preserve
             data-focusable data-parental-avatar></div>
      </div>`;
  }

  private currentAccount(): PlaylistEntry | undefined {
    const accounts = this.xtreamAccounts();
    return accounts.find(account => account.id === this.xtreamId) ?? accounts[0];
  }

  private mountAccount(): void {
    const slot = this.container.querySelector<HTMLElement>('.parental-account-slot');
    if (!slot) return;
    if (!this.switcher) {
      this.switcher = new AccountSwitcher(slot, {
        onSelect: id => this.selectAccount(id),
        // The open menu owns the keys and draws its own highlight; the
        // avatar hid its ring before the menu rendered and stays hidden.
        onMenuOpen: () => Focus.push(this.accountMenuScope),
        onMenuClose: (reason, hit) => {
          Focus.pop(this.accountMenuScope);
          const avatar = reason === 'toggle' ? hit?.closest('.account-avatar') : null;
          // Closed by the pointer, the ring waits for the next key, unless the
          // pointer still rests on the avatar it clicked.
          if (InputMode.current === 'keys') this.focusScope.focus(this.focusScope.focusKey, 'key');
          else if (avatar && isHovered(avatar)) this.pick(slot, 'pointer');
          else this.concealed = true;
        },
      });
      this.switcher.init();
    }
    const current = this.tab === 'rules' ? this.currentAccount() : undefined;
    this.switcher.setAccounts(current ? this.xtreamAccounts() : [], current?.id ?? '');
  }

  private renderRules(currentGroup: GroupEntry | undefined): Safe {
    const kinds: Array<{ id: SourceKind; label: string }> = [
      { id: 'live', label: t('nav.live') },
      { id: 'vod', label: t('nav.movies') },
      { id: 'series', label: t('nav.series') },
    ];
    const playlists = this.sources
      .map((source, index) => ({ source, index }))
      .filter(({ source }) => source.kind === 'live');
    const groupRules = ParentalControlService.groupRuleKeys();
    const { lockedGroups, exceptions } = this.ruleSummary();
    const groupLocked = !!currentGroup && this.isGroupLocked(currentGroup);
    return html`
      <div class="parental-toolbar">
        ${this.xtreamAccounts().length ? html`
          <div class="parental-kinds" data-nav-container>${
            toggleGroup('parental-kind', kinds.map(kind => ({ value: kind.id, label: kind.label })), this.kind)
          }</div>` : ''}
        ${this.groups.length ? html`
          <div class="parental-summary">${raw(LOCK_ICON)}<span>${
            t(this.kind === 'live' ? 'parental.lockedGroupsSummary' : 'parental.lockedCategoriesSummary',
              { count: lockedGroups, total: this.groups.length })}</span></div>`
          : ''}
      </div>
      <div class="parental-columns">
        ${this.kind === 'live' && playlists.length > 1
          ? this.column(t('settings.playlists'), html``, playlists.map(({ source, index }) => {
            const prefix = parentalTargetKey({
              kind: 'live-group',
              playlistId: source.account.id,
              groupKey: '',
            });
            const locked = groupRules.filter(key => key.startsWith(prefix)).length;
            const unreviewed = !ParentalControlService.sourceApproved('live', source.account.id);
            return html`
              <button class="parental-row ${index === this.sourceIndex ? 'active' : ''}"
                      data-focusable data-key="${source.key}" data-parental-source="${index}">
                <span>${source.account.name}</span>
                ${isSourceEnabled(source.account)
                  ? ''
                  : html`<small>${t('parental.sourceDisabled')}</small>`}
                <strong class="${locked || unreviewed ? 'is-locked' : ''}">${
                  unreviewed ? t('parental.locked')
                    : locked ? tp('parental.lockedCount', locked) : t('parental.notLocked')}</strong>
              </button>`;
          }), 'source')
          : ''}
        ${this.column(
          t(this.kind === 'live' ? 'common.groups' : 'parental.categories'),
          this.groupsLoading || !this.groups.length
            ? html``
            : html`<span class="parental-column-note">${this.groups.length}</span>`,
          this.groupsLoading
            ? [html`<div class="parental-empty">${t('common.loading')}</div>`]
            : this.groups.length
              ? [this.suggestionRow(), this.virtualRows('group', this.groups, (group, index, top) => {
                const locked = this.isGroupLocked(group);
                return html`
                <button class="parental-row ${index === this.groupIndex ? 'active' : ''}"
                        style="top:${top}px" data-focusable data-key="${group.key}"
                        data-parental-group="${index}">
                  ${raw(lockBadge(locked ? 'locked' : 'unlocked'))}
                  <span>${group.name}</span>
                  ${group.count === null ? '' : html`<small>${group.count}</small>`}
                  ${group.suggested && !locked
                    ? html`<em class="parental-suggested">${t('parental.suggested')}</em>`
                    : ''}
                  <strong class="${locked || this.hasExceptions(group) ? 'is-locked' : ''}">${
                    this.groupState(group)}</strong>
                </button>`;
              })]
              : [html`<div class="parental-empty">${t('parental.noGroups')}</div>`],
          'group')}
        ${this.column(
          currentGroup?.name ?? '',
          currentGroup && !this.itemsLoading ? html`
            <span class="parental-column-note">${
              t(groupLocked ? 'parental.locked' : 'parental.notLocked')}</span>
            ${exceptions
              ? html`<span class="parental-column-note">${tp('parental.setSeparatelyCount', exceptions)}</span>`
              : ''}` : html``,
          this.itemsLoading
            ? [html`<div class="parental-empty">${t('common.loading')}</div>`]
            : this.items.length
              ? [this.virtualRows('item', this.items, (item, index, top) => {
                const locked = this.isItemLocked(item, currentGroup);
                return html`
                <button class="parental-row" style="top:${top}px"
                        data-focusable data-key="${item.key}"
                        data-parental-item="${index}">
                  ${raw(lockBadge(locked ? 'locked' : 'unlocked'))}
                  <span>${item.name}</span>
                  ${currentGroup && locked !== groupLocked
                    ? html`<em class="parental-exception">${t('parental.setSeparately')}</em>`
                    : ''}
                  <strong class="${locked ? 'is-locked' : ''}">${
                    t(locked ? 'parental.locked' : 'parental.notLocked')}</strong>
                </button>`;
              })]
              : [html`<div class="parental-empty">${t('parental.selectGroup')}</div>`],
          'item')}
      </div>`;
  }

  private renderOptions(): Safe {
    const config = ParentalControlService.snapshot();
    const enabled = ParentalControlService.enabled;
    const conceal = [
      { value: 'show-locked', label: t('parental.showWithLock') },
      { value: 'hide-locked', label: t('parental.hide') },
    ];
    const durations: Array<{ value: ParentalUnlockDuration; label: string }> = [
      { value: 'once', label: t('parental.askEveryTime') },
      { value: '5-minutes', label: t('parental.askAfter5') },
      { value: '15-minutes', label: t('parental.askAfter15') },
      { value: 'until-backgrounded', label: t('parental.askAfterLeaving') },
    ];
    return html`
      <div class="parental-options-pane ${enabled ? '' : 'parental-options-off'}" data-nav-container>
        <section class="parental-options-section">
          <div class="settings-item">
            <div class="settings-item-title">${t('parental.useControls')}</div>
            ${sourceToggle(enabled)}
            <div class="settings-item-hint">${
              t(enabled ? 'parental.turnOffHint' : 'parental.settingsHint')}</div>
          </div>
        </section>
        <section class="parental-options-section parental-options-rules">
          <div class="settings-item">
            <div class="settings-item-title">${t('parental.lockedInLists')}</div>
            ${toggleGroup('parental-conceal', conceal, config.concealMode)}
            <div class="settings-item-hint">${t('parental.lockedInListsHint')}</div>
          </div>
          <div class="settings-item">
            <div class="settings-item-title">${t('parental.askAgain')}</div>
            ${toggleGroup('parental-duration', durations, config.unlockDuration,
              config.concealMode === 'hide-locked' ? ['once'] : [])}
            <div class="settings-item-hint">${t('parental.askAgainHint')}</div>
          </div>
        </section>
        <section class="parental-options-section parental-options-actions">
          ${enabled ? html`
          <button class="btn btn-secondary" data-focusable data-key="parental-change-pin"
                  data-parental-change-pin>${t('parental.changePin')}</button>` : ''}
          <button class="btn btn-danger" data-focusable data-key="parental-remove-all"
                  data-parental-remove-all>${t('parental.removeAll')}</button>
        </section>
      </div>`;
  }

  private suggestionRow(): Safe {
    const count = this.pendingSuggestions().length;
    if (!count) return html``;
    return html`
      <button class="parental-row parental-suggest-row" data-focusable
              data-key="parental-suggest" data-parental-suggest>
        ${raw(LOCK_ICON)}<span>${t('parental.lockSuggested', { count })}</span>
      </button>`;
  }

  private column(title: string, note: Safe, rows: Safe[], kind: string): Safe {
    return html`
      <section class="parental-column parental-column-${kind}" data-nav-container
               data-nav-enter="last-focused">
        <header class="parental-column-head"><h3>${title}</h3>${note}</header>
        <div class="parental-list" data-parental-list="${kind}">${rows}</div>
      </section>`;
  }

  // Only the rows in view (plus overscan) are mounted; a 50,000-entry
  // catalog would otherwise rebuild every row on each render.
  private virtualRows<T>(
    kind: ListKind,
    entries: T[],
    row: (entry: T, index: number, top: number) => Safe,
  ): Safe {
    const virtualizer = this.virtualizer(kind);
    const suggestion = kind === 'group' && this.pendingSuggestions().length > 0;
    virtualizer.setLeadingSize(LIST_PADDING + (suggestion ? ROW_STRIDE : 0));
    const range = virtualizer.getRange(entries.length, this.listViewport(kind));
    const rows: Safe[] = [];
    for (let index = range.start; index < range.end; index++) {
      rows.push(row(entries[index], index, virtualizer.getItemOffset(index)));
    }
    return html`
      <div class="parental-spacer" data-key="parental-spacer:${kind}"
           style="height:${virtualizer.getTotalSize(entries.length)}px">${rows}</div>`;
  }

  private virtualizer(kind: ListKind): VirtualList {
    return kind === 'group' ? this.groupVirtualizer : this.itemVirtualizer;
  }

  private listElement(kind: ListKind): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(`[data-parental-list="${kind}"]`);
  }

  private listViewport(kind: ListKind): number {
    return this.listElement(kind)?.clientHeight || FALLBACK_LIST_HEIGHT;
  }

  private syncListScroll(kind: ListKind): void {
    const list = this.listElement(kind);
    if (list) this.scrollGuard.syncOffset(list, 'vertical', this.virtualizer(kind).scrollOffset);
  }

  // Up/Down step by index, since the neighboring row may not be mounted yet.
  private moveInList(delta: number): boolean {
    const data = this.nav.focused?.dataset;
    if (!data) return false;
    if (data.parentalSuggest !== undefined) {
      if (delta < 0 || !this.groups.length) return false;
      this.focusRow('group', 0);
      return true;
    }
    const kind: ListKind | null = data.parentalGroup !== undefined ? 'group'
      : data.parentalItem !== undefined ? 'item' : null;
    if (!kind) return false;
    return this.stepInList(kind, Number(kind === 'group' ? data.parentalGroup : data.parentalItem), delta);
  }

  private stepInList(kind: ListKind, from: number, delta: number): boolean {
    const index = from + delta;
    if (kind === 'group' && index < 0 && this.pendingSuggestions().length) {
      this.groupVirtualizer.setScrollOffset(0);
      this.render();
      const suggest = this.container.querySelector<HTMLElement>('[data-parental-suggest]');
      if (suggest) this.nav.focus(suggest);
      return true;
    }
    const count = kind === 'group' ? this.groups.length : this.items.length;
    if (index < 0 || index >= count) return false;
    this.focusRow(kind, index);
    return true;
  }

  private focusRow(kind: ListKind, index: number): void {
    this.virtualizer(kind).ensureVisible(index, this.listViewport(kind));
    this.render();
    const attribute = kind === 'group' ? 'data-parental-group' : 'data-parental-item';
    const row = this.container.querySelector<HTMLElement>(`[${attribute}="${index}"]`);
    if (row) this.nav.focus(row);
  }

  // Left/Right always crosses to the neighboring column — geometric nav would
  // jump to the tabs when the next column is shorter than the focused row.
  private hopColumn(direction: 'left' | 'right'): boolean {
    const from = this.nav.focused;
    const column = from?.closest('.parental-column');
    if (!from || !column) return false;
    let next = direction === 'left' ? column.previousElementSibling : column.nextElementSibling;
    if (!next?.classList.contains('parental-column')) return false;
    if (next.classList.contains('parental-column-group') && this.groupIndex >= 0
        && this.groupVirtualizer.ensureVisible(this.groupIndex, this.listViewport('group'))) {
      this.render();
      next = this.container.querySelector('.parental-column-group');
      if (!next) return false;
    }
    const rows = Array.from(next.querySelectorAll<HTMLElement>('[data-focusable]'));
    if (!rows.length) return false;
    const center = (el: HTMLElement): number => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    const y = center(from);
    const nearest = rows.reduce((best, row) =>
      Math.abs(center(row) - y) < Math.abs(center(best) - y) ? row : best);
    this.nav.focus(rows.find(row => row.classList.contains('active')) ?? nearest);
    return true;
  }

  private focusColumn(kind: 'group' | 'item'): void {
    setTimeout(() => {
      const selector = kind === 'group' ? '[data-parental-group]' : '[data-parental-item]';
      const target = this.container.querySelector<HTMLElement>(selector);
      if (target) this.nav.focus(target);
    }, 0);
  }

  private focusSelector(selector: string): void {
    setTimeout(() => {
      const target = this.container.querySelector<HTMLElement>(selector);
      if (target) this.nav.focus(target);
    }, 0);
  }

  private focusKey(key: string): void {
    setTimeout(() => {
      const target = this.findKey(key);
      if (target) this.nav.focus(target);
    }, 0);
  }
}
