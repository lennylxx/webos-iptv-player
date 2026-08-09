import type {
  Action,
  NumberEvent,
  CatchupInfo,
  CatchupProgressEntry,
  Channel,
  ChannelGroupId,
  Programme,
} from '../types';
import { html, raw } from '../utils/dom';
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
import { getLocale, t, tp, type SupportedLocale } from '../i18n';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';

type FocusCol = 'playlists' | 'filters' | 'channels' | 'dates' | 'programmes';
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
  private onChannelSelect: (index: number, catchup?: CatchupInfo) => void;
  private onRevealTabBar?: () => void;
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
  private resumePrompt = new CatchupResumePrompt();
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
  private programmeSource: Programme[] | null = null;
  private programmeSizeKey = '';
  private programmeCount = 0;
  private measuredProgrammes = new Set<number>();
  private programmeMeasureFrame: number | null = null;
  private programmeMeasureGeneration = 0;
  private scrollFrame: number | null = null;
  private readonly scrollGuard = new VirtualScrollGuard();

  constructor(
    container: HTMLElement,
    onChannelSelect: (index: number, catchup?: CatchupInfo) => void,
    onRevealTabBar?: () => void,
  ) {
    this.container = container;
    this.onChannelSelect = onChannelSelect;
    this.onRevealTabBar = onRevealTabBar;
    this.bindEvents();
  }

  /** Re-snap the day selection to "today". Called on a full reload: the display
   *  timezone may have changed, which shifts the day boundaries and makes the
   *  remembered day *index* point at the wrong day. */
  resetDay(): void {
    this.dayInitialized = false;
    this.selectedDay = 0;
    this.focusProg = 0;
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
    const visible = PlaylistService.getByGroup(
      this.selectedGroup,
      this.selectedPlaylist || undefined,
    ).map(channel => ({
      channel,
      globalIndex: PlaylistService.indexOf(channel),
    }));
    const query = this.searchQuery.trim();
    if (!query) return visible;
    const ranked = rankByName(visible.map(item => item.channel), query);
    const byChannel = new Map(visible.map(item => [item.channel, item]));
    return ranked.map(channel => byChannel.get(channel)!);
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

  private exitSearchToChannels(): void {
    this.container.querySelector<HTMLInputElement>('.epg-search-input')?.blur();
    const visible = this.getVisibleChannels();
    this.focusCol = visible.length ? 'channels' : 'filters';
    if (visible.length && this.selectedChannelIdx < 0) {
      this.selectedChannelIdx = visible[0].globalIndex;
    }
    this.render();
  }

  private searchInputFocused(): boolean {
    return this.container.querySelector('.epg-search-input') === document.activeElement;
  }

  render(ensureFocus = true): void {
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
    if (ensureFocus && this.focusCol === 'channels') {
      this.channelVirtualizer.ensureVisible(selectedVisibleIdx, channelViewport);
    }
    if (ensureFocus && this.focusCol === 'programmes') {
      this.programmeVirtualizer.ensureVisible(this.focusProg, programmeViewport);
    }
    const channelRange = this.channelVirtualizer.getRange(
      visibleChannels.length,
      channelViewport,
    );
    const programmeRange = this.programmeVirtualizer.getRange(programmes.length, programmeViewport);
    const groupViewport = previousGroupList?.clientHeight || 400;
    if (this.groupOpen && ensureFocus) {
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
                <div class="playlist-tab ${!this.selectedPlaylist ? 'active' : ''} ${this.focusCol === 'playlists' && this.playlistFocusIdx === 0 ? 'focused' : ''}"
                     data-key="epg-tab:"
                     data-playlist="" data-playlist-index="0">${t('common.all')}</div>
                ${tabs.map((tab, i) => html`
                  <div class="playlist-tab ${tab.id === this.selectedPlaylist ? 'active' : ''} ${this.focusCol === 'playlists' && this.playlistFocusIdx === i + 1 ? 'focused' : ''}"
                       data-key="epg-tab:${tab.id}"
                       data-playlist="${tab.id}" data-playlist-index="${i + 1}">${tab.name}</div>
                `)}
              </div>
            ` : ''}
            <div class="epg-filter-bar">
              <div class="epg-group-control">
                <button type="button"
                        class="epg-filter-control epg-group-button ${this.focusCol === 'filters' && this.filterFocus === 'group' ? 'focused' : ''} ${this.selectedGroup !== 'builtin:all' ? 'active' : ''}"
                        data-key="epg-group-button" data-epg-group-toggle
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
                        <div class="epg-group-option ${group.id === this.selectedGroup ? 'active' : ''} ${i === this.groupFocusIdx ? 'focused' : ''}"
                             data-key="epg-group:${group.id}"
                             data-epg-group="${group.id}" data-group-index="${i}"
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
              <label class="epg-search-wrap ${this.focusCol === 'filters' && this.filterFocus === 'search' ? 'focused' : ''}">
                <span class="epg-search-icon">${raw(SEARCH_ICON)}</span>
                <input type="text" class="epg-search-input" data-key="epg-search"
                       aria-label="${t('search.ariaChannels')}"
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
              const foc = sel && this.focusCol === 'channels';
              return html`
                <div class="epg-channel-item ${sel ? 'selected' : ''} ${foc ? 'focused' : ''}"
                     data-key="${channelKey(ch)}"
                     data-channel-idx="${globalIndex}"
                     data-channel-pos="${itemIndex}"
                     style="top:${this.channelVirtualizer.getItemOffset(itemIndex)}px">
                  <span class="epg-ch-num">${globalIndex + 1}</span>
                  <span class="epg-ch-name">${ch.name}</span>
                </div>
              `;
            })}
              </div>
            ` : html`<div class="epg-no-channels">${t('channel.empty')}</div>`}
            </div>
          </div>
          <div class="epg-right-pane">
            <div class="epg-date-bar">
              <div class="epg-date-list ${this.focusCol === 'dates' ? 'pane-focused' : ''}" id="epg-dates">
                ${dateOptions.map((d, i) => {
                  const sel = i === this.selectedDay;
                  const foc = sel && this.focusCol === 'dates';
                  const isToday = d.getTime() === todayMs;
                  const dayState = d.getTime() < todayMs ? 'day-past' : d.getTime() > todayMs ? 'day-future' : '';
                  const lbl = formatDayLabel(d);
                  return html`
                    <div class="epg-date-item ${sel ? 'selected' : ''} ${foc ? 'focused' : ''} ${isToday ? 'today' : ''} ${dayState}"
                         data-key="${displayDayKey(d)}"
                         data-day-index="${i}">
                      <span class="epg-date-weekday">${lbl.weekday}</span>
                      <span class="epg-date-date">${lbl.date}</span>
                    </div>
                  `;
                })}
              </div>
              <div class="epg-legend">
                <span class="epg-legend-item state-past">
                  <i class="epg-legend-dot"></i>${t('epg.aired')}
                </span>
                <span class="epg-legend-item state-future">
                  <i class="epg-legend-dot"></i>${t('epg.upcoming')}
                </span>
                <span class="epg-legend-item">${raw(bellIcon(true))}${t('epg.reminder')}</span>
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
                    const foc = i === this.focusProg && this.focusCol === 'programmes';
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
                                  state-${state} ${current ? 'current' : ''} ${foc ? 'focused' : ''}"
                           data-key="${String(p.start.getTime())}"
                           data-prog-idx="${i}"
                           style="top:${this.programmeVirtualizer.getItemOffset(i)}px">
                        <div class="epg-prog-time-col">
                          <span class="epg-prog-time">${formatTime(p.start)}</span>
                          <span class="epg-prog-dur">${state === 'past'
                            ? raw(REPLAY_ICON)
                            : ''}${formatDuration(stopMs - startMs)}</span>
                        </div>
                        <div class="epg-prog-body">
                          <div class="epg-prog-title">
                            ${current ? html`<span class="epg-now-badge"><span class="epg-now-dot"></span>${t('common.live')}</span>` : ''}
                            ${p.title}
                            ${state === 'future' && channel ? raw(bellIcon(ReminderService.has(channelKey(channel), startMs))) : ''}
                            ${progress ? html`<span class="epg-catchup-badge ${progress.completed ? 'watched' : 'resume'}">${t(progress.completed ? 'epg.watched' : 'common.resume')}</span>` : ''}
                          </div>
                          ${progress && !progress.completed && progress.duration > 0 ? html`<div class="epg-catchup-progress"><div class="epg-catchup-progress-fill" style="width: ${Math.min(100, Math.max(0, Math.round(progress.position / progress.duration * 100)))}%"></div></div>` : ''}
                          ${p.description ? html`<div class="epg-prog-desc">${p.description.slice(0, 200)}</div>` : ''}
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
    if (ensureFocus && previousChannelList) this.scrollFocusedIntoView();
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
    const rows = this.container.querySelectorAll<HTMLElement>('.epg-programme-item');
    spacer.style.height = `${this.programmeVirtualizer.getTotalSize(this.programmeCount)}px`;
    rows.forEach((row) => {
      const index = parseInt(row.dataset.progIdx || '-1', 10);
      if (index < 0) return;
      row.style.top = `${this.programmeVirtualizer.getItemOffset(index)}px`;
    });
  }

  private bindEvents(): void {
    // Delegated handlers attached once to the persistent container. With morph
    // reusing nodes across renders, per-render addEventListener would stack up.
    this.container.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
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
          this.onChannelSelect(idx);
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

    this.container.addEventListener('mouseover', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const groupItem = target.closest<HTMLElement>('[data-epg-group]');
      if (groupItem) {
        const idx = parseInt(groupItem.dataset.groupIndex!, 10);
        if (idx !== this.groupFocusIdx) {
          this.groupFocusIdx = idx;
          this.render();
        }
        return;
      }
      if (this.groupOpen) return;
      const item = target.closest<HTMLElement>('#epg-programmes [data-prog-idx]');
      if (!item) return;
      this.setProgFocusLight(parseInt(item.dataset.progIdx!, 10));
    });

    this.container.addEventListener('input', (e: Event) => {
      const input = e.target as HTMLInputElement;
      if (!input.classList.contains('epg-search-input')) return;
      this.searchQuery = input.value;
      this.focusCol = 'filters';
      this.filterFocus = 'search';
      this.groupOpen = false;
      this.render();
    });

    this.container.addEventListener('focusin', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('epg-search-input')) return;
      const menuWasOpen = this.groupOpen;
      this.groupOpen = false;
      this.focusCol = 'filters';
      this.filterFocus = 'search';
      if (menuWasOpen) {
        this.render();
      } else {
        this.container.querySelector('.epg-group-button')?.classList.remove('focused');
        this.container.querySelector('.epg-search-wrap')?.classList.add('focused');
      }
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
        (input as HTMLInputElement).blur();
        this.focusCol = 'filters';
        this.render();
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
        this.render(false);
      });
    }, true);
  }

  private setProgFocusLight(idx: number): void {
    if (this.focusProg === idx && this.focusCol === 'programmes') return;
    this.container.querySelectorAll('.epg-programme-item.focused').forEach(el => el.classList.remove('focused'));
    this.container.querySelector<HTMLElement>(`[data-prog-idx="${idx}"]`)?.classList.add('focused');
    this.focusProg = idx;
    if (this.focusCol !== 'programmes') {
      this.focusCol = 'programmes';
      this.container.querySelectorAll('.pane-focused').forEach(el => el.classList.remove('pane-focused'));
      this.container.querySelector('.epg-programmes-pane')?.classList.add('pane-focused');
    }
  }

  private moveProgrammeFocus(idx: number): void {
    const pane = this.container.querySelector<HTMLElement>('.epg-programmes-pane');
    const target = this.container.querySelector<HTMLElement>(`[data-prog-idx="${idx}"]`);
    if (!pane || !target) {
      this.focusProg = idx;
      this.render();
      return;
    }

    const viewport = pane.clientHeight || EPG_VIEWPORT_FALLBACK;
    this.programmeVirtualizer.setScrollOffset(pane.scrollTop);
    this.programmeVirtualizer.ensureVisible(idx, viewport);
    this.setProgFocusLight(idx);
    this.scrollGuard.syncOffset(
      pane,
      'vertical',
      this.programmeVirtualizer.scrollOffset,
    );
  }

  private scrollFocusedIntoView(): void {
    if (this.groupOpen) {
      this.container.querySelector<HTMLElement>('.epg-group-option.focused')
        ?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const map: Record<FocusCol, string> = {
      playlists: '.epg-playlist-tabs .playlist-tab.focused',
      filters: '.epg-filter-bar .focused',
      channels: '.epg-channel-item.focused',
      dates: '.epg-date-item.focused',
      programmes: '.epg-programme-item.focused',
    };
    const el = this.container.querySelector<HTMLElement>(map[this.focusCol]);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
        resumeSecs,
      };
    }
    this.onChannelSelect(this.selectedChannelIdx, catchup);
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
        title: prog.title,
        startMs,
        stopMs: prog.stop.getTime(),
      });
      showToast(t('epg.reminderSet'));
    }
    this.render();
  }

  handleAction(action: Action, _event?: NumberEvent): void {
    if (this.resumePrompt.visible) {
      this.resumePrompt.handleAction(action);
      return;
    }

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
      this.container.querySelector<HTMLInputElement>('.epg-search-input')?.blur();
      this.focusCol = 'filters';
      this.render();
      return;
    }

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
        } else if (this.focusCol === 'programmes') {
          if (this.focusProg > 0) {
            this.moveProgrammeFocus(this.focusProg - 1);
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
        } else if (this.focusCol === 'dates') {
          this.focusCol = 'programmes';
          this.focusProg = 0;
          this.render();
        } else if (this.focusCol === 'programmes') {
          if (this.focusProg < progCount - 1) {
            this.moveProgrammeFocus(this.focusProg + 1);
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
          this.focusCol = 'programmes';
          this.focusProg = 0;
          this.render();
        } else if (this.focusCol === 'dates') {
          const total = this.getDateOptions().length;
          if (this.selectedDay < total - 1) {
            this.selectedDay++;
            this.focusProg = 0;
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
          this.moveProgrammeFocus(Math.max(0, this.focusProg - 10));
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
          this.moveProgrammeFocus(Math.min(progCount - 1, this.focusProg + 10));
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
          this.onChannelSelect(this.selectedChannelIdx);
        } else if (this.focusCol === 'programmes') {
          void this.activateFocusedProgramme();
        } else if (this.focusCol === 'dates') {
          this.focusCol = 'programmes';
          this.focusProg = 0;
          this.render();
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
