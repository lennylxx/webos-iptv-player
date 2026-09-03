import type { Reminder } from '../types';
import { CONFIG } from '../config';
import { StorageService } from './storage-service';
import { PlaylistService } from './playlist-service';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { truncate } from '../utils/text';
import { t } from '../i18n';
import { createLogger } from '../utils/logger';
import { isSourceEnabled } from '../utils/playlist';
import { isLunaAvailable, lunaRequest } from './luna';

const log = createLogger('Reminder');

function activityName(chKey: string, startMs: number): string {
  return `iptvReminder-${chKey}-${startMs}`;
}

function parseReminderChannelKey(raw: unknown): string | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (obj && typeof obj === 'object' && 'reminderChannelKey' in obj) {
    const k = (obj as { reminderChannelKey?: unknown }).reminderChannelKey;
    return typeof k === 'string' && k ? k : null;
  }
  return null;
}

class ReminderServiceImpl {
  private _devMode = false;

  setDevMode(v: boolean): void { this._devMode = v; }

  get devMode(): boolean { return this._devMode; }

  list(): Reminder[] {
    return StorageService.getReminders();
  }

  listManageable(now = Date.now()): Reminder[] {
    this.prune(now);
    return this.list()
      .filter(r => now < r.startMs && this.resolveChannelIndex(r.channelKey) >= 0)
      .sort((a, b) => a.startMs - b.startMs);
  }

  has(chKey: string, startMs: number): boolean {
    return this.list().some(r => this.matchesChannel(r, chKey) && r.startMs === startMs);
  }

  add(reminder: Reminder): void {
    if (this.has(reminder.channelKey, reminder.startMs)) return;
    const list = this.list();
    list.push(reminder);
    StorageService.setReminders(list);
    log.info(
      'Reminder added',
      'event=reminder.added',
      new Date(reminder.startMs).toISOString(),
    );
    this.schedule(reminder);
  }

  remove(chKey: string, startMs: number): void {
    const list = this.list();
    const removed = list.filter(r => this.matchesChannel(r, chKey) && r.startMs === startMs);
    StorageService.setReminders(list.filter(r => !removed.includes(r)));
    for (const reminder of removed) this.cancelSchedule(reminder.channelKey, startMs);
    if (removed.length) {
      log.info(
        'Reminder removed',
        'event=reminder.removed',
        `count=${String(removed.length)}`,
      );
    }
  }

  clearAll(): void {
    const reminders = this.list();
    StorageService.setReminders([]);
    for (const reminder of reminders) {
      this.cancelSchedule(reminder.channelKey, reminder.startMs);
    }
    if (reminders.length) {
      log.info(
        'Reminders cleared',
        'event=reminder.cleared',
        `count=${String(reminders.length)}`,
      );
    }
  }

  markAnswered(chKey: string, startMs: number): void {
    const list = this.list();
    const r = list.find(x => x.channelKey === chKey && x.startMs === startMs);
    if (!r) return;
    r.answered = true;
    StorageService.setReminders(list);
  }

  resolveChannelIndex(chKey: string): number {
    const exact = PlaylistService.channels.findIndex(ch => channelKey(ch) === chKey);
    if (exact >= 0) return exact;
    let legacyMatch = -1;
    for (let i = 0; i < PlaylistService.channels.length; i++) {
      if (legacyChannelKey(PlaylistService.channels[i]) !== chKey) continue;
      if (legacyMatch >= 0) return -1;
      legacyMatch = i;
    }
    return legacyMatch;
  }

  private matchesChannel(reminder: Reminder, chKey: string): boolean {
    if (reminder.channelKey === chKey) return true;
    const target = PlaylistService.channels.find(ch => channelKey(ch) === chKey);
    if (!target || legacyChannelKey(target) !== reminder.channelKey) return false;
    const legacyMatches = PlaylistService.channels
      .filter(ch => legacyChannelKey(ch) === reminder.channelKey);
    if (legacyMatches.length === 1) return legacyMatches[0] === target;
    const named = legacyMatches.filter(ch =>
      ch.name === reminder.channelName || ch.sourceName === reminder.channelName);
    return named.length === 1 && named[0] === target;
  }

  private unavailableBecauseDisabled(reminder: Reminder): boolean {
    const ids = reminder.playlistIds;
    if (!ids?.length) return false;
    const matching = StorageService.getPlaylists()
      .filter(source => ids.includes(source.id));
    return matching.length > 0 && !matching.some(isSourceEnabled);
  }

  backfillSourceIds(): void {
    const reminders = this.list();
    let changed = false;
    for (const reminder of reminders) {
      if (reminder.playlistIds?.length) continue;
      const index = this.resolveChannelIndex(reminder.channelKey);
      if (index < 0) continue;
      reminder.playlistIds = PlaylistService.channels[index].playlistIds.slice();
      changed = true;
    }
    if (changed) StorageService.setReminders(reminders);
  }

