import type { Action, BuiltinChannelGroup, CatchupInfo, Channel, ChannelGroupId, NumberEvent } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelKey, groupDisplayLabel } from '../utils/channel';
import { formatPosition } from '../utils/time';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { RecentlyWatchedService, type RecentlyWatchedItem } from '../services/recently-watched';
import { groupIcon } from './group-icon';
import { showToast } from './toast';
import { getLocale, t, tp, type SupportedLocale } from '../i18n';
import { ChannelListEditor } from './channel-list-editor';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';

// Row strides mirror the fixed row geometry in css/channel-list.css:
// .channel-item is 88px, .group-item is 60px plus its 8px vertical margin.
const CHANNEL_ROW_STRIDE = 88;
const GROUP_ROW_STRIDE = 68;
const CHANNEL_OVERSCAN = 12;
const CHANNEL_VIEWPORT_FALLBACK = 900;

export class ChannelList {
  private container: HTMLElement;
  private onChannelSelect: (index: number, catchup?: CatchupInfo) => void;
  private onChannelsChanged: () => void;
  private nav: SpatialNav;
  private editor: ChannelListEditor;
  private currentGroup: ChannelGroupId = 'builtin:all';
  private currentPlaylist = '';  // '' = All playlists
  private playingIndex = -1;
  private playingCatchupStart: number | null = null;
  private recentItems: RecentlyWatchedItem[] = [];
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
  private readonly scrollGuard = new VirtualScrollGuard();
  private groupEntries: { id: ChannelGroupId; label: string; builtin?: BuiltinChannelGroup }[] = [];
  private groupEntriesChannels: Channel[] | null = null;
  private groupEntriesPlaylist = '';
  private groupEntriesRevision = -1;
  private groupEntriesLocale: SupportedLocale | null = null;

  constructor(
    container: HTMLElement,
    onChannelSelect: (index: number, catchup?: CatchupInfo) => void,
    onChannelsChanged: () => void = () => {},
  ) {
    this.container = container;
    this.onChannelSelect = onChannelSelect;
    this.onChannelsChanged = onChannelsChanged;
    this.nav = new SpatialNav(container, (el) => {
      this.editor?.trackFocus(el);
    });
    this.editor = new ChannelListEditor(container, this.nav, {
      render: () => this.render(),
      moveListFocus: (delta) => this.moveVirtualFocus(delta),
      onChannelsChanged: () => this.onChannelsChanged(),
      getCurrentGroup: () => this.currentGroup,
      getCurrentPlaylist: () => this.currentPlaylist,
      setLocation: (group, playlist) => {
        this.currentGroup = group;
        this.currentPlaylist = playlist;
      },
    });

    // Cursor left the view: drop the hover highlight.
    this.container.addEventListener('mouseleave', () => {
      this.nav.clearHighlight();
      this.editor.finishPointerDrag();
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
        this.render();
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
          this.render(false);
        });
        return;
      }
      if (!target.classList.contains('channel-main')) return;
      if (this.currentGroup === 'builtin:recently-watched') return;
      const offset = this.scrollGuard.readUserOffset(target, 'vertical');
      if (offset === null) return;
      this.channelVirtualizer.setScrollOffset(offset);
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
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

