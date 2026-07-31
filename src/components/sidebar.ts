import type { Action, BuiltinChannelGroup, CatchupInfo, Channel, ChannelGroupId } from '../types';
import { CONFIG } from '../config';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { RecentlyWatchedService, type RecentlyWatchedItem } from '../services/recently-watched';
import { $, html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { rankChannels } from '../utils/channel-search';
import { formatPosition } from '../utils/time';
import { t } from '../i18n';
import { groupIcon } from './group-icon';
import { CHEVRON_LEFT_ICON } from './icons';
import { showToast } from './toast';

type SidebarEntry = { ch: Channel; globalIdx: number; recent?: RecentlyWatchedItem };
type SidebarPane = 'channels' | 'groups';
type SidebarGroup = {
  id: ChannelGroupId;
  label: string;
  count: number;
  builtin?: BuiltinChannelGroup;
};

const AUTO_HIDE_MS = 5000;
const GROUP_PANEL_MIN_WIDTH = 260;
const CHANNEL_PANEL_WIDTH = 420;
const POINTER_MARGIN = 40;
const GROUP_DWELL_EDGE = 48;
const GROUP_DWELL_MS = 500;
const POINTER_EXIT_DWELL_MS = 500;
const CHANNEL_ROW_STRIDE = 92;
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
  private onSelectChannel: (index: number, catchup?: CatchupInfo) => void;
  private getCurrentCatchupStart: () => number | null;
  private isVisible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activePane: SidebarPane = 'channels';
  private groupsExpanded = false;
  private channelFocusIdx = -1; // -1 here means the search box is focused
  private groupFocusIdx = 0;
  private group: ChannelGroupId = 'builtin:all';
  private playlist = ''; // '' = All
  private searchQuery = '';
  keyboardOn = false; // while on, the sidebar never auto-hides
  private hoverCleared = false; // highlight removed on mouseleave; next hover re-shows it
  private opening = false;
  private channelScrollTop = 0;
  private scrollFrame: number | null = null;
  private groupDwellTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerAtGroupEdge = false;
  private pointerExitTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerExitPending = false;
  private failedLogos = new Set<string>();

  constructor(
    container: HTMLElement,
    getCurrentIndex: () => number,
    onSelectChannel: (index: number, catchup?: CatchupInfo) => void,
    getCurrentCatchupStart: () => number | null = () => null,
  ) {
    this.getCurrentIndex = getCurrentIndex;
    this.onSelectChannel = onSelectChannel;
    this.getCurrentCatchupStart = getCurrentCatchupStart;
    this.el = $('#player-sidebar', container);
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
    this.focusCurrentChannel(false);
    this.render();
    this.resetTimer();
  }

  handlePointerMove(clientX: number, overSidebar: boolean): boolean {
    if (!this.isVisible || this.keyboardOn) {
      this.pointerAtGroupEdge = false;
      this.clearGroupDwell();
      return false;
    }

    if (overSidebar) this.resetTimer();

    this.pointerAtGroupEdge = clientX <= GROUP_DWELL_EDGE;
    if (!this.groupsExpanded && this.pointerAtGroupEdge && !this.opening) {
      this.startGroupDwell();
    } else {
      this.clearGroupDwell();
    }

    if (this.groupsExpanded && !overSidebar && clientX > this.pointerDismissX) {
      this.collapseGroups();
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
    this.keyboardOn = false;
    this.opening = true;
    this.activePane = 'channels';
    this.groupsExpanded = false;
    this.searchQuery = '';
    this.pointerAtGroupEdge = false;
    this.clearGroupDwell();
    this.clearPointerExit();
    this.focusCurrentChannel(true);
    if (this.el) {
      this.syncPanelState();
      this.el.classList.remove('hidden');
      this.el.classList.add('visible');
    }
    this.render();
    this.resetTimer();
  }

  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.keyboardOn = false;
    this.opening = false;
    this.pointerAtGroupEdge = false;
    this.clearGroupDwell();
    this.clearPointerExit();
    const el = this.el;
    if (el) {
      el.querySelector<HTMLInputElement>('.sidebar-search-input')?.blur(); // dismiss keyboard
      el.classList.remove('visible');
      el.addEventListener('transitionend', () => {
        if (!this.isVisible) el.classList.add('hidden');
      }, { once: true });
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
      this.updateFocus();
      this.resetTimer();
    } else if (this.channelFocusIdx < 0) {
      this.hide();
    } else {
      this.resetTimer();
    }
  }

  handleAction(action: Action): void {
    if (!this.el) return;

    if (action === 'left') {
      if (!this.groupsExpanded) {
        this.openGroups();
      } else if (this.activePane === 'channels') {
        this.activePane = 'groups';
        this.updateFocus();
      }
      this.resetTimer();
      return;
    }

    if (action === 'right') {
      if (this.groupsExpanded) this.collapseGroups();
      else this.hide();
      return;
    }

    if (this.activePane === 'groups') {
      this.handleGroupAction(action);
      return;
    }

    if (action === 'select' && this.channelFocusIdx === -1) {
      this.openSearchInput(); // OK on the search box
      return;
    }

    const entries = this.getChannels();
    const len = entries.length;
    this.resetTimer();

    if (action === 'up' || action === 'channel_up') {
      this.channelFocusIdx = this.channelFocusIdx <= 0 ? -1 : this.channelFocusIdx - 1;
    } else if (action === 'down' || action === 'channel_down') {
      if (this.channelFocusIdx < len - 1) this.channelFocusIdx += 1;
    } else if (action === 'select') {
      const entry = entries[this.channelFocusIdx];
      if (entry) this.selectEntry(entry);
      return;
    }

    this.updateFocus();
  }

  handleBack(): boolean {
    if (!this.groupsExpanded) return false;
    this.collapseGroups();
    return true;
  }

  private handleGroupAction(action: Action): void {
    const groups = this.getGroups();
    this.resetTimer();
    if (action === 'up' || action === 'channel_up') {
      this.groupFocusIdx = Math.max(0, this.groupFocusIdx - 1);
    } else if (action === 'down' || action === 'channel_down') {
      this.groupFocusIdx = Math.min(groups.length - 1, this.groupFocusIdx + 1);
    } else if (action === 'select') {
      const group = groups[this.groupFocusIdx];
      if (group) this.selectGroup(group.id);
      return;
    }
    this.updateFocus();
  }

  private getChannels(): SidebarEntry[] {
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
      return items.map(item => ({
        ch: item.channel,
        globalIdx: item.channelIndex,
        recent: item,
      }));
    }
    let channels = PlaylistService.getByGroup(this.group, playlist);
    const q = this.searchQuery.trim();
    if (q) channels = rankChannels(channels, q);
    return channels.map(ch => ({ ch, globalIdx: PlaylistService.indexOf(ch) }));
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
    this.channelFocusIdx = 0;
    this.setChannelScrollTop(0);
    this.updateFocus();
    this.el?.querySelector<HTMLInputElement>('.sidebar-search-input')?.blur();
    this.resetTimer();
  }

  /** Drop the hover highlight; next hover/d-pad re-shows it (see hoverCleared). */
  private clearHover(): void {
    this.el?.querySelectorAll('.focused').forEach(n => n.classList.remove('focused'));
    this.hoverCleared = true;
  }

  private updateFocus(items?: NodeListOf<HTMLElement>): void {
    this.hoverCleared = false;
    if (this.activePane === 'channels') {
      if (this.ensureFocusVisible()) {
        this.render();
        return;
      }
      if (!items) {
        if (!this.el) return;
        items = this.el.querySelectorAll<HTMLElement>('.sidebar-ch-item');
      }
      items.forEach((item) => {
        item.classList.toggle('focused',
          parseInt(item.dataset.sidebarPos || '-2', 10) === this.channelFocusIdx);
      });
      this.el?.querySelector('.sidebar-search-input')
        ?.classList.toggle('focused', this.channelFocusIdx === -1);
      this.el?.querySelectorAll('.sidebar-group-item.focused')
        .forEach(item => item.classList.remove('focused'));
    } else {
      this.el?.querySelector('.sidebar-search-input')?.classList.remove('focused');
      this.el?.querySelectorAll('.sidebar-ch-item.focused')
        .forEach(item => item.classList.remove('focused'));
      this.el?.querySelectorAll<HTMLElement>('.sidebar-group-item').forEach((item) => {
        item.classList.toggle('focused',
          parseInt(item.dataset.groupPos || '-1', 10) === this.groupFocusIdx);
      });
      this.el?.querySelector('.sidebar-group-item.focused')
        ?.scrollIntoView({ block: 'nearest' });
    }
  }

  private ensureFocusVisible(): boolean {
    if (this.channelFocusIdx < 0 || !this.el) return false;
    const list = this.el.querySelector<HTMLElement>('.sidebar-channel-list');
    const viewportHeight = list?.clientHeight || FALLBACK_LIST_HEIGHT;
    const rowTop = this.channelFocusIdx * CHANNEL_ROW_STRIDE;
    const rowBottom = rowTop + CHANNEL_ROW_STRIDE;
    let nextScrollTop = this.channelScrollTop;
    if (rowTop < nextScrollTop) {
      nextScrollTop = rowTop;
    } else if (rowBottom > nextScrollTop + viewportHeight) {
      nextScrollTop = rowBottom - viewportHeight;
    }
    nextScrollTop = Math.max(0, nextScrollTop);
    if (nextScrollTop === this.channelScrollTop) return false;
    this.setChannelScrollTop(nextScrollTop);
    return true;
  }

  private setChannelScrollTop(scrollTop: number): void {
    this.channelScrollTop = scrollTop;
    const list = this.el?.querySelector<HTMLElement>('.sidebar-channel-list');
    if (list && list.scrollTop !== scrollTop) list.scrollTop = scrollTop;
  }

  private visibleRange(total: number, viewportHeight: number): { start: number; end: number } {
    const visibleRows = Math.max(1, Math.ceil(viewportHeight / CHANNEL_ROW_STRIDE));
    const start = Math.max(0, Math.floor(this.channelScrollTop / CHANNEL_ROW_STRIDE) - CHANNEL_OVERSCAN);
    const end = Math.min(total, start + visibleRows + CHANNEL_OVERSCAN * 2);
    return { start, end };
  }

  private getGroups(): SidebarGroup[] {
    const playlist = this.playlist || undefined;
    const groups: SidebarGroup[] = [
      {
        id: 'builtin:all',
        label: t('common.all'),
        count: PlaylistService.getByGroup('builtin:all', playlist).length,
        builtin: 'all',
      },
      {
        id: 'builtin:favorites',
        label: t('channel.favorites'),
        count: PlaylistService.getByGroup('builtin:favorites', playlist).length,
        builtin: 'favorites',
      },
      {
        id: 'builtin:recently-watched',
        label: t('channel.recentlyWatched'),
        count: RecentlyWatchedService.getItems(playlist).length,
        builtin: 'recently-watched',
      },
    ];
    const channels = PlaylistService.getByGroup('builtin:all', playlist);
    const counts = new Map<string, number>();
    channels.forEach(ch => counts.set(ch.group, (counts.get(ch.group) || 0) + 1));
    PlaylistService.getGroupsForPlaylist(playlist).forEach(name => {
      groups.push({
        id: `source:${name}`,
        label: name,
        count: counts.get(name) || 0,
      });
    });
    return groups;
  }

  private focusCurrentChannel(fallbackToAll: boolean): void {
    let entries = this.getChannels();
    const currentIdx = this.getCurrentIndex();
    let position = entries.findIndex(entry => entry.globalIdx === currentIdx);
    if (position < 0 && fallbackToAll && this.group !== 'builtin:all') {
      this.group = 'builtin:all';
      entries = this.getChannels();
      position = entries.findIndex(entry => entry.globalIdx === currentIdx);
    }
    if (position < 0 && fallbackToAll && this.playlist) {
      this.playlist = '';
      entries = this.getChannels();
      position = entries.findIndex(entry => entry.globalIdx === currentIdx);
    }
    this.channelFocusIdx = position >= 0 ? position : (entries.length ? 0 : -1);
    const viewportHeight = this.el?.querySelector<HTMLElement>('.sidebar-channel-list')?.clientHeight
      || FALLBACK_LIST_HEIGHT;
    this.setChannelScrollTop(Math.max(
      0,
      this.channelFocusIdx * CHANNEL_ROW_STRIDE - (viewportHeight - CHANNEL_ROW_STRIDE) / 2,
    ));
  }

  private openGroups(): void {
    this.clearGroupDwell();
    this.groupsExpanded = true;
    this.activePane = 'groups';
    const groups = this.getGroups();
    const selected = groups.findIndex(group => group.id === this.group);
    this.groupFocusIdx = selected >= 0 ? selected : 0;
    this.syncPanelState();
    this.render();
  }

  private collapseGroups(): void {
    this.groupsExpanded = false;
    this.activePane = 'channels';
    this.syncPanelState();
    this.updateFocus();
    this.resetTimer();
  }

  private selectGroup(group: ChannelGroupId): void {
    this.group = group;
    this.searchQuery = '';
    this.activePane = 'channels';
    this.focusCurrentChannel(false);
    this.render();
    this.resetTimer();
  }

  private syncPanelState(): void {
    this.el?.classList.toggle('groups-expanded', this.groupsExpanded);
    this.el?.classList.toggle('channels-only', !this.groupsExpanded);
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

  private render(measureMarquees = true): void {
    const el = this.el;
    if (!el) return;

    const scrolling = measureMarquees
      ? []
      : Array.from(el.querySelectorAll<HTMLElement>('.ch-name-text.scrolling, .ch-now-text.scrolling'))
        .map(span => ({ span, dist: span.style.getPropertyValue('--scroll-dist') }));
    const tabs = PlaylistService.playlistTabs;
    if (this.playlist && !tabs.some(t => t.id === this.playlist)) this.playlist = '';
    const showTabs = tabs.length > 1;
    const groups = this.getGroups();
    if (!groups.some(item => item.id === this.group)) {
      this.group = 'builtin:all';
      this.groupFocusIdx = 0;
    }
    const entries = this.getChannels();
    const previousList = el.querySelector<HTMLElement>('.sidebar-channel-list');
    if (previousList) this.channelScrollTop = previousList.scrollTop;
    const viewportHeight = previousList?.clientHeight || FALLBACK_LIST_HEIGHT;
    const range = this.visibleRange(entries.length, viewportHeight);
    const visibleEntries = entries.slice(range.start, range.end);
    const currentIdx = this.getCurrentIndex();
    const currentCatchupStart = this.getCurrentCatchupStart();
    const currentTab = tabs.find(t => t.id === this.playlist);
    const activeGroup = groups.find(item => item.id === this.group) || groups[0];
    const searchPlaceholder = currentTab
      ? t('search.sidebarPlaylist', { name: currentTab.name })
      : t('search.sidebarAll');

    morph(el, html`
      <div class="sidebar-group-panel" data-key="group-panel">
        <div class="sidebar-title">${t('common.groups')}</div>
        <div class="sidebar-group-list">
          ${groups.map((item, i) => html`
            <div class="sidebar-group-item ${item.id === this.group ? 'active' : ''}
                        ${this.activePane === 'groups' && i === this.groupFocusIdx ? 'focused' : ''}"
                 data-key="group:${item.id}" data-group-id="${item.id}" data-group-pos="${i}">
              <span class="sidebar-group-icon">${raw(groupIcon(item.label, item.builtin))}</span>
              <span class="sidebar-group-name">${item.label}</span>
              <span class="sidebar-group-count">${item.count}</span>
            </div>
          `)}
        </div>
      </div>
      <div class="sidebar-channel-panel" data-key="channel-panel">
        <button type="button" class="sidebar-title sidebar-channel-title" data-open-groups>
          <span class="sidebar-picker-label">${activeGroup?.label || t('common.channels')}</span>
          <span class="sidebar-picker-arrow" aria-hidden="true">
            ${raw(CHEVRON_LEFT_ICON)}
          </span>
        </button>
        <input type="text"
               class="sidebar-search-input ${this.activePane === 'channels' && this.channelFocusIdx === -1 ? 'focused' : ''}"
               data-key="search" aria-label="${t('search.ariaChannels')}"
               placeholder="${searchPlaceholder}" value="${this.searchQuery}">
        ${showTabs ? html`
          <div class="sidebar-tabs">
            <div class="sidebar-tab ${!this.playlist ? 'active' : ''}"
                 data-key="tab:"
                 data-sidebar-playlist="">${t('common.all')}</div>
            ${tabs.map(tab => html`
              <div class="sidebar-tab ${tab.id === this.playlist ? 'active' : ''}"
                   data-key="tab:${tab.id}"
                   data-sidebar-playlist="${tab.id}">${tab.name}</div>
            `)}
          </div>
        ` : ''}
        <div class="sidebar-channel-list" data-key="channel-list">
          <div class="sidebar-channel-spacer" data-key="channel-spacer"
               style="height:${entries.length * CHANNEL_ROW_STRIDE}px">
          ${visibleEntries.map(({ ch, globalIdx, recent }, offset) => {
            const i = range.start + offset;
            const epgId = EpgService.findChannelId(ch);
            const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
            const isFocused = this.activePane === 'channels' && i === this.channelFocusIdx;
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
              <div class="sidebar-ch-item ${isPlaying ? 'playing' : ''} ${isFocused ? 'focused' : ''}"
                   data-key="${catchup
                     ? `recent:catchup:${String(globalIdx)}:${String(catchup.progress.progStart)}`
                     : `ch:${String(globalIdx)}`}"
                   data-focusable data-sidebar-index="${globalIdx}" data-sidebar-pos="${i}"
                   style="top:${i * CHANNEL_ROW_STRIDE}px">
                <span class="ch-num">${globalIdx + 1}</span>
                ${this.renderLogo(ch)}
                <div class="ch-info">
                  <span class="ch-name"><span class="ch-name-text">${title}</span></span>
                  ${subtitle ? html`<span class="ch-now"><span class="ch-now-text">${subtitle}</span></span>` : ''}
                </div>
                ${catchup ? html`<span class="sidebar-recent-kind">${t('common.catchup')}</span>` : ''}
              </div>
            `;
          })}
          </div>
        </div>
      </div>
    `);

    const list = el.querySelector<HTMLElement>('.sidebar-channel-list');
    if (list && list.scrollTop !== this.channelScrollTop) list.scrollTop = this.channelScrollTop;
    const search = el.querySelector<HTMLInputElement>('.sidebar-search-input');
    if (search && search.value !== this.searchQuery) search.value = this.searchQuery;

    scrolling.forEach(({ span, dist }) => {
      if (!el.contains(span)) return;
      span.style.setProperty('--scroll-dist', dist);
      span.classList.add('scrolling');
    });
    if (!this.opening && measureMarquees) this.measureMarquees();
  }

  private renderLogo(ch: Channel): Safe {
    let logo: Safe | string = '';
    if (!ch.logo) {
      logo = html`<div class="ch-logo-placeholder">${ch.name.charAt(0)}</div>`;
    } else if (!this.failedLogos.has(ch.logo)) {
      logo = html`<img class="ch-logo" src="${ch.logo}" alt="" loading="lazy">`;
    }

    return html`<div class="ch-logo-wrap">${logo}</div>`;
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
      if (e.target !== el || e.propertyName !== 'transform' || !this.isVisible || !this.opening) return;
      this.opening = false;
      if (this.pointerAtGroupEdge) this.startGroupDwell();
      this.measureMarquees();
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
      this.activePane = 'channels';
      this.channelFocusIdx = -1;
      this.setChannelScrollTop(0);
      this.render();
      this.resetTimer();
    });

    // Desktop fallback for the keyboard signal: the input's focus.
    el.addEventListener('focusin', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('sidebar-search-input')) return;
      this.setKeyboardVisible(true);
    });
    el.addEventListener('focusout', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('sidebar-search-input')) return;
      this.setKeyboardVisible(false);
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
        if (this.groupsExpanded) this.collapseGroups();
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
        this.playlist = tab.dataset.sidebarPlaylist!;
        this.group = 'builtin:all';
        this.searchQuery = '';
        this.focusCurrentChannel(false);
        this.render();
        this.resetTimer();
        return;
      }
      const chItem = target.closest<HTMLElement>('[data-sidebar-index]');
      if (chItem) {
        const position = parseInt(chItem.dataset.sidebarPos!, 10);
        const entry = this.getChannels()[position];
        if (entry) this.selectEntry(entry);
      }
    });

    // Hover moves the highlight within the pane under the pointer.
    el.addEventListener('mouseover', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const groupItem = target.closest<HTMLElement>('[data-group-pos]');
      if (groupItem) {
        const pos = parseInt(groupItem.dataset.groupPos!, 10);
        if (this.activePane !== 'groups' || pos !== this.groupFocusIdx || this.hoverCleared) {
          this.activePane = 'groups';
          this.groupFocusIdx = pos;
          this.updateFocus();
        }
        this.resetTimer();
        return;
      }
      const item = target.closest<HTMLElement>('[data-sidebar-pos]');
      const pos = item
        ? parseInt(item.dataset.sidebarPos!, 10)
        : (target.closest('.sidebar-search-input') ? -1 : null);
      if (pos === null) return;
      if (this.activePane !== 'channels' || pos !== this.channelFocusIdx || this.hoverCleared) {
        this.activePane = 'channels';
        this.channelFocusIdx = pos;
        this.updateFocus();
      }
      this.resetTimer();
    });

    // Cursor left the sidebar: drop the hover highlight. Focus is kept so a
    // later d-pad press or hover re-shows it.
    el.addEventListener('mouseleave', () => this.clearHover());

    el.addEventListener('scroll', (e: Event) => {
      const list = e.target as HTMLElement;
      if (!list.classList.contains('sidebar-channel-list')) return;
      this.channelScrollTop = list.scrollTop;
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        if (this.isVisible) this.render(false);
      });
    }, true);

    // Scroll wheel moves focus within the pane under the pointer.
    el.addEventListener('wheel', (e: WheelEvent) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest('.sidebar-group-panel')) {
        const len = this.getGroups().length;
        this.activePane = 'groups';
        if (e.deltaY < 0) this.groupFocusIdx = Math.max(0, this.groupFocusIdx - 1);
        else if (e.deltaY > 0) this.groupFocusIdx = Math.min(len - 1, this.groupFocusIdx + 1);
      } else {
        const len = this.getChannels().length;
        this.activePane = 'channels';
        if (e.deltaY < 0) this.channelFocusIdx = Math.max(0, this.channelFocusIdx - 1);
        else if (e.deltaY > 0) {
          this.channelFocusIdx = Math.min(len - 1, this.channelFocusIdx + 1);
        }
      }
      this.updateFocus();
      this.resetTimer();
    }, { passive: false });
  }

  private selectEntry(entry: SidebarEntry): void {
    if (entry.recent?.kind === 'catchup') {
      void this.playRecentCatchup(entry.recent);
      return;
    }
    this.onSelectChannel(entry.globalIdx);
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
    this.onSelectChannel(item.channelIndex, catchup);
    this.hide();
  }
}
