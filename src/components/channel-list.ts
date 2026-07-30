import type { Action, BuiltinChannelGroup, CatchupInfo, Channel, ChannelGroupId, NumberEvent } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelKey } from '../utils/channel';
import { formatPosition } from '../utils/time';
import { PlaylistService } from '../services/playlist-service';
import { ChannelCustomizationService, groupKeyOf } from '../services/channel-customization';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { RecentlyWatchedService, type RecentlyWatchedItem } from '../services/recently-watched';
import { groupIcon } from './group-icon';
import { BACK_ICON } from './icons';
import { showToast } from './toast';
import { t, tp } from '../i18n';
import { CONFIG } from '../config';

type EditTarget = { kind: 'channel'; key: string } | { kind: 'group'; key: string };
type DragCandidate = { target: EditTarget; x: number; y: number };

const DRAG_START_DISTANCE = 8;

export class ChannelList {
  private container: HTMLElement;
  private onChannelSelect: (index: number, catchup?: CatchupInfo) => void;
  private onChannelsChanged: () => void;
  private nav: SpatialNav;
  private currentGroup: ChannelGroupId = 'builtin:all';
  private currentPlaylist = '';  // '' = All playlists
  private playingIndex = -1;
  private playingCatchupStart: number | null = null;
  private recentItems: RecentlyWatchedItem[] = [];
  private editing = false;
  private grabbed: EditTarget | null = null;
  private renaming: EditTarget | null = null;
  private groupPickerFor: string | null = null; // customization key awaiting a group choice
  private newGroupOpen = false;
  private refocus: string | null = null; // data-key to focus after the next render
  private dragCandidate: DragCandidate | null = null;
  private pointerDragging = false;
  private suppressPointerClick = false;
  private pointerClickReset: ReturnType<typeof setTimeout> | null = null;
  private lastDragPlacement = '';
  private editActionTarget: EditTarget | null = null;
  private failedLogos = new Set<string>();

