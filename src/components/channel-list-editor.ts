import type { Action, Channel, ChannelGroupId } from '../types';
import type { SpatialNav } from '../navigation/spatial-nav';
import { html, raw, type Safe } from '../utils/dom';
import { channelKey, groupDisplayLabel } from '../utils/channel';
import { PlaylistService } from '../services/playlist-service';
import { ChannelCustomizationService, groupKeyOf } from '../services/channel-customization';
import { StorageService } from '../services/storage-service';
import { EpgService } from '../services/epg-service';
import type {
  EpgMappingCandidate,
  EpgMappingSearchEntry,
} from '../services/epg-service';
import { BACK_ICON, CHECK_ICON, CLOCK_ICON, GUIDE_ICON, SEARCH_ICON } from './icons';
import { showToast } from './toast';
import { t } from '../i18n';
import { CONFIG } from '../config';
import { VirtualList } from '../utils/virtual-list';
import { formatEpgOffset } from '../utils/epg-offset';
import { WorkerMappingSearch } from '../workers/mapping-search-client';
import { createLogger } from '../utils/logger';

const log = createLogger('ChannelEditor');

type EditTarget = { kind: 'channel'; key: string } | { kind: 'group'; key: string };
type DragCandidate = { target: EditTarget; x: number; y: number };

interface ChannelListEditorOptions {
  render: () => void;
  moveListFocus: (delta: number) => boolean;
  onChannelsChanged: () => void;
  onEpgMappingChanged: () => void;
  onEpgOffsetChanged: () => void;
  getCurrentGroup: () => ChannelGroupId;
  getCurrentPlaylist: () => string;
  setLocation: (group: ChannelGroupId, playlist: string) => void;
}

const DRAG_START_DISTANCE = 8;
const EPG_OPTION_HEIGHT = 72;
const EPG_VIEWPORT_HEIGHT = 420;
const EPG_OVERSCAN = 3;

export class ChannelListEditor {
  private favoriteSelection: Set<string> | null = null;
  private editing = false;
  private grabbed: EditTarget | null = null;
  private renaming: EditTarget | null = null;
  private groupPickerFor: string | null = null;
  private newGroupOpen = false;
  private epgPickerFor: string | null = null;
  private epgOffsetFor: string | null = null;
  private epgQuery = '';
  private epgCandidates: EpgMappingCandidate[] = [];
  private epgMappingEntries: EpgMappingSearchEntry[] = [];
  private epgCandidateRevision = -1;
  private epgSearchGeneration = 0;
  private epgSearchPending = false;
  private epgSearchResultQuery = '';
  private epgPendingFocusDelta = 0;
  private readonly epgSearch = new WorkerMappingSearch<EpgMappingSearchEntry>(
    'epg-mapping',
  );
  private epgFocusPosition = -1;
  private epgKeyboardVisible = false;
  private readonly epgVirtualizer = new VirtualList({
    itemSize: EPG_OPTION_HEIGHT,
    overscan: EPG_OVERSCAN,
    fallbackViewportSize: EPG_VIEWPORT_HEIGHT,
  });
  private epgScrollFrame: number | null = null;
  private epgKeyboardFrame: number | null = null;
  private refocus: string | null = null;
  private dragCandidate: DragCandidate | null = null;
  private pointerDragging = false;
  private suppressPointerClick = false;
  private pointerClickReset: ReturnType<typeof setTimeout> | null = null;
  private lastDragPlacement = '';
  private editActionTarget: EditTarget | null = null;

