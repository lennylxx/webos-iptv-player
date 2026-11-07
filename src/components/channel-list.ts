import type {
  Action,
  BuiltinChannelGroup,
  CatchupInfo,
  Channel,
  ChannelGroupId,
  ChannelHealthStatus,
  ChannelScope,
  NumberEvent,
} from '../types';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { KeyHandler } from '../navigation/key-handler';
import { InputMode } from '../navigation/input-mode';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelKey, groupDisplayLabel } from '../utils/channel';
import { formatPosition } from '../utils/time';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { RecentlyWatchedService, type RecentlyWatchedItem } from '../services/recently-watched';
import { ChannelHealthService } from '../services/channel-health';
import { groupIcon } from './group-icon';
import { NAV_HORIZONTAL_ICON, favoriteIcon } from './icons';
import { backKey, okHint } from './key-hints';
import { channelLockBadge, liveGroupLockBadge } from './parental-badge';
import { showToast } from './toast';
import { getLocale, t, tp, type SupportedLocale } from '../i18n';
import { ChannelListEditor } from './channel-list-editor';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { CONFIG } from '../config';

// Row strides mirror the fixed row geometry in css/channel-list.css:
// .channel-item is 88px, .group-item is 60px plus its 8px vertical margin.
const CHANNEL_ROW_STRIDE = 88;
const GROUP_ROW_STRIDE = 68;
const CHANNEL_OVERSCAN = 12;
const CHANNEL_VIEWPORT_FALLBACK = 900;

type PreviewHintState = 'off' | 'ready' | 'active';
type RowList = 'group' | 'channel';
// 'render': a re-render that requests no focus of its own.
type SyncVia = Via | 'render';

let liveList: ChannelList | null = null;
type ChannelSelectionMode = 'expand-current' | 'fullscreen';

export interface ChannelListOptions {
  onChannelSelect: (
    index: number,
    catchup?: CatchupInfo,
    scope?: ChannelScope,
    mode?: ChannelSelectionMode,
  ) => void;
  onChannelsChanged?: () => void;
  onEpgMappingChanged?: () => void;
  onEpgOffsetChanged?: () => void;
  onEnterPreview?: () => boolean;
  onListFocus?: () => void;
  getPreviewHintState?: () => PreviewHintState;
  onEnterManagement?: () => void;
  authorizeEdit?: (proceed: () => void) => void;
}

export class ChannelList {
  private container: HTMLElement;
  private onChannelSelect: (
    index: number,
    catchup?: CatchupInfo,
    scope?: ChannelScope,
    mode?: ChannelSelectionMode,
  ) => void;
  private onChannelsChanged: () => void;
  private onEnterPreview: () => boolean;
  private onListFocus: () => void;
  private getPreviewHintState: () => PreviewHintState;
  private nav: SpatialNav;
  private editor: ChannelListEditor;
  private currentGroup: ChannelGroupId = 'builtin:all';
  private currentPlaylist = '';  // '' = All playlists
  private playingIndex = -1;
  private previewFocused = false;
  private playingCatchupStart: number | null = null;
  private recentItems: RecentlyWatchedItem[] = [];
  private footerReturnRow: string | null = null;
  private failedLogos = new Set<string>();
  private readonly channelVirtualizer = new VirtualList({
    itemSize: CHANNEL_ROW_STRIDE,
    overscan: CHANNEL_OVERSCAN,
    fallbackViewportSize: CHANNEL_VIEWPORT_FALLBACK,
  });
  private readonly groupVirtualizer = new VirtualList({
    itemSize: GROUP_ROW_STRIDE,
    overscan: CHANNEL_OVERSCAN,
    fallbackViewportSize: CHANNEL_VIEWPORT_FALLBACK,
  });
  private scrollFrame: number | null = null;
  private groupScrollFrame: number | null = null;
  // A channel tuned from outside the list since it was last entered.
  private playingMoved = false;
  // The list's own key while a live-preview control holds the scope's.
  private listKey: string | null = null;
  // The focusable the pointer rests on, from the last hover.
  private hovered: HTMLElement | null = null;
  // The pointer left the focused row, or the preview took the ring.
  private ringHidden = false;
  // How the nav's last focus was asked for, so only a hover reaches the scope as one.
  private navVia: 'key' | 'pointer' = 'key';
  // A Recently Watched row the list itself re-rendered or re-entered.
  private recentToReveal: string | null = null;
  readonly focusScope: FocusScope;
  private channelScrollbarVisible = false;
  private channelScrollbarTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scrollGuard = new VirtualScrollGuard();
  private groupEntries: { id: ChannelGroupId; label: string; builtin?: BuiltinChannelGroup }[] = [];
  private groupEntriesChannels: Channel[] | null = null;
  private groupEntriesPlaylist = '';
  private groupEntriesRevision = -1;
  private groupEntriesLocale: SupportedLocale | null = null;