    // Capture the current focus key before morph so we can restore it on a
    // reused node. morph treats `class` as authoritative — it will remove the
    // imperative `.focused` class — and we re-apply nav.focus in the same
    // synchronous tick to avoid any flicker.
    const prevFocusedKey = this.nav.focused?.getAttribute('data-key') ?? null;
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
    } else if (!showingRecent && ensureFocus && !wantedKey && this.playingIndex >= 0) {
      wantedPosition = filteredChannels.findIndex(
        ch => PlaylistService.indexOf(ch) === this.playingIndex,
      );
      if (wantedPosition >= 0) this.channelVirtualizer.centerOn(wantedPosition, viewportHeight);
    }
    const range = this.channelVirtualizer.getRange(filteredChannels.length, viewportHeight);
    const groupViewportHeight = previousGroupList?.clientHeight || CHANNEL_VIEWPORT_FALLBACK;
    const focusedGroupPosition = parseInt(
      this.nav.focused?.dataset.groupPosition ?? '-1',
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
            <div class="playlist-tabs">
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
        <div class="channel-main" data-nav-container>
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
        ${this.editor.renderFooter(
          this.currentGroup === 'builtin:favorites' && filteredChannels.length > 0,
        )}
        ${this.editor.renderGroupPicker()}
      </div>
    `);

    // Restore focus on the reused node (or fall back to a sensible default).
    let target: HTMLElement | null = null;
    target = this.editor.focusGroupPicker();
    if (!target && wantedKey) {
      target = this.container.querySelector<HTMLElement>(
        `[data-key="${attrSelectorEscape(wantedKey)}"]`,
      );
    }
    let playingChannel: HTMLElement | null = null;
    if (!target && ensureFocus) {
      playingChannel = this.playingIndex >= 0
        ? this.container.querySelector<HTMLElement>(`.channel-main [data-channel-index="${this.playingIndex}"]`)
        : null;
      // Default focus: the first channel (an empty list falls through to the
      // first focusable — a group or playlist tab — below).
      const target0 = this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]');
      target = playingChannel
        ?? target0
        ?? this.container.querySelector<HTMLElement>('[data-focusable]');
    }
    if (target) {
      this.nav.focus(target);
      if (showingRecent && target.closest('.channel-main')) {
        target.scrollIntoView({ block: 'nearest' });
      }
    }
    if (!ensureFocus) this.nav.clearDetachedFocus();
    const main = this.container.querySelector<HTMLElement>('.channel-main');
    if (main && !showingRecent) {
      this.scrollGuard.syncOffset(main, 'vertical', this.channelVirtualizer.scrollOffset);
    }
    const groupList = this.container.querySelector<HTMLElement>('.group-list');
    if (groupList) {
      this.scrollGuard.syncOffset(groupList, 'vertical', this.groupVirtualizer.scrollOffset);
    }

    // An inline rename / new-group field owns the keyboard while it is open.
    this.editor.focusTextInput();
  }

  get isEditing(): boolean {
    return this.editor.isEditing;
  }

  enterEditMode(group: ChannelGroupId = this.currentGroup): void {
    this.editor.enterEditMode(group);
  }

  exitEditMode(): void {
    this.editor.exitEditMode();
  }

  /** Back inside the channel list: close what is open, else let the view handle it. */
  handleBack(): boolean {
    return this.editor.handleBack();
  }

  handleAction(action: Action, event?: NumberEvent): boolean {
    if (this.editor.handleAction(action)) return true;

    switch (action) {
      case 'up':
      case 'down':
        if (this.moveVirtualFocus(action === 'up' ? -1 : 1)) return true;
        return this.nav.move(action);
      case 'left':
      case 'right':
        return this.nav.move(action);

      case 'channel_up':
        if (!this.moveVirtualFocus(-1)) this.nav.move('up');
        break;

      case 'channel_down':
        if (!this.moveVirtualFocus(1)) this.nav.move('down');
        break;

      case 'select': {
        const focused = this.nav.focused;
        if (!focused) break;

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
            this.setPlaying(item.channelIndex);
            this.onChannelSelect(item.channelIndex);
          } else if (item) {
            void this.playRecentCatchup(item);
          }
        } else if (focused.dataset.channelIndex !== undefined) {
          const idx = parseInt(focused.dataset.channelIndex, 10);
          this.setPlaying(idx);
          this.onChannelSelect(idx);
        }
        break;
      }

      case 'green': {
        this.editor.toggleFocusedFavorite();
        break;
      }

      case 'yellow':
        if (this.currentGroup !== 'builtin:recently-watched') this.enterEditMode();
        break;

      case 'number': {
        if (!event) break;
        const num = event.number - 1;
        if (num >= 0 && num < PlaylistService.channels.length) {
          this.playingIndex = num;
          this.onChannelSelect(num);
        }
        break;
      }
    }
    return false;
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
          ? html`<input class="edit-text-input" type="text" value="${g.label}">`
          : html`<span class="group-name">${g.label}</span>`}
        <span class="group-count">${count}</span>
      </div>
    `;
  }

  setPlaying(idx: number, catchupStart?: number | null): void {
    this.playingIndex = idx;
    this.playingCatchupStart = catchupStart ?? null;
  }

  /** On entering the view: highlight the first channel (else the first focusable). */
  highlightEntryPoint(): void {
    const entry = this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]')
      ?? this.container.querySelector<HTMLElement>('[data-focusable]');
    if (entry) this.nav.focus(entry);
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
            ? html`<input class="edit-text-input" type="text" value="${ch.name}">`
            : html`<div class="channel-name">${
                showFavoriteStar ? raw('&#9733; ') : ''
              }${ch.name}</div>`}
          ${this.editor.isChannelEditing && ch.sourceName
            ? html`<div class="channel-now channel-source-name">${ch.sourceName}</div>`
            : (nowPlaying
                ? html`<div class="channel-now">${nowPlaying.title}</div>`
                : '')}
        </div>
        ${this.editor.renderChannelEditStatus(ch)}
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
            <div class="channel-name">${isFav ? raw('&#9733; ') : ''}${item.channel.name}</div>
            ${nowPlaying ? html`<div class="channel-now">${nowPlaying.title}</div>` : ''}
          </div>
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
          <div class="channel-name">${isFav ? raw('&#9733; ') : ''}${item.progress.title ?? ''}</div>
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

  private async playRecentCatchup(item: Extract<RecentlyWatchedItem, { kind: 'catchup' }>): Promise<void> {
    const catchup = await RecentlyWatchedService.catchupInfo(item);
    if (!catchup) {
      showToast(t('channel.catchupUnavailable'));
      this.render();
      return;
    }
    this.setPlaying(item.channelIndex, item.progress.progStart);
    this.onChannelSelect(item.channelIndex, catchup);
  }

  private moveVirtualFocus(delta: number): boolean {
    const focused = this.nav.focused;
    const rawGroupPosition = focused?.dataset.groupPosition;
    if (rawGroupPosition !== undefined) {
      const next = parseInt(rawGroupPosition, 10) + delta;
      const groups = this.getGroupEntries();
      if (next < 0 || next >= groups.length) return false;
      const list = this.container.querySelector<HTMLElement>('.group-list');
      this.groupVirtualizer.ensureVisible(
        next,
        list?.clientHeight || CHANNEL_VIEWPORT_FALLBACK,
      );
      this.render(false);
      const target = this.container.querySelector<HTMLElement>(
        `[data-group-position="${String(next)}"]`,
      );
      if (target) this.nav.focus(target);
      return true;
    }
    const rawPosition = focused?.dataset.listPosition;
    if (rawPosition === undefined) return false;
    if (this.currentGroup === 'builtin:recently-watched') return false;
    const position = parseInt(rawPosition, 10);
    const count = PlaylistService.getGroupCount(
      this.currentGroup,
      this.currentPlaylist || undefined,
    );
    const next = position + delta;
    if (next < 0 || next >= count) return false;
    const main = this.container.querySelector<HTMLElement>('.channel-main');
    this.channelVirtualizer.ensureVisible(next, main?.clientHeight || CHANNEL_VIEWPORT_FALLBACK);
    this.render(false);
    const target = this.container.querySelector<HTMLElement>(`[data-list-position="${next}"]`);
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