  constructor(
    private container: HTMLElement,
    private nav: SpatialNav,
    private options: ChannelListEditorOptions,
  ) {
    this.container.addEventListener('nav:hover', (event: Event) => {
      const target = event.target;
      const active = document.activeElement;
      if (!this.epgPickerFor || !this.epgKeyboardVisible
          || !(target instanceof HTMLElement)
          || target.dataset.epgPosition === undefined
          || !(active instanceof HTMLInputElement)
          || !active.classList.contains('epg-mapping-search')) return;
      this.updateEpgPointerHover(target);
      event.stopImmediatePropagation();
    }, true);
    this.container.addEventListener('mousedown', (event: MouseEvent) => {
      this.onPointerDown(event);
    });
    this.container.addEventListener('mousemove', (event: MouseEvent) => {
      if (event.target instanceof HTMLElement) this.updateEpgPointerHover(event.target);
      this.onPointerMove(event);
    });
    this.container.addEventListener('mouseup', () => this.finishPointerDrag());
    this.container.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const wrap = target.closest('.epg-mapping-search-wrap');
      const input = wrap?.querySelector<HTMLInputElement>('.epg-mapping-search');
      if (!input) return;
      event.stopImmediatePropagation();
      this.updateEpgPointerHover(null);
      input.focus();
      this.epgFocusPosition = -1;
    });
    this.container.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      if (event.target.classList.contains('epg-mapping-search')
          && (event.key === 'Escape' || event.keyCode === CONFIG.KEYS.ESC
            || event.keyCode === CONFIG.KEYS.BACK)) {
        event.preventDefault();
        event.stopPropagation();
        this.handleBack();
        return;
      }
      if (event.target.classList.contains('epg-mapping-search')
          && (event.key === 'ArrowDown' || event.keyCode === CONFIG.KEYS.DOWN)) {
        event.preventDefault();
        event.stopPropagation();
        this.moveEpgFocus(1);
        return;
      }
      if (event.key !== 'Enter' && event.keyCode !== CONFIG.KEYS.ENTER) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.target.classList.contains('epg-mapping-search')) {
        this.moveEpgFocus(1);
      } else {
        this.commitTextInput();
      }
    });
    this.container.addEventListener('input', (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)
          || !input.classList.contains('epg-mapping-search')) return;
      this.epgQuery = input.value;
      const generation = ++this.epgSearchGeneration;
      this.epgSearchPending = true;
      this.epgSearchResultQuery = '';
      this.epgFocusPosition = -1;
      this.epgPendingFocusDelta = 0;
      this.epgVirtualizer.setScrollOffset(0);
      input.dataset.searchPending = 'true';
      input.dataset.searchQuery = '';
      void this.updateEpgCandidates(generation);
    });
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)
          || !target.classList.contains('epg-mapping-list')) return;
      if (Math.abs(target.scrollTop - this.epgVirtualizer.scrollOffset) < 1) return;
      this.epgVirtualizer.setScrollOffset(target.scrollTop);
      if (this.epgFocusPosition >= 0) {
        const itemCount = this.epgCandidates.length + 1;
        const viewportHeight = target.clientHeight || EPG_VIEWPORT_HEIGHT;
        const firstVisible = Math.min(
          itemCount - 1,
          Math.ceil(target.scrollTop / EPG_OPTION_HEIGHT),
        );
        const lastVisible = Math.max(
          firstVisible,
          Math.min(
            itemCount - 1,
            Math.floor((target.scrollTop + viewportHeight) / EPG_OPTION_HEIGHT) - 1,
          ),
        );
        this.epgFocusPosition = Math.max(
          firstVisible,
          Math.min(this.epgFocusPosition, lastVisible),
        );
      }
      if (this.epgScrollFrame !== null) return;
      this.epgScrollFrame = requestAnimationFrame(() => {
        this.epgScrollFrame = null;
        this.options.render();
      });
    }, true);
    document.addEventListener('keyboardStateChange', (event: Event) => {
      const visible = (event as CustomEvent<{ visibility?: boolean }>).detail?.visibility;
      if (!this.epgPickerFor || typeof visible !== 'boolean') return;
      this.epgKeyboardVisible = visible;
      if (!visible) this.updateEpgPointerHover(null);
      this.container.querySelector('.epg-mapping-picker')
        ?.classList.toggle('keyboard-visible', visible);
      if (this.epgKeyboardFrame !== null) cancelAnimationFrame(this.epgKeyboardFrame);
      this.epgKeyboardFrame = requestAnimationFrame(() => {
        this.epgKeyboardFrame = null;
        if (this.epgPickerFor) this.options.render();
      });
    });
  }

  get isEditing(): boolean {
    return this.editing || this.favoriteSelection !== null;
  }

  get isChannelEditing(): boolean {
    return this.editing;
  }

  get isManagingFavorites(): boolean {
    return this.favoriteSelection !== null;
  }

  get hasGroupPicker(): boolean {
    return this.groupPickerFor !== null;
  }

  trackFocus(el: HTMLElement | null): void {
    if (this.epgPickerFor && this.epgKeyboardVisible
        && el?.dataset.epgPosition !== undefined) {
      return;
    }
    if (this.epgPickerFor && el?.dataset.epgPosition !== undefined) {
      this.epgFocusPosition = parseInt(el.dataset.epgPosition, 10);
    } else if (this.epgPickerFor && el?.classList.contains('epg-mapping-search')) {
      this.epgFocusPosition = -1;
    }
    const target = el ? this.editTargetForElement(el) : null;
    if (target) this.editActionTarget = target;
  }

  enterEditMode(group: ChannelGroupId): void {
    if (this.editing || group === 'builtin:recently-watched') return;
    this.options.setLocation(group, this.options.getCurrentPlaylist());
    this.favoriteSelection = null;
    this.editActionTarget = this.nav.focused
      ? this.editTargetForElement(this.nav.focused)
      : null;
    this.editing = true;
    this.grabbed = null;
    // Reveal hidden channels so they can be brought back.
    PlaylistService.setIncludeHidden(true);
    this.options.onChannelsChanged();
    this.options.render();
    showToast(t('channel.editModeOn'));
  }

  exitEditMode(): void {
    if (!this.editing && !this.favoriteSelection) return;
    const wasEditingChannels = this.editing;
    this.editing = false;
    this.favoriteSelection = null;
    this.grabbed = null;
    this.renaming = null;
    this.groupPickerFor = null;
    this.newGroupOpen = false;
    this.epgPickerFor = null;
    this.epgOffsetFor = null;
    this.epgQuery = '';
    this.epgCandidates = [];
    this.releaseEpgSearch();
    this.epgCandidateRevision = -1;
    this.epgFocusPosition = -1;
    this.epgKeyboardVisible = false;
    this.epgVirtualizer.setScrollOffset(0);
    this.editActionTarget = null;
    if (wasEditingChannels) {
      PlaylistService.setIncludeHidden(false);
      this.options.onChannelsChanged();
    }
    this.options.render();
  }

  private updateEpgPointerHover(target: HTMLElement | null): void {
    const candidate = this.epgPickerFor && this.epgKeyboardVisible
      ? target?.closest<HTMLElement>('[data-epg-position]') ?? null
      : null;
    this.container.querySelectorAll('.epg-mapping-option.pointer-hovered')
      .forEach(element => {
        if (element !== candidate) element.classList.remove('pointer-hovered');
      });
    candidate?.classList.add('pointer-hovered');
  }

  handleBack(): boolean {
    if (this.newGroupOpen) {
      this.newGroupOpen = false;
      this.options.render();
      return true;
    }
    if (this.epgPickerFor) {
      this.epgPickerFor = null;
      this.epgQuery = '';
      this.epgCandidates = [];
      this.releaseEpgSearch();
      this.epgCandidateRevision = -1;
      this.epgFocusPosition = -1;
      this.epgKeyboardVisible = false;
      this.epgVirtualizer.setScrollOffset(0);
      this.options.render();
      return true;
    }
    if (this.epgOffsetFor) {
      this.epgOffsetFor = null;
      this.options.render();
      return true;
    }
    if (this.groupPickerFor) {
      this.groupPickerFor = null;
      this.options.render();
      return true;
    }
    if (this.renaming) {
      this.renaming = null;
      this.options.render();
      return true;
    }
    if (this.favoriteSelection) {
      this.exitFavoriteManagement();
      return true;
    }
    if (this.editing) {
      this.exitEditMode();
      return true;
    }
    return false;
  }

  handleAction(action: Action): boolean {
    if (this.favoriteSelection) return this.handleFavoriteAction(action);
    if (!this.editing) return false;
    return this.handleEditAction(action);
  }

  enterFavoriteManagement(): void {
    if (this.editing || this.favoriteSelection) return;
    this.favoriteSelection = new Set();
    this.options.render();
  }

  toggleFocusedFavorite(): void {
    const focused = this.nav.focused;
    if (focused?.dataset.channelIndex === undefined) return;
    const channel = PlaylistService.getByIndex(parseInt(focused.dataset.channelIndex, 10));
    if (!channel) return;
    StorageService.toggleFavorite(channelKey(channel));
    this.favoriteSelection?.delete(channelKey(channel));
    this.options.render();
  }

  consumePointerClick(): boolean {
    if (!this.suppressPointerClick) return false;
    if (this.pointerClickReset) clearTimeout(this.pointerClickReset);
    this.pointerClickReset = null;
    this.suppressPointerClick = false;
    return true;
  }

  finishPointerDrag(): void {
    this.dragCandidate = null;
    this.lastDragPlacement = '';
    if (!this.pointerDragging) return;
    this.pointerDragging = false;
    this.grabbed = null;
    this.options.render();
    this.pointerClickReset = setTimeout(() => {
      this.suppressPointerClick = false;
      this.pointerClickReset = null;
    }, 0);
  }

  takeRefocusKey(previous: string | null): string | null {
    const key = this.refocus ?? previous;
    this.refocus = null;
    return key;
  }

  focusGroupPicker(): HTMLElement | null {
    if (this.epgOffsetFor) {
      return this.container.querySelector<HTMLElement>('[data-epg-offset-reset]');
    }
    if (this.epgPickerFor) {
      if (this.epgFocusPosition >= 0) {
        return this.container.querySelector<HTMLElement>(
          `[data-epg-position="${String(this.epgFocusPosition)}"]`,
        );
      }
      return this.container.querySelector<HTMLElement>('.epg-mapping-search');
    }
    if (this.groupPickerFor) {
      return this.container.querySelector<HTMLElement>('.group-picker [data-focusable]');
    }
    return null;
  }

  focusTextInput(): void {
    if (this.epgPickerFor && this.epgFocusPosition >= 0) {
      const option = this.container.querySelector<HTMLElement>(
        `[data-epg-position="${String(this.epgFocusPosition)}"]`,
      );
      if (option && document.activeElement !== option) option.focus({ preventScroll: true });
      return;
    }
    const input = this.container.querySelector<HTMLInputElement>(
      '.edit-text-input, .epg-mapping-search',
    );
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }

  groupKeyForDisplay(display: string): string {
    return PlaylistService.getGroupKeyForDisplay(display);
  }

  isGroupHidden(key: string): boolean {
    return ChannelCustomizationService.isGroupHidden(key);
  }

  isGroupGrabbed(key: string): boolean {
    return this.grabbed?.kind === 'group' && this.grabbed.key === key;
  }

  isGroupRenaming(key: string): boolean {
    return this.editing && this.renaming?.kind === 'group' && this.renaming.key === key;
  }

  isChannelHidden(channel: Channel): boolean {
    return ChannelCustomizationService.isChannelHidden(channel);
  }

  isChannelGrabbed(channel: Channel): boolean {
    return this.grabbed?.kind === 'channel' && this.grabbed.key === channelKey(channel);
  }

  isFavoriteSelected(channel: Channel): boolean {
    return this.favoriteSelection?.has(channelKey(channel)) ?? false;
  }

  isChannelRenaming(channel: Channel): boolean {
    return this.editing && this.renaming?.kind === 'channel'
      && this.renaming.key === channelKey(channel);
  }

  renderChannelEditStatus(channel: Channel): Safe | string {
    const hidden = this.isChannelHidden(channel);
    const selected = this.isFavoriteSelected(channel);
    const override = ChannelCustomizationService.overrideFor(channelKey(channel));
    const epgMapped = !!override?.epgChannelId;
    const epgOffset = override?.epgOffsetDeltaMinutes === undefined
      ? null
      : EpgService.getSourceOffsetMinutes(channel) + override.epgOffsetDeltaMinutes;
    return html`
      ${hidden ? html`<div class="hidden-badge">${t('channel.editHidden')}</div>` : ''}
      ${epgMapped
        ? html`
          <div class="epg-mapped-badge">
            <span class="epg-mapped-badge-value">${t('channel.editEpgMapped')}</span>
          </div>
        `
        : ''}
      ${epgOffset === null
        ? ''
        : html`
          <div class="epg-offset-badge" aria-label="${t('settings.timeCorrection')}">
            <span class="epg-offset-badge-icon">${raw(CLOCK_ICON)}</span>
            <span class="epg-offset-badge-value">${formatEpgOffset(epgOffset)}</span>
          </div>
        `}
      ${this.favoriteSelection
        ? html`<div class="favorite-checkbox">${selected ? raw(CHECK_ICON) : ''}</div>`
        : ''}
    `;
  }

  renderFooter(showFavoriteManage: boolean): Safe | string {
    if (this.editing) return this.renderEditHints();
    if (this.favoriteSelection) return this.renderFavoriteHints();
    return showFavoriteManage ? this.renderFavoriteManageHint() : '';
  }

  renderGroupPicker(): Safe | string {
    if (this.epgOffsetFor) return this.renderEpgOffsetPicker();
    if (this.epgPickerFor) return this.renderEpgPicker();
    if (!this.groupPickerFor) return '';
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
                     data-group-choice="${key}">${
                       groupDisplayLabel(ChannelCustomizationService.groupLabel(key))
                     }</div>
              `)}
              <div class="group-picker-option" data-key="gp:new" data-focusable
                   data-group-choice="new">${t('channel.editNewGroup')}</div>
            </div>
          `}
      </div>
    `;
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
    if (this.epgPickerFor) {
      if (action === 'up' || action === 'down') {
        this.moveEpgFocus(action === 'up' ? -1 : 1);
      }
      else if (action === 'select') this.chooseEpgOption();
      return true;
    }
    if (this.epgOffsetFor) {
      if (action === 'left' || action === 'right') {
        this.adjustEpgOffset(
          action === 'left'
            ? -CONFIG.EPG.OFFSET_STEP_MINUTES
            : CONFIG.EPG.OFFSET_STEP_MINUTES,
        );
      } else if (action === 'select') {
        const delta = this.nav.focused?.dataset.epgOffsetDelta;
        if (delta !== undefined) this.adjustEpgOffset(Number(delta));
        else if (this.nav.focused?.dataset.epgOffsetReset !== undefined) {
          this.resetEpgOffset();
        }
      } else if (action === 'up' || action === 'down') {
        this.nav.move(action);
      }
      return true;
    }

    const buttonAction = this.nav.focused?.dataset.editAction as Action | undefined;
    if (action === 'select' && buttonAction) return this.handleEditAction(buttonAction);
    if (action === 'select' && this.nav.focused?.dataset.epgAction !== undefined) {
      this.openEpgPicker();
      return true;
    }
    if (action === 'select' && this.nav.focused?.dataset.epgOffsetAction !== undefined) {
      this.openEpgOffsetPicker();
      return true;
    }

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

  private handleFavoriteAction(action: Action): boolean {
    const buttonAction = this.nav.focused?.dataset.favoriteAction as Action | undefined;
    if (action === 'select' && buttonAction) return this.handleFavoriteAction(buttonAction);

    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        if ((action === 'up' || action === 'down')
            && this.options.moveListFocus(action === 'up' ? -1 : 1)) return true;
        this.nav.move(action);
        return true;
      case 'channel_up':
        if (!this.options.moveListFocus(-1)) this.nav.move('up');
        return true;
      case 'channel_down':
        if (!this.options.moveListFocus(1)) this.nav.move('down');
        return true;
      case 'select':
        this.activateFavoriteTarget();
        return true;
      case 'blue':
        this.selectAllFavorites();
        return true;
      case 'red':
        this.removeSelectedFavorites();
        return true;
      case 'yellow':
        this.exitFavoriteManagement();
        return true;
      default:
        return true;
    }
  }

  private exitFavoriteManagement(): void {
    if (!this.favoriteSelection) return;
    this.favoriteSelection = null;
    this.options.render();
  }

  private activateFavoriteTarget(): void {
    const focused = this.nav.focused;
    if (!focused) return;
    if (focused.dataset.editChannels !== undefined) {
      this.enterEditMode(this.options.getCurrentGroup());
    } else if (focused.dataset.playlist !== undefined) {
      this.options.setLocation('builtin:all', focused.dataset.playlist);
      this.favoriteSelection = null;
      this.options.render();
    } else if (focused.dataset.group !== undefined) {
      this.options.setLocation(
        focused.dataset.group as ChannelGroupId,
        this.options.getCurrentPlaylist(),
      );
      this.favoriteSelection = null;
      this.options.render();
    } else {
      this.toggleFavoriteSelection();
    }
  }

  private toggleFavoriteSelection(): void {
    const focused = this.nav.focused;
    if (!this.favoriteSelection || focused?.dataset.channelIndex === undefined) return;
    const channel = PlaylistService.getByIndex(parseInt(focused.dataset.channelIndex, 10));
    if (!channel) return;
    const key = channelKey(channel);
    if (this.favoriteSelection.has(key)) this.favoriteSelection.delete(key);
    else this.favoriteSelection.add(key);
    this.options.render();
  }

  private selectAllFavorites(): void {
    const selection = this.favoriteSelection;
    if (!selection) return;
    const favorites = PlaylistService.getByGroup(
      'builtin:favorites',
      this.options.getCurrentPlaylist() || undefined,
    );
    const allSelected = favorites.length > 0
      && favorites.every(channel => selection.has(channelKey(channel)));
    selection.clear();
    if (!allSelected) {
      for (const channel of favorites) selection.add(channelKey(channel));
    }
    this.options.render();
  }

  private removeSelectedFavorites(): void {
    if (!this.favoriteSelection?.size) {
      showToast(t('channel.favoriteSelectFirst'));
      return;
    }
    const selected = this.favoriteSelection;
    const saved = StorageService.setFavorites(
      StorageService.getFavorites().filter(key => !selected.has(key)),
    );
    if (!saved) return;
    selected.clear();
    this.options.render();
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
      const channel = PlaylistService.getByIndex(parseInt(el.dataset.channelIndex, 10));
      return channel ? { kind: 'channel', key: channelKey(channel) } : null;
    }
    const group = el.dataset.group;
    if (group && group.indexOf('source:') === 0) {
      return { kind: 'group', key: this.groupKeyForDisplay(group.slice('source:'.length)) };
    }
    return null;
  }

  private toggleGrab(): void {
    const target = this.focusedTarget();
    if (!target) return;
    const same = this.grabbed && this.grabbed.kind === target.kind
      && this.grabbed.key === target.key;
    this.grabbed = same ? null : target;
    this.options.render();
  }

  private moveGrabbed(delta: number): void {
    const grabbed = this.grabbed;
    if (!grabbed) return;

    if (grabbed.kind === 'channel') {
      const list = PlaylistService.getByGroup(
        this.options.getCurrentGroup(),
        this.options.getCurrentPlaylist() || undefined,
      );
      const pos = list.findIndex(channel => channelKey(channel) === grabbed.key);
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
      this.options.render();
      return;
    }

    const visibleKeys = PlaylistService.getGroupsForPlaylist(
      this.options.getCurrentPlaylist() || undefined,
    ).map(display => this.groupKeyForDisplay(display));
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
    this.options.render();
  }

  private onPointerDown(event: MouseEvent): void {
    if (!this.editing || this.favoriteSelection || event.button !== 0 || this.renaming
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
      this.options.render();
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
    this.options.render();
  }

  private setDragRefocus(target: EditTarget): void {
    if (target.kind === 'channel') {
      this.refocus = `ch:${PlaylistService.indexOfKey(target.key)}`;
    }
  }

  private focusableAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    return el && this.container.contains(el) ? el : null;
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
    this.options.render();
  }

  private startRename(): void {
    const target = this.grabbed;
    if (!target) {
      showToast(t('channel.editSelectFirst'));
      return;
    }
    this.renaming = target;
    this.options.render();
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
      this.options.render();
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
    this.options.render();
  }

  private groupNameExists(targetKey: string | null, value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return this.editGroupKeys().some((key) => key !== targetKey
      && groupDisplayLabel(ChannelCustomizationService.groupLabel(key))
        .trim().toLowerCase() === normalized);
  }

  private openGroupPicker(): void {
    const target = this.grabbed;
    if (!target) {
      showToast(t('channel.editSelectFirst'));
      return;
    }
    if (target.kind !== 'channel') return;
    this.groupPickerFor = target.key;
    this.options.render();
  }

  private chooseGroupOption(): void {
    const choice = this.nav.focused?.dataset.groupChoice;
    const key = this.groupPickerFor;
    if (!choice || !key) return;
    if (choice === 'new') {
      this.newGroupOpen = true;
      this.options.render();
      return;
    }
    ChannelCustomizationService.setGroup(key, choice === 'source' ? '' : choice);
    this.groupPickerFor = null;
    this.applyEdit();
    this.refocus = `ch:${PlaylistService.indexOfKey(key)}`;
    this.options.render();
  }

  private openEpgPicker(): void {
    const target = this.grabbed;
    if (!target || target.kind !== 'channel') {
      showToast(t('channel.editSelectChannel'));
      return;
    }
    const index = PlaylistService.indexOfKey(target.key);
    const channel = PlaylistService.getByIndex(index);
    if (!channel) return;
    this.epgPickerFor = target.key;
    this.epgQuery = channel.sourceName ?? channel.name;
    this.startEpgSearch(channel);
    this.epgFocusPosition = -1;
    this.epgKeyboardVisible = false;
    this.epgVirtualizer.setScrollOffset(0);
    this.options.render();
  }

  private openEpgOffsetPicker(): void {
    const target = this.grabbed;
    if (!target || target.kind !== 'channel') {
      showToast(t('channel.editSelectChannel'));
      return;
    }
    const channel = PlaylistService.getByIndex(PlaylistService.indexOfKey(target.key));
    const epgId = channel ? EpgService.findChannelId(channel) : null;
    if (!channel || !epgId || !EpgService.programmes[epgId]?.length) {
      showToast(t('channel.editEpgOffsetUnavailable'));
      return;
    }
    this.epgOffsetFor = target.key;
    this.options.render();
  }

  private adjustEpgOffset(delta: number): void {
    const key = this.epgOffsetFor;
    if (!key || !Number.isFinite(delta)) return;
    const channel = PlaylistService.getByIndex(PlaylistService.indexOfKey(key));
    if (!channel) return;
    const source = EpgService.getSourceOffsetMinutes(channel);
    const deltaMinutes =
      ChannelCustomizationService.overrideFor(key)?.epgOffsetDeltaMinutes ?? 0;
    const current = source + deltaMinutes;
    const next = Math.max(
      -CONFIG.EPG.OFFSET_MAX_MINUTES,
      Math.min(CONFIG.EPG.OFFSET_MAX_MINUTES, current + delta),
    );
    ChannelCustomizationService.setEpgOffsetDelta(key, next - source);
    this.options.onEpgOffsetChanged();
    this.options.render();
  }

  private resetEpgOffset(): void {
    const key = this.epgOffsetFor;
    if (!key) return;
    ChannelCustomizationService.setEpgOffsetDelta(key, null);
    this.options.onEpgOffsetChanged();
    this.options.render();
  }

  private renderEpgOffsetPicker(): Safe | string {
    const key = this.epgOffsetFor;
    if (!key) return '';
    const channel = PlaylistService.getByIndex(PlaylistService.indexOfKey(key));
    if (!channel) return '';
    const source = EpgService.getSourceOffsetMinutes(channel);
    const deltaMinutes =
      ChannelCustomizationService.overrideFor(key)?.epgOffsetDeltaMinutes ?? 0;
    const current = source + deltaMinutes;
    return html`
      <div class="group-picker epg-offset-picker" data-nav-container>
        <div class="group-picker-title">${
          t('settings.timeCorrection')
        }: ${
          channel.name
        }</div>
        <div class="epg-offset-current">${formatEpgOffset(current)}</div>
        <div class="channel-epg-offset-controls">
          <button class="group-picker-option channel-epg-offset-step"
                  data-key="epg-offset:earlier"
                  data-focusable data-epg-offset-delta="-${CONFIG.EPG.OFFSET_STEP_MINUTES}"
                  aria-label="${t('settings.offsetEarlier')}">-</button>
          <button class="group-picker-option channel-epg-offset-source"
                  data-key="epg-offset:source"
                  data-focusable data-epg-offset-reset>
            ${t('channel.editEpgOffsetFollowSource', {
              offset: formatEpgOffset(source),
            })}
          </button>
          <button class="group-picker-option channel-epg-offset-step"
                  data-key="epg-offset:later"
                  data-focusable data-epg-offset-delta="${CONFIG.EPG.OFFSET_STEP_MINUTES}"
                  aria-label="${t('settings.offsetLater')}">+</button>
        </div>
        <div class="epg-offset-hint">${t('channel.editEpgOffsetHint')}</div>
        ${this.renderOverlayBackHint()}
      </div>
    `;
  }

  private renderOverlayBackHint(): Safe {
    return html`
      <div class="channel-edit-overlay-back">
        <span class="edit-key key-back">${raw(BACK_ICON)}</span>
        ${t('common.back')}
      </div>
    `;
  }

  private startEpgSearch(channel: Channel): void {
    const generation = ++this.epgSearchGeneration;
    this.epgMappingEntries = EpgService.getMappingSearchEntries(channel);
    this.epgCandidates = [];
    this.epgSearchPending = true;
    this.epgSearchResultQuery = '';
    this.epgPendingFocusDelta = 0;
    this.epgCandidateRevision = EpgService.mappingRevision;
    void this.updateEpgCandidates(generation);
  }

  private async updateEpgCandidates(generation: number): Promise<void> {
    const key = this.epgPickerFor;
    const channel = key
      ? PlaylistService.getByIndex(PlaylistService.indexOfKey(key))
      : null;
    if (!key || !channel) return;
    const query = this.epgQuery;
    try {
      const candidates = await this.epgSearch.query(
        this.epgMappingEntries,
        query,
        ChannelCustomizationService.overrideFor(key)?.epgChannelId ?? '',
      );
      if (generation !== this.epgSearchGeneration
          || key !== this.epgPickerFor
          || query !== this.epgQuery) return;
      this.epgCandidates = candidates;
    } catch (error) {
      if (generation !== this.epgSearchGeneration || key !== this.epgPickerFor) return;
      log.error(
        'Worker search failed; using main-thread fallback',
        'event=search.worker.fallback.used',
        'scope=mapping',
        'owner=epg-mapping',
        error,
      );
      this.epgCandidates = EpgService.getLocalMappingCandidates(channel, query);
    }
    this.epgSearchPending = false;
    this.epgSearchResultQuery = query;
    while (this.epgPendingFocusDelta !== 0) {
      const delta = this.epgPendingFocusDelta > 0 ? 1 : -1;
      this.epgPendingFocusDelta -= delta;
      const next = this.epgFocusPosition < 0
        ? (delta > 0 ? 0 : -1)
        : this.epgFocusPosition + delta;
      this.epgFocusPosition = next < 0
        ? -1
        : Math.min(this.epgCandidates.length, next);
    }
    if (this.epgFocusPosition >= 0) {
      const list = this.container.querySelector<HTMLElement>('.epg-mapping-list');
      this.epgVirtualizer.ensureVisible(
        this.epgFocusPosition,
        list?.clientHeight || EPG_VIEWPORT_HEIGHT,
      );
    }
    this.options.render();
  }

  private releaseEpgSearch(): void {
    this.epgSearchGeneration++;
    this.epgMappingEntries = [];
    this.epgSearchPending = false;
    this.epgSearchResultQuery = '';
    this.epgPendingFocusDelta = 0;
    this.epgSearch.release();
  }

  private moveEpgFocus(delta: number): void {
    if (!this.epgPickerFor) return;
    if (this.epgSearchPending) {
      this.epgPendingFocusDelta += delta;
      return;
    }
    const itemCount = this.epgCandidates.length + 1;
    const next = this.epgFocusPosition < 0
      ? (delta > 0 ? 0 : -1)
      : this.epgFocusPosition + delta;
    if (next < 0) {
      this.epgFocusPosition = -1;
      this.options.render();
      return;
    }
    this.epgFocusPosition = Math.min(itemCount - 1, next);
    const list = this.container.querySelector<HTMLElement>('.epg-mapping-list');
    this.epgVirtualizer.ensureVisible(
      this.epgFocusPosition,
      list?.clientHeight || EPG_VIEWPORT_HEIGHT,
    );
    this.options.render();
  }

  private chooseEpgOption(): void {
    const id = this.nav.focused?.dataset.epgChannel;
    const key = this.epgPickerFor;
    if (id === undefined || !key) return;
    ChannelCustomizationService.setEpgChannel(key, id);
    this.epgPickerFor = null;
    this.epgQuery = '';
    this.epgCandidates = [];
    this.releaseEpgSearch();
    this.epgCandidateRevision = -1;
    this.epgFocusPosition = -1;
    this.epgKeyboardVisible = false;
    this.epgVirtualizer.setScrollOffset(0);
    this.refocus = `ch:${PlaylistService.indexOfKey(key)}`;
    this.options.onEpgMappingChanged();
    this.options.render();
  }

  private renderEpgPicker(): Safe | string {
    const key = this.epgPickerFor;
    if (!key) return '';
    const channel = PlaylistService.getByIndex(PlaylistService.indexOfKey(key));
    if (!channel) return '';
    if (this.epgCandidateRevision !== EpgService.mappingRevision) {
      this.startEpgSearch(channel);
    }
    const current = ChannelCustomizationService.overrideFor(key)?.epgChannelId ?? '';
    const candidates = this.epgCandidates;
    const itemCount = candidates.length + 1;
    const previousList = this.container.querySelector<HTMLElement>('.epg-mapping-list');
    const viewportHeight = previousList?.clientHeight || EPG_VIEWPORT_HEIGHT;
    const range = this.epgVirtualizer.getRange(itemCount, viewportHeight);
    const candidateStart = Math.max(0, range.start - 1);
    const candidateEnd = Math.max(0, range.end - 1);
    const totalHeight = this.epgVirtualizer.getTotalSize(itemCount)
      + (candidates.length ? 0 : 48);
    return html`
      <div class="group-picker epg-mapping-picker ${
        this.epgKeyboardVisible ? 'keyboard-visible' : ''
      }" data-nav-container>
        <div class="epg-mapping-heading">
          <div class="group-picker-title">${
            t('channel.editEpgTitle', { name: channel.name })
          }</div>
        </div>
        <label class="epg-mapping-search-wrap">
          <span class="epg-mapping-search-icon">${raw(SEARCH_ICON)}</span>
          <input class="epg-mapping-search" data-key="epg-search"
                 type="text" value="${this.epgQuery}"
                 data-search-query="${this.epgSearchResultQuery}"
                 data-search-pending="${this.epgSearchPending ? 'true' : 'false'}"
                 placeholder="${t('channel.editEpgSearch')}">
        </label>
        <div class="group-picker-list epg-mapping-list">
          <div class="epg-mapping-spacer" style="height:${totalHeight}px">
            ${range.start === 0
              ? html`
                <div class="group-picker-option epg-mapping-option ${
                  current ? '' : 'active'
                }" style="top:0px" data-key="epg:auto" data-focusable
                     tabindex="-1" data-epg-position="0" data-epg-channel="">
                  <span>${t('channel.editEpgAutomatic')}</span>
                </div>
              `
              : ''}
            ${candidates.slice(candidateStart, candidateEnd).map((candidate, offset) => {
              const position = candidateStart + offset + 1;
              return html`
                <div class="group-picker-option epg-mapping-option ${
                  candidate.id === current ? 'active' : ''
                }" style="top:${this.epgVirtualizer.getItemOffset(position)}px"
                     data-key="epg:${candidate.id}" data-focusable
                     tabindex="-1" data-epg-position="${position}"
                     data-epg-channel="${candidate.id}">
                  <span class="epg-mapping-name">${candidate.name}</span>
                  <span class="epg-mapping-meta">${candidate.channelId} - ${
                    candidate.sourceName
                  }</span>
                </div>
              `;
            })}
            ${!candidates.length
              ? html`<div class="epg-mapping-empty">${t('channel.editEpgEmpty')}</div>`
              : ''}
          </div>
        </div>
        ${this.renderOverlayBackHint()}
      </div>
    `;
  }

  syncEpgPickerScroll(): void {
    const list = this.container.querySelector<HTMLElement>('.epg-mapping-list');
    if (list && Math.abs(list.scrollTop - this.epgVirtualizer.scrollOffset) >= 1) {
      list.scrollTop = this.epgVirtualizer.scrollOffset;
    }
  }

  /** Re-derive the channel list from the changed customization. */
  private applyEdit(): void {
    PlaylistService.applyCustomization();
    this.options.onChannelsChanged();
  }

  private editGroupKeys(): string[] {
    const keys = new Set<string>();
    for (const channel of PlaylistService.channels) {
      const key = groupKeyOf(channel);
      if (key) keys.add(key);
    }
    for (const name of ChannelCustomizationService.customGroups) keys.add(name);
    return ChannelCustomizationService.sortGroupKeys(Array.from(keys));
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
        <button class="edit-hint edit-action" data-key="edit:epg" data-focusable
                data-epg-action>
          <span class="edit-action-icon">${raw(GUIDE_ICON)}</span>
          ${t('channel.editEpg')}
        </button>
        <button class="edit-hint edit-action" data-key="edit:epg-offset" data-focusable
                data-epg-offset-action>
          <span class="edit-action-icon">${raw(CLOCK_ICON)}</span>
          ${t('settings.timeCorrection')}
        </button>
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

  private renderFavoriteHints(): Safe {
    const selected = this.favoriteSelection?.size ?? 0;
    const total = PlaylistService.getByGroup(
      'builtin:favorites',
      this.options.getCurrentPlaylist() || undefined,
    ).length;
    const selectAllLabel = total > 0 && selected === total
      ? t('channel.favoriteDeselectAll')
      : t('channel.favoriteSelectAll');
    return html`
      <div class="edit-hints favorite-hints">
        <span class="edit-hint"><span class="edit-key key-ok">OK</span>${
          t('channel.favoriteSelect')}</span>
        <button class="edit-hint edit-action" data-key="favorite:blue" data-focusable
                data-favorite-action="blue"><span class="edit-key key-blue"></span>${
                  selectAllLabel}</button>
        <button class="edit-hint edit-action" data-key="favorite:red" data-focusable
                data-favorite-action="red"><span class="edit-key key-red"></span>${
                  t('channel.favoriteRemoveSelected', { count: selected })}</button>
        <button class="edit-hint edit-action" data-key="favorite:yellow" data-focusable
                data-favorite-action="yellow">
          <span class="edit-key key-yellow"></span>
          <span class="edit-key-separator">/</span>
          <span class="edit-key key-back">${raw(BACK_ICON)}</span>
          ${t('channel.editDone')}
        </button>
      </div>
    `;
  }

  private renderFavoriteManageHint(): Safe {
    return html`
      <div class="edit-hints favorite-manage-hint">
        <button class="edit-hint edit-action" data-key="favorite:manage"
                data-focusable data-favorite-manage>
          ${t('channel.favoriteManage')}
        </button>
      </div>
    `;
  }
}
