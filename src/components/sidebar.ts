import type {
  Action,
  BuiltinChannelGroup,
  CatchupInfo,
  Channel,
  ChannelGroupId,
  ChannelHealthStatus,
  ChannelScope,
} from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import { CONFIG } from '../config';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { RecentlyWatchedService, type RecentlyWatchedItem } from '../services/recently-watched';
import { $, html, inShownView, onceTransitionEnd, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { rankChannels } from '../utils/channel-search';
import { groupDisplayLabel } from '../utils/channel';
import { formatPosition } from '../utils/time';
import { getLocale, t, type SupportedLocale } from '../i18n';
import { groupIcon, playlistLanguage } from './group-icon';
import { CHEVRON_LEFT_ICON } from './icons';
import { channelLockBadge, liveGroupLockBadge } from './parental-badge';
import { showToast } from './toast';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { WorkerListSearch } from '../workers/list-search-client';
import { isIndexRetryPending } from '../workers/index-retry';
import { createLogger } from '../utils/logger';
import { ChannelHealthService } from '../services/channel-health';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { InputMode } from '../navigation/input-mode';

const log = createLogger('Sidebar');

type SidebarEntry = { ch: Channel; globalIdx: number; recent?: RecentlyWatchedItem };
type SidebarSource =
  | { kind: 'channels'; channels: Channel[] }
  | { kind: 'recent'; items: RecentlyWatchedItem[] };
type SidebarPane = 'channels' | 'sources' | 'groups';
type SidebarGroup = {
  id: ChannelGroupId;
  label: string;
  count: number;
  builtin?: BuiltinChannelGroup;
};

const AUTO_HIDE_MS = 5000;
const GROUP_PANEL_MIN_WIDTH = 280;
const CHANNEL_PANEL_WIDTH = 420;
const POINTER_MARGIN = 40;
const GROUP_DWELL_EDGE = 48;
const GROUP_DWELL_MS = 500;
const POINTER_EXIT_DWELL_MS = 500;
// Row strides mirror the fixed row geometry in css/player.css: .sidebar-ch-item
// is 84px plus a 4px gap, .sidebar-group-item is 64px.
const CHANNEL_ROW_STRIDE = 88;
const CHANNEL_ROW_GAP = 4;
const GROUP_ROW_STRIDE = 64;
const CHANNEL_OVERSCAN = 12;
const FALLBACK_LIST_HEIGHT = 800;

/**
 * The channel overlay shown on the left edge during playback. Owns its own
 * visibility, auto-hide timer, focus index and playlist tab. Delegated DOM
 * listeners are bound once in the constructor so they do not accumulate across
 * re-renders.
 */
export class Sidebar {
  private el: HTMLElement | null;
  private getCurrentIndex: () => number;
  private onSelectChannel: (index: number, catchup?: CatchupInfo, scope?: ChannelScope) => void;
  private getCurrentCatchupStart: () => number | null;
  private isVisible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelHide: (() => void) | null = null;
  private activePane: SidebarPane = 'channels';
  private groupsExpanded = false;
  private channelFocusIdx = -1; // -1 here means the search box is focused
  private sourceFocusIdx = 0;
  private groupFocusIdx = 0;
  private group: ChannelGroupId = 'builtin:all';
  private playlist = ''; // '' = All
  private searchQuery = '';
  keyboardOn = false; // while on, the sidebar never auto-hides
  readonly focusScope: FocusScope;
  private lastWheelAt = 0;
  private opening = false;
  private readonly channelVirtualizer = new VirtualList({
    itemSize: CHANNEL_ROW_STRIDE,
    overscan: CHANNEL_OVERSCAN,
    fallbackViewportSize: FALLBACK_LIST_HEIGHT,
  });
  private readonly groupVirtualizer = new VirtualList({
    itemSize: GROUP_ROW_STRIDE,
    overscan: CHANNEL_OVERSCAN,
    fallbackViewportSize: FALLBACK_LIST_HEIGHT,
  });
  private scrollFrame: number | null = null;
  private groupScrollFrame: number | null = null;
  private readonly scrollGuard = new VirtualScrollGuard();
  private groupDwellTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerAtGroupEdge = false;
  private pointerExitTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerExitPending = false;
  private failedLogos = new Set<string>();
  private channelSource: SidebarSource | null = null;
  private channelSearchResults: Channel[] | null = null;
  private channelSearchResultSource: Channel[] | null = null;
  private channelSearchResultQuery = '';
  private channelSearchPending = false;
  private channelSearchGeneration = 0;
  private channelSearchScope: Channel[] = [];
  private channelSearchRoot: Channel[] | null = null;
  private channelSearchGroup: ChannelGroupId = 'builtin:all';
  private channelSearchPlaylist = '';
  private channelSearchRevision = -1;
  private readonly channelSearch = new WorkerListSearch(
    'sidebar',
    'fields',
    (channel: Channel) => [channel.name, channel.group, channel.sourceName ?? ''],
  );
  private groupSource: SidebarGroup[] | null = null;
  private groupSourceChannels: Channel[] | null = null;
  private groupSourcePlaylist = '';
  private groupSourceRevision = -1;
  private groupSourceLocale: SupportedLocale | null = null;
  private groupLanguage: SupportedLocale | null = null;
  private groupWidthProbe: SidebarGroup | null = null;
  private decodedLogos = new Set<string>();
  private logoDecodePromises = new Map<string, Promise<boolean>>();
  private logoLoadGeneration = 0;
  private logoRevealQueue: string[] = [];
  private logoRevealFrame: number | null = null;

  constructor(
    container: HTMLElement,
    getCurrentIndex: () => number,
    onSelectChannel: (index: number, catchup?: CatchupInfo, scope?: ChannelScope) => void,
    getCurrentCatchupStart: () => number | null = () => null,
  ) {
    this.getCurrentIndex = getCurrentIndex;
    this.onSelectChannel = onSelectChannel;
    this.getCurrentCatchupStart = getCurrentCatchupStart;
    this.el = $('#player-sidebar', container);
    // The pane indices stay as the virtual lists' cache; the scope holds the
    // focused item's data-key and owns its ring and reveal.
    this.focusScope = Focus.register({
      id: 'player.sidebar',
      hoverOnSettle: true,
      root: () => this.el,
      restrict: 'self-first',
      when: () => !this.el || inShownView(this.el),
      defaultKey: () => this.stateKey(),
      has: (key) => key === this.stateKey(),
      reveal: (key) => this.reveal(key),
      revealOnHover: (key) => key.startsWith('tab:'),
      concealOnLeave: true,
    });
    // The D-pad taking over cancels what the pointer had started.
    InputMode.onChange((mode) => {
      if (mode === 'keys') this.dropPointerIntent();
    });
    this.bindEvents();
  }

  get visible(): boolean {
    return this.isVisible;
  }

  get pointerDismissX(): number {
    const groupWidth = this.el?.querySelector<HTMLElement>('.sidebar-group-panel')
      ?.getBoundingClientRect().width || GROUP_PANEL_MIN_WIDTH;
    return (this.groupsExpanded ? groupWidth + CHANNEL_PANEL_WIDTH : CHANNEL_PANEL_WIDTH)
      + POINTER_MARGIN;
  }

  refresh(): void {
    if (!this.isVisible) return;
    this.channelSearchRoot = null;
    this.channelSource = null;
    this.groupSource = null;
    this.focusCurrentChannel(false);
    this.render();
    this.resetTimer();
  }

  // `overTabs`: the tab row's own edge belongs to edge scrolling.
  handlePointerMove(clientX: number, overSidebar: boolean, overTabs = false): boolean {
    if (!this.isVisible || this.keyboardOn) {
      this.pointerAtGroupEdge = false;
      this.clearGroupDwell();
      return false;
    }

    if (overSidebar) this.resetTimer();

    this.pointerAtGroupEdge = clientX <= GROUP_DWELL_EDGE && !overTabs;
    if (!this.groupsExpanded && this.pointerAtGroupEdge && !this.opening) {
      this.startGroupDwell();
    } else {
      this.clearGroupDwell();
    }

    if (this.groupsExpanded && !overSidebar && clientX > this.pointerDismissX) {
      this.collapseGroups(true);
      // The hovered row may have been re-rendered away, so no mouseout
      // reached the panel to conceal its ring.
      this.focusScope.conceal();
      this.pointerExitPending = true;
      this.pointerExitTimer = setTimeout(() => {
        this.pointerExitTimer = null;
        if (this.pointerExitPending) this.hide();
      }, POINTER_EXIT_DWELL_MS);
      return true;
    }

    if (this.pointerExitPending) {
      if (clientX <= CHANNEL_PANEL_WIDTH) this.clearPointerExit();
      return true;
    }

    return false;
  }

  show(): void {
    if (this.isVisible) return;
    this.isVisible = true;
    Focus.push(this.focusScope);
    this.cancelHide?.();
    this.cancelHide = null;
    this.keyboardOn = false;
    this.opening = true;
    this.activePane = 'channels';
    this.groupsExpanded = false;
    this.searchQuery = '';
    this.channelSearchGeneration++;
    this.channelSearchResults = null;
    this.channelSearchResultSource = null;
    this.channelSearchResultQuery = '';
    this.channelSearchPending = false;
    this.channelSearchRoot = null;
    this.channelSource = null;
    this.groupSource = null;
    this.pointerAtGroupEdge = false;
    this.clearGroupDwell();
    this.clearPointerExit();
    this.focusCurrentChannel(true);
    if (this.el) {
      this.syncPanelState();
    }
    this.render();
    this.paint('resume');
    if (this.el) {
      this.el.classList.remove('hidden');
      this.el.classList.add('visible');
    }
    this.resetTimer();
  }

  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    Focus.pop(this.focusScope);
    this.channelSearchGeneration++;
    this.channelSearch.release();
    this.channelSearchPending = false;
    this.keyboardOn = false;
    this.opening = false;
    this.cancelLogoLoads();
    this.pointerAtGroupEdge = false;
    this.clearGroupDwell();
    this.clearPointerExit();
    const el = this.el;
    if (el) {
      el.querySelector<HTMLInputElement>('.sidebar-search-input')?.blur(); // dismiss keyboard
      el.classList.remove('visible');
      this.cancelHide = onceTransitionEnd(el, () => {
        this.cancelHide = null;
        if (!this.isVisible) el.classList.add('hidden');
      });
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // Stay while the keyboard is on or the pointer is over the sidebar.
      if (this.keyboardOn || this.el?.matches(':hover')) {
        this.resetTimer();
        return;
      }
      this.hide();
    }, AUTO_HIDE_MS);
  }

  // Keyboard off while still on the search box → hide; in the list → stay.
  setKeyboardVisible(visible: boolean): void {
    if (visible === this.keyboardOn) return;
    this.keyboardOn = visible;
    if (visible) {
      this.activePane = 'channels';
      this.channelFocusIdx = -1;
      this.paint('key');
      this.resetTimer();
    } else if (this.channelFocusIdx < 0) {
      this.hide();
    } else {
      this.resetTimer();
    }
  }

  handleAction(action: Action): void {
    if (!this.el) return;
    // A cursor resting at the edge leaves the mode on keys, so a key must
    // cancel the dwell itself too.
    this.dropPointerIntent();
    if (this.applyAction(action)) this.paint('key');
  }

  // Updates the pane state; true when focus should then be painted.
  private applyAction(action: Action): boolean {
    if (this.activePane === 'sources') return this.handleSourceAction(action);

    // Left/Right still run after a resume so they don't reveal a stale row.
    if (action === 'left' || action === 'right') this.resumeDetachedFocus();

    if (action === 'left') {
      if (!this.groupsExpanded) {
        this.openGroups();
      } else if (this.activePane === 'channels') {
        this.activePane = 'groups';
      }
      this.resetTimer();
      return true;
    }

    if (action === 'right') {
      if (this.groupsExpanded) {
        this.collapseGroups();
      } else {
        this.hide();
      }
      return false;
    }

    if ((action === 'up' || action === 'down' || action === 'channel_up'
        || action === 'channel_down' || action === 'select') && this.resumeDetachedFocus()) {
      this.resetTimer();
      return false;
    }

    if (this.activePane === 'groups') return this.handleGroupAction(action);

    if (action === 'select' && this.channelFocusIdx === -1) {
      this.openSearchInput(); // OK on the search box
      return false;
    }

    const len = this.getChannelCount();
    this.resetTimer();

    if (action === 'up' || action === 'channel_up') {
      if (this.channelFocusIdx === 0 && this.hasSourceTabs()) {
        this.focusActiveSource();
        return true;
      }
      this.channelFocusIdx = this.channelFocusIdx <= 0 ? -1 : this.channelFocusIdx - 1;
    } else if (action === 'down' || action === 'channel_down') {
      if (this.channelFocusIdx === -1 && this.hasSourceTabs()) {
        this.focusActiveSource();
        return true;
      }
      if (this.channelFocusIdx < len - 1) this.channelFocusIdx += 1;
    } else if (action === 'select') {
      const entry = this.getChannelEntry(this.channelFocusIdx);
      if (entry) this.selectEntry(entry);
      return false;
    }
    return true;
  }

  private handleSourceAction(action: Action): boolean {
    const sources = this.getSourceIds();
    this.resetTimer();
    if (action === 'left') {
      if (this.sourceFocusIdx > 0) {
        this.sourceFocusIdx -= 1;
      } else {
        this.openGroups();
      }
    } else if (action === 'right') {
      this.sourceFocusIdx = Math.min(sources.length - 1, this.sourceFocusIdx + 1);
    } else if (action === 'up' || action === 'channel_up') {
      this.activePane = 'channels';
      this.channelFocusIdx = -1;
    } else if (action === 'down' || action === 'channel_down') {
      this.activePane = 'channels';
      this.channelFocusIdx = this.getChannelCount() ? 0 : -1;
    } else if (action === 'select') {
      const playlist = sources[this.sourceFocusIdx];
      if (playlist !== undefined) this.selectPlaylist(playlist);
    }
    return true;
  }

  handleBack(): boolean {
    if (!this.groupsExpanded) return false;
    this.collapseGroups();
    return true;
  }

  private handleGroupAction(action: Action): boolean {
    const groups = this.getGroups();
    this.resetTimer();
    if (action === 'up' || action === 'channel_up') {
      this.groupFocusIdx = Math.max(0, this.groupFocusIdx - 1);
    } else if (action === 'down' || action === 'channel_down') {
      this.groupFocusIdx = Math.min(groups.length - 1, this.groupFocusIdx + 1);
    } else if (action === 'select') {
      const group = groups[this.groupFocusIdx];
      if (group) this.selectGroup(group.id);
    }
    return true;
  }

  private getChannelSource(): SidebarSource {
    if (this.channelSource) return this.channelSource;

    const playlist = this.playlist || undefined;
    if (this.group === 'builtin:recently-watched') {
      let items = RecentlyWatchedService.getItems(playlist);
      const q = this.searchQuery.trim();
      if (q) {
        const folded = q.toLocaleLowerCase();
        items = items.filter(item =>
          rankChannels([item.channel], q).length > 0 ||
          (item.kind === 'catchup' && (item.progress.title ?? '').toLocaleLowerCase().includes(folded)),
        );
      }
      this.channelSource = { kind: 'recent', items };
      return this.channelSource;
    }
    let channels = this.searchScopedChannels();
    const q = this.searchQuery.trim();
    if (q) channels = this.channelSearchResultSource === channels
        && this.channelSearchResultQuery === q
        ? this.channelSearchResults ?? []
        : [];
    this.channelSource = { kind: 'channels', channels };
    return this.channelSource;
  }

  private async updateChannelSearch(generation: number): Promise<void> {
    const query = this.searchQuery.trim();
    if (!query || !this.isVisible) return;
    const source = this.searchScopedChannels();
    let channels: Channel[];
    try {
      channels = await this.channelSearch.query(source, query);
    } catch (error) {
      if (generation !== this.channelSearchGeneration || !this.isVisible) return;
      if (!isIndexRetryPending(error)) {
        log.error(
          'Worker search failed; using main-thread fallback',
          'event=search.worker.fallback.used',
          'scope=list',
          'owner=sidebar',
          error,
        );
      }
      channels = rankChannels(source, query);
    }
    if (generation !== this.channelSearchGeneration
        || query !== this.searchQuery.trim()
        || !this.isVisible) return;
    this.channelSearchResults = channels;
    this.channelSearchResultSource = source;
    this.channelSearchResultQuery = query;
    this.channelSearchPending = false;
    this.channelSource = null;
    this.render();
  }

  private searchScopedChannels(): Channel[] {
    if (this.channelSearchRoot !== PlaylistService.channels
        || this.channelSearchGroup !== this.group
        || this.channelSearchPlaylist !== this.playlist
        || this.channelSearchRevision !== PlaylistService.groupsRevision) {
      this.channelSearchRoot = PlaylistService.channels;
      this.channelSearchGroup = this.group;
      this.channelSearchPlaylist = this.playlist;
      this.channelSearchRevision = PlaylistService.groupsRevision;
      this.channelSearchScope = PlaylistService.getByGroup(
        this.group,
        this.playlist || undefined,
      );
    }
    return this.channelSearchScope;
  }

  // The channel_up/channel_down scope for whatever gets selected here — not
  // to be confused with channelSearchScope above (the in-sidebar search's
  // own filtered list).
  private currentLaunchScope(): ChannelScope {
    return { group: this.group, playlist: this.playlist || undefined };
  }

  private getChannelCount(): number {
    const source = this.getChannelSource();
    return source.kind === 'channels' ? source.channels.length : source.items.length;
  }

  private getChannelEntry(position: number): SidebarEntry | null {
    const source = this.getChannelSource();
    if (source.kind === 'recent') {
      const recent = source.items[position];
      return recent
        ? { ch: recent.channel, globalIdx: recent.channelIndex, recent }
        : null;
    }
    const ch = source.channels[position];
    return ch ? { ch, globalIdx: PlaylistService.indexOf(ch) } : null;
  }

  private findChannelPosition(globalIdx: number): number {
    const source = this.getChannelSource();
    if (source.kind === 'recent') {
      return source.items.findIndex(item => item.channelIndex === globalIdx);
    }
    const channel = PlaylistService.getByIndex(globalIdx);
    return channel ? source.channels.indexOf(channel) : -1;
  }

  /** OK: focus the search box (caret at end); focus turns the keyboard on. */
  private openSearchInput(): void {
    const input = this.el?.querySelector<HTMLInputElement>('.sidebar-search-input');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    this.resetTimer();
  }

  // Down/Enter: into the list. Focus is set before blur so keyboard-off keeps it open.
  private exitSearchToList(): void {
    // A hovered group or tab is only tracked while the box has the caret.
    this.activePane = 'channels';
    this.channelFocusIdx = 0;
    this.setChannelScrollTop(0);
    this.paint('key');
    this.el?.querySelector<HTMLInputElement>('.sidebar-search-input')?.blur();
    this.resetTimer();
  }

  private entryKey({ globalIdx, recent }: SidebarEntry): string {
    return recent?.kind === 'catchup'
      ? `recent:catchup:${String(globalIdx)}:${String(recent.progress.progStart)}`
      : `ch:${String(globalIdx)}`;
  }

  // The data-key of the item the pane indices point at.
  private stateKey(): string | null {
    if (this.activePane === 'sources') {
      const id = this.getSourceIds()[this.sourceFocusIdx];
      return id === undefined ? null : `tab:${id}`;
    }
    if (this.activePane === 'groups') {
      const group = this.getGroups()[this.groupFocusIdx];
      return group ? `group:${group.id}` : null;
    }
    if (this.channelFocusIdx < 0) return 'search';
    // A rendered row has its key at hand; resolving an entry walks the playlist.
    const row = this.el?.querySelector<HTMLElement>(
      `.sidebar-ch-item[data-sidebar-pos="${String(this.channelFocusIdx)}"]`);
    if (row?.dataset.key) return row.dataset.key;
    const entry = this.getChannelEntry(this.channelFocusIdx);
    return entry ? this.entryKey(entry) : null;
  }

  private searchFocused(): boolean {
    const input = this.el?.querySelector('.sidebar-search-input');
    return !!input && document.activeElement === input;
  }

  private paint(via: Via): void {
    this.focusScope.focus(this.stateKey(), via);
    Focus.flush();
  }

  // Scroll a virtual list to the focused row and render it; the tab strip is
  // not virtual, so it takes the geometric reveal.
  private reveal(key: string): boolean {
    if (key !== this.stateKey() || this.activePane === 'sources') return false;
    const moved = this.activePane === 'groups'
      ? this.ensureGroupFocusVisible()
      : this.ensureFocusVisible();
    if (moved) this.render();
    return moved;
  }

  private getSourceIds(): string[] {
    return ['', ...PlaylistService.playlistTabs.map(tab => tab.id)];
  }

  private hasSourceTabs(): boolean {
    return PlaylistService.playlistTabs.length > 1;
  }

  private focusActiveSource(): void {
    const sources = this.getSourceIds();
    const selected = sources.indexOf(this.playlist);
    this.sourceFocusIdx = selected >= 0 ? selected : 0;
    this.activePane = 'sources';
  }

  // The wheel scrolls without moving focus, so the focused row is lost when the
  // pointer stops over padding or a key beats the hover sync. Resume at the
  // nearest row in view instead of scrolling back to it.
  private resumeDetachedFocus(): boolean {
    if (!this.el || this.activePane === 'sources') return false;
    const channels = this.activePane === 'channels';
    const list = this.el.querySelector<HTMLElement>(
      channels ? '.sidebar-channel-list' : '.sidebar-group-list',
    );
    const index = channels ? this.channelFocusIdx : this.groupFocusIdx;
    const count = channels ? this.getChannelCount() : this.getGroups().length;
    if (!list || !list.clientHeight || index < 0 || count === 0) return false;
    const stride = channels ? CHANNEL_ROW_STRIDE : GROUP_ROW_STRIDE;
    const rowHeight = channels ? CHANNEL_ROW_STRIDE - CHANNEL_ROW_GAP : GROUP_ROW_STRIDE;
    const padding = parseFloat(getComputedStyle(list).paddingTop) || 0;
    const top = list.scrollTop - padding;
    const bottom = top + list.clientHeight;
    const rowTop = index * stride;
    if (rowTop + rowHeight > top && rowTop < bottom) return false;
    const first = Math.max(0, Math.ceil(top / stride));
    const last = Math.min(count - 1, Math.floor((bottom - rowHeight) / stride));
    if (first > last) return false;
    const target = index < first ? first : last;
    if (channels) this.channelFocusIdx = target;
    else this.groupFocusIdx = target;
    this.render();
    const key = this.stateKey();
    if (key !== null) this.focusScope.resume(key, Math.abs(target - index));
    Focus.flush();
    return true;
  }

  private ensureFocusVisible(): boolean {
    if (this.channelFocusIdx < 0 || !this.el) return false;
    const list = this.el.querySelector<HTMLElement>('.sidebar-channel-list');
    const viewportHeight = list?.clientHeight || FALLBACK_LIST_HEIGHT;
    if (!this.channelVirtualizer.ensureVisible(this.channelFocusIdx, viewportHeight)) return false;
    this.applyChannelScrollOffset();
    return true;
  }

  private setChannelScrollTop(scrollTop: number): void {
    this.channelVirtualizer.setScrollOffset(scrollTop);
    this.applyChannelScrollOffset();
  }

  private applyChannelScrollOffset(): void {
    const list = this.el?.querySelector<HTMLElement>('.sidebar-channel-list');
    const offset = this.channelVirtualizer.scrollOffset;
    if (list) this.scrollGuard.syncOffset(list, 'vertical', offset);
  }

  private ensureGroupFocusVisible(): boolean {
    if (!this.el) return false;
    const list = this.el.querySelector<HTMLElement>('.sidebar-group-list');
    const viewportHeight = list?.clientHeight || FALLBACK_LIST_HEIGHT;
    if (!this.groupVirtualizer.ensureVisible(this.groupFocusIdx, viewportHeight)) return false;
    this.applyGroupScrollOffset();
    return true;
  }

  private applyGroupScrollOffset(): void {
    const list = this.el?.querySelector<HTMLElement>('.sidebar-group-list');
    if (list) {
      this.scrollGuard.syncOffset(list, 'vertical', this.groupVirtualizer.scrollOffset);
    }
  }

  private getGroups(): SidebarGroup[] {
    if (this.groupSource
        && this.groupSourceChannels === PlaylistService.channels
        && this.groupSourcePlaylist === this.playlist
        && this.groupSourceRevision === PlaylistService.groupsRevision
        && this.groupSourceLocale === getLocale()) {
      return this.groupSource;
    }
    const playlist = this.playlist || undefined;
    const groups: SidebarGroup[] = [
      {
        id: 'builtin:all',
        label: t('common.all'),
        count: PlaylistService.getGroupCount('builtin:all', playlist),
        builtin: 'all',
      },
      {
        id: 'builtin:favorites',
        label: t('channel.favorites'),
        count: PlaylistService.getGroupCount('builtin:favorites', playlist),
        builtin: 'favorites',
      },
      {
        id: 'builtin:recently-watched',
        label: t('channel.recentlyWatched'),
        count: RecentlyWatchedService.getItems(playlist).length,
        builtin: 'recently-watched',
      },
    ];
    PlaylistService.getGroupsForPlaylist(playlist).forEach(name => {
      groups.push({
        id: `source:${name}`,
        label: groupDisplayLabel(name),
        count: PlaylistService.getGroupCount(`source:${name}`, playlist),
      });
    });
    this.groupSource = groups;
    this.groupSourceChannels = PlaylistService.channels;
    this.groupSourcePlaylist = this.playlist;
    this.groupSourceRevision = PlaylistService.groupsRevision;
    this.groupSourceLocale = getLocale();
    this.groupLanguage = playlistLanguage(groups
      .filter(g => !g.builtin && g.id !== `source:${UNCATEGORIZED_GROUP}`)
      .map(g => g.label));
    this.groupWidthProbe = groups.reduce((widest, item) =>
      this.groupWidthScore(item) > this.groupWidthScore(widest) ? item : widest);
    return this.groupSource;
  }

  private focusCurrentChannel(fallbackToAll: boolean): void {
    const currentIdx = this.getCurrentIndex();
    let position = this.findChannelPosition(currentIdx);
    if (position < 0 && fallbackToAll && this.group !== 'builtin:all') {
      this.group = 'builtin:all';
      this.channelSource = null;
      position = this.findChannelPosition(currentIdx);
    }
    if (position < 0 && fallbackToAll && this.playlist) {
      this.playlist = '';
      this.channelSource = null;
      position = this.findChannelPosition(currentIdx);
    }
    this.channelFocusIdx = position >= 0 ? position : (this.getChannelCount() ? 0 : -1);
    const viewportHeight = this.el?.querySelector<HTMLElement>('.sidebar-channel-list')?.clientHeight
      || FALLBACK_LIST_HEIGHT;
    this.channelVirtualizer.centerOn(this.channelFocusIdx, viewportHeight);
    this.applyChannelScrollOffset();
  }

  private openGroups(): void {
    this.clearGroupDwell();
    this.groupsExpanded = true;
    this.activePane = 'groups';
    const groups = this.getGroups();
    const selected = groups.findIndex(group => group.id === this.group);
    this.groupFocusIdx = selected >= 0 ? selected : 0;
    this.syncPanelState();
    this.render(true, true);
  }

  // A pointer collapse only follows the state: it neither scrolls nor
  // brings back a ring the pointer leaving concealed.
  private collapseGroups(byPointer = false): void {
    this.groupsExpanded = false;
    this.activePane = 'channels';
    this.syncPanelState();
    if (byPointer) this.focusScope.track(this.stateKey());
    else this.paint('back');
    this.resetTimer();
  }

  private selectGroup(group: ChannelGroupId): void {
    this.group = group;
    this.searchQuery = '';
    this.channelSource = null;
    this.activePane = 'channels';
    this.focusCurrentChannel(false);
    this.render();
    this.resetTimer();
  }

  private selectPlaylist(playlist: string): void {
    this.playlist = playlist;
    this.group = 'builtin:all';
    this.groupFocusIdx = 0;
    this.groupVirtualizer.setScrollOffset(0);
    this.applyGroupScrollOffset();
    this.searchQuery = '';
    this.channelSource = null;
    this.groupSource = null;
    this.activePane = 'channels';
    this.focusCurrentChannel(false);
    this.render();
    this.resetTimer();
  }

  private syncPanelState(): void {
    this.el?.classList.toggle('groups-expanded', this.groupsExpanded);
    this.el?.classList.toggle('channels-only', !this.groupsExpanded);
  }

  private dropPointerIntent(): void {
    this.pointerAtGroupEdge = false;
    this.clearGroupDwell();
    this.clearPointerExit();
  }

  private clearGroupDwell(): void {
    if (!this.groupDwellTimer) return;
    clearTimeout(this.groupDwellTimer);
    this.groupDwellTimer = null;
  }

  private startGroupDwell(): void {
    if (this.groupDwellTimer) return;
    this.groupDwellTimer = setTimeout(() => {
      this.groupDwellTimer = null;
      if (this.isVisible && !this.groupsExpanded && !this.keyboardOn
          && this.pointerAtGroupEdge) {
        this.openGroups();
        this.paint('pointer');
        this.resetTimer();
      }
    }, GROUP_DWELL_MS);
  }

  private clearPointerExit(): void {
    this.pointerExitPending = false;
    if (!this.pointerExitTimer) return;
    clearTimeout(this.pointerExitTimer);
    this.pointerExitTimer = null;
  }

  // Only opening the groups pane reveals its focus; key moves reveal through
  // the focus scope, and background renders keep the user's scroll offset.
  private render(measureMarquees = true, revealGroup = false): void {
    const el = this.el;
    if (!el) return;

    const scrolling = measureMarquees
      ? []
      : Array.from(el.querySelectorAll<HTMLElement>('.ch-name-text.scrolling, .ch-now-text.scrolling'))
        .map(span => ({ span, dist: span.style.getPropertyValue('--scroll-dist') }));
    const tabs = PlaylistService.playlistTabs;
    if (this.playlist && !tabs.some(t => t.id === this.playlist)) this.playlist = '';
    const showTabs = tabs.length > 1;
    if (this.activePane === 'sources') {
      const sourceCount = tabs.length + 1;
      this.sourceFocusIdx = Math.max(0, Math.min(sourceCount - 1, this.sourceFocusIdx));
    }
    const groups = this.getGroups();
    const groupLang = this.groupLanguage;
    if (!groups.some(item => item.id === this.group)) {
      this.group = 'builtin:all';
      this.groupFocusIdx = 0;
      this.channelSource = null;
    }
    const entryCount = this.getChannelCount();
    const previousList = el.querySelector<HTMLElement>('.sidebar-channel-list');
    const previousGroupList = el.querySelector<HTMLElement>('.sidebar-group-list');
    if (previousList) this.channelVirtualizer.setScrollOffset(previousList.scrollTop);
    if (previousGroupList) this.groupVirtualizer.setScrollOffset(previousGroupList.scrollTop);
    const viewportHeight = previousList?.clientHeight || FALLBACK_LIST_HEIGHT;
    const groupViewportHeight = previousGroupList?.clientHeight || FALLBACK_LIST_HEIGHT;
    if (revealGroup) this.groupVirtualizer.centerOn(this.groupFocusIdx, groupViewportHeight);
    const groupRange = this.groupVirtualizer.getRange(groups.length, groupViewportHeight);
    const range = this.channelVirtualizer.getRange(entryCount, viewportHeight);
    const visibleEntries: SidebarEntry[] = [];
    for (let i = range.start; i < range.end; i++) {
      const entry = this.getChannelEntry(i);
      if (entry) visibleEntries.push(entry);
    }
    const currentIdx = this.getCurrentIndex();
    const currentCatchupStart = this.getCurrentCatchupStart();
    const currentTab = tabs.find(t => t.id === this.playlist);
    const activeGroup = groups.find(item => item.id === this.group) || groups[0];
    const widthProbeGroup = this.groupWidthProbe ?? groups[0];
    const searchPlaceholder = currentTab
      ? t('search.sidebarPlaylist', { name: currentTab.name })
      : t('search.sidebarAll');

    morph(el, html`
      <div class="sidebar-group-panel" data-key="group-panel">
        <div class="sidebar-group-width-probe" aria-hidden="true">
          <span class="sidebar-group-icon"></span>
          <span class="sidebar-group-name">${widthProbeGroup.label}</span>
          <span class="sidebar-group-count">${widthProbeGroup.count}</span>
        </div>
        <div class="sidebar-title">${t('common.groups')}</div>
        <div class="sidebar-group-list">
          <div class="sidebar-group-spacer"
               style="height:${this.groupVirtualizer.getTotalSize(groups.length)}px">
          ${groups.slice(groupRange.start, groupRange.end).map((item, offset) => {
            const i = groupRange.start + offset;
            return html`
            <div class="sidebar-group-item ${item.id === this.group ? 'active' : ''}"
                 data-key="group:${item.id}" data-group-id="${item.id}" data-group-pos="${i}"
                 data-hover-target
                 style="top:${this.groupVirtualizer.getItemOffset(i)}px">
              <span class="sidebar-group-icon">${raw(groupIcon(item.label, item.builtin, groupLang))}</span>
              <span class="sidebar-group-name">${
                raw(liveGroupLockBadge(item.id, this.playlist))}${item.label}</span>
              <span class="sidebar-group-count">${item.count}</span>
            </div>
          `;
          })}
          </div>
        </div>
      </div>
      <div class="sidebar-channel-panel" data-key="channel-panel">
        <button type="button" class="sidebar-title sidebar-channel-title" data-open-groups>
          <span class="sidebar-picker-label">${activeGroup?.label || t('common.channels')}</span>
          <span class="sidebar-picker-arrow" aria-hidden="true">
            ${raw(CHEVRON_LEFT_ICON)}
          </span>
        </button>
        <input type="text" class="sidebar-search-input" data-hover-target
               data-key="search" aria-label="${t('search.ariaChannels')}"
               data-search-query="${this.channelSearchResultQuery}"
               data-search-pending="${this.channelSearchPending ? 'true' : 'false'}"
               placeholder="${searchPlaceholder}" value="${this.searchQuery}">
        ${showTabs ? html`
          <div class="sidebar-tabs" data-edge-scroll>
            <div class="sidebar-tab ${!this.playlist ? 'active' : ''}" data-hover-target
                 data-key="tab:"
                 data-sidebar-playlist="">${t('common.all')}</div>
            ${tabs.map((tab) => html`
              <div class="sidebar-tab ${tab.id === this.playlist ? 'active' : ''}" data-hover-target
                   data-key="tab:${tab.id}"
                   data-sidebar-playlist="${tab.id}">${tab.name}</div>
            `)}
          </div>
        ` : ''}
        <div class="sidebar-channel-list" data-key="channel-list">
          <div class="sidebar-channel-spacer" data-key="channel-spacer"
               style="height:${this.channelVirtualizer.getTotalSize(entryCount)}px">
          ${visibleEntries.map((entry, offset) => {
            const { ch, globalIdx, recent } = entry;
            const i = range.start + offset;
            const epgId = EpgService.findChannelId(ch);
            const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
            const catchup = recent?.kind === 'catchup' ? recent : null;
            const isPlaying = globalIdx === currentIdx && (catchup
              ? catchup.progress.progStart === currentCatchupStart
              : currentCatchupStart === null);
            const title = catchup ? catchup.progress.title ?? ch.name : ch.name;
            const subtitle = catchup
              ? t('channel.resumeAt', {
                  channel: ch.name,
                  position: formatPosition(catchup.progress.position),
                })
              : nowPlaying?.title;
            return html`
              <div class="sidebar-ch-item ${isPlaying ? 'playing' : ''}"
                   data-key="${this.entryKey(entry)}"
                   data-focusable data-sidebar-index="${globalIdx}" data-sidebar-pos="${i}"
                   style="top:${this.channelVirtualizer.getItemOffset(i)}px">
                <span class="ch-num">${globalIdx + 1}</span>
                ${this.renderLogo(ch)}
                <div class="ch-info">
                  <span class="ch-name">${raw(channelLockBadge(ch))}<span class="ch-name-text">${title}</span></span>
                  ${subtitle ? html`<span class="ch-now"><span class="ch-now-text">${subtitle}</span></span>` : ''}
                </div>
                ${catchup
                  ? html`<span class="sidebar-recent-kind">${t('common.catchup')}</span>`
                  : this.renderHealthDot(ch)}
              </div>
            `;
          })}
          </div>
        </div>
      </div>
    `);

    this.applyChannelScrollOffset();
    this.applyGroupScrollOffset();
    const search = el.querySelector<HTMLInputElement>('.sidebar-search-input');
    if (search && search.value !== this.searchQuery) search.value = this.searchQuery;
    this.focusScope.track(this.stateKey());

    scrolling.forEach(({ span, dist }) => {
      if (!el.contains(span)) return;
      span.style.setProperty('--scroll-dist', dist);
      span.classList.add('scrolling');
    });
    if (!this.opening) {
      if (measureMarquees) this.measureMarquees();
      this.scheduleVisibleLogoLoads();
    }
  }

  private groupWidthScore(group: SidebarGroup): number {
    let score = String(group.count).length;
    for (const char of group.label) score += char.charCodeAt(0) > 0xff ? 2 : 1;
    return score;
  }

  private renderLogo(ch: Channel): Safe {
    if (!ch.logo) {
      return html`
        <div class="ch-logo-wrap">
          <div class="ch-logo-placeholder">${ch.name.charAt(0)}</div>
        </div>
      `;
    }

    if (this.failedLogos.has(ch.logo)) return html`<div class="ch-logo-wrap"></div>`;
    if (this.decodedLogos.has(ch.logo) && !this.opening) {
      return html`
        <div class="ch-logo-wrap">
          <img class="ch-logo" src="${ch.logo}" alt="">
        </div>
      `;
    }
    return html`<div class="ch-logo-wrap" data-logo-src="${ch.logo}"></div>`;
  }

  private renderHealthDot(ch: Channel): Safe | string {
    const status = ChannelHealthService.getRecord(ch)?.status;
    if (!status) return '';
    const labels: Record<ChannelHealthStatus, string> = {
      healthy: t('channel.healthHealthy'),
      suspect: t('channel.healthSuspect'),
      unavailable: t('channel.healthUnavailable'),
    };
    return html`
      <span class="channel-health-status channel-health-dot ${status}" title="${labels[status]}"
            aria-label="${labels[status]}"></span>
    `;
  }

  private preloadLogo(src: string): Promise<boolean> {
    const existing = this.logoDecodePromises.get(src);
    if (existing) return existing;

    const promise = new Promise<boolean>((resolve) => {
      const image = new Image();
      const finish = (decoded: boolean) => {
        image.onload = null;
        image.onerror = null;
        resolve(decoded);
      };
      image.decoding = 'async';
      image.onload = () => {
        const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
        decoded.then(() => finish(true), () => finish(false));
      };
      image.onerror = () => finish(false);
      image.src = src;
    });
    this.logoDecodePromises.set(src, promise);
    void promise.then(() => {
      if (this.logoDecodePromises.get(src) === promise) this.logoDecodePromises.delete(src);
    });
    return promise;
  }

  private scheduleVisibleLogoLoads(): void {
    const el = this.el;
    if (!el || !this.isVisible || this.opening) return;
    const list = el.querySelector<HTMLElement>('.sidebar-channel-list');
    if (!list) return;

    const generation = ++this.logoLoadGeneration;
    this.logoRevealQueue = [];
    if (this.logoRevealFrame !== null) {
      cancelAnimationFrame(this.logoRevealFrame);
      this.logoRevealFrame = null;
    }

    const viewportStart = list.scrollTop;
    const viewportEnd = viewportStart + (list.clientHeight || FALLBACK_LIST_HEIGHT);
    const sources = new Set<string>();
    list.querySelectorAll<HTMLElement>('.ch-logo-wrap[data-logo-src]').forEach((spacer) => {
      const item = spacer.closest<HTMLElement>('.sidebar-ch-item');
      const position = item?.dataset.sidebarPos ? parseInt(item.dataset.sidebarPos, 10) : -1;
      if (position < 0) return;
      const rowStart = this.channelVirtualizer.getItemOffset(position);
      if (rowStart + CHANNEL_ROW_STRIDE <= viewportStart || rowStart >= viewportEnd) return;
      const src = spacer.dataset.logoSrc;
      if (src) sources.add(src);
    });

    sources.forEach((src) => {
      void this.preloadLogo(src).then((decoded) => {
        if (generation !== this.logoLoadGeneration || !this.isVisible) return;
        if (!decoded) {
          this.failedLogos.add(src);
          el.querySelectorAll<HTMLElement>('.ch-logo-wrap[data-logo-src]').forEach((spacer) => {
            if (spacer.dataset.logoSrc === src) spacer.removeAttribute('data-logo-src');
          });
          return;
        }
        this.logoRevealQueue.push(src);
        this.scheduleLogoReveal(generation);
      });
    });
  }

  private scheduleLogoReveal(generation: number): void {
    if (this.logoRevealFrame !== null) return;
    this.logoRevealFrame = requestAnimationFrame(() => {
      this.logoRevealFrame = null;
      if (generation !== this.logoLoadGeneration || !this.isVisible) return;
      const src = this.logoRevealQueue.shift();
      if (!src) return;
      const spacers = this.el?.querySelectorAll<HTMLElement>('.ch-logo-wrap[data-logo-src]');
      const target = spacers
        ? Array.from(spacers).find(spacer => spacer.dataset.logoSrc === src)
        : undefined;
      if (target) {
        this.decodedLogos.add(src);
        target.removeAttribute('data-logo-src');
        const image = document.createElement('img');
        image.className = 'ch-logo';
        image.alt = '';
        image.src = src;
        target.appendChild(image);
      }
      if (this.logoRevealQueue.length) this.scheduleLogoReveal(generation);
    });
  }

  private cancelLogoLoads(): void {
    this.logoLoadGeneration++;
    this.logoRevealQueue = [];
    if (this.logoRevealFrame !== null) {
      cancelAnimationFrame(this.logoRevealFrame);
      this.logoRevealFrame = null;
    }
  }

  private measureMarquees(): void {
    const el = this.el;
    if (!el) return;
    requestAnimationFrame(() => {
      el.querySelectorAll<HTMLElement>('.ch-name, .ch-now').forEach(container => {
        const span = container.querySelector<HTMLElement>('.ch-name-text, .ch-now-text');
        if (!span) return;
        const textWidth = span.offsetWidth;
        const containerWidth = container.offsetWidth;
        if (textWidth > containerWidth) {
          const dist = containerWidth - textWidth;
          span.style.setProperty('--scroll-dist', `${dist}px`);
          span.classList.add('scrolling');
        } else {
          span.style.removeProperty('--scroll-dist');
          span.classList.remove('scrolling');
        }
      });
    });
  }

  private bindEvents(): void {
    const el = this.el;
    if (!el) return;

    el.addEventListener('transitionend', (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'transform' || !this.isVisible) return;
      // The group panel slid in or out under a resting pointer: a move made
      // mid-slide hovered whatever passed under it then.
      Focus.hoverPointerIn(this.focusScope);
      if (!this.opening) return;
      this.opening = false;
      if (this.pointerAtGroupEdge) this.startGroupDwell();
      this.measureMarquees();
      this.scheduleVisibleLogoLoads();
    });

    el.addEventListener('error', (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLImageElement)
          || !target.classList.contains('ch-logo')) return;
      const src = target.getAttribute('src');
      if (src && !this.failedLogos.has(src)) {
        this.failedLogos.add(src);
        this.render();
      }
    }, true);

    el.addEventListener('input', (e: Event) => {
      if (!(e.target as HTMLElement).classList.contains('sidebar-search-input')) return;
      this.searchQuery = (e.target as HTMLInputElement).value;
      const generation = ++this.channelSearchGeneration;
      this.channelSearchResults = null;
      this.channelSearchResultSource = null;
      this.channelSearchResultQuery = '';
      this.channelSearchPending = !!this.searchQuery.trim();
      this.channelSource = null;
      this.activePane = 'channels';
      this.channelFocusIdx = -1;
      this.setChannelScrollTop(0);
      this.render();
      if (this.searchQuery.trim()) void this.updateChannelSearch(generation);
      this.resetTimer();
    });

    // Desktop fallback for the keyboard signal: the input's focus.
    // While the box has the caret it is lit while the pointer last rested on
    // it (a click lights it at once; no hover follows a still pointer);
    // otherwise its native focus stands in for the ring, and the ring comes
    // back on the item it rests on however the caret leaves.
    const lightSearchUnderPointer = (input: HTMLElement): boolean => {
      if (!input.matches(':hover')) return false;
      this.activePane = 'channels';
      this.channelFocusIdx = -1;
      this.paint('pointer');
      return true;
    };
    el.addEventListener('focusin', (e: FocusEvent) => {
      const input = e.target as HTMLElement;
      if (!input.classList.contains('sidebar-search-input')) return;
      this.setKeyboardVisible(true);
      if (InputMode.current !== 'pointer' || !lightSearchUnderPointer(input)) {
        this.focusScope.conceal();
      }
    });
    // A click on a box that already has the caret fires no focusin, and a
    // still pointer leaves the input mode on the keys.
    el.addEventListener('click', (e: MouseEvent) => {
      const input = e.target as HTMLElement;
      if (input.classList.contains('sidebar-search-input') && this.searchFocused()) {
        lightSearchUnderPointer(input);
      }
    });
    el.addEventListener('focusout', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('sidebar-search-input')) return;
      this.setKeyboardVisible(false);
      if (!this.isVisible) return;
      // A scope that does not own the keys only follows the state, so no
      // reveal waits in it and nothing lights under the owner.
      if (Focus.owner() !== this.focusScope) this.focusScope.track(this.stateKey(), true);
      else this.paint(InputMode.current === 'keys' ? 'key' : 'pointer');
    });

    // webOS: authoritative keyboard signal (independent of the lingering caret).
    document.addEventListener('keyboardStateChange', (e: Event) => {
      const visible = (e as CustomEvent<{ visibility?: boolean }>).detail?.visibility;
      if (typeof visible !== 'boolean') return;
      this.setKeyboardVisible(visible);
    });

    // Keys typed in the search box are handled here. The global key handler now
    // routes the remote Back key through even from inputs, so stop propagation
    // on the keys we own — otherwise Back would both exit the search box (below)
    // and bubble up to close the whole sidebar / act on the player.
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!t.classList.contains('sidebar-search-input')) return;
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        this.exitSearchToList();
      } else if (e.key === 'Escape' || e.keyCode === CONFIG.KEYS.BACK) {
        e.preventDefault();
        e.stopPropagation();
        (t as HTMLInputElement).blur();
      }
    });

    // Click to select a group, channel, or playlist tab.
    el.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-open-groups]')) {
        if (this.groupsExpanded) this.collapseGroups(true);
        else this.openGroups();
        this.resetTimer();
        return;
      }
      const group = target.closest<HTMLElement>('[data-group-id]');
      if (group) {
        this.groupFocusIdx = parseInt(group.dataset.groupPos!, 10);
        this.selectGroup(group.dataset.groupId as ChannelGroupId);
        return;
      }
      const tab = target.closest<HTMLElement>('[data-sidebar-playlist]');
      if (tab) {
        this.selectPlaylist(tab.dataset.sidebarPlaylist!);
        return;
      }
      const chItem = target.closest<HTMLElement>('[data-sidebar-index]');
      if (chItem) {
        const position = parseInt(chItem.dataset.sidebarPos!, 10);
        const entry = this.getChannelEntry(position);
        if (entry) this.selectEntry(entry);
      }
    });

    // Hover moves focus within the pane under the pointer.
    el.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      const groupItem = target.closest<HTMLElement>('[data-group-pos]');
      const sourceItem = target.closest<HTMLElement>('[data-sidebar-playlist]');
      const item = target.closest<HTMLElement>('[data-sidebar-pos]');
      if (groupItem) {
        this.activePane = 'groups';
        this.groupFocusIdx = parseInt(groupItem.dataset.groupPos!, 10);
      } else if (sourceItem) {
        this.activePane = 'sources';
        this.sourceFocusIdx = Array.from(el.querySelectorAll('[data-sidebar-playlist]'))
          .indexOf(sourceItem);
      } else if (item || target.closest('.sidebar-search-input')) {
        this.activePane = 'channels';
        this.channelFocusIdx = item ? parseInt(item.dataset.sidebarPos!, 10) : -1;
      } else {
        return;
      }
      // While the box has the caret, only the box itself lights; any other
      // item is only noted.
      const key = this.stateKey();
      if (this.searchFocused() && key !== 'search') {
        this.focusScope.conceal();
        this.focusScope.track(key);
        Focus.flush();
      } else {
        this.paint('pointer');
      }
      this.resetTimer();
    });

    el.addEventListener('scroll', (e: Event) => {
      const list = e.target as HTMLElement;
      if (list.classList.contains('sidebar-group-list')) {
        const offset = this.scrollGuard.readUserOffset(list, 'vertical');
        if (offset === null) return;
        this.groupVirtualizer.setScrollOffset(offset);
        if (this.groupScrollFrame !== null) return;
        this.groupScrollFrame = requestAnimationFrame(() => {
          this.groupScrollFrame = null;
          if (this.isVisible) this.render(false);
        });
        return;
      }
      if (!list.classList.contains('sidebar-channel-list')) return;
      const offset = this.scrollGuard.readUserOffset(list, 'vertical');
      if (offset === null) return;
      this.channelVirtualizer.setScrollOffset(offset);
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        if (this.isVisible) this.render(false);
      });
    }, true);

    // The wheel scrolls natively and hover moves focus. Claiming it keeps the
    // channel step away; stepping focus here raced the scroll event and yanked
    // the list back to the stale offset.
    el.addEventListener('nav:wheel', (e: Event) => {
      e.preventDefault();
      const now = Date.now();
      if (now - this.lastWheelAt > 500) {
        const pane = (e.target as HTMLElement).closest('.sidebar-group-panel')
          ? 'groups' : 'channels';
        log.debug('Wheel scroll', 'event=sidebar.wheel.scroll', `pane=${pane}`);
      }
      this.lastWheelAt = now;
      this.resetTimer();
    });
  }

  private selectEntry(entry: SidebarEntry): void {
    if (entry.recent?.kind === 'catchup') {
      void this.playRecentCatchup(entry.recent);
      return;
    }
    this.onSelectChannel(entry.globalIdx, undefined, this.currentLaunchScope());
    this.hide();
  }

  private async playRecentCatchup(
    item: Extract<RecentlyWatchedItem, { kind: 'catchup' }>,
  ): Promise<void> {
    const catchup = await RecentlyWatchedService.catchupInfo(item);
    if (!catchup) {
      showToast(t('channel.catchupUnavailable'));
      this.render();
      return;
    }
    this.onSelectChannel(item.channelIndex, catchup, this.currentLaunchScope());
    this.hide();
  }
}
