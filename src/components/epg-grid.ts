import type {
  Action,
  NumberEvent,
  CatchupInfo,
  CatchupProgressEntry,
  Channel,
  ChannelGroupId,
  ChannelScope,
  Programme,
} from '../types';
import { html, inShownView, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelKey, groupDisplayLabel, legacyChannelKey } from '../utils/channel';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { ReminderService } from '../services/reminder-service';
import { XtreamArchiveService } from '../services/xtream-archive';
import { CatchupResumePrompt } from './catchup-resume-prompt';
import { showToast } from './toast';
import { formatTime, formatDayLabel, displayDayKey, startOfDisplayDay, addDisplayDays, formatDuration } from '../utils/time';
import { rankByName } from '../utils/channel-search';
import { CONFIG } from '../config';
import { bellIcon, CHEVRON_LEFT_ICON, REPLAY_ICON, SEARCH_ICON } from './icons';
import { channelLockBadge } from './parental-badge';
import { getLocale, t, tp, type SupportedLocale } from '../i18n';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { WorkerListSearch } from '../workers/list-search-client';
import { isIndexRetryPending } from '../workers/index-retry';
import { createLogger } from '../utils/logger';
import { liveBadge } from './live-badge';
import { Focus, Tier, type FocusScope, type Via } from '../navigation/focus-scope';
import { InputMode } from '../navigation/input-mode';

const log = createLogger('EpgGrid');

function keyIndex(key: string, prefix: string): number {
  return key.indexOf(prefix) === 0 ? Number(key.slice(prefix.length)) : -1;
}

const KEY_SELECTORS: Record<string, string> = {
  tab: '#epg-playlists [data-playlist-index="%"]',
  channel: '#epg-channels [data-channel-idx="%"]',
  day: '#epg-dates [data-day-index="%"]',
  prog: '#epg-programmes [data-prog-idx="%"]',
  'filter:group': '.epg-group-button',
  'filter:search': '.epg-search-wrap',
  legend: '.epg-reminder-entry',
};

type FocusCol = 'playlists' | 'filters' | 'channels' | 'dates' | 'legend' | 'programmes';
type FilterFocus = 'group' | 'search';
type VisibleChannel = { channel: Channel; globalIndex: number };
type GroupOption = { id: ChannelGroupId; label: string; count: number };

const CHANNEL_ROW_SIZE = 72;
const GROUP_ROW_SIZE = 44;
// Seed sizes only: rows are content-sized (a one-line description is shorter
// than a two-line one), so the real heights are measured after each render.
const PROGRAMME_ROW_ESTIMATE = 80;
const PROGRAMME_WITH_DESCRIPTION_ESTIMATE = 108;
const VIRTUAL_OVERSCAN = 8;
const EPG_VIEWPORT_FALLBACK = 900;

export class EpgGrid {
  private container: HTMLElement;
  private onChannelSelect: (index: number, catchup?: CatchupInfo, scope?: ChannelScope) => void;
  private onRevealTabBar?: () => void;
  private onManageReminders?: () => void;
  private selectedChannelIdx = 0;
  private selectedPlaylist = '';
  private playlistFocusIdx = 0;
  private selectedGroup: ChannelGroupId = 'builtin:all';
  private groupOpen = false;
  private groupFocusIdx = 0;
  private filterFocus: FilterFocus = 'group';
  private searchQuery = '';
  private selectedDay = 0;
  private dayInitialized = false;
  private focusCol: FocusCol = 'channels';
  private focusProg = 0;
  private resumePrompt = new CatchupResumePrompt('prompt.epg');
  private archiveLoadingKey = '';
  private readonly channelVirtualizer = new VirtualList({
    itemSize: CHANNEL_ROW_SIZE,
    overscan: VIRTUAL_OVERSCAN,
    fallbackViewportSize: EPG_VIEWPORT_FALLBACK,
  });
  private readonly programmeVirtualizer = new VirtualList({
    overscan: VIRTUAL_OVERSCAN,
    fallbackViewportSize: EPG_VIEWPORT_FALLBACK,
  });
  private readonly groupVirtualizer = new VirtualList({
    itemSize: GROUP_ROW_SIZE,
    overscan: VIRTUAL_OVERSCAN,
    fallbackViewportSize: 400,
  });
  private groupOptions: GroupOption[] = [];
  private groupOptionsChannels: Channel[] | null = null;
  private groupOptionsPlaylist = '';
  private groupOptionsRevision = -1;
  private groupOptionsLocale: SupportedLocale | null = null;
  private visibleChannelRoot: Channel[] | null = null;
  private visibleChannelGroup: ChannelGroupId = 'builtin:all';
  private visibleChannelPlaylist = '';
  private visibleChannelRevision = -1;
  private visibleChannels: VisibleChannel[] = [];
  private channelSearchResults: VisibleChannel[] | null = null;
  private channelSearchResultSource: VisibleChannel[] | null = null;
  private channelSearchResultQuery = '';
  private channelSearchPending = false;
  private channelSearchGeneration = 0;
  private readonly channelSearch = new WorkerListSearch(
    'epg-grid',
    'names',
    (item: VisibleChannel) => [item.channel.name],
  );
  private programmeSource: Programme[] | null = null;
  private programmeSizeKey = '';
  private programmeCount = 0;
  private measuredProgrammes = new Set<number>();
  private programmeMeasureFrame: number | null = null;
  private programmeMeasureGeneration = 0;
  private scrollFrame: number | null = null;
  private readonly scrollGuard = new VirtualScrollGuard();
  // State keeps the Guide's position; the scopes hold its key and own the
  // ring and its reveal. The group menu is pushed over the grid while open.
  readonly focusScope: FocusScope;
  private readonly groupScope: FocusScope;
  private groupScopePushed = false;
  private dateCount = 0;

  constructor(
    container: HTMLElement,
    onChannelSelect: (index: number, catchup?: CatchupInfo, scope?: ChannelScope) => void,
    onRevealTabBar?: () => void,
    onManageReminders?: () => void,
  ) {
    this.container = container;
    this.onChannelSelect = onChannelSelect;
    this.onRevealTabBar = onRevealTabBar;
    this.onManageReminders = onManageReminders;
    this.focusScope = Focus.register({
      id: 'guide.grid',
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.gridKey(),
      resolve: (key) => this.resolveGridKey(key),
      has: (key) => this.hasRow(key),
      reveal: (key) => this.revealGridKey(key),
      // A caret left in the search box keeps the arrow keys from whatever owns them.
      onRelease: () => this.blurSearchInput(),
    });
    this.groupScope = Focus.register({
      id: 'guide.groups',
      root: () => this.container.querySelector<HTMLElement>('.epg-group-menu'),
      restrict: 'self-only',
      tier: Tier.overlay,
      when: () => this.groupOpen && inShownView(this.container),
      defaultKey: () => `group:${String(this.groupFocusIdx)}`,
      resolve: (key) => this.groupOption(keyIndex(key, 'group:')),
      has: (key) => {
        const index = keyIndex(key, 'group:');
        return index >= 0 && index < this.getGroupOptions().length;
      },
      reveal: (key) => {
        const index = keyIndex(key, 'group:');
        return this.revealRow(this.container.querySelector<HTMLElement>('.epg-group-options'),
          () => this.groupOption(index), this.groupVirtualizer, index);
      },
    });
    this.bindEvents();
  }