  migrateEpgOffsets(
    previous: Record<string, number>,
    next: Record<string, number>,
    sourceByChannel: Record<string, string>,
    now = Date.now(),
  ): void {
    const reminders = this.list();
    let changed = false;
    const touchedKeys = new Set<string>();
    for (const reminder of reminders) {
      const sourceUrl = reminder.epgSourceUrl ?? sourceByChannel[reminder.channelKey];
      if (!sourceUrl) continue;
      const deltaMs = ((next[sourceUrl] ?? 0) - (previous[sourceUrl] ?? 0)) * 60_000;
      if (!deltaMs) continue;
      this.cancelSchedule(reminder.channelKey, reminder.startMs);
      reminder.startMs += deltaMs;
      reminder.stopMs += deltaMs;
      reminder.epgSourceUrl = sourceUrl;
      touchedKeys.add(`${reminder.channelKey}|${reminder.startMs}`);
      changed = true;
    }
    if (!changed) return;

    const deduped: Reminder[] = [];
    const indexByKey = new Map<string, number>();
    for (const reminder of reminders) {
      const key = `${reminder.channelKey}|${reminder.startMs}`;
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, deduped.length);
        deduped.push(reminder);
        continue;
      }
      touchedKeys.add(key);
      const existing = deduped[existingIndex];
      if (existing.answered && !reminder.answered) deduped[existingIndex] = reminder;
    }

    StorageService.setReminders(deduped);
    for (const reminder of deduped) {
      const key = `${reminder.channelKey}|${reminder.startMs}`;
      if (!touchedKeys.has(key)) continue;
      if (!reminder.answered && reminder.startMs > now && reminder.stopMs > now) {
        this.schedule(reminder);
      } else {
        this.cancelSchedule(reminder.channelKey, reminder.startMs);
      }
    }
  }

  // Parse a reminderChannelKey out of a launch param (JSON string on cold
  // launch, object on webOSRelaunch) and resolve it to a channel index (-1 if
  // absent, malformed, or the channel is gone).
  resolveLaunchChannel(rawLaunchParams: unknown): number {
    const key = parseReminderChannelKey(rawLaunchParams);
    return key ? this.resolveChannelIndex(key) : -1;
  }

  dueNow(now = Date.now()): Reminder[] {
    return this.list().filter(r =>
      !r.answered && r.startMs <= now && now < r.stopMs && this.resolveChannelIndex(r.channelKey) >= 0);
  }

  prune(now = Date.now()): void {
    const list = this.list();
    const kept = list.filter(r => now < r.stopMs
      && (this.resolveChannelIndex(r.channelKey) >= 0 || this.unavailableBecauseDisabled(r)));
    if (kept.length !== list.length) {
      StorageService.setReminders(kept);
      for (const r of list) {
        if (!kept.includes(r)) this.cancelSchedule(r.channelKey, r.startMs);
      }
    }
    for (const r of kept) {
      if (this.resolveChannelIndex(r.channelKey) < 0) {
        this.cancelSchedule(r.channelKey, r.startMs);
      }
    }
  }

  reschedulePending(now = Date.now()): void {
    for (const reminder of this.list()) {
      if (!reminder.answered && reminder.startMs > now && reminder.stopMs > now
          && this.resolveChannelIndex(reminder.channelKey) >= 0) {
        this.schedule(reminder);
      }
    }
  }

  private localTimeString(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private schedule(reminder: Reminder): void {
    if (!isLunaAvailable()) {
      log.debug('Luna unavailable — reminder is in-app only');
      return;
    }
    const name = activityName(reminder.channelKey, reminder.startMs);
    // Cap title/channel so a long name can't overflow the toast/alert.
    const title = truncate(reminder.title, CONFIG.REMINDER.TITLE_MAX);
    const channel = truncate(reminder.channelName, CONFIG.REMINDER.CHANNEL_MAX);
    // Dev mode: fire an interactive system alert (app open or closed) via the
    // bundled service. Retail: a passive toast (the actionable prompt is in-app).
    const callback = this._devMode
      ? {
          method: `luna://${CONFIG.SERVICE_ID}/fireReminderAlert`,
          params: {
            copyVersion: 1,
            title,
            channelName: channel,
            channelKey: reminder.channelKey,
            appId: CONFIG.APP_ID,
            alertTitle: t('reminder.title'),
            alertMessage: t('reminder.message', { channel, title }),
            watchLabel: t('reminder.watchNow'),
            cancelLabel: t('common.cancel'),
          },
        }
      : {
          method: 'luna://com.webos.notification/createToast',
          params: {
            sourceId: CONFIG.APP_ID,
            message: t('reminder.toast', { channel, title }),
          },
        };
    try {
      lunaRequest('luna://com.webos.service.activitymanager', {
        method: 'create',
        parameters: {
          activity: {
            name,
            description: t('reminder.title'),
            type: { foreground: true, persist: true },
            schedule: { start: this.localTimeString(reminder.startMs), local: true },
            callback,
          },
          start: true,
          replace: true,
        },
        onSuccess: () => log.info(
          'Reminder activity scheduled',
          'event=reminder.schedule.completed',
        ),
        onFailure: () => log.warn(
          'Reminder activity schedule failed',
          'event=reminder.schedule.failed',
          'reason=request_failed',
        ),
      });
    } catch (e) {
      log.warn(
        'Reminder activity schedule threw',
        'event=reminder.schedule.failed',
        'reason=exception',
        e,
      );
    }
  }

  private cancelSchedule(chKey: string, startMs: number): void {
    if (!isLunaAvailable()) return;
    try {
      lunaRequest('luna://com.webos.service.activitymanager', {
        method: 'cancel',
        parameters: { activityName: activityName(chKey, startMs) },
        onSuccess: () => log.debug(
          'Reminder activity cancelled',
          'event=reminder.cancel.completed',
        ),
        onFailure: () => log.debug(
          'Reminder activity cancel failed',
          'event=reminder.cancel.failed',
          'reason=request_failed',
        ),
      });
    } catch (e) {
      log.warn(
        'Reminder activity cancel threw',
        'event=reminder.cancel.failed',
        'reason=exception',
        e,
      );
    }
  }
}

export const ReminderService = new ReminderServiceImpl();