  private authorizeEdit: (proceed: () => void) => void;
  constructor(
    container: HTMLElement,
    options: ChannelListOptions,
  ) {
    const {
      onChannelSelect,
      onChannelsChanged = () => {},
      onEpgMappingChanged = () => {},
      onEpgOffsetChanged = () => {},
      onEnterPreview = () => false,
      onListFocus = () => {},
      getPreviewHintState = () => 'off',
      onEnterManagement = () => {},
      authorizeEdit = proceed => proceed(),
    } = options;
    this.authorizeEdit = authorizeEdit;
    this.container = container;
    this.onChannelSelect = onChannelSelect;
    this.onChannelsChanged = onChannelsChanged;
    this.onEnterPreview = onEnterPreview;
    this.onListFocus = onListFocus;
    this.getPreviewHintState = getPreviewHintState;
    // One list per app; a new instance takes the id over.
    liveList?.dispose();
    liveList = this;
    this.focusScope = Focus.register({
      id: 'live.channels',
      root: () => this.container.closest<HTMLElement>('.view') ?? this.container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.defaultKey(),
      has: (key) => this.rowPosition(key) !== null,
      reveal: (key) => this.reveal(key),
      enterTo: (via) => {
        this.prepareEntry(via);
        return 'last';
      },
      onRelease: () => this.editor.blurTextInput(),
      onAcquire: () => {
        this.editor.focusTextInput();
        // A hover that landed while another scope held the keys lights now.
        if (InputMode.current === 'pointer' && this.hovered && this.hovered === this.nav.focused) {
          this.syncScope('pointer');
        }
      },
    });
    this.nav = new SpatialNav(container, (el) => {
      this.editor?.trackFocus(el);
      if (!el?.closest('.edit-hints')) this.footerReturnRow = null;
      if (el) this.onListFocus();
      const via = this.navVia;
      this.navVia = 'key';
      this.syncScope(via);
    }, {
      onRequest: (_el, via) => {
        this.ringHidden = false;
        this.navVia = via;
      },
    });
    this.container.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      this.hovered = target.hasAttribute('data-focusable') ? target : null;
      this.onListFocus();
    });
    // The pointer leaving the focused row hides its ring until the next key.
    this.container.addEventListener('nav:unhover', (e: Event) => {
      if (e.target === this.hovered) this.hovered = null;
      if (e.target === this.nav.focused) this.ringHidden = true;
      this.syncScope('pointer');
    });
    this.container.addEventListener('click', () => this.onListFocus(), true);
    this.editor = new ChannelListEditor(container, this.nav, {
      render: () => this.render(),
      stepChannelList: (action) => this.stepChannelList(action),
      onEnterManagement,
      onChannelsChanged: () => this.onChannelsChanged(),
      onEpgMappingChanged,
      onEpgOffsetChanged,
      getCurrentGroup: () => this.currentGroup,
      getCurrentPlaylist: () => this.currentPlaylist,
      requestEditMode: group => this.enterEditMode(group),
      rowPosition: key => this.rowPosition(key)?.position ?? -1,
      setLocation: (group, playlist) => {
        this.currentGroup = group;
        this.currentPlaylist = playlist;
      },
    });

    // Activate the item under the pointer by coordinate hit-test, so a click plays
    // the channel (or switches group/playlist) regardless of what holds D-pad focus
    // — the global click path would instead route select to the focused tab bar
    // (swallowed while the search box is open). The container is marked
    // `data-self-activate` so that global handler skips this subtree.
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (this.editor.consumePointerClick()) return;
      this.onPointerRelease(e.clientX, e.clientY);
    });
    this.container.addEventListener('error', (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLImageElement)
          || !target.classList.contains('channel-logo')) return;
      const src = target.getAttribute('src');
      if (src && !this.failedLogos.has(src)) {
        this.failedLogos.add(src);
        this.render(false);
      }
    }, true);
    this.container.addEventListener('scroll', (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('group-list')) {
        const offset = this.scrollGuard.readUserOffset(target, 'vertical');
        if (offset === null) return;
        this.groupVirtualizer.setScrollOffset(offset);
        if (this.groupScrollFrame !== null) return;
        this.groupScrollFrame = requestAnimationFrame(() => {
          this.groupScrollFrame = null;
          // A smooth scroll keeps moving after the event; render at where it is now.
          this.groupVirtualizer.setScrollOffset(target.scrollTop);
          this.render(false);
        });
        return;
      }
      if (!target.classList.contains('channel-main')) return;
      this.showChannelScrollbar(target);
      if (this.currentGroup === 'builtin:recently-watched') return;
      const offset = this.scrollGuard.readUserOffset(target, 'vertical');
      if (offset === null) return;
      this.channelVirtualizer.setScrollOffset(offset);
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.channelVirtualizer.setScrollOffset(target.scrollTop);
        this.render(false);
      });
    }, true);
  }

  private onPointerRelease(x: number, y: number): void {
    const el = this.focusableAt(x, y);
    if (!el || !this.container.contains(el)) return;
    this.nav.focus(el);
    this.handleAction('select');
  }

  private focusableAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    return el && this.container.contains(el) ? el : null;
  }

  // The view a channel launched from here — including Recently Watched,
  // which PlaylistService.getByGroup already treats as the full list, same
  // as no scope at all.
  private currentScope(): ChannelScope {
    return { group: this.currentGroup, playlist: this.currentPlaylist || undefined };
  }

  render(ensureFocus = true): void {
    const tabs = PlaylistService.playlistTabs;
    // The selected playlist may have just been deleted in settings — fall back to All.
    if (this.currentPlaylist && !tabs.some(t => t.id === this.currentPlaylist)) this.currentPlaylist = '';
    const showTabs = tabs.length > 1;
    const groups = this.getGroupEntries();
    if (!groups.some(group => group.id === this.currentGroup)) this.currentGroup = 'builtin:all';
    if (ensureFocus || this.recentItems.length === 0) {
      this.recentItems = RecentlyWatchedService.getItems(this.currentPlaylist || undefined);
    }
    const showingRecent = this.currentGroup === 'builtin:recently-watched';
    const filteredChannels = PlaylistService.getByGroup(this.currentGroup, this.currentPlaylist || undefined);
    const totalChannels = PlaylistService.getGroupCount(
      'builtin:all',
      this.currentPlaylist || undefined,
    );
    const favs = StorageService.getFavorites();
    const editing = this.editor.isChannelEditing;
    const managingFavorites = this.editor.isManagingFavorites;
    const allSourcesDisabled = PlaylistService.allSourcesDisabled;

    // Capture the focus key before morph so focus lands on the same item
    // after it. Focus a re-render already detached waits for the next key.
    const attached = this.nav.focused && this.container.contains(this.nav.focused)
      ? this.nav.focused : null;
    const prevFocusedKey = attached?.getAttribute('data-key') ?? null;
    const wantedKey = this.editor.takeRefocusKey(prevFocusedKey);
    const previousMain = this.container.querySelector<HTMLElement>('.channel-main');
    const previousGroupList = this.container.querySelector<HTMLElement>('.group-list');
    const wasShowingRecent = previousMain
      ?.querySelector('.channel-list-scroll')
      ?.classList.contains('recent-list') ?? false;
    if (showingRecent && !wasShowingRecent && previousMain) {
      previousMain.scrollTop = 0;
    } else if (!showingRecent && ensureFocus && previousMain) {
      this.channelVirtualizer.setScrollOffset(previousMain.scrollTop);
    }
    if (previousGroupList) this.groupVirtualizer.setScrollOffset(previousGroupList.scrollTop);
    const viewportHeight = previousMain?.clientHeight || CHANNEL_VIEWPORT_FALLBACK;
    let wantedPosition = filteredChannels.findIndex(
      ch => `ch:${String(PlaylistService.indexOf(ch))}` === wantedKey,
    );
    if (!showingRecent && ensureFocus && wantedPosition >= 0) {
      this.channelVirtualizer.ensureVisible(wantedPosition, viewportHeight);
    } else if (!showingRecent && ensureFocus && !wantedKey && !this.detachedKey()
        && this.playingIndex >= 0) {
      wantedPosition = filteredChannels.findIndex(
        ch => PlaylistService.indexOf(ch) === this.playingIndex,
      );
      if (wantedPosition >= 0) this.channelVirtualizer.centerOn(wantedPosition, viewportHeight);
    }
    const range = this.channelVirtualizer.getRange(filteredChannels.length, viewportHeight);
    const groupViewportHeight = previousGroupList?.clientHeight || CHANNEL_VIEWPORT_FALLBACK;
    const wantedGroupPosition = wantedKey && wantedKey.indexOf('g:') === 0
      ? groups.findIndex(group => `g:${group.id}` === wantedKey)
      : -1;
    const focusedGroupPosition = wantedGroupPosition >= 0 ? wantedGroupPosition : parseInt(
      attached?.dataset.groupPosition ?? '-1',
      10,
    );
    if (ensureFocus && focusedGroupPosition >= 0) {
      this.groupVirtualizer.ensureVisible(focusedGroupPosition, groupViewportHeight);
    }
    const groupRange = this.groupVirtualizer.getRange(groups.length, groupViewportHeight);

    morph(this.container, html`
      <div class="channel-view ${editing && !managingFavorites ? 'editing' : ''} ${
        managingFavorites ? 'favorite-managing' : ''} ${
        !editing && this.currentGroup === 'builtin:favorites'
          && (managingFavorites || filteredChannels.length)
          ? 'has-channel-hints'
          : ''}">
        <div class="sidebar" data-nav-container>
          <div class="sidebar-header">
            <div class="channel-count">${tp('channel.count', totalChannels)}</div>
            ${editing || showingRecent
              ? html`<div class="channel-edit-btn-spacer" aria-hidden="true"></div>`
              : html`
                <button class="channel-edit-btn"
                        data-key="edit-channels"
                        data-focusable data-edit-channels
                        aria-label="${t('settings.editChannelList')}"
                        title="${t('settings.editChannelList')}"><img src="assets/icons/pencil.svg" alt=""></button>
              `}
          </div>
          ${showTabs ? html`
            <div class="playlist-tabs" data-edge-scroll>
              <div class="playlist-tab ${!this.currentPlaylist ? 'active' : ''}"
                   data-key="tab:"
                   data-focusable data-playlist="">${t('common.all')}</div>
              ${tabs.map(t => html`
                <div class="playlist-tab ${t.id === this.currentPlaylist ? 'active' : ''}"
                     data-key="tab:${t.id}"
                     data-focusable data-playlist="${t.id}">${t.name}</div>
              `)}
            </div>
          ` : ''}
          <div class="group-list">
            <div class="group-list-spacer"
                 style="height:${this.groupVirtualizer.getTotalSize(groups.length)}px">
              ${groups.slice(groupRange.start, groupRange.end).map((g, offset) =>
                this.renderGroup(
                  g,
                  groupRange.start + offset,
                  this.groupVirtualizer.getItemOffset(groupRange.start + offset),
                ))}
            </div>
          </div>
        </div>
        <div class="channel-main" data-nav-container data-nav-enter="last-focused">
          <div class="channel-list-scroll ${showingRecent ? 'recent-list' : ''}">
            ${showingRecent
              ? (this.recentItems.length
                  ? this.recentItems.map((item, index) =>
                    this.renderRecentItem(item, index, favs))
                  : html`<div class="empty-state">${t('channel.recentEmpty')}</div>`)
              : (filteredChannels.length
                  ? html`
                    <div class="channel-list-spacer" data-key="channel-list-spacer"
                         style="height:${this.channelVirtualizer.getTotalSize(filteredChannels.length)}px">
                      ${filteredChannels.slice(range.start, range.end)
                        .map((ch, offset) => this.renderChannel(
                          ch,
                          favs,
                          range.start + offset,
                          this.channelVirtualizer.getItemOffset(range.start + offset),
                        ))}
                    </div>
                  `
                  : html`<div class="empty-state">${
                    t(allSourcesDisabled ? 'channel.noEnabledSources' : 'channel.empty')
                  }</div>`)}
          </div>
        </div>
        <div class="channel-scroll-indicator ${
          this.channelScrollbarVisible ? 'visible' : ''
        }" data-key="channel-scroll-indicator" aria-hidden="true">
          <div class="channel-scroll-thumb"></div>
        </div>
        ${this.editor.renderFooter(
          this.currentGroup === 'builtin:favorites' && filteredChannels.length > 0,
        ) || this.renderPreviewHints()}
        ${this.editor.renderGroupPicker()}
      </div>
    `);
    this.editor.syncEpgPickerScroll();

    // Restore focus on the reused node (or fall back to a sensible default).
    let target: HTMLElement | null = null;
    target = this.editor.focusGroupPicker();
    if (!target && wantedKey) {
      target = this.container.querySelector<HTMLElement>(
        `[data-key="${attrSelectorEscape(wantedKey)}"]`,
      );
    }
    let playingChannel: HTMLElement | null = null;
    // A detached focus waits for the next key to resume near where the list was scrolled.
    if (!target && ensureFocus && !this.detachedKey()) {
      playingChannel = this.playingIndex >= 0
        ? this.container.querySelector<HTMLElement>(`.channel-main [data-channel-index="${this.playingIndex}"]`)
        : null;
      // Default focus: the first channel (an empty list falls through to the
      // first focusable — a group or playlist tab — below).
      const target0 = this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]');
      target = playingChannel ?? target0;
      if (!target) this.nav.focusFirst();
    }
    if (target) this.nav.focus(target);
    const main = this.container.querySelector<HTMLElement>('.channel-main');
    if (main && !showingRecent) {
      this.scrollGuard.syncOffset(main, 'vertical', this.channelVirtualizer.scrollOffset);
    }
    if (main) this.updateChannelScrollbar(main);
    const groupList = this.container.querySelector<HTMLElement>('.group-list');
    if (groupList) {
      this.scrollGuard.syncOffset(groupList, 'vertical', this.groupVirtualizer.scrollOffset);
    }

    // An inline rename / new-group field owns the keyboard while it is open.
    if (Focus.owner() === this.focusScope) this.editor.focusTextInput();
    if (this.previewFocused) this.ringHidden = true;
    if (ensureFocus && showingRecent) this.recentToReveal = this.nav.focused?.dataset.key ?? null;
    this.syncScope(ensureFocus ? 'key' : 'render');
  }

  private showChannelScrollbar(main: HTMLElement): void {
    if (!this.container.closest('.has-live-preview')) return;
    this.channelScrollbarVisible = true;
    this.updateChannelScrollbar(main);
    this.container.querySelector('.channel-scroll-indicator')?.classList.add('visible');
    if (this.channelScrollbarTimer !== null) clearTimeout(this.channelScrollbarTimer);
    this.channelScrollbarTimer = setTimeout(() => {
      this.channelScrollbarTimer = null;
      this.channelScrollbarVisible = false;
      this.container.querySelector('.channel-scroll-indicator')?.classList.remove('visible');
    }, CONFIG.CHANNEL_SCROLLBAR_HIDE_MS);
  }

  private updateChannelScrollbar(main: HTMLElement): void {
    const indicator = this.container.querySelector<HTMLElement>('.channel-scroll-indicator');
    const thumb = indicator?.querySelector<HTMLElement>('.channel-scroll-thumb');
    if (!indicator || !thumb) return;
    const viewport = main.clientHeight;
    const content = main.scrollHeight;
    const track = indicator.clientHeight;
    if (viewport <= 0 || track <= 0 || content <= viewport) {
      indicator.classList.remove('visible');
      return;
    }
    const height = Math.max(48, Math.min(track, track * viewport / content));
    const offset = (track - height) * main.scrollTop / (content - viewport);
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${Math.max(0, Math.min(track - height, offset))}px)`;
  }

  // `key` names the preview control that takes the ring.
  setPreviewFocused(focused: boolean, key?: string): void {
    this.previewFocused = focused;
    if (focused) this.ringHidden = true;
    if (focused && key) this.setScopeKey(key, 'pointer');
    else this.syncScope();
  }

  restoreFocus(): void {
    this.previewFocused = false;
    if (this.resumeScrolledAway()) return;
    if (this.nav.focused && this.container.contains(this.nav.focused)) {
      this.nav.focus(this.nav.focused);
      this.syncScope('key');
    } else {
      this.highlightEntryPoint();
    }
  }

  // Mirror SpatialNav's focus into the scope, which paints and gates the ring.
  private syncScope(via: SyncVia = 'key'): void {
    if (this.previewFocused) return;
    const el = this.nav.focused;
    const key = el && this.container.contains(el) ? el.dataset.key ?? null : null;
    if (key) this.listKey = key;
    if (this.ringHidden) {
      if (key) this.focusScope.track(key);
      this.focusScope.conceal();
      return;
    }
    // A row scrolled out of the rendered window keeps its key.
    if (key) this.setScopeKey(key, via);
  }

  // After the pointer left, the first key only shows where focus is, so the
  // list doesn't run on from a row the user could not see.
  private revealRing(): boolean {
    const el = this.nav.focused;
    if (!this.ringHidden || !el || !this.nav.navigable(el)) return false;
    this.nav.focus(el);
    this.syncScope('key');
    return true;
  }

  // Only the owner of the keys may reveal; off the keys a pointer pick still
  // lights where the pointer rests, and any other follows without a ring.
  private setScopeKey(key: string, via: SyncVia): void {
    const owner = Focus.owner() === this.focusScope;
    // A re-render asks for nothing: the owner keeps its key unrevealed.
    // It drops a pending reveal too; in keys mode the input's pass reveals anyway.
    if (via === 'render') {
      if (owner) this.focusScope.focus(key, 'pointer');
      else this.focusScope.track(key);
    } else if (via === 'pointer' || owner) {
      this.focusScope.focus(key, via);
    } else {
      this.focusScope.track(key);
    }
  }

  // Release the scope id and the listeners kept outside the container.
  dispose(): void {
    if (liveList === this) liveList = null;
    this.focusScope.dispose();
    this.editor.dispose();
  }

  get isEditing(): boolean {
    return this.editor.isEditing;
  }

  private renderPreviewHints(): Safe | string {
    const state = this.getPreviewHintState();
    if (state === 'off') return '';
    return html`
      <div class="edit-hints preview-list-hints">
        <div class="preview-list-context">
          ${okHint(t('preview.open'), { 'data-preview-list-open': '' })}
          ${state === 'active' ? html`
            <span class="edit-hint" data-preview-list-controls>
              ${raw(NAV_HORIZONTAL_ICON)}
              <span>${t('preview.controls')}</span>
            </span>` : ''}
        </div>
        ${state === 'active' ? html`
          <span class="edit-hint preview-list-close" data-preview-list-close>
            ${backKey()}
            <span>${t('common.close')}</span>
          </span>` : ''}
      </div>
    `;
  }

  enterEditMode(group: ChannelGroupId = this.currentGroup): void {
    this.authorizeEdit(() => this.editor.enterEditMode(group));
  }

  exitEditMode(): void {
    this.editor.exitEditMode();
  }

  /** Back inside the channel list: close what is open, else let the view handle it. */
  handleBack(): boolean {
    return this.editor.handleBack();
  }

  handleAction(action: Action, event?: NumberEvent): boolean {
    const handled = this.dispatchAction(action, event);
    this.syncScope('key');
    return handled;
  }

  private dispatchAction(action: Action, event?: NumberEvent): boolean {
    // Before the editor too: it applies these to whichever row holds focus.
    // Up also precedes the row-0 hand-off to the tab bar; Down would move a grabbed row.
    const resumeFirst = action === 'select' || action === 'left' || action === 'right'
      || action === 'up' || (action === 'green' && !this.editor.isEditing)
      || (action === 'down' && this.editor.hasGrabbed);
    if (resumeFirst && !this.editor.ownsInput && this.resumeScrolledAway()
        && action !== 'left' && action !== 'right') {
      return true;
    }
    if (isFocusMove(action, true) && !this.editor.ownsInput) {
      // The preview controls hold the ring, and a wheel step scrolls: both move
      // the list directly.
      if (this.previewFocused || KeyHandler.isWheelAction()) this.ringHidden = false;
      if (!this.previewFocused && (this.resumeScrolledAway() || this.revealRing())) {
        // A row scrolled away resumes in view instead of being scrolled back to.
        return true;
      }
    }
    if (this.editor.handleAction(action)) return true;
    if (action === 'up' && this.nav.focused?.dataset.listPosition === '0') return false;
    if (this.handleRegionNavigation(action)) return true;

    switch (action) {
      case 'up':
      case 'down':
        if (this.stepChannelList(action)) return true;
        // Above the sidebar's top sits the tab bar, never the channel list.
        if (action === 'up' && this.nav.focused?.closest('.sidebar')) {
          const edit = this.container.querySelector<HTMLElement>('[data-edit-channels]');
          if (!edit || edit === this.nav.focused) return false;
          this.nav.focus(edit);
          return true;
        }
        return this.nav.move(action);
      case 'left':
        return this.nav.move(action);
      case 'right':
        if (this.nav.focused?.closest('.channel-main') && this.onEnterPreview()) return true;
        return this.nav.move(action);

      case 'channel_up':
        if (!this.stepChannelList(action)) this.nav.move('up');
        break;

      case 'channel_down':
        if (!this.stepChannelList(action)) this.nav.move('down');
        break;

      case 'select': {
        const focused = this.nav.focused;
        // A row a re-render removed is no longer what the list shows.
        if (!focused || !this.container.contains(focused)) break;

        if (focused.dataset.editChannels !== undefined) {
          this.enterEditMode();
        } else if (focused.dataset.favoriteManage !== undefined) {
          this.editor.enterFavoriteManagement();
        } else if (focused.dataset.playlist !== undefined) {
          this.currentPlaylist = focused.dataset.playlist;
          this.currentGroup = 'builtin:all';
          this.render();
        } else if (focused.dataset.group !== undefined) {
          this.currentGroup = focused.dataset.group as ChannelGroupId;
          this.render();
        } else if (focused.dataset.recentIndex !== undefined) {
          const item = this.recentItems[parseInt(focused.dataset.recentIndex, 10)];
          if (item?.kind === 'live') {
            this.markPlaying(item.channelIndex);
            this.onChannelSelect(
              item.channelIndex,
              undefined,
              this.currentScope(),
              'expand-current',
            );
          } else if (item) {
            void this.playRecentCatchup(item);
          }
        } else if (focused.dataset.channelIndex !== undefined) {
          const idx = parseInt(focused.dataset.channelIndex, 10);
          this.markPlaying(idx);
          this.onChannelSelect(idx, undefined, this.currentScope(), 'expand-current');
        }
        break;
      }

      case 'green': {
        if (this.nav.focused && this.container.contains(this.nav.focused)) {
          this.editor.toggleFocusedFavorite();
        }
        break;
      }

      case 'yellow':
        if (this.currentGroup !== 'builtin:recently-watched') this.enterEditMode();
        break;

      case 'number': {
        if (!event) break;
        const num = event.number - 1;
        if (num >= 0 && num < PlaylistService.channels.length) {
          this.markPlaying(num);
          this.revealChannel(num); // may widen currentGroup — read scope after
          this.onChannelSelect(num, undefined, this.currentScope(), 'fullscreen');
        }
        break;
      }
    }
    return false;
  }

  private handleRegionNavigation(action: Action): boolean {
    const focused = this.nav.focused;
    if (!focused) return false;

    if (focused.dataset.playlist !== undefined) {
      const tabs = Array.from(
        this.container.querySelectorAll<HTMLElement>('.playlist-tab[data-playlist]'),
      );
      const index = tabs.indexOf(focused);
      if (action === 'left' || action === 'right') {
        const next = index + (action === 'left' ? -1 : 1);
        if (tabs[next]) this.nav.focus(tabs[next]);
        return true;
      }
      if (action === 'up') {
        const edit = this.container.querySelector<HTMLElement>('[data-edit-channels]');
        if (edit) this.nav.focus(edit);
        return !!edit;
      }
      if (action === 'down') return this.focusActiveGroup();
      return false;
    }

    if (action === 'down' && focused.dataset.editChannels !== undefined) {
      return this.focusActivePlaylist() || this.focusFirstChannel();
    }

    if (action === 'left' && focused.closest('.channel-main')) {
      return this.focusActiveGroup();
    }

    if (action === 'right' && focused.dataset.group !== undefined) {
      return this.nav.focusContainerEntry('.channel-main');
    }

    if (action !== 'up' || !this.hasPlaylistTabs()) return false;
    if (focused.dataset.groupPosition === '0') {
      return this.focusActivePlaylist();
    }
    return false;
  }

  private hasPlaylistTabs(): boolean {
    return this.container.querySelector('.playlist-tabs') !== null;
  }

  private focusActivePlaylist(): boolean {
    const active = this.container.querySelector<HTMLElement>('.playlist-tab.active');
    if (!active) return false;
    this.nav.focus(active);
    return true;
  }

  private focusActiveGroup(): boolean {
    const groups = this.getGroupEntries();
    const selected = groups.findIndex(group => group.id === this.currentGroup);
    const position = selected >= 0 ? selected : 0;
    const selector = `[data-group-position="${String(position)}"]`;
    let active = this.container.querySelector<HTMLElement>(selector);
    if (!active) {
      const list = this.container.querySelector<HTMLElement>('.group-list');
      this.groupVirtualizer.ensureVisible(
        position,
        list?.clientHeight || CHANNEL_VIEWPORT_FALLBACK,
      );
      if (list) {
        this.scrollGuard.syncOffset(list, 'vertical', this.groupVirtualizer.scrollOffset);
      }
      this.render(false);
      active = this.container.querySelector<HTMLElement>(selector);
    }
    if (!active) return false;
    this.nav.focus(active);
    return true;
  }

  private focusFirstChannel(): boolean {
    const first = this.container.querySelector<HTMLElement>(
      '.channel-main [data-list-position="0"]',
    );
    if (!first) return false;
    this.nav.focus(first);
    return true;
  }

  private renderGroup(
    g: { id: ChannelGroupId; label: string; builtin?: BuiltinChannelGroup },
    position: number,
    top: number,
  ): Safe {
    const isSource = g.id.indexOf('source:') === 0;
    const key = isSource
      ? this.editor.groupKeyForDisplay(g.id.slice('source:'.length))
      : '';
    const hidden = isSource && this.editor.isGroupHidden(key);
    const grabbed = this.editor.isGroupGrabbed(key);
    const renaming = this.editor.isGroupRenaming(key);
    const count = g.id === 'builtin:recently-watched'
      ? this.recentItems.length
      : PlaylistService.getGroupCount(g.id, this.currentPlaylist || undefined);

    return html`
      <div class="group-item ${g.id === this.currentGroup ? 'active' : ''} ${hidden ? 'hidden-entry' : ''} ${grabbed ? 'grabbed' : ''}"
           data-key="g:${g.id}"
           data-focusable data-group="${g.id}" data-group-position="${position}"
           style="top:${top}px">
        <span class="group-icon">${raw(groupIcon(g.label, g.builtin))}</span>
        ${renaming
          ? html`<input class="edit-text-input" type="text" value="${this.editor.renameValue(g.label)}">`
          : html`<span class="group-name">${
              raw(liveGroupLockBadge(g.id, this.currentPlaylist))}${g.label}</span>`}
        <span class="group-count">${count}</span>
      </div>
    `;
  }

  setPlaying(idx: number, catchupStart?: number | null): void {
    // Stopping playback tunes nothing for the list to land on.
    const moved = idx >= 0 && idx !== this.playingIndex;
    this.markPlaying(idx, catchupStart);
    if (moved) this.playingMoved = true;
  }

  // A channel the list itself tuned: its row already holds focus.
  private markPlaying(idx: number, catchupStart?: number | null): void {
    this.playingMoved = false;
    this.playingIndex = idx;
    this.playingCatchupStart = catchupStart ?? null;
  }

  private channelPosition(globalIdx: number): number {
    return PlaylistService
      .getByGroup(this.currentGroup, this.currentPlaylist || undefined)
      .findIndex(ch => PlaylistService.indexOf(ch) === globalIdx);
  }

  // A channel named by global index can sit outside the current filter and
  // outside the virtualized window: widen, center, then focus.
  private revealChannel(globalIdx: number): boolean {
    let position = this.channelPosition(globalIdx);
    if (position < 0 && this.currentGroup !== 'builtin:all') {
      this.currentGroup = 'builtin:all';
      position = this.channelPosition(globalIdx);
    }
    if (position < 0 && this.currentPlaylist) {
      this.currentPlaylist = '';
      position = this.channelPosition(globalIdx);
    }
    if (position < 0) return false;
    const main = this.container.querySelector<HTMLElement>('.channel-main');
    this.channelVirtualizer.centerOn(position, main?.clientHeight || CHANNEL_VIEWPORT_FALLBACK);
    this.render(false);
    const target = this.container.querySelector<HTMLElement>(
      `[data-list-position="${String(position)}"]`,
    );
    if (target) this.nav.focus(target);
    return true;
  }

  /** On entering the view: the entry point, or with `resume` where focus was left, brought into view. */
  highlightEntryPoint(resume = false): void {
    this.focusScope.enter(resume ? 'back' : 'key');
  }

  private prepareEntry(via: Via): void {
    this.placeEntry(via);
    // Focusing the row SpatialNav already holds reports no change.
    const focused = this.nav.focused?.dataset.key;
    if (focused) this.focusScope.track(focused);
  }

  // Back and the bar resume where focus was left; a channel tuned elsewhere
  // meanwhile wins. Any other entry starts at the playing channel or the top.
  private placeEntry(via: Via): void {
    const moved = this.playingMoved;
    this.playingMoved = false;
    const resume = via === 'back' || via === 'resume';
    const playing = this.playingIndex;
    if ((!resume || moved) && playing >= 0 && this.revealChannel(playing)) return;
    const key = this.focusScope.focusKey;
    if (resume && key !== null && this.revealKey(key)) return;
    if (playing >= 0 && this.revealChannel(playing)) return;
    const entry = this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]');
    if (entry) this.nav.focus(entry);
    else this.nav.focusFirst();
  }

  private revealKey(key: string): boolean {
    const row = this.rowPosition(key);
    if (row) return this.focusRow(row.list, row.position);
    const el = this.container.querySelector<HTMLElement>(`[data-key="${attrSelectorEscape(key)}"]`);
    if (!el || !el.hasAttribute('data-focusable')) return false;
    this.nav.focus(el);
    if (key.indexOf('recent:') === 0) this.recentToReveal = key;
    return true;
  }

  // Focus a virtual row fully in view, scrolling the list only when it is not.
  private focusRow(list: RowList, position: number): boolean {
    const selector = list === 'group'
      ? `[data-group-position="${String(position)}"]`
      : `[data-list-position="${String(position)}"]`;
    let row = this.container.querySelector<HTMLElement>(selector);
    if (!row || this.rowVisibility(row, list) !== 'full') {
      const scroller = this.container.querySelector<HTMLElement>(
        list === 'group' ? '.group-list' : '.channel-main',
      );
      const virtualizer = list === 'group' ? this.groupVirtualizer : this.channelVirtualizer;
      virtualizer.ensureVisible(position, scroller?.clientHeight || CHANNEL_VIEWPORT_FALLBACK);
      // render() reads the group offset back from the DOM.
      if (scroller) this.scrollGuard.syncOffset(scroller, 'vertical', virtualizer.scrollOffset);
      this.render(false);
      row = this.container.querySelector<HTMLElement>(selector);
    }
    if (!row) return false;
    this.nav.focus(row);
    return true;
  }

  // A virtual list row's place in the model, rendered or not.
  private rowPosition(key: string): { list: RowList; position: number } | null {
    if (key.indexOf('g:') === 0) {
      const position = this.getGroupEntries().findIndex(group => `g:${group.id}` === key);
      return position < 0 ? null : { list: 'group', position };
    }
    if (key.indexOf('ch:') !== 0 || this.currentGroup === 'builtin:recently-watched') return null;
    const position = this.channelPosition(parseInt(key.slice(3), 10));
    return position < 0 ? null : { list: 'channel', position };
  }

  // A list row moves with the list's scroll, so no input pass may scroll it
  // back: virtual rows are kept in view by the list, and a Recently Watched
  // row only by the list's own re-render or re-entry.
  private reveal(key: string): boolean | null {
    if (this.recentToReveal === key) {
      this.recentToReveal = null;
      return false;
    }
    return this.rowPosition(key) !== null || key.indexOf('recent:') === 0 ? null : false;
  }

  private defaultKey(): string | null {
    const focused = this.nav.focused;
    if (focused && this.container.contains(focused) && focused.dataset.key) return focused.dataset.key;
    const playing = this.playingIndex >= 0
      ? this.container.querySelector<HTMLElement>(
        `.channel-main [data-channel-index="${String(this.playingIndex)}"]`)
      : null;
    const row = playing
      ?? this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]')
      ?? this.container.querySelector<HTMLElement>('[data-focusable][data-key]');
    return row?.dataset.key ?? null;
  }

  private renderChannel(ch: Channel, favs: string[], position: number, top: number): Safe {
    const globalIdx = PlaylistService.indexOf(ch);
    const epgId = EpgService.findChannelId(ch);
    const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
    const isPlaying = globalIdx === this.playingIndex && this.playingCatchupStart === null;
    const isFav = favs.includes(channelKey(ch));
    const showFavoriteStar = isFav && this.currentGroup !== 'builtin:favorites';
    const selectedFavorite = this.editor.isFavoriteSelected(ch);
    const hidden = this.editor.isChannelHidden(ch);
    const grabbed = this.editor.isChannelGrabbed(ch);
    const renaming = this.editor.isChannelRenaming(ch);

    return html`
      <div class="channel-item ${isPlaying ? 'playing' : ''} ${hidden ? 'hidden-entry' : ''} ${
        grabbed ? 'grabbed' : ''} ${selectedFavorite ? 'favorite-selected' : ''}"
           data-key="ch:${String(globalIdx)}"
           data-focusable data-channel-index="${globalIdx}"
           data-list-position="${position}" style="top:${top}px">
        <div class="channel-number">${globalIdx + 1}</div>
        ${this.renderLogo(ch)}
        <div class="channel-info">
          ${renaming
            ? html`<input class="edit-text-input" type="text" value="${this.editor.renameValue(ch.name)}">`
            : html`<div class="channel-name">${raw(channelLockBadge(ch))}${
                showFavoriteStar ? raw(favoriteIcon(true)) : ''
              }${ch.name}</div>`}
          ${this.editor.isChannelEditing && ch.sourceName
            ? html`<div class="channel-now channel-source-name">${ch.sourceName}</div>`
            : (nowPlaying
                ? html`<div class="channel-now">${nowPlaying.title}</div>`
                : '')}
        </div>
        ${this.editor.renderChannelEditStatus(ch)}
        ${this.renderHealth(ch)}
        ${isPlaying ? raw('<div class="playing-indicator">&#9654;</div>') : ''}
      </div>
    `;
  }

  private renderRecentItem(
    item: RecentlyWatchedItem,
    index: number,
    favs: string[],
  ): Safe {
    const isFav = favs.includes(channelKey(item.channel));
    if (item.kind === 'live') {
      const epgId = EpgService.findChannelId(item.channel);
      const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
      const isPlaying = item.channelIndex === this.playingIndex && this.playingCatchupStart === null;
      return html`
        <div class="channel-item recent-item recent-live ${isPlaying ? 'playing' : ''}"
             data-key="recent:live:${channelKey(item.channel)}"
             data-focusable data-recent-index="${index}" data-channel-index="${item.channelIndex}"
             data-list-position="${index}">
          <div class="channel-number">${item.channelIndex + 1}</div>
          ${this.renderLogo(item.channel)}
          <div class="channel-info">
            <div class="channel-name">${raw(channelLockBadge(item.channel))}${
              isFav ? raw(favoriteIcon(true)) : ''
            }${item.channel.name}</div>
            ${nowPlaying ? html`<div class="channel-now">${nowPlaying.title}</div>` : ''}
          </div>
          ${this.renderHealth(item.channel)}
          <div class="recent-kind-badge live">${t('common.live')}</div>
          ${isPlaying ? raw('<div class="playing-indicator">&#9654;</div>') : ''}
        </div>
      `;
    }

    const duration = item.progress.duration > 0
      ? item.progress.duration
      : Math.max(1, (item.progress.progEnd - item.progress.progStart) / 1000);
    const percent = Math.round(Math.max(0, Math.min(1, item.progress.position / duration)) * 100);
    const isPlaying = item.channelIndex === this.playingIndex &&
      this.playingCatchupStart === item.progress.progStart;
    return html`
      <div class="channel-item recent-item recent-catchup ${isPlaying ? 'playing' : ''}"
           data-key="recent:catchup:${channelKey(item.channel)}:${item.progress.progStart}"
           data-focusable data-recent-index="${index}" data-channel-index="${item.channelIndex}"
           data-list-position="${index}">
        <div class="channel-number">${item.channelIndex + 1}</div>
        ${this.renderLogo(item.channel)}
        <div class="channel-info">
          <div class="channel-name">${raw(channelLockBadge(item.channel))}${
            isFav ? raw(favoriteIcon(true)) : ''
          }${item.progress.title ?? ''}</div>
          <div class="channel-now">${t('channel.resumeAt', {
            channel: item.channel.name,
            position: formatPosition(item.progress.position),
          })}</div>
          <div class="recent-progress"><div class="recent-progress-fill" style="width:${percent}%"></div></div>
        </div>
        <div class="recent-kind-badge catchup">${t('common.catchup')}</div>
        ${isPlaying ? raw('<div class="playing-indicator">&#9654;</div>') : ''}
      </div>
    `;
  }

  private renderLogo(ch: Channel): Safe {
    let logo: Safe | string = '';
    if (!ch.logo) {
      logo = html`<div class="channel-logo-placeholder">${ch.name.charAt(0)}</div>`;
    } else if (!this.failedLogos.has(ch.logo)) {
      logo = html`<img class="channel-logo" src="${ch.logo}" alt="" loading="lazy">`;
    }

    return html`
      <div class="channel-logo-wrap">
        ${logo}
      </div>
    `;
  }

  private renderHealth(ch: Channel): Safe | string {
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

  private async playRecentCatchup(item: Extract<RecentlyWatchedItem, { kind: 'catchup' }>): Promise<void> {
    const catchup = await RecentlyWatchedService.catchupInfo(item);
    if (!catchup) {
      showToast(t('channel.catchupUnavailable'));
      this.render();
      return;
    }
    this.markPlaying(item.channelIndex, item.progress.progStart);
    this.onChannelSelect(item.channelIndex, catchup, this.currentScope());
  }

  // A focused row the list scrolled out of its rendered window.
  private detachedKey(): string | null {
    const focused = this.nav.focused;
    if (focused && this.container.contains(focused)) return null;
    let key = this.focusScope.focusKey;
    if (key !== null && key.indexOf('preview-') === 0) key = this.listKey;
    return key !== null && this.rowPosition(key) ? key : null;
  }

  // Where the focused row went when the list scrolled it fully out of view,
  // whether still rendered in the overscan or not.
  private scrolledAway(): { list: RowList; position: number } | null {
    const focused = this.nav.focused;
    if (!focused || !this.container.contains(focused)) {
      const key = this.detachedKey();
      return key === null ? null : this.rowPosition(key);
    }
    const list: RowList | null = focused.dataset.groupPosition !== undefined ? 'group'
      : focused.dataset.listPosition !== undefined ? 'channel' : null;
    if (!list || this.rowVisibility(focused, list) !== 'none') return null;
    const position = list === 'group' ? focused.dataset.groupPosition : focused.dataset.listPosition;
    return { list, position: parseInt(position ?? '', 10) };
  }

  // The focused row scrolled away without the pointer following it (cursor
  // hidden, or the wheel over the list padding). Resume at the row in view
  // nearest to it, rather than letting the D-pad restart from the sidebar.
  private resumeScrolledAway(): boolean {
    const from = this.scrolledAway();
    if (!from) return false;
    // A grabbed row stays the one to move or drop, so bring it back.
    if (this.editor.refocusGrabbed(from.list)) {
      this.render();
      const key = this.nav.focused?.dataset.key;
      if (key) this.focusScope.resume(key, 0, `list=${from.list}`, 'target=grabbed');
      return true;
    }
    const list = this.container.querySelector<HTMLElement>(
      from.list === 'group' ? '.group-list' : '.channel-main',
    );
    if (!list) return false;
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const row of Array.from(list.querySelectorAll<HTMLElement>(
      from.list === 'group' ? '[data-group-position]' : '[data-list-position]',
    ))) {
      if (this.rowVisibility(row, from.list) !== 'full') continue;
      const position = from.list === 'group' ? row.dataset.groupPosition : row.dataset.listPosition;
      const distance = Math.abs(parseInt(position ?? '', 10) - from.position);
      if (distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    if (!best) return false;
    this.nav.focus(best);
    if (best.dataset.key) {
      this.focusScope.resume(best.dataset.key, bestDistance, `list=${from.list}`, 'target=nearest');
    }
    return true;
  }

  // A list that has no layout yet (hidden, or no CSS) counts every row as in view.
  private rowVisibility(row: HTMLElement, list: RowList): 'full' | 'partial' | 'none' {
    const scroller = row.closest<HTMLElement>(list === 'group' ? '.group-list' : '.channel-main');
    if (!scroller) return 'none';
    const view = this.listViewport(scroller, list);
    if (view.bottom <= view.top) return 'full';
    const box = row.getBoundingClientRect();
    if (box.top >= view.top - 1 && box.bottom <= view.bottom + 1) return 'full';
    return box.bottom > view.top && box.top < view.bottom ? 'partial' : 'none';
  }

  // The edit and preview hints overlay the bottom of the channel list.
  private listViewport(list: HTMLElement, kind: 'group' | 'channel'): { top: number; bottom: number } {
    const rect = list.getBoundingClientRect();
    let bottom = rect.bottom;
    const hints = kind === 'channel' ? this.container.querySelector<HTMLElement>('.edit-hints') : null;
    const hintsRect = hints?.getBoundingClientRect();
    if (hintsRect && hintsRect.height > 0 && hintsRect.top > rect.top) {
      bottom = Math.min(bottom, hintsRect.top);
    }
    return { top: rect.top, bottom };
  }

  // A channel row that couldn't step further sits at a list end; the
  // geometric fallback would leave the list for the group sidebar.
  // Up from the footer returns to the row Down left, else the lowest row it
  // doesn't cover, not to whatever the geometric pick finds in the sidebar.
  private focusRowAboveFooter(): boolean {
    const footer = this.nav.focused?.closest<HTMLElement>('.edit-hints');
    const main = this.container.querySelector<HTMLElement>('.channel-main');
    if (!footer || !main) return false;
    const left = this.footerReturnRow === null ? null
      : main.querySelector<HTMLElement>(`[data-list-position="${this.footerReturnRow}"]`);
    this.footerReturnRow = null;
    // A row scrolled out of view resumes in view instead of being scrolled back to.
    if (left && this.rowVisibility(left, 'channel') !== 'none') {
      this.nav.focus(left);
      return true;
    }
    const limit = Math.min(main.getBoundingClientRect().bottom, footer.getBoundingClientRect().top) + 1;
    let best: HTMLElement | null = null;
    let bestBottom = -Infinity;
    for (const row of Array.from(main.querySelectorAll<HTMLElement>('[data-list-position]'))) {
      const bottom = row.getBoundingClientRect().bottom;
      if (bottom <= limit && bottom > bestBottom) {
        best = row;
        bestBottom = bottom;
      }
    }
    if (!best) return false;
    this.nav.focus(best);
    return true;
  }

  // Up/Down/CH+/CH- within the list and its footer; false leaves the move
  // to SpatialNav.
  private stepChannelList(action: 'up' | 'down' | 'channel_up' | 'channel_down'): boolean {
    if (this.moveVirtualFocus(action === 'up' || action === 'channel_up' ? -1 : 1)) return true;
    if (action === 'channel_up' || action === 'channel_down') return this.atChannelListEnd();
    if (action === 'up') return this.focusRowAboveFooter();
    if (!this.atChannelListEnd()) return false;
    // The footer actions below the list are only reached from its last row.
    const footer = this.container.querySelector<HTMLElement>('.edit-hints [data-focusable]');
    const from = this.nav.focused;
    if (footer && from && !from.closest('.edit-hints')) {
      this.footerReturnRow = from.dataset.listPosition ?? null;
      this.nav.focus(footer);
    }
    return true;
  }

  // The footer below the list is a dead end for Down and CH+/CH- too.
  private atChannelListEnd(): boolean {
    const focused = this.nav.focused;
    if (!focused || !this.container.contains(focused)) return false;
    return focused.dataset.listPosition !== undefined || !!focused.closest('.edit-hints');
  }

  private moveVirtualFocus(delta: number): boolean {
    if (this.resumeScrolledAway()) return true;
    const focused = this.nav.focused;
    const rawGroupPosition = focused?.dataset.groupPosition;
    if (rawGroupPosition !== undefined) {
      const next = parseInt(rawGroupPosition, 10) + delta;
      const groups = this.getGroupEntries();
      if (next < 0 || next >= groups.length) return false;
      const selector = `[data-group-position="${String(next)}"]`;
      const renderedTarget = this.container.querySelector<HTMLElement>(selector);
      if (renderedTarget && this.groupScrollFrame === null) {
        this.nav.focus(renderedTarget);
        return true;
      }
      const list = this.container.querySelector<HTMLElement>('.group-list');
      this.groupVirtualizer.ensureVisible(
        next,
        list?.clientHeight || CHANNEL_VIEWPORT_FALLBACK,
      );
      this.render(false);
      const target = this.container.querySelector<HTMLElement>(selector);
      if (target) this.nav.focus(target);
      return true;
    }
    const rawPosition = focused?.dataset.listPosition;
    if (rawPosition === undefined) return false;
    const position = parseInt(rawPosition, 10);
    if (this.currentGroup === 'builtin:recently-watched') {
      const target = this.container.querySelector<HTMLElement>(
        `.channel-main [data-list-position="${String(position + delta)}"]`,
      );
      if (!target) return false;
      this.nav.focus(target);
      return true;
    }
    const count = PlaylistService.getGroupCount(
      this.currentGroup,
      this.currentPlaylist || undefined,
    );
    const next = position + delta;
    if (next < 0 || next >= count) return false;
    const selector = `[data-list-position="${String(next)}"]`;
    const renderedTarget = this.container.querySelector<HTMLElement>(selector);
    if (renderedTarget && this.scrollFrame === null) {
      this.nav.focus(renderedTarget);
      return true;
    }
    const main = this.container.querySelector<HTMLElement>('.channel-main');
    this.channelVirtualizer.ensureVisible(next, main?.clientHeight || CHANNEL_VIEWPORT_FALLBACK);
    this.render(false);
    const target = this.container.querySelector<HTMLElement>(selector);
    if (target) this.nav.focus(target);
    return true;
  }

  private getGroupEntries(): { id: ChannelGroupId; label: string; builtin?: BuiltinChannelGroup }[] {
    if (this.groupEntriesChannels === PlaylistService.channels
        && this.groupEntriesPlaylist === this.currentPlaylist
        && this.groupEntriesRevision === PlaylistService.groupsRevision
        && this.groupEntriesLocale === getLocale()) {
      return this.groupEntries;
    }
    this.groupEntriesChannels = PlaylistService.channels;
    this.groupEntriesPlaylist = this.currentPlaylist;
    this.groupEntriesRevision = PlaylistService.groupsRevision;
    this.groupEntriesLocale = getLocale();
    this.groupEntries = [
      { id: 'builtin:all', label: t('common.all'), builtin: 'all' },
      { id: 'builtin:favorites', label: t('channel.favorites'), builtin: 'favorites' },
      {
        id: 'builtin:recently-watched',
        label: t('channel.recentlyWatched'),
        builtin: 'recently-watched',
      },
      ...PlaylistService.getGroupsForPlaylist(this.currentPlaylist || undefined)
        .map(name => ({
          id: `source:${name}` as ChannelGroupId,
          label: groupDisplayLabel(name),
        })),
    ];
    return this.groupEntries;
  }

}

// Escape a value for use inside a `[attr="..."]` selector. Only `\` and `"`
// matter. Avoids relying on `CSS.escape` which jsdom does not implement.
function attrSelectorEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