  private currentScope(): ChannelScope {
    return { group: this.selectedGroup, playlist: this.selectedPlaylist || undefined };
  }

  /** Re-snap the day selection to "today". Called on a full reload: the display
   *  timezone may have changed, which shifts the day boundaries and makes the
   *  remembered day *index* point at the wrong day. */
  resetDay(): void {
    this.dayInitialized = false;
    this.selectedDay = 0;
    this.focusProg = 0;
  }

  focusChannel(channelIndex: number): void {
    const visible = this.getVisibleChannels();
    this.selectedChannelIdx = visible.some(item => item.globalIndex === channelIndex)
      ? channelIndex
      : visible[0]?.globalIndex ?? -1;
    this.focusCol = 'channels';
    this.focusProg = 0;
    this.groupOpen = false;
    this.syncGroupScope();
  }

  focusReminderEntry(): void {
    this.focusCol = 'legend';
    this.render();
  }

  /** Whether the catch-up resume prompt is currently visible. */
  get isPromptVisible(): boolean {
    return this.resumePrompt.visible;
  }

  get isFilterOpen(): boolean {
    return this.groupOpen || this.searchInputFocused();
  }

  /** Dismiss the catch-up resume prompt if it is open. */
  dismissPrompt(): void {
    if (this.resumePrompt.visible) this.resumePrompt.hide();
  }

  deactivateFilters(): void {
    this.groupOpen = false;
    this.syncGroupScope();
    this.channelSearchGeneration++;
    this.channelSearch.release();
    this.channelSearchPending = false;
    this.container.querySelector<HTMLInputElement>('.epg-search-input')?.blur();
  }

  private getDateOptions(): Date[] {
    // Day columns span the earliest..latest program START. Using start (not
    // stop) means a program that merely runs past midnight doesn't add an
    // empty day column for the day it spills into — it belongs to its start day.
    let minStart = Infinity;
    let maxStart = -Infinity;
    for (const progs of Object.values(EpgService.programmes)) {
      if (!progs.length) continue;
      const first = progs[0].start.getTime();
      const last = progs[progs.length - 1].start.getTime();
      if (first < minStart) minStart = first;
      if (last > maxStart) maxStart = last;
    }
    if (minStart === Infinity) return [];

    const firstDay = startOfDisplayDay(new Date(minStart));
    const lastDay = startOfDisplayDay(new Date(maxStart));

    const opts: Date[] = [];
    let cur = firstDay;
    while (cur.getTime() <= lastDay.getTime()) {
      opts.push(cur);
      cur = addDisplayDays(cur, 1);
    }
    return opts;
  }

  private findTodayIndex(options: Date[]): number {
    if (!options.length) return 0;
    const todayMs = startOfDisplayDay(new Date()).getTime();
    for (let i = 0; i < options.length; i++) {
      if (options[i].getTime() === todayMs) return i;
    }
    return todayMs < options[0].getTime() ? 0 : options.length - 1;
  }

  private getCurrentProgrammes(): Programme[] {
    const channel = PlaylistService.channels[this.selectedChannelIdx];
    if (!channel) return [];
    const epgId = EpgService.findChannelId(channel);
    if (!epgId) return [];
    const options = this.getDateOptions();
    const dayStart = options[this.selectedDay];
    if (!dayStart) return [];
    const dayEnd = addDisplayDays(dayStart, 1).getTime();
    const from = dayStart.getTime();
    // Bucket each program by the day it STARTS, so one spanning midnight shows
    // on its start day only — not as a stray previous-day entry atop the next day.
    return EpgService.getProgrammesStartingInRange(epgId, from, dayEnd);
  }

  private getVisibleChannels(): VisibleChannel[] {
    const scopeChanged = this.visibleChannelRoot !== PlaylistService.channels
      || this.visibleChannelGroup !== this.selectedGroup
      || this.visibleChannelPlaylist !== this.selectedPlaylist
      || this.visibleChannelRevision !== PlaylistService.groupsRevision;
    if (scopeChanged) {
      const source = PlaylistService.getByGroup(
        this.selectedGroup,
        this.selectedPlaylist || undefined,
      );
      this.visibleChannelRoot = PlaylistService.channels;
      this.visibleChannelGroup = this.selectedGroup;
      this.visibleChannelPlaylist = this.selectedPlaylist;
      this.visibleChannelRevision = PlaylistService.groupsRevision;
      this.visibleChannels = source.map(channel => ({
        channel,
        globalIndex: PlaylistService.indexOf(channel),
      }));
      if (this.searchQuery.trim()) {
        const generation = ++this.channelSearchGeneration;
        this.channelSearchResults = null;
        this.channelSearchResultSource = null;
        this.channelSearchResultQuery = '';
        this.channelSearchPending = true;
        void this.updateChannelSearch(generation);
      }
    }
    const query = this.searchQuery.trim();
    if (!query) return this.visibleChannels;
    return this.channelSearchResultSource === this.visibleChannels
        && this.channelSearchResultQuery === query
      ? this.channelSearchResults ?? []
      : [];
  }

  private async updateChannelSearch(generation: number): Promise<void> {
    const query = this.searchQuery.trim();
    if (!query) return;
    this.getVisibleChannels();
    const source = this.visibleChannels;
    let results: VisibleChannel[];
    try {
      results = await this.channelSearch.query(source, query);
    } catch (error) {
      if (generation !== this.channelSearchGeneration) return;
      if (!isIndexRetryPending(error)) {
        log.error(
          'Worker search failed; using main-thread fallback',
          'event=search.worker.fallback.used',
          'scope=list',
          'owner=epg-grid',
          error,
        );
      }
      const ranked = rankByName(source.map(item => item.channel), query);
      const byChannel = new Map(source.map(item => [item.channel, item]));
      results = ranked.map(channel => byChannel.get(channel)!);
    }
    if (generation !== this.channelSearchGeneration
        || query !== this.searchQuery.trim()) return;
    this.channelSearchResults = results;
    this.channelSearchResultSource = source;
    this.channelSearchResultQuery = query;
    this.channelSearchPending = false;
    this.render();
  }

  private getGroupOptions(): GroupOption[] {
    const playlist = this.selectedPlaylist || undefined;
    if (this.groupOptionsChannels === PlaylistService.channels
        && this.groupOptionsPlaylist === this.selectedPlaylist
        && this.groupOptionsRevision === PlaylistService.groupsRevision
        && this.groupOptionsLocale === getLocale()) {
      return this.groupOptions;
    }
    const groups = PlaylistService.getGroupsForPlaylist(playlist);
    this.groupOptionsChannels = PlaylistService.channels;
    this.groupOptionsPlaylist = this.selectedPlaylist;
    this.groupOptionsRevision = PlaylistService.groupsRevision;
    this.groupOptionsLocale = getLocale();
    this.groupOptions = [
      {
        id: 'builtin:all',
        label: t('common.all'),
        count: PlaylistService.getGroupCount('builtin:all', playlist),
      },
      {
        id: 'builtin:favorites',
        label: t('channel.favorites'),
        count: PlaylistService.getGroupCount('builtin:favorites', playlist),
      },
      ...groups.map(group => ({
        id: `source:${group}` as const,
        label: groupDisplayLabel(group),
        count: PlaylistService.getGroupCount(`source:${group}`, playlist),
      })),
    ];
    return this.groupOptions;
  }

