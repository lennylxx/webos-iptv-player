import type { Reminder } from '../types';
import { CONFIG } from '../config';
import { StorageService } from './storage-service';
import { PlaylistService } from './playlist-service';
import { channelKey } from '../utils/channel';
import { truncate } from '../utils/text';
import { t } from '../i18n';
import { createLogger } from '../utils/logger';

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

  has(chKey: string, startMs: number): boolean {
    return this.list().some(r => r.channelKey === chKey && r.startMs === startMs);
  }

  add(reminder: Reminder): void {
    if (this.has(reminder.channelKey, reminder.startMs)) return;
    const list = this.list();
    list.push(reminder);
    StorageService.setReminders(list);
    log.info('added', reminder.title, new Date(reminder.startMs).toISOString());
    this.schedule(reminder);
  }

  remove(chKey: string, startMs: number): void {
    const list = this.list().filter(r => !(r.channelKey === chKey && r.startMs === startMs));
    StorageService.setReminders(list);
    this.cancelSchedule(chKey, startMs);
  }

  markAnswered(chKey: string, startMs: number): void {
    const list = this.list();
    const r = list.find(x => x.channelKey === chKey && x.startMs === startMs);
    if (!r) return;
    r.answered = true;
    StorageService.setReminders(list);
  }

  resolveChannelIndex(chKey: string): number {
    return PlaylistService.channels.findIndex(ch => channelKey(ch) === chKey);
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
    const kept = list.filter(r => now < r.stopMs && this.resolveChannelIndex(r.channelKey) >= 0);
    if (kept.length === list.length) return;
    StorageService.setReminders(kept);
    for (const r of list) {
      if (!kept.includes(r)) this.cancelSchedule(r.channelKey, r.startMs);
    }
  }

  reschedulePending(now = Date.now()): void {
    for (const reminder of this.list()) {
      if (!reminder.answered && reminder.startMs > now && reminder.stopMs > now) {
        this.schedule(reminder);
      }
    }
  }

  private lunaRequest(): ((uri: string, opts: unknown) => void) | null {
    const w = window as unknown as { webOS?: { service?: { request?: (uri: string, opts: unknown) => void } } };
    return w.webOS?.service?.request ?? null;
  }

  private localTimeString(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private schedule(reminder: Reminder): void {
    const request = this.lunaRequest();
    if (!request) { log.debug('Luna unavailable — reminder is in-app only'); return; }
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
      request('luna://com.webos.service.activitymanager', {
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
        onSuccess: (r: unknown) => log.info('scheduled', name, JSON.stringify(r)),
        onFailure: (e: unknown) => log.warn('schedule failed', name, JSON.stringify(e)),
      });
    } catch (e) {
      log.warn('schedule threw', e);
    }
  }

  private cancelSchedule(chKey: string, startMs: number): void {
    const request = this.lunaRequest();
    if (!request) return;
    try {
      request('luna://com.webos.service.activitymanager', {
        method: 'cancel',
        parameters: { activityName: activityName(chKey, startMs) },
        onSuccess: () => { /* best-effort */ },
        onFailure: () => { /* activity may already be gone */ },
      });
    } catch (e) {
      log.warn('cancel threw', e);
    }
  }
}

export const ReminderService = new ReminderServiceImpl();
