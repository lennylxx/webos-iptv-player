import type { Action, NumberEvent, CatchupInfo, CatchupProgressEntry, Channel, Programme } from '../types';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelKey } from '../utils/channel';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { ReminderService } from '../services/reminder-service';
import { XtreamArchiveService } from '../services/xtream-archive';
import { CatchupResumePrompt } from './catchup-resume-prompt';
import { showToast } from './toast';
import { formatTime, formatDayLabel, displayDayKey, startOfDisplayDay, addDisplayDays, formatDuration } from '../utils/time';
import { bellIcon, REPLAY_ICON } from './icons';
import { t, tp } from '../i18n';

type FocusCol = 'channels' | 'dates' | 'programmes';

export class EpgGrid {
  private container: HTMLElement;
  private onChannelSelect: (index: number, catchup?: CatchupInfo) => void;
  private selectedChannelIdx = 0;
  private selectedDay = 0;
  private dayInitialized = false;
  private focusCol: FocusCol = 'channels';
  private focusProg = 0;
  private resumePrompt = new CatchupResumePrompt();
  private archiveLoadingKey = '';

  constructor(container: HTMLElement, onChannelSelect: (index: number, catchup?: CatchupInfo) => void) {
    this.container = container;
    this.onChannelSelect = onChannelSelect;
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

  /** Dismiss the catch-up resume prompt if it is open. */
  dismissPrompt(): void {
    if (this.resumePrompt.visible) this.resumePrompt.hide();
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
    return (EpgService.programmes[epgId] ?? [])
      .filter(p => p.start.getTime() >= from && p.start.getTime() < dayEnd);
  }

  render(): void {
    const channels = PlaylistService.channels;
    const channel = channels[this.selectedChannelIdx];
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
    this.loadArchiveAvailability(channel);

    // Load catch-up progress once per render for the current channel.
    const hasCatchup = !!(channel && channel.catchupSource);
    let progressMap: Map<number, CatchupProgressEntry> | undefined;
    if (hasCatchup && channel) {
      const chKey = channelKey(channel);
      const entries = StorageService.getCatchupProgressList(chKey);
      progressMap = new Map(entries.map(e => [e.progStart, e]));
    }

    morph(this.container, html`
      <div class="epg-view">
        <div class="epg-header">
          <h2>${t('epg.title')}</h2>
          <span class="epg-page-info">${channel?.name ?? ''}${programmes.length
            ? html` · ${tp('epg.programCount', programmes.length)}`
            : ''}</span>
          ${raw(`
            <div class="epg-legend">
              <span class="epg-legend-item state-past"><i class="epg-legend-dot"></i>${t('epg.aired')}</span>
              <span class="epg-legend-item state-future"><i class="epg-legend-dot"></i>${t('epg.upcoming')}</span>
              <span class="epg-legend-item">${bellIcon(true)}${t('epg.reminder')}</span>
            </div>
          `)}
        </div>
        <div class="epg-main">
          <div class="epg-channels-pane ${this.focusCol === 'channels' ? 'pane-focused' : ''}" id="epg-channels">
            ${channels.map((ch, i) => {
              const sel = i === this.selectedChannelIdx;
              const foc = sel && this.focusCol === 'channels';
              return html`
                <div class="epg-channel-item ${sel ? 'selected' : ''} ${foc ? 'focused' : ''}"
                     data-key="${channelKey(ch)}"
                     data-channel-idx="${i}">
                  <span class="epg-ch-num">${i + 1}</span>
                  <span class="epg-ch-name">${ch.name}</span>
                </div>
              `;
            })}
          </div>
          <div class="epg-right-pane">
            <div class="epg-date-bar ${this.focusCol === 'dates' ? 'pane-focused' : ''}" id="epg-dates">
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
            <div class="epg-programmes-pane ${this.focusCol === 'programmes' ? 'pane-focused' : ''}" id="epg-programmes">
              ${programmes.length === 0
                ? html`<div class="epg-no-data">${t('epg.noData')}</div>`
                : programmes.map((p, i) => {
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
                      <div class="epg-programme-item state-${state} ${current ? 'current' : ''} ${foc ? 'focused' : ''}"
                           data-key="${String(p.start.getTime())}"
                           data-prog-idx="${i}">
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
                  })
              }
            </div>
          </div>
        </div>
      </div>
    `);

    this.scrollFocusedIntoView();
  }

  private bindEvents(): void {
    // Delegated handlers attached once to the persistent container. With morph
    // reusing nodes across renders, per-render addEventListener would stack up.
    this.container.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const channelItem = target.closest<HTMLElement>('#epg-channels [data-channel-idx]');
      if (channelItem) {
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
        this.selectedDay = parseInt(dateItem.dataset.dayIndex!, 10);
        this.focusCol = 'dates';
        this.focusProg = 0;
        this.render();
        return;
      }
      const progItem = target.closest<HTMLElement>('#epg-programmes [data-prog-idx]');
      if (progItem) {
        this.focusProg = parseInt(progItem.dataset.progIdx!, 10);
        this.focusCol = 'programmes';
        this.activateFocusedProgramme();
      }
    });

    this.container.addEventListener('mouseover', (e: MouseEvent) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('#epg-programmes [data-prog-idx]');
      if (!item) return;
      this.setProgFocusLight(parseInt(item.dataset.progIdx!, 10));
    });
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

  private scrollFocusedIntoView(): void {
    const map: Record<FocusCol, string> = {
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
      const entries = StorageService.getCatchupProgressList(chKey);
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

    const channelCount = PlaylistService.channels.length;
    const progCount = this.getCurrentProgrammes().length;

    switch (action) {
      case 'up':
        if (this.focusCol === 'channels') {
          if (this.selectedChannelIdx > 0) {
            this.selectedChannelIdx--;
            this.focusProg = 0;
            this.render();
          }
        } else if (this.focusCol === 'programmes') {
          if (this.focusProg > 0) {
            this.focusProg--;
            this.render();
          } else {
            this.focusCol = 'dates';
            this.render();
          }
        }
        break;

      case 'down':
        if (this.focusCol === 'channels') {
          if (this.selectedChannelIdx < channelCount - 1) {
            this.selectedChannelIdx++;
            this.focusProg = 0;
            this.render();
          }
        } else if (this.focusCol === 'dates') {
          this.focusCol = 'programmes';
          this.focusProg = 0;
          this.render();
        } else if (this.focusCol === 'programmes') {
          if (this.focusProg < progCount - 1) {
            this.focusProg++;
            this.render();
          }
        }
        break;

      case 'left':
        if (this.focusCol === 'dates') {
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
        if (this.focusCol === 'channels') {
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
          this.selectedChannelIdx = Math.max(0, this.selectedChannelIdx - 10);
          this.focusProg = 0;
        } else if (this.focusCol === 'programmes') {
          this.focusProg = Math.max(0, this.focusProg - 10);
        }
        this.render();
        break;

      case 'channel_down':
        if (this.focusCol === 'channels') {
          this.selectedChannelIdx = Math.min(channelCount - 1, this.selectedChannelIdx + 10);
          this.focusProg = 0;
        } else if (this.focusCol === 'programmes') {
          this.focusProg = Math.min(progCount - 1, this.focusProg + 10);
        }
        this.render();
        break;

      case 'select':
        if (this.focusCol === 'channels') {
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