  constructor(
    container: HTMLElement,
    onChannelSelect: (index: number, catchup?: CatchupInfo) => void,
    onChannelsChanged: () => void = () => {},
  ) {
    this.container = container;
    this.onChannelSelect = onChannelSelect;
    this.onChannelsChanged = onChannelsChanged;
    this.nav = new SpatialNav(container, (el) => {
      const target = el ? this.editTargetForElement(el) : null;
      if (target) this.editActionTarget = target;
    });

    // Cursor left the view: drop the hover highlight.
    this.container.addEventListener('mouseleave', () => {
      this.nav.clearHighlight();
      this.finishPointerDrag();
    });

    // Activate the item under the pointer by coordinate hit-test, so a click plays
    // the channel (or switches group/playlist) regardless of what holds D-pad focus
    // — the global click path would instead route select to the focused tab bar
    // (swallowed while the search box is open). The container is marked
    // `data-self-activate` so that global handler skips this subtree.
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('mousedown', (e: MouseEvent) => this.onPointerDown(e));
    this.container.addEventListener('mousemove', (e: MouseEvent) => this.onPointerMove(e));
    this.container.addEventListener('mouseup', () => this.finishPointerDrag());
    this.container.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!(e.target instanceof HTMLInputElement)
          || (e.key !== 'Enter' && e.keyCode !== CONFIG.KEYS.ENTER)) return;
      e.preventDefault();
      e.stopPropagation();
      this.commitTextInput();
    });
    this.container.addEventListener('click', (e: MouseEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (this.suppressPointerClick) {
        if (this.pointerClickReset) clearTimeout(this.pointerClickReset);
        this.pointerClickReset = null;
        this.suppressPointerClick = false;
        return;
      }
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
  }

  private onPointerRelease(x: number, y: number): void {
    const el = this.focusableAt(x, y);
    if (!el || !this.container.contains(el)) return;
    this.nav.focus(el);
    this.handleAction('select');
  }

  private onPointerDown(event: MouseEvent): void {
    if (!this.editing || event.button !== 0 || this.renaming
        || this.groupPickerFor || this.newGroupOpen) return;
    const el = this.focusableAt(event.clientX, event.clientY);
    const target = el ? this.editTargetForElement(el) : null;
    if (!el || !target) return;
    this.nav.focus(el);
    this.dragCandidate = { target, x: event.clientX, y: event.clientY };
    this.lastDragPlacement = '';
  }

  private onPointerMove(event: MouseEvent): void {
    const candidate = this.dragCandidate;
    if (!candidate) return;

    if (!this.pointerDragging) {
      const dx = event.clientX - candidate.x;
      const dy = event.clientY - candidate.y;
      if (dx * dx + dy * dy < DRAG_START_DISTANCE * DRAG_START_DISTANCE) return;
      this.pointerDragging = true;
      if (this.pointerClickReset) clearTimeout(this.pointerClickReset);
      this.pointerClickReset = null;
      this.suppressPointerClick = true;
      this.grabbed = candidate.target;
      this.setDragRefocus(candidate.target);
      this.render();
    }

    const el = this.focusableAt(event.clientX, event.clientY);
    const target = el ? this.editTargetForElement(el) : null;
    if (!el || !target || target.kind !== candidate.target.kind
        || target.key === candidate.target.key) return;
    const rect = el.getBoundingClientRect();
    const after = event.clientY >= rect.top + rect.height / 2;
    const placement = `${target.kind}:${target.key}:${after ? 'after' : 'before'}`;
    if (placement === this.lastDragPlacement) return;
    this.lastDragPlacement = placement;
    this.movePointerGrabbed(target, after);
  }

  private finishPointerDrag(): void {
    this.dragCandidate = null;
    this.lastDragPlacement = '';
    if (!this.pointerDragging) return;
    this.pointerDragging = false;
    this.grabbed = null;
    this.render();
    this.pointerClickReset = setTimeout(() => {
      this.suppressPointerClick = false;
      this.pointerClickReset = null;
    }, 0);
  }

  private focusableAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    return el && this.container.contains(el) ? el : null;
  }

  render(): void {
    const tabs = PlaylistService.playlistTabs;
    // The selected playlist may have just been deleted in settings — fall back to All.
    if (this.currentPlaylist && !tabs.some(t => t.id === this.currentPlaylist)) this.currentPlaylist = '';
    const showTabs = tabs.length > 1;
    const builtins: { id: ChannelGroupId; label: string; builtin: BuiltinChannelGroup }[] = [
      { id: 'builtin:all', label: t('common.all'), builtin: 'all' },
      { id: 'builtin:favorites', label: t('channel.favorites'), builtin: 'favorites' },
      { id: 'builtin:recently-watched', label: t('channel.recentlyWatched'), builtin: 'recently-watched' },
    ];
    const groups = [
      ...builtins,
      ...PlaylistService.getGroupsForPlaylist(this.currentPlaylist || undefined)
        .map(name => ({ id: `source:${name}` as ChannelGroupId, label: name, builtin: undefined })),
    ];
    if (!groups.some(group => group.id === this.currentGroup)) this.currentGroup = 'builtin:all';
    this.recentItems = RecentlyWatchedService.getItems(this.currentPlaylist || undefined);
    const showingRecent = this.currentGroup === 'builtin:recently-watched';
    const filteredChannels = PlaylistService.getByGroup(this.currentGroup, this.currentPlaylist || undefined);
    const totalChannels = this.currentPlaylist
      ? PlaylistService.getByGroup('builtin:all', this.currentPlaylist).length
      : PlaylistService.channels.length;
    const favs = StorageService.getFavorites();
    const editing = this.editing;

    // Capture the current focus key before morph so we can restore it on a
    // reused node. morph treats `class` as authoritative — it will remove the
    // imperative `.focused` class — and we re-apply nav.focus in the same
    // synchronous tick to avoid any flicker.
    const prevFocusedKey = this.nav.focused?.getAttribute('data-key') ?? null;

    morph(this.container, html`
      <div class="channel-view ${editing ? 'editing' : ''}">
        <div class="sidebar" data-nav-container>
          <div class="sidebar-header">
            <div class="channel-count">${tp('channel.count', totalChannels)}</div>
            ${editing ? '' : html`
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
            ${groups.map(g => this.renderGroup(g))}
          </div>
        </div>
        <div class="channel-main" data-nav-container>
          <div class="channel-list-scroll">
            ${showingRecent
              ? (this.recentItems.length
                  ? this.recentItems.map((item, index) => this.renderRecentItem(item, index, favs))
                  : html`<div class="empty-state">${t('channel.recentEmpty')}</div>`)
              : (filteredChannels.length
                  ? filteredChannels.map(ch => this.renderChannel(ch, favs))
                  : html`<div class="empty-state">${t('channel.empty')}</div>`)}
          </div>
        </div>
        ${editing ? this.renderEditHints() : ''}
        ${this.groupPickerFor ? this.renderGroupPicker() : ''}
      </div>
    `);

    // Restore focus on the reused node (or fall back to a sensible default).
    let target: HTMLElement | null = null;
    const wantedKey = this.refocus ?? prevFocusedKey;
    this.refocus = null;
    if (this.groupPickerFor) {
      target = this.container.querySelector<HTMLElement>('.group-picker [data-focusable]');
    }
    if (!target && wantedKey) {
      target = this.container.querySelector<HTMLElement>(
        `[data-key="${attrSelectorEscape(wantedKey)}"]`,
      );
    }
    let playingChannel: HTMLElement | null = null;
    if (!target) {
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
      if (playingChannel) playingChannel.scrollIntoView({ block: 'center' });
    }

    // An inline rename / new-group field owns the keyboard while it is open.
    const input = this.container.querySelector<HTMLInputElement>('.edit-text-input');
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }

  // --- Edit mode

  get isEditing(): boolean {
    return this.editing;
  }

  enterEditMode(): void {
    if (this.editing) return;
    this.editActionTarget = this.nav.focused
      ? this.editTargetForElement(this.nav.focused)
      : null;
    this.editing = true;
    this.grabbed = null;
    // Reveal hidden channels so they can be brought back.
    PlaylistService.setIncludeHidden(true);
    this.onChannelsChanged();
    this.render();
    showToast(t('channel.editModeOn'));
  }

  exitEditMode(): void {
    if (!this.editing) return;
    this.editing = false;
    this.grabbed = null;
    this.renaming = null;
    this.groupPickerFor = null;
    this.newGroupOpen = false;
    this.editActionTarget = null;
    PlaylistService.setIncludeHidden(false);
    this.onChannelsChanged();
    this.render();
  }

  /** Back inside the channel list: close what is open, else let the view handle it. */
  handleBack(): boolean {
    if (this.newGroupOpen) {
      this.newGroupOpen = false;
      this.render();
      return true;
    }
    if (this.groupPickerFor) {
      this.groupPickerFor = null;
      this.render();
      return true;
    }
    if (this.renaming) {
      this.renaming = null;
      this.render();
      return true;
    }
    if (this.editing) {
      this.exitEditMode();
      return true;
    }
    return false;
  }

  handleAction(action: Action, event?: NumberEvent): boolean {
    if (this.editing && this.handleEditAction(action)) return true;

    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        return this.nav.move(action);

      case 'channel_up':
        this.nav.move('up');
        break;

      case 'channel_down':
        this.nav.move('down');
        break;

      case 'select': {
        const focused = this.nav.focused;
        if (!focused) break;

        if (focused.dataset.editChannels !== undefined) {
          this.enterEditMode();
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
        const focused = this.nav.focused;
        if (focused?.dataset.channelIndex !== undefined) {
          const idx = parseInt(focused.dataset.channelIndex, 10);
          const ch = PlaylistService.getByIndex(idx);
          if (ch) {
            StorageService.toggleFavorite(channelKey(ch));
            this.render();
          }
        }
        break;
      }

      case 'yellow':
        this.enterEditMode();
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

  private handleEditAction(action: Action): boolean {
    // The inline field owns typing; select commits, back cancels via handleBack.
    if (this.renaming || this.newGroupOpen) {
      if (action === 'select') this.commitTextInput();
      return true;
    }

    if (this.groupPickerFor) {
      if (action === 'up' || action === 'down') this.nav.move(action);
      else if (action === 'select') this.chooseGroupOption();
      return true;
    }

    const buttonAction = this.nav.focused?.dataset.editAction as Action | undefined;
    if (action === 'select' && buttonAction) return this.handleEditAction(buttonAction);

    switch (action) {
      case 'yellow':
        this.exitEditMode();
        return true;
      case 'up':
      case 'down':
        if (!this.grabbed) return false;
        this.moveGrabbed(action === 'up' ? -1 : 1);
        return true;
      case 'select':
        this.toggleGrab();
        return true;
      case 'green':
        this.toggleHiddenSelected();
        return true;
      case 'blue':
        this.startRename();
        return true;
      case 'red':
        this.openGroupPicker();
        return true;
      default:
        return false;
    }
  }

  /** The edit target under focus: a channel row, or a source group row. */
  private focusedTarget(): EditTarget | null {
    const focused = this.nav.focused;
    const target = focused ? this.editTargetForElement(focused) : null;
    return target ?? this.editActionTarget;
  }

  private editTargetForElement(el: HTMLElement): EditTarget | null {
    if (el.dataset.recentIndex !== undefined) return null;
    if (el.dataset.channelIndex !== undefined) {
      const ch = PlaylistService.getByIndex(parseInt(el.dataset.channelIndex, 10));
      return ch ? { kind: 'channel', key: channelKey(ch) } : null;
    }
    const group = el.dataset.group;
    if (group && group.indexOf('source:') === 0) {
      return { kind: 'group', key: this.groupKeyForDisplay(group.slice('source:'.length)) };
    }
    return null;
  }

  private groupKeyForDisplay(display: string): string {
    for (const key of ChannelCustomizationService.customGroups) {
      if (ChannelCustomizationService.groupLabel(key) === display) return key;
    }
    for (const ch of PlaylistService.channels) {
      if (ch.group === display) return groupKeyOf(ch);
    }
    return display;
  }

  private toggleGrab(): void {
    const target = this.focusedTarget();
    if (!target) return;
    const same = this.grabbed && this.grabbed.kind === target.kind && this.grabbed.key === target.key;
    this.grabbed = same ? null : target;
    this.render();
  }

  private moveGrabbed(delta: number): void {
    const grabbed = this.grabbed;
    if (!grabbed) return;

    if (grabbed.kind === 'channel') {
      const list = PlaylistService.getByGroup(this.currentGroup, this.currentPlaylist || undefined);
      const pos = list.findIndex(ch => channelKey(ch) === grabbed.key);
      const target = list[pos + delta];
      if (pos < 0 || !target) return;
      ChannelCustomizationService.moveChannel(
        PlaylistService.channels.map(channelKey),
        grabbed.key,
        channelKey(target),
        delta > 0,
      );
      this.applyEdit();
      this.refocus = `ch:${PlaylistService.indexOfKey(grabbed.key)}`;
      this.render();
      return;
    }

    const visibleKeys = PlaylistService.getGroupsForPlaylist(this.currentPlaylist || undefined)
      .map(display => this.groupKeyForDisplay(display));
    const pos = visibleKeys.indexOf(grabbed.key);
    const targetKey = visibleKeys[pos + delta];
    if (pos < 0 || !targetKey) return;
    ChannelCustomizationService.moveGroup(
      this.editGroupKeys(),
      grabbed.key,
      targetKey,
      delta > 0,
    );
    this.applyEdit();
    this.render();
  }

  private movePointerGrabbed(target: EditTarget, after: boolean): void {
    const grabbed = this.grabbed;
    if (!grabbed || grabbed.kind !== target.kind) return;

    if (grabbed.kind === 'channel' && target.kind === 'channel') {
      ChannelCustomizationService.moveChannel(
        PlaylistService.channels.map(channelKey),
        grabbed.key,
        target.key,
        after,
      );
    } else if (grabbed.kind === 'group' && target.kind === 'group') {
      ChannelCustomizationService.moveGroup(
        this.editGroupKeys(),
        grabbed.key,
        target.key,
        after,
      );
    }
    this.applyEdit();
    this.setDragRefocus(grabbed);
    this.render();
  }

  private setDragRefocus(target: EditTarget): void {
    if (target.kind === 'channel') {
      this.refocus = `ch:${PlaylistService.indexOfKey(target.key)}`;
    }
  }

  private toggleHiddenSelected(): void {
    const target = this.grabbed;
    if (!target) {
      showToast(t('channel.editSelectFirst'));
      return;
    }
    if (target.kind === 'channel') ChannelCustomizationService.toggleHidden(target.key);
    else ChannelCustomizationService.toggleGroupHidden(target.key);
    this.applyEdit();
    if (target.kind === 'channel') {
      this.refocus = `ch:${PlaylistService.indexOfKey(target.key)}`;
    }
    this.render();
  }

  private startRename(): void {
    const target = this.grabbed;
    if (!target) {
      showToast(t('channel.editSelectFirst'));
      return;
    }
    this.renaming = target;
    this.render();
  }

  private commitTextInput(): void {
    const input = this.container.querySelector<HTMLInputElement>('.edit-text-input');
    const value = input?.value ?? '';
    if (this.newGroupOpen) {
      const key = this.groupPickerFor;
      if (key && value.trim() && this.groupNameExists(null, value)) {
        showToast(t('channel.editGroupExists'));
        return;
      }
      this.newGroupOpen = false;
      this.groupPickerFor = null;
      if (key && value.trim()) ChannelCustomizationService.setGroup(key, value);
      this.applyEdit();
      if (key) this.refocus = `ch:${PlaylistService.indexOfKey(key)}`;
      this.render();
      return;
    }

    const target = this.renaming;
    if (target) {
      if (target.kind === 'group' && this.groupNameExists(target.key, value)) {
        showToast(t('channel.editGroupExists'));
        return;
      }
      this.renaming = null;
      if (target.kind === 'channel') ChannelCustomizationService.rename(target.key, value);
      else ChannelCustomizationService.renameGroup(target.key, value);
      this.applyEdit();
      if (target.kind === 'channel') {
        this.refocus = `ch:${PlaylistService.indexOfKey(target.key)}`;
      }
    }
    this.render();
  }

  private groupNameExists(targetKey: string | null, value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return this.editGroupKeys().some((key) => key !== targetKey
      && ChannelCustomizationService.groupLabel(key).trim().toLowerCase() === normalized);
  }

  private openGroupPicker(): void {
    const target = this.grabbed;
    if (!target) {
      showToast(t('channel.editSelectFirst'));
      return;
    }
    if (target.kind !== 'channel') return;
    this.groupPickerFor = target.key;
    this.render();
  }

  private chooseGroupOption(): void {
    const choice = this.nav.focused?.dataset.groupChoice;
    const key = this.groupPickerFor;
    if (!choice || !key) return;
    if (choice === 'new') {
      this.newGroupOpen = true;
      this.render();
      return;
    }
    ChannelCustomizationService.setGroup(key, choice === 'source' ? '' : choice);
    this.groupPickerFor = null;
    this.applyEdit();
    this.refocus = `ch:${PlaylistService.indexOfKey(key)}`;
    this.render();
  }

  /** Re-derive the channel list from the changed customization. */
  private applyEdit(): void {
    PlaylistService.applyCustomization();
    this.onChannelsChanged();
  }

  private editGroupKeys(): string[] {
    const keys = new Set<string>();
    for (const ch of PlaylistService.channels) {
      const key = groupKeyOf(ch);
      if (key) keys.add(key);
    }
    for (const name of ChannelCustomizationService.customGroups) keys.add(name);
    return ChannelCustomizationService.sortGroupKeys(Array.from(keys));
  }

  private renderGroupPicker(): Safe {
    return html`
      <div class="group-picker" data-nav-container>
        <div class="group-picker-title">${t('channel.editMoveToGroup')}</div>
        ${this.newGroupOpen
          ? html`<input class="edit-text-input" data-key="new-group" type="text"
                        placeholder="${t('channel.editNewGroupName')}">`
          : html`
            <div class="group-picker-list">
              <div class="group-picker-option" data-key="gp:source" data-focusable
                   data-group-choice="source">${t('channel.editSourceGroup')}</div>
              ${this.editGroupKeys().map(key => html`
                <div class="group-picker-option" data-key="gp:${key}" data-focusable
                     data-group-choice="${key}">${ChannelCustomizationService.groupLabel(key)}</div>
              `)}
              <div class="group-picker-option" data-key="gp:new" data-focusable
                   data-group-choice="new">${t('channel.editNewGroup')}</div>
            </div>
          `}
      </div>
    `;
  }

  private renderEditHints(): Safe {
    const grabbed = !!this.grabbed;
    return html`
      <div class="edit-hints">
        <span class="edit-hint"><span class="edit-key key-ok">OK</span>${
          grabbed ? t('channel.editDrop') : t('channel.editGrab')}</span>
        <button class="edit-hint edit-action" data-key="edit:green" data-focusable
                data-edit-action="green"><span class="edit-key key-green"></span>${
                  t('channel.editHide')}</button>
        <button class="edit-hint edit-action" data-key="edit:blue" data-focusable
                data-edit-action="blue"><span class="edit-key key-blue"></span>${
                  t('channel.editRename')}</button>
        <button class="edit-hint edit-action" data-key="edit:red" data-focusable
                data-edit-action="red"><span class="edit-key key-red"></span>${
                  t('channel.editGroup')}</button>
        <button class="edit-hint edit-action" data-key="edit:yellow" data-focusable
                data-edit-action="yellow">
          <span class="edit-key key-yellow"></span>
          <span class="edit-key-separator">/</span>
          <span class="edit-key key-back">${raw(BACK_ICON)}</span>
          ${t('channel.editDone')}
        </button>
      </div>
    `;
  }

  private renderGroup(g: { id: ChannelGroupId; label: string; builtin?: BuiltinChannelGroup }): Safe {
    const isSource = g.id.indexOf('source:') === 0;
    const key = isSource ? this.groupKeyForDisplay(g.label) : '';
    const hidden = isSource && ChannelCustomizationService.isGroupHidden(key);
    const grabbed = this.grabbed?.kind === 'group' && this.grabbed.key === key;
    const renaming = this.editing && this.renaming?.kind === 'group' && this.renaming.key === key;
    const count = g.id === 'builtin:recently-watched'
      ? this.recentItems.length
      : PlaylistService.getByGroup(g.id, this.currentPlaylist || undefined).length;

    return html`
      <div class="group-item ${g.id === this.currentGroup ? 'active' : ''} ${hidden ? 'hidden-entry' : ''} ${grabbed ? 'grabbed' : ''}"
           data-key="g:${g.id}"
           data-focusable data-group="${g.id}">
        <span class="group-icon">${raw(groupIcon(g.label, g.builtin))}</span>
        ${renaming
          ? html`<input class="edit-text-input" type="text" value="${g.label}">`
          : html`<span class="group-name">${g.label}</span>`}
        <span class="group-count">${count}</span>
      </div>
    `;
  }

  setPlaying(idx: number, catchupStart?: number | null): void {    this.playingIndex = idx;
    this.playingCatchupStart = catchupStart ?? null;
  }

  /** On entering the view: highlight the first channel (else the first focusable). */
  highlightEntryPoint(): void {
    const entry = this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]')
      ?? this.container.querySelector<HTMLElement>('[data-focusable]');
    if (entry) this.nav.focus(entry);
  }

  private renderChannel(ch: Channel, favs: string[]): Safe {
    const globalIdx = PlaylistService.indexOf(ch);
    const epgId = EpgService.findChannelId(ch);
    const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
    const isPlaying = globalIdx === this.playingIndex && this.playingCatchupStart === null;
    const customizationKey = channelKey(ch);
    const isFav = favs.includes(channelKey(ch));
    const hidden = ChannelCustomizationService.isChannelHidden(ch);
    const grabbed = this.grabbed?.kind === 'channel' && this.grabbed.key === customizationKey;
    const renaming = this.editing && this.renaming?.kind === 'channel'
      && this.renaming.key === customizationKey;

    return html`
      <div class="channel-item ${isPlaying ? 'playing' : ''} ${hidden ? 'hidden-entry' : ''} ${grabbed ? 'grabbed' : ''}"
           data-key="ch:${String(globalIdx)}"
           data-focusable data-channel-index="${globalIdx}">
        <div class="channel-number">${globalIdx + 1}</div>
        ${this.renderLogo(ch)}
        <div class="channel-info">
          ${renaming
            ? html`<input class="edit-text-input" type="text" value="${ch.name}">`
            : html`<div class="channel-name">${isFav ? raw('&#9733; ') : ''}${ch.name}</div>`}
          ${this.editing && ch.sourceName
            ? html`<div class="channel-now channel-source-name">${ch.sourceName}</div>`
            : (nowPlaying ? html`<div class="channel-now">${nowPlaying.title}</div>` : '')}
        </div>
        ${hidden ? html`<div class="hidden-badge">${t('channel.editHidden')}</div>` : ''}
        ${isPlaying ? raw('<div class="playing-indicator">&#9654;</div>') : ''}
      </div>
    `;
  }

  private renderRecentItem(item: RecentlyWatchedItem, index: number, favs: string[]): Safe {
    const isFav = favs.includes(channelKey(item.channel));
    if (item.kind === 'live') {
      const epgId = EpgService.findChannelId(item.channel);
      const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
      const isPlaying = item.channelIndex === this.playingIndex && this.playingCatchupStart === null;
      return html`
        <div class="channel-item recent-item recent-live ${isPlaying ? 'playing' : ''}"
             data-key="recent:live:${channelKey(item.channel)}"
             data-focusable data-recent-index="${index}" data-channel-index="${item.channelIndex}">
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
           data-focusable data-recent-index="${index}" data-channel-index="${item.channelIndex}">
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

}

// Escape a value for use inside a `[attr="..."]` selector. Only `\` and `"`
// matter. Avoids relying on `CSS.escape` which jsdom does not implement.
function attrSelectorEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