  private selectPlaylist(id: string): void {
    this.selectedPlaylist = id;
    this.selectedGroup = 'builtin:all';
    this.groupOpen = false;
    const visible = this.getVisibleChannels();
    this.selectedChannelIdx = visible[0]?.globalIndex ?? -1;
    this.focusProg = 0;
  }

  private selectGroup(id: ChannelGroupId): void {
    this.selectedGroup = id;
    this.groupOpen = false;
    const visible = this.getVisibleChannels();
    this.selectedChannelIdx = visible[0]?.globalIndex ?? -1;
    this.focusProg = 0;
  }

  private openGroupMenu(): void {
    const groups = this.getGroupOptions();
    const favorites = groups.find(group => group.id === 'builtin:favorites');
    if (favorites) {
      favorites.count = PlaylistService.getGroupCount(
        'builtin:favorites',
        this.selectedPlaylist || undefined,
      );
    }
    this.groupFocusIdx = Math.max(0, groups.findIndex(group => group.id === this.selectedGroup));
    this.groupVirtualizer.centerOn(this.groupFocusIdx, 400);
    this.groupOpen = true;
    this.focusCol = 'filters';
    this.filterFocus = 'group';
    this.render();
  }

  private openSearchInput(): void {
    this.groupOpen = false;
    this.focusCol = 'filters';
    this.filterFocus = 'search';
    this.render();
    const input = this.container.querySelector<HTMLInputElement>('.epg-search-input');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  // Each way out of the search box sets where the ring lands before the caret
  // goes, so the focusout paint never reveals a programme hovered meanwhile.
  private exitSearchToChannels(): void {
    const visible = this.getVisibleChannels();
    this.focusCol = visible.length ? 'channels' : 'filters';
    if (visible.length && this.selectedChannelIdx < 0) {
      this.selectedChannelIdx = visible[0].globalIndex;
    }
    this.container.querySelector<HTMLInputElement>('.epg-search-input')?.blur();
    this.render();
    this.paint('key');
  }

  private blurSearchInput(): void {
    if (this.searchInputFocused()) {
      this.container.querySelector<HTMLInputElement>('.epg-search-input')!.blur();
    }
  }

  private searchInputFocused(): boolean {
    return this.container.querySelector('.epg-search-input') === document.activeElement;
  }

  // Only opening the Guide places the lists on the focus; after that the
  // scopes reveal it on input, so a background refresh never scrolls.
  render(placeFocus = false): void {
    const tabs = PlaylistService.playlistTabs;
    if (this.selectedPlaylist && !tabs.some(tab => tab.id === this.selectedPlaylist)) {
      this.selectedPlaylist = '';
    }
    const showTabs = tabs.length > 1;
    const tabIds = ['', ...tabs.map(tab => tab.id)];
    this.playlistFocusIdx = Math.max(0, Math.min(this.playlistFocusIdx, tabIds.length - 1));
    const groups = this.getGroupOptions();
    if (this.selectedGroup && !groups.some(group => group.id === this.selectedGroup)) {
      this.selectedGroup = 'builtin:all';
    }
    this.groupFocusIdx = Math.max(0, Math.min(this.groupFocusIdx, groups.length - 1));
    const visibleChannels = this.getVisibleChannels();
    if (!visibleChannels.some(item => item.globalIndex === this.selectedChannelIdx)) {
      this.selectedChannelIdx = visibleChannels[0]?.globalIndex ?? -1;
      this.focusProg = 0;
    }
    if (!showTabs && this.focusCol === 'playlists') this.focusCol = 'filters';

    const channel = PlaylistService.channels[this.selectedChannelIdx];
    const dateOptions = this.getDateOptions();
    this.dateCount = dateOptions.length;
    if (dateOptions.length > 0) {
      if (!this.dayInitialized) {
        this.selectedDay = this.findTodayIndex(dateOptions);
        this.dayInitialized = true;
      } else {
        this.selectedDay = Math.max(0, Math.min(this.selectedDay, dateOptions.length - 1));
      }
    }
    const todayMs = startOfDisplayDay(new Date()).getTime();
    const programmes = this.getCurrentProgrammes();
    this.programmeCount = programmes.length;
    const epgId = channel ? EpgService.findChannelId(channel) : null;
    const programmeSource = epgId ? EpgService.programmes[epgId] ?? null : null;
    if (programmeSource !== this.programmeSource) {
      this.programmeSource = programmeSource;
      this.programmeSizeKey = '';
    }
    const programmeSizeKey = [
      this.selectedChannelIdx,
      this.selectedDay,
      programmes.length,
      programmes[0]?.start.getTime() ?? '',
      programmes[programmes.length - 1]?.start.getTime() ?? '',
    ].join(':');
    if (programmeSizeKey !== this.programmeSizeKey) {
      this.programmeSizeKey = programmeSizeKey;
      this.measuredProgrammes.clear();
      this.programmeVirtualizer.setItemSizes(programmes.map(programme =>
        programme.description
          ? PROGRAMME_WITH_DESCRIPTION_ESTIMATE
          : PROGRAMME_ROW_ESTIMATE));
    }
    this.loadArchiveAvailability(channel);
    const previousChannelList = this.container.querySelector<HTMLElement>('.epg-channel-list');
    const previousProgrammeList = this.container.querySelector<HTMLElement>('.epg-programmes-pane');
    const previousGroupList = this.container.querySelector<HTMLElement>('.epg-group-options');
    if (previousChannelList) {
      this.channelVirtualizer.setScrollOffset(previousChannelList.scrollTop);
    }
    if (previousProgrammeList) {
      this.programmeVirtualizer.setScrollOffset(previousProgrammeList.scrollTop);
    }
    if (previousGroupList) {
      this.groupVirtualizer.setScrollOffset(previousGroupList.scrollTop);
    }
    const channelViewport = previousChannelList?.clientHeight || EPG_VIEWPORT_FALLBACK;
    const programmeViewport = previousProgrammeList?.clientHeight || EPG_VIEWPORT_FALLBACK;
    const selectedVisibleIdx = visibleChannels.findIndex(
      item => item.globalIndex === this.selectedChannelIdx,
    );
    if (placeFocus && this.focusCol === 'channels') {
      this.channelVirtualizer.ensureVisible(selectedVisibleIdx, channelViewport);
    }
    if (placeFocus && this.focusCol === 'programmes') {
      this.programmeVirtualizer.ensureVisible(this.focusProg, programmeViewport);
    }
    const channelRange = this.channelVirtualizer.getRange(
      visibleChannels.length,
      channelViewport,
    );
    const programmeRange = this.programmeVirtualizer.getRange(programmes.length, programmeViewport);
    const groupViewport = previousGroupList?.clientHeight || 400;
    if (this.groupOpen && placeFocus) {
      this.groupVirtualizer.ensureVisible(this.groupFocusIdx, groupViewport);
    }
    const groupRange = this.groupVirtualizer.getRange(groups.length, groupViewport);

    // Load catch-up progress once per render for the current channel.
    const hasCatchup = !!(channel && channel.catchupSource);
    let progressMap: Map<number, CatchupProgressEntry> | undefined;
    if (hasCatchup && channel) {
      const chKey = channelKey(channel);
      const entries = StorageService.getCatchupProgressList(
        chKey,
        undefined,
        legacyChannelKey(channel),
      );
      progressMap = new Map(entries.map(e => [e.progStart, e]));
    }

    morph(this.container, html`
      <div class="epg-view">
        <div class="epg-main">
          <div class="epg-channels-pane ${this.focusCol === 'channels' || this.focusCol === 'playlists' || this.focusCol === 'filters' ? 'pane-focused' : ''}">
            ${showTabs ? html`
              <div class="playlist-tabs epg-playlist-tabs" id="epg-playlists">
                <div class="playlist-tab ${!this.selectedPlaylist ? 'active' : ''}"
                     data-key="epg-tab:"
                     data-playlist="" data-playlist-index="0" data-hover-target>${t('common.all')}</div>
                ${tabs.map((tab, i) => html`
                  <div class="playlist-tab ${tab.id === this.selectedPlaylist ? 'active' : ''}"
                       data-key="epg-tab:${tab.id}"
                       data-playlist="${tab.id}" data-playlist-index="${i + 1}" data-hover-target>${tab.name}</div>
                `)}
              </div>
            ` : ''}
            <div class="epg-filter-bar">
              <div class="epg-group-control">
                <button type="button"
                        class="epg-filter-control epg-group-button ${this.selectedGroup !== 'builtin:all' ? 'active' : ''}"
                        data-key="epg-group-button" data-epg-group-toggle data-hover-target
                        aria-expanded="${this.groupOpen ? 'true' : 'false'}">
                  <span class="epg-group-button-prefix">${t('common.groups')}:</span>
                  <span class="epg-group-button-label">${
                    groups.find(group => group.id === this.selectedGroup)?.label ?? t('common.all')
                  }</span>
                  <span class="epg-group-button-arrow">${raw(CHEVRON_LEFT_ICON)}</span>
                </button>
                ${this.groupOpen ? html`
                  <div class="epg-group-menu" data-key="epg-group-menu">
                    <div class="epg-group-menu-title">${t('common.groups')}</div>
                    <div class="epg-group-options">
                      <div class="epg-group-options-spacer"
                           style="height:${this.groupVirtualizer.getTotalSize(groups.length)}px">
                      ${groups.slice(groupRange.start, groupRange.end).map((group, offset) => {
                        const i = groupRange.start + offset;
                        return html`
                        <div class="epg-group-option ${group.id === this.selectedGroup ? 'active' : ''}"
                             data-key="epg-group:${group.id}"
                             data-epg-group="${group.id}" data-group-index="${i}" data-hover-target
                             style="top:${this.groupVirtualizer.getItemOffset(i)}px">
                          <span class="epg-group-option-label">${group.label}</span>
                          <span class="epg-group-option-count">${group.count}</span>
                        </div>
                      `;
                      })}
                      </div>
                    </div>
                  </div>
                ` : ''}
              </div>
              <label class="epg-search-wrap">
                <span class="epg-search-icon">${raw(SEARCH_ICON)}</span>
                <input type="text" class="epg-search-input" data-key="epg-search"
                       aria-label="${t('search.ariaChannels')}"
                       data-search-query="${this.channelSearchResultQuery}"
                       data-search-pending="${this.channelSearchPending ? 'true' : 'false'}"
                       placeholder="${t('common.search')}" value="${this.searchQuery}">
              </label>
            </div>
            <div class="epg-channel-pane-header">
              <span class="epg-channel-pane-count">${tp('channel.count', visibleChannels.length)}</span>
              <span class="epg-page-info">${channel?.name ?? ''}${programmes.length
                ? html` · ${tp('epg.programCount', programmes.length)}`
                : ''}</span>
            </div>
            <div class="epg-channel-list" id="epg-channels">
            ${visibleChannels.length ? html`
              <div class="epg-virtual-spacer"
                   style="height:${this.channelVirtualizer.getTotalSize(visibleChannels.length)}px">
              ${visibleChannels.slice(channelRange.start, channelRange.end)
                .map(({ channel: ch, globalIndex }, offset) => {
              const itemIndex = channelRange.start + offset;
              const sel = globalIndex === this.selectedChannelIdx;
              return html`
                <div class="epg-channel-item ${sel ? 'selected' : ''}"
                     data-key="${channelKey(ch)}"
                     data-channel-idx="${globalIndex}"
                     data-channel-pos="${itemIndex}" data-hover-target
                     style="top:${this.channelVirtualizer.getItemOffset(itemIndex)}px">
                  <span class="epg-ch-num">${globalIndex + 1}</span>
                  <span class="epg-ch-name">${raw(channelLockBadge(ch))}${ch.name}</span>
                </div>
              `;
            })}
              </div>
            ` : html`<div class="epg-no-channels">${t('channel.empty')}</div>`}
            </div>
          </div>
          <div class="epg-right-pane">
            <div class="epg-date-bar">
              <div class="epg-date-list ${this.focusCol === 'dates' ? 'pane-focused' : ''}" id="epg-dates" data-edge-scroll>
                ${dateOptions.map((d, i) => {
                  const sel = i === this.selectedDay;
                  const isToday = d.getTime() === todayMs;
                  const dayState = d.getTime() < todayMs ? 'day-past' : d.getTime() > todayMs ? 'day-future' : '';
                  const lbl = formatDayLabel(d);
                  return html`
                    <div class="epg-date-item ${sel ? 'selected' : ''} ${isToday ? 'today' : ''} ${dayState}"
                         data-key="${displayDayKey(d)}"
                         data-day-index="${i}" data-hover-target>
                      <span class="epg-date-weekday">${lbl.weekday}</span>
                      <span class="epg-date-date">${lbl.date}</span>
                    </div>
                  `;
                })}
              </div>
              <div class="epg-legend">
                <span class="epg-legend-item state-past">
                  <i class="epg-legend-dot"></i><span>${t('epg.aired')}</span>
                </span>
                <span class="epg-legend-item state-future">
                  <i class="epg-legend-dot"></i><span>${t('epg.upcoming')}</span>
                </span>
                <button type="button"
                        class="epg-legend-item epg-reminder-entry"
                        data-epg-reminders aria-label="${t('reminderManager.title')}">
                  ${raw(bellIcon(true))}<span>${t('epg.reminder')}</span>
                </button>
              </div>
            </div>
            <div class="epg-programmes-pane ${this.focusCol === 'programmes' ? 'pane-focused' : ''}" id="epg-programmes">
              ${programmes.length === 0
                ? html`<div class="epg-no-data">${t('epg.noData')}</div>`
                : html`
                  <div class="epg-virtual-spacer"
                       style="height:${this.programmeVirtualizer.getTotalSize(programmes.length)}px">
                  ${programmes.slice(programmeRange.start, programmeRange.end).map((p, offset) => {
                    const i = programmeRange.start + offset;
                    const now = Date.now();
                    const startMs = p.start.getTime();
                    const stopMs = p.stop.getTime();
                    // Three temporal states drive the row's color: aired (replayable
                    // via catch-up), live (airing now), and upcoming.
                    const state = stopMs <= now ? 'past' : startMs > now ? 'future' : 'live';
                    const current = state === 'live';
                    const catchupAvailable = state === 'past' && channel
                      ? XtreamArchiveService.isAvailable(channel, startMs)
                      : false;
                    const progress = catchupAvailable && hasCatchup ? progressMap!.get(startMs) : undefined;
                    return html`
                      <div class="epg-programme-item
                                  state-${state} ${current ? 'current' : ''}"
                           data-key="${String(p.start.getTime())}"
                           data-prog-idx="${i}" data-hover-target
                           style="top:${this.programmeVirtualizer.getItemOffset(i)}px">
                        <div class="epg-prog-time-col">
                          <span class="epg-prog-time">${formatTime(p.start)}</span>
                          <span class="epg-prog-dur">${state === 'past'
                            ? raw(REPLAY_ICON)
                            : ''}<span>${formatDuration(stopMs - startMs)}</span></span>
                        </div>
                        <div class="epg-prog-body">
                          <div class="epg-prog-title">
                            ${current ? liveBadge() : ''}
                            <span>${p.title}</span>
                            ${state === 'future' && channel ? raw(bellIcon(ReminderService.has(channelKey(channel), startMs))) : ''}
                            ${progress ? html`<span class="epg-catchup-badge ${progress.completed ? 'watched' : 'resume'}">${t(progress.completed ? 'epg.watched' : 'common.resume')}</span>` : ''}
                          </div>
                          ${progress && !progress.completed && progress.duration > 0 ? html`<div class="epg-catchup-progress"><div class="epg-catchup-progress-fill" style="width: ${Math.min(100, Math.max(0, Math.round(progress.position / progress.duration * 100)))}%"></div></div>` : ''}
                          ${p.description ? html`<div class="epg-prog-desc">${p.description}</div>` : ''}
                        </div>
                      </div>
                    `;
                  })}
                  </div>
                `
              }
            </div>
          </div>
        </div>
      </div>
    `);

    this.scheduleProgrammeRowMeasurement();

    const channelList = this.container.querySelector<HTMLElement>('.epg-channel-list');
    const programmeList = this.container.querySelector<HTMLElement>('.epg-programmes-pane');
    if (previousChannelList && channelList) {
      this.scrollGuard.syncOffset(
        channelList,
        'vertical',
        this.channelVirtualizer.scrollOffset,
      );
    }
    if (previousProgrammeList && programmeList) {
      this.scrollGuard.syncOffset(
        programmeList,
        'vertical',
        this.programmeVirtualizer.scrollOffset,
      );
    }
    const groupList = this.container.querySelector<HTMLElement>('.epg-group-options');
    if (previousGroupList && groupList) {
      this.scrollGuard.syncOffset(groupList, 'vertical', this.groupVirtualizer.scrollOffset);
    }
    // A fresh list's first pass never writes its scroll offsets; only this one moves it.
    if (placeFocus && !previousChannelList && channelList?.clientHeight) {
      this.render(true);
      return;
    }
    this.syncFocus();
  }

  private scheduleProgrammeRowMeasurement(): void {
    const generation = ++this.programmeMeasureGeneration;
    if (this.programmeMeasureFrame !== null) {
      cancelAnimationFrame(this.programmeMeasureFrame);
    }
    this.programmeMeasureFrame = requestAnimationFrame(() => {
      this.programmeMeasureFrame = requestAnimationFrame(() => {
        this.programmeMeasureFrame = null;
        if (generation !== this.programmeMeasureGeneration) return;
        if (this.measureProgrammeRows()) this.applyProgrammeRowOffsets();
      });
    });
  }

  /** Programme rows are content-sized — a one-line description is shorter than a
   *  two-line one — so the seeded estimates are replaced by real heights once a
   *  row has been painted. Returns true when a size changed. */
  private measureProgrammeRows(): boolean {
    const updates: Array<{ index: number; size: number }> = [];
    this.container.querySelectorAll<HTMLElement>('.epg-programme-item').forEach((row) => {
      const index = parseInt(row.dataset.progIdx || '-1', 10);
      if (index < 0 || this.measuredProgrammes.has(index)) return;
      const size = row.getBoundingClientRect().height;
      if (size <= 0) return;
      this.measuredProgrammes.add(index);
      updates.push({ index, size });
    });
    return this.programmeVirtualizer.updateItemSizes(updates);
  }

  /** Re-place the rendered rows after a measurement instead of rendering again:
   *  the rows themselves are unchanged, only their offsets moved. */
  private applyProgrammeRowOffsets(): void {
    const spacer = this.container.querySelector<HTMLElement>(
      '#epg-programmes .epg-virtual-spacer',
    );
    if (!spacer) return;
    const list = this.container.querySelector<HTMLElement>('.epg-programmes-pane');
    const anchor = this.programmeAnchor(list);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    const rows = this.container.querySelectorAll<HTMLElement>('.epg-programme-item');
    spacer.style.height = `${this.programmeVirtualizer.getTotalSize(this.programmeCount)}px`;
    rows.forEach((row) => {
      const index = parseInt(row.dataset.progIdx || '-1', 10);
      if (index < 0) return;
      row.style.top = `${this.programmeVirtualizer.getItemOffset(index)}px`;
    });
    if (!anchor || !list) return;
    // Rows above the focused one changed size: scroll with it, so a
    // programme a key just revealed stays where it was shown.
    const delta = Math.round(anchor.getBoundingClientRect().top - anchorTop);
    if (!delta) return;
    this.scrollGuard.syncOffset(list, 'vertical', list.scrollTop + delta);
    this.programmeVirtualizer.setScrollOffset(list.scrollTop);
    this.render();
  }

  // The focused programme, while any of it shows in the list.
  private programmeAnchor(list: HTMLElement | null): HTMLElement | null {
    if (!list || this.focusCol !== 'programmes') return null;
    const row = this.container.querySelector<HTMLElement>(
      `#epg-programmes [data-prog-idx="${String(this.focusProg)}"]`,
    );
    if (!row) return null;
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    return r.bottom > l.top && r.top < l.bottom ? row : null;
  }

  private bindEvents(): void {
    // Delegated handlers attached once to the persistent container. With morph
    // reusing nodes across renders, per-render addEventListener would stack up.
    this.container.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-epg-reminders]')) {
        this.groupOpen = false;
        this.syncGroupScope();
        this.focusCol = 'legend';
        this.onManageReminders?.();
        return;
      }
      const groupToggle = target.closest('[data-epg-group-toggle]');
      if (groupToggle) {
        if (this.groupOpen) {
          this.groupOpen = false;
          this.render();
        } else {
          this.openGroupMenu();
        }
        return;
      }
      const groupItem = target.closest<HTMLElement>('[data-epg-group]');
      if (groupItem) {
        this.groupFocusIdx = parseInt(groupItem.dataset.groupIndex!, 10);
        const group = this.getGroupOptions()[this.groupFocusIdx];
        if (!group) return;
        this.selectGroup(group.id);
        this.focusCol = 'filters';
        this.filterFocus = 'group';
        this.render();
        return;
      }
      const playlistItem = target.closest<HTMLElement>('#epg-playlists [data-playlist]');
      if (playlistItem) {
        this.groupOpen = false;
        this.playlistFocusIdx = parseInt(playlistItem.dataset.playlistIndex!, 10);
        this.selectPlaylist(playlistItem.dataset.playlist!);
        this.focusCol = 'playlists';
        this.render();
        return;
      }
      const channelItem = target.closest<HTMLElement>('#epg-channels [data-channel-idx]');
      if (channelItem) {
        this.groupOpen = false;
        const idx = parseInt(channelItem.dataset.channelIdx!, 10);
        if (idx === this.selectedChannelIdx && this.focusCol === 'channels') {
          this.onChannelSelect(idx, undefined, this.currentScope());
        } else {
          this.selectedChannelIdx = idx;
          this.focusCol = 'channels';
          this.focusProg = 0;
          this.render();
        }
        return;
      }
      const dateItem = target.closest<HTMLElement>('#epg-dates [data-day-index]');
      if (dateItem) {
        this.groupOpen = false;
        this.selectedDay = parseInt(dateItem.dataset.dayIndex!, 10);
        this.focusCol = 'dates';
        this.focusProg = 0;
        this.render();
        return;
      }
      const progItem = target.closest<HTMLElement>('#epg-programmes [data-prog-idx]');
      if (progItem) {
        this.groupOpen = false;
        this.focusProg = parseInt(progItem.dataset.progIdx!, 10);
        this.focusCol = 'programmes';
        this.render();
        this.activateFocusedProgramme();
        return;
      }
      if (this.groupOpen) {
        this.groupOpen = false;
        this.render();
      }
    });

    // The pointer lights a group option or a programme where it rests; the
    // other columns answer it with :hover alone. The open group menu is a
    // modal scope, so no hover behind it arrives here.
    this.container.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      const groupItem = target.closest<HTMLElement>('[data-epg-group]');
      if (groupItem) {
        this.groupFocusIdx = parseInt(groupItem.dataset.groupIndex!, 10);
        this.paint('pointer');
        return;
      }
      const item = target.closest<HTMLElement>('#epg-programmes [data-prog-idx]');
      if (!item) return;
      this.lightProgramme(parseInt(item.dataset.progIdx!, 10));
      this.paint('pointer');
    });

    this.container.addEventListener('input', (e: Event) => {
      const input = e.target as HTMLInputElement;
      if (!input.classList.contains('epg-search-input')) return;
      this.searchQuery = input.value;
      const generation = ++this.channelSearchGeneration;
      this.channelSearchResults = null;
      this.channelSearchResultSource = null;
      this.channelSearchResultQuery = '';
      this.channelSearchPending = !!this.searchQuery.trim();
      this.focusCol = 'filters';
      this.filterFocus = 'search';
      this.groupOpen = false;
      this.render();
      if (this.searchQuery.trim()) void this.updateChannelSearch(generation);
    });

    this.container.addEventListener('focusin', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('epg-search-input')) return;
      const menuWasOpen = this.groupOpen;
      this.groupOpen = false;
      this.focusCol = 'filters';
      this.filterFocus = 'search';
      if (menuWasOpen) this.render();
      this.paint(InputMode.current === 'keys' ? 'key' : 'pointer');
    });

    // However the caret leaves, the ring comes back where the Guide rests.
    this.container.addEventListener('focusout', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('epg-search-input')) return;
      this.paint(InputMode.current === 'keys' ? 'key' : 'pointer');
    });

    this.container.addEventListener('keydown', (e: KeyboardEvent) => {
      const input = e.target as HTMLElement;
      if (!input.classList.contains('epg-search-input')) return;
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        this.exitSearchToChannels();
      } else if (e.key === 'Escape' || e.keyCode === CONFIG.KEYS.BACK) {
        e.preventDefault();
        e.stopPropagation();
        this.focusCol = 'filters';
        (input as HTMLInputElement).blur();
        this.render();
        this.paint('key');
      }
    });

    this.container.addEventListener('scroll', (e: Event) => {
      const target = e.target as HTMLElement;
      const offset = this.scrollGuard.readUserOffset(target, 'vertical');
      if (offset === null) return;
      if (target.classList.contains('epg-channel-list')) {
        this.channelVirtualizer.setScrollOffset(offset);
      } else if (target.classList.contains('epg-programmes-pane')) {
        this.programmeVirtualizer.setScrollOffset(offset);
      } else if (target.classList.contains('epg-group-options')) {
        this.groupVirtualizer.setScrollOffset(offset);
      } else {
        return;
      }
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.render();
      });
    }, true);
  }

  // Hover and the D-pad move within the column without a render: only the
  // pane highlight and the ring change. The scope paints the ring, and its
  // reveal renders a row outside the virtual window.
  private lightProgramme(idx: number): void {
    this.focusProg = idx;
    if (this.focusCol === 'programmes') return;
    this.focusCol = 'programmes';
    this.container.querySelectorAll('.pane-focused').forEach(el => el.classList.remove('pane-focused'));
    this.container.querySelector('.epg-programmes-pane')?.classList.add('pane-focused');
  }


  // While the search box has the caret the ring stays on it; a programme
  // hovered meanwhile is only noted, and gets the ring when the caret leaves.
  private gridKey(): string | null {
    if (this.searchInputFocused()) return 'filter:search';
    switch (this.focusCol) {
      case 'playlists': return `tab:${String(this.playlistFocusIdx)}`;
      case 'filters': return `filter:${this.filterFocus}`;
      case 'channels':
        return this.selectedChannelIdx >= 0 ? `channel:${String(this.selectedChannelIdx)}` : null;
      case 'dates': return this.dateCount ? `day:${String(this.selectedDay)}` : null;
      case 'legend': return 'legend';
      case 'programmes':
        return this.focusProg < this.programmeCount ? `prog:${String(this.focusProg)}` : null;
    }
  }

  private resolveGridKey(key: string): HTMLElement | null {
    const colon = key.indexOf(':');
    const row = colon > 0 ? KEY_SELECTORS[key.slice(0, colon)] : undefined;
    const selector = row
      ? row.replace('%', key.slice(colon + 1))
      : KEY_SELECTORS[key];
    return selector ? this.container.querySelector<HTMLElement>(selector) : null;
  }

  // A virtual row scrolled out of the rendered window is still focused.
  private hasRow(key: string): boolean {
    const prog = keyIndex(key, 'prog:');
    if (prog >= 0) return prog < this.programmeCount;
    const channel = keyIndex(key, 'channel:');
    return channel >= 0 && this.getVisibleChannels().some(item => item.globalIndex === channel);
  }

  private revealGridKey(key: string): boolean | null {
    const prog = keyIndex(key, 'prog:');
    if (prog >= 0) {
      return this.revealRow(this.container.querySelector<HTMLElement>('.epg-programmes-pane'),
        () => this.resolveGridKey(key), this.programmeVirtualizer, prog);
    }
    const channel = keyIndex(key, 'channel:');
    if (channel >= 0) {
      const index = this.getVisibleChannels().findIndex(item => item.globalIndex === channel);
      return this.revealRow(this.container.querySelector<HTMLElement>('.epg-channel-list'),
        () => this.resolveGridKey(key), this.channelVirtualizer, index);
    }
    return false;
  }

  private groupOption(index: number): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(
      `.epg-group-menu [data-group-index="${String(index)}"]`,
    );
  }

  // Brings a virtual row wholly into its list: renders it first when it lies
  // outside the rendered window, then scrolls by what the DOM shows, since
  // programme rows are only estimated until measured.
  private revealRow(
    list: HTMLElement | null,
    find: () => HTMLElement | null,
    virtualizer: VirtualList,
    index: number,
  ): boolean | null {
    if (!list || index < 0) return false;
    let moved = false;
    let row = find();
    if (!row) {
      virtualizer.setScrollOffset(list.scrollTop);
      virtualizer.ensureVisible(index, list.clientHeight || virtualizer.fallbackViewportSize);
      this.scrollGuard.syncOffset(list, 'vertical', virtualizer.scrollOffset);
      this.render();
      moved = true;
      row = find();
    }
    if (!row || !list.clientHeight) return moved || null;
    const r = row.getBoundingClientRect();
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    let delta = 0;
    if (r.top < top - 1) delta = r.top - top;
    else if (r.bottom > bottom + 1) delta = Math.min(r.bottom - bottom, r.top - top);
    if (!delta) return moved || null;
    this.scrollGuard.syncOffset(list, 'vertical', list.scrollTop + delta);
    virtualizer.setScrollOffset(list.scrollTop);
    this.render();
    return true;
  }

  private syncGroupScope(): void {
    if (this.groupOpen === this.groupScopePushed) return;
    this.groupScopePushed = this.groupOpen;
    if (this.groupOpen) Focus.push(this.groupScope);
    else Focus.pop(this.groupScope);
  }

  // Follows the state a render settled on; the next pass paints it.
  private syncFocus(): void {
    this.syncGroupScope();
    if (this.groupOpen) this.groupScope.track(`group:${String(this.groupFocusIdx)}`);
    this.focusScope.track(this.gridKey());
  }

  // Requests the ring where the state rests, now: a key may reveal it even
  // when it moved nothing, such as Down on the last programme. A scope that
  // does not own the keys only follows the state, so no reveal waits in it.
  private paint(via: Via): void {
    const scope = this.groupOpen ? this.groupScope : this.focusScope;
    const key = this.groupOpen ? `group:${String(this.groupFocusIdx)}` : this.gridKey();
    if (Focus.owner() !== scope) {
      scope.track(key);
      return;
    }
    scope.focus(key, via);
    Focus.flush();
  }

  private loadArchiveAvailability(channel: Channel | undefined): void {
    if (!channel?.catchupAccountId || !channel.catchupStreamId) return;
    if (XtreamArchiveService.getCached(channel) !== undefined) return;
    const key = `${channel.catchupAccountId}:${channel.catchupStreamId}`;
    if (this.archiveLoadingKey === key) return;
    this.archiveLoadingKey = key;
    void XtreamArchiveService.load(channel).then(() => {
      if (this.archiveLoadingKey !== key) return;
      this.archiveLoadingKey = '';
      const selected = PlaylistService.channels[this.selectedChannelIdx];
      if (selected?.catchupAccountId === channel.catchupAccountId &&
          selected.catchupStreamId === channel.catchupStreamId) {
        this.render();
      }
    });
  }

  private playSelectedProgramme(resumeSecs?: number): void {
    const programmes = this.getCurrentProgrammes();
    const prog = programmes[this.focusProg];
    if (!prog) return;
    const now = Math.floor(Date.now() / 1000);
    const progStart = Math.floor(prog.start.getTime() / 1000);
    const progStop = Math.floor(prog.stop.getTime() / 1000);

    const channel = PlaylistService.channels[this.selectedChannelIdx];
    let catchup: CatchupInfo | undefined;
    if (progStop <= now && channel &&
        XtreamArchiveService.isAvailable(channel, prog.start.getTime())) {
      catchup = {
        start: progStart,
        end: progStop,
        title: prog.title,
        description: prog.description || '',
        icon: prog.icon || '',
        epgSourceUrl: EpgService.getSourceUrl(channel) ?? undefined,
        resumeSecs,
      };
    }
    this.onChannelSelect(this.selectedChannelIdx, catchup, this.currentScope());
  }

  private async activateFocusedProgramme(): Promise<void> {
    const prog = this.getCurrentProgrammes()[this.focusProg];
    if (!prog) return;
    if (prog.start.getTime() > Date.now()) { this.toggleReminder(); return; }

    const channel = PlaylistService.channels[this.selectedChannelIdx];
    const isPast = prog.stop.getTime() <= Date.now();
    if (isPast && channel?.catchupAccountId && channel.catchupStreamId) {
      const channelIndex = this.selectedChannelIdx;
      await XtreamArchiveService.load(channel);
      if (PlaylistService.channels[channelIndex] !== channel) return;
      this.render();
    }
    if (isPast && channel?.catchupSource &&
        !XtreamArchiveService.isAvailable(channel, prog.start.getTime())) {
      showToast(t('epg.catchupUnavailable'));
      return;
    }
    if (isPast && channel?.catchupSource) {
      const chKey = channelKey(channel);
      const startMs = prog.start.getTime();
      const entries = StorageService.getCatchupProgressList(
        chKey,
        undefined,
        legacyChannelKey(channel),
      );
      const entry = entries.find(e => e.progStart === startMs);
      if (entry && !entry.completed) {
        // Partial entry — show resume prompt
        this.resumePrompt.show(prog.title, entry.position, {
          onResume: () => { this.playSelectedProgramme(entry.position); },
          onStartOver: () => {
            StorageService.clearCatchupProgress(chKey, startMs);
            this.playSelectedProgramme();
          },
          onCancel: () => { /* leave EPG unchanged */ },
        });
        return;
      }
      // Completed or untouched — play from start (no prompt)
    }
    this.playSelectedProgramme();
  }

  private toggleReminder(): void {
    const prog = this.getCurrentProgrammes()[this.focusProg];
    const channel = PlaylistService.channels[this.selectedChannelIdx];
    if (!prog || !channel) return;
    const chKey = channelKey(channel);
    const startMs = prog.start.getTime();
    if (ReminderService.has(chKey, startMs)) {
      ReminderService.remove(chKey, startMs);
      showToast(t('epg.reminderRemoved'));
    } else {
      ReminderService.add({
        channelKey: chKey,
        channelName: channel.name,
        playlistIds: channel.playlistIds.slice(),
        epgSourceUrl: EpgService.getSourceUrl(channel) ?? undefined,
        title: prog.title,
        startMs,
        stopMs: prog.stop.getTime(),
      });
      showToast(t('epg.reminderSet'));
    }
    this.render();
  }

  handleAction(action: Action, event?: NumberEvent): void {
    if (this.resumePrompt.visible) {
      this.resumePrompt.handleAction(action);
      return;
    }
    this.act(action, event);
    if (!this.resumePrompt.visible) this.paint('key');
  }

  private act(action: Action, _event?: NumberEvent): void {

    if (this.groupOpen) {
      const groups = this.getGroupOptions();
      switch (action) {
        case 'up':
          if (this.groupFocusIdx > 0) {
            this.groupFocusIdx--;
            this.render();
          }
          break;
        case 'down':
          if (this.groupFocusIdx < groups.length - 1) {
            this.groupFocusIdx++;
            this.render();
          }
          break;
        case 'select':
          this.selectGroup(groups[this.groupFocusIdx]?.id ?? 'builtin:all');
          this.render();
          break;
        case 'back':
        case 'left':
          this.groupOpen = false;
          this.render();
          break;
        case 'yellow':
          this.openSearchInput();
          break;
      }
      return;
    }

    if (action === 'yellow') {
      this.openSearchInput();
      return;
    }

    if (action === 'back' && this.searchInputFocused()) {
      this.focusCol = 'filters';
      this.container.querySelector<HTMLInputElement>('.epg-search-input')?.blur();
      this.render();
      return;
    }

    // Channel Up/Down pass through the search box; a programme hovered while
    // typing must not move unseen behind the caret.
    if ((action === 'channel_up' || action === 'channel_down') && this.searchInputFocused()) return;

    const tabs = PlaylistService.playlistTabs;
    const showTabs = tabs.length > 1;
    const tabIds = ['', ...tabs.map(tab => tab.id)];
    const visibleChannels = this.getVisibleChannels();
    const selectedVisibleIdx = visibleChannels.findIndex(
      item => item.globalIndex === this.selectedChannelIdx,
    );
    const progCount = this.getCurrentProgrammes().length;

    switch (action) {
      case 'up':
        if (this.focusCol === 'channels') {
          if (selectedVisibleIdx > 0) {
            this.selectedChannelIdx = visibleChannels[selectedVisibleIdx - 1].globalIndex;
            this.focusProg = 0;
            this.render();
          } else {
            this.focusCol = 'filters';
            this.filterFocus = 'group';
            this.render();
          }
        } else if (this.focusCol === 'filters' && showTabs) {
          this.playlistFocusIdx = Math.max(0, tabIds.indexOf(this.selectedPlaylist));
          this.focusCol = 'playlists';
          this.render();
        } else if (this.focusCol === 'filters' || this.focusCol === 'playlists') {
          this.onRevealTabBar?.(); // topmost row: hand focus to the docked tab bar
        } else if (this.focusCol === 'legend') {
          this.onRevealTabBar?.();
        } else if (this.focusCol === 'programmes') {
          if (this.focusProg > 0) {
            this.lightProgramme(this.focusProg - 1);
          } else {
            this.focusCol = 'dates';
            this.render();
          }
        } else if (this.focusCol === 'dates') {
          this.onRevealTabBar?.();
        }
        break;

      case 'down':
        if (this.focusCol === 'playlists') {
          this.focusCol = 'filters';
          this.filterFocus = 'group';
          this.render();
        } else if (this.focusCol === 'filters') {
          if (visibleChannels.length) this.focusCol = 'channels';
          this.render();
        } else if (this.focusCol === 'channels') {
          if (selectedVisibleIdx >= 0 && selectedVisibleIdx < visibleChannels.length - 1) {
            this.selectedChannelIdx = visibleChannels[selectedVisibleIdx + 1].globalIndex;
            this.focusProg = 0;
            this.render();
          }
        } else if ((this.focusCol === 'dates' || this.focusCol === 'legend') && progCount) {
          this.focusCol = 'programmes';
          this.focusProg = 0;
          this.render();
        } else if (this.focusCol === 'programmes') {
          if (this.focusProg < progCount - 1) {
            this.lightProgramme(this.focusProg + 1);
          }
        }
        break;

      case 'left':
        if (this.focusCol === 'playlists') {
          if (this.playlistFocusIdx > 0) {
            this.playlistFocusIdx--;
            this.render();
          }
        } else if (this.focusCol === 'filters') {
          if (this.filterFocus === 'search') {
            this.filterFocus = 'group';
            this.render();
          } else {
            this.openGroupMenu();
          }
        } else if (this.focusCol === 'channels') {
          this.openGroupMenu();
        } else if (this.focusCol === 'dates') {
          if (this.selectedDay > 0) {
            this.selectedDay--;
            this.focusProg = 0;
            this.render();
          }
        } else if (this.focusCol === 'legend') {
          this.focusCol = 'dates';
          this.render();
        } else if (this.focusCol === 'programmes') {
          this.focusCol = 'channels';
          this.render();
        }
        break;

      case 'right':
        if (this.focusCol === 'playlists') {
          if (this.playlistFocusIdx < tabIds.length - 1) {
            this.playlistFocusIdx++;
            this.render();
          }
        } else if (this.focusCol === 'filters') {
          if (this.filterFocus === 'group') {
            this.filterFocus = 'search';
            this.render();
          }
        } else if (this.focusCol === 'channels') {
          if (!progCount) break;
          this.focusCol = 'programmes';
          this.focusProg = 0;
          this.render();
        } else if (this.focusCol === 'dates') {
          const total = this.getDateOptions().length;
          if (this.selectedDay < total - 1) {
            this.selectedDay++;
            this.focusProg = 0;
            this.render();
          } else {
            this.focusCol = 'legend';
            this.render();
          }
        }
        break;

      case 'channel_up':
        if (this.focusCol === 'channels') {
          const next = Math.max(0, selectedVisibleIdx - 10);
          if (visibleChannels[next]) {
            this.selectedChannelIdx = visibleChannels[next].globalIndex;
            this.focusProg = 0;
          }
        } else if (this.focusCol === 'programmes') {
          this.lightProgramme(Math.max(0, this.focusProg - 10));
          break;
        }
        this.render();
        break;

      case 'channel_down':
        if (this.focusCol === 'channels') {
          const next = Math.min(visibleChannels.length - 1, selectedVisibleIdx + 10);
          if (visibleChannels[next]) {
            this.selectedChannelIdx = visibleChannels[next].globalIndex;
            this.focusProg = 0;
          }
        } else if (this.focusCol === 'programmes') {
          this.lightProgramme(Math.min(progCount - 1, this.focusProg + 10));
          break;
        }
        this.render();
        break;

      case 'select':
        if (this.focusCol === 'playlists') {
          this.selectPlaylist(tabIds[this.playlistFocusIdx] ?? '');
          this.render();
        } else if (this.focusCol === 'filters') {
          if (this.filterFocus === 'group') this.openGroupMenu();
          else this.openSearchInput();
        } else if (this.focusCol === 'channels') {
          if (this.selectedChannelIdx < 0) break;
          this.onChannelSelect(this.selectedChannelIdx, undefined, this.currentScope());
        } else if (this.focusCol === 'programmes') {
          void this.activateFocusedProgramme();
        } else if (this.focusCol === 'dates') {
          if (!progCount) break;
          this.focusCol = 'programmes';
          this.focusProg = 0;
          this.render();
        } else if (this.focusCol === 'legend') {
          this.onManageReminders?.();
        }
        break;

      case 'green':
        this.selectedDay = this.findTodayIndex(this.getDateOptions());
        this.focusProg = 0;
        this.render();
        break;
    }
  }
}
