// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state, playlistMock } = vi.hoisted(() => {
  const state = { channels: [] as Array<{ url: string; name: string }> };
  return { state, playlistMock: { get channels() { return state.channels; } } };
});
vi.mock('./playlist-service', () => ({ PlaylistService: playlistMock }));

import { ReminderService } from './reminder-service';
import { StorageService } from './storage-service';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { CONFIG } from '../config';
import { setLocale } from '../i18n';

const chan = (url: string, name: string, playlistIds: string[] = []) => ({
  id: '', name, logo: '', group: '', url, extras: null,
  playlistIds, catchup: '', catchupSource: '', catchupDays: 0,
});

const keyA = channelKey(chan('http://host/a', 'A') as never);

beforeEach(() => {
  localStorage.clear();
  state.channels = [chan('http://host/a', 'A'), chan('http://host/b', 'B')] as never[];
});

const rem = (over = {}) => ({ channelKey: keyA, channelName: 'A', title: 'Alpha', startMs: 1000, stopMs: 2000, ...over });

describe('ReminderService store', () => {
  it('adds, detects, and removes a reminder idempotently', () => {
    expect(ReminderService.has(keyA, 1000)).toBe(false);
    ReminderService.add(rem());
    ReminderService.add(rem()); // duplicate ignored
    expect(ReminderService.list()).toHaveLength(1);
    expect(ReminderService.has(keyA, 1000)).toBe(true);
    ReminderService.remove(keyA, 1000);
    expect(ReminderService.has(keyA, 1000)).toBe(false);
  });

  it('resolves a channelKey to its playlist index (-1 if gone)', () => {
    expect(ReminderService.resolveChannelIndex(keyA)).toBe(0);
    expect(ReminderService.resolveChannelIndex('nope')).toBe(-1);
  });

  it('resolves only unambiguous legacy channel keys', () => {
    const legacy = legacyChannelKey(chan('http://host/a?id=1', 'A') as never);
    state.channels = [chan('http://host/a?id=1', 'A')] as never[];
    expect(ReminderService.resolveChannelIndex(legacy)).toBe(0);

    state.channels.push(chan('http://host/a?id=2', 'B') as never);
    expect(ReminderService.resolveChannelIndex(legacy)).toBe(-1);
  });

  it('detects and removes the correct legacy reminder after query keys diverge', () => {
    const first = chan('http://host/a?id=1', 'A');
    const second = chan('http://host/a?id=2', 'B');
    state.channels = [first, second] as never[];
    const oldKey = legacyChannelKey(first as never);
    ReminderService.add(rem({ channelKey: oldKey, channelName: 'A', startMs: 5000 }));

    expect(ReminderService.has(channelKey(first as never), 5000)).toBe(true);
    expect(ReminderService.has(channelKey(second as never), 5000)).toBe(false);

    ReminderService.remove(channelKey(first as never), 5000);
    expect(ReminderService.list()).toEqual([]);
  });

  it('dueNow returns only on-air, unanswered, resolvable reminders', () => {
    ReminderService.add(rem({ startMs: 1000, stopMs: 3000 }));
    expect(ReminderService.dueNow(500)).toHaveLength(0);   // before start
    expect(ReminderService.dueNow(4000)).toHaveLength(0);  // after stop
    expect(ReminderService.dueNow(2000)).toHaveLength(1);  // on air
    ReminderService.markAnswered(keyA, 1000);
    expect(ReminderService.dueNow(2000)).toHaveLength(0);  // answered
  });

  it('prune drops ended reminders and vanished channels', () => {
    ReminderService.add(rem({ startMs: 1000, stopMs: 2000 }));
    ReminderService.add({ channelKey: 'gone', channelName: 'X', title: 'T', startMs: 1000, stopMs: 9000 });
    ReminderService.prune(5000); // first ended, second channel gone
    expect(ReminderService.list()).toHaveLength(0);
  });

  it('lists manageable reminders in start order and excludes dormant ones', () => {
    StorageService.setPlaylists([
      { id: 'p1', name: 'P1', url: 'http://host/p1', enabled: false },
    ]);
    ReminderService.add(rem({ title: 'Bravo', startMs: 6000, stopMs: 9000 }));
    ReminderService.add(rem({ title: 'Alpha', startMs: 5000, stopMs: 8000 }));
    ReminderService.add(rem({
      channelKey: 'gone',
      playlistIds: ['p1'],
      startMs: 4000,
      stopMs: 7000,
    }));

    expect(ReminderService.listManageable(4500).map(r => r.title))
      .toEqual(['Alpha', 'Bravo']);
    expect(ReminderService.list()).toHaveLength(3);
  });

  it('keeps a reminder dormant while all of its sources are disabled', () => {
    StorageService.setPlaylists([
      { id: 'p1', name: 'P1', url: 'http://host/p1', enabled: false },
    ]);
    ReminderService.add(rem({
      channelKey: 'gone',
      playlistIds: ['p1'],
      startMs: 6000,
      stopMs: 9000,
    }));
    state.channels = [];

    ReminderService.prune(5000);
    expect(ReminderService.list()).toHaveLength(1);

    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/p1' }]);
    ReminderService.prune(5000);
    expect(ReminderService.list()).toHaveLength(0);
  });

  it('backfills legacy reminder source ids before a source is disabled', () => {
    state.channels = [chan('http://host/a', 'A', ['p1'])] as never[];
    ReminderService.add(rem());

    ReminderService.backfillSourceIds();

    expect(ReminderService.list()[0].playlistIds).toEqual(['p1']);
  });

  it('migrates reminder times when an EPG offset changes', () => {
    ReminderService.add(rem({
      startMs: 5_000_000,
      stopMs: 6_000_000,
      epgSourceUrl: 'http://host/epg.xml',
    }));

    ReminderService.migrateEpgOffsets(
      {},
      { 'http://host/epg.xml': 30 },
      {},
      1000,
    );

    expect(ReminderService.list()[0]).toMatchObject({
      startMs: 6_800_000,
      stopMs: 7_800_000,
      epgSourceUrl: 'http://host/epg.xml',
    });
  });

  it('migrates legacy reminders using their channel source', () => {
    ReminderService.add(rem({ startMs: 5_000_000, stopMs: 6_000_000 }));

    ReminderService.migrateEpgOffsets(
      { 'http://host/epg.xml': 15 },
      {},
      { [keyA]: 'http://host/epg.xml' },
      1000,
    );

    expect(ReminderService.list()[0].startMs).toBe(4_100_000);
  });

  it('deduplicates reminders that migrate to the same timestamp', () => {
    ReminderService.add(rem({
      title: 'Alpha',
      startMs: 1_000,
      stopMs: 2_000,
      answered: true,
      epgSourceUrl: 'http://host/a.xml',
    }));
    ReminderService.add(rem({
      title: 'Bravo',
      startMs: 3_601_000,
      stopMs: 3_602_000,
      epgSourceUrl: 'http://host/b.xml',
    }));

    ReminderService.migrateEpgOffsets(
      {},
      { 'http://host/a.xml': 60 },
      {},
      0,
    );

    expect(ReminderService.list()).toEqual([
      expect.objectContaining({
        title: 'Bravo',
        startMs: 3_601_000,
      }),
    ]);
    expect(ReminderService.list()[0].answered).toBeUndefined();
  });
});

describe('ReminderService scheduling', () => {
  function mockLuna(): ReturnType<typeof vi.fn> & { failLast(): void } {
    const bridges: Array<{
      onservicecallback: ((message: string) => void) | null;
    }> = [];
    const request = vi.fn() as ReturnType<typeof vi.fn> & { failLast(): void };
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;

      constructor() {
        bridges.push(this);
      }

      call(uri: string, payload: string): void {
        const slash = uri.lastIndexOf('/');
        request(uri.slice(0, slash), {
          method: uri.slice(slash + 1),
          parameters: JSON.parse(payload),
        });
      }

      cancel(): void {
        this.onservicecallback = null;
      }
    }
    request.failLast = () => {
      bridges[bridges.length - 1].onservicecallback?.(JSON.stringify({
        returnValue: false,
        errorCode: -1,
        errorText: 'request failed',
      }));
    };
    Object.defineProperty(window, 'PalmServiceBridge', {
      configurable: true,
      value: FakePalmServiceBridge,
    });
    return request;
  }
  beforeEach(() => {
    Reflect.deleteProperty(window, 'PalmServiceBridge');
    ReminderService.setDevMode(false);
  });

  it('schedules an activity with a createToast callback on add', () => {
    const request = mockLuna();
    const startMs = new Date(2030, 0, 2, 15, 4, 5).getTime();
    ReminderService.add(rem({ startMs, title: 'Alpha' }));
    expect(request).toHaveBeenCalledTimes(1);
    const [uri, opts] = request.mock.calls[0];
    expect(uri).toBe('luna://com.webos.service.activitymanager');
    const a = (opts as { parameters: { activity: Record<string, unknown> } }).parameters.activity;
    expect(a.name).toBe(`iptvReminder-${keyA}-${startMs}`);
    expect(a.schedule as { start: string; local: boolean }).toEqual({ start: '2030-01-02 15:04:05', local: true });
    expect((a.callback as { method: string }).method).toBe('luna://com.webos.notification/createToast');
    expect((a.callback as { params: { message: string } }).params.message)
      .toBe('A - Alpha is now live — open the app to watch');
  });

  it('schedules translated retail copy in the active locale', () => {
    setLocale('zh-CN');
    const request = mockLuna();
    const startMs = new Date(2030, 0, 2, 15, 4, 5).getTime();
    ReminderService.add(rem({ startMs, title: 'Alpha' }));
    const [, opts] = request.mock.calls[0];
    const activity = (opts as { parameters: { activity: Record<string, unknown> } }).parameters.activity;
    expect((activity.callback as { params: { message: string } }).params.message)
      .toBe('A - Alpha 已开始播出，打开应用即可观看');
  });

  it('cancels the activity by name on remove', () => {
    const request = mockLuna();
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    ReminderService.add(rem({ startMs: 5000 }));
    request.mockClear();
    ReminderService.remove(keyA, 5000);
    expect(request).toHaveBeenCalledWith('luna://com.webos.service.activitymanager',
      expect.objectContaining({ method: 'cancel', parameters: { activityName: `iptvReminder-${keyA}-5000` } }));
    expect(info).toHaveBeenCalledWith(
      '[Reminder]',
      'Reminder removed',
      'event=reminder.removed',
      'count=1',
    );
  });

  it('reports Activity Manager cancellation failures for diagnostics', () => {
    const request = mockLuna();
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    ReminderService.add(rem({ startMs: 5000 }));
    request.mockClear();

    ReminderService.remove(keyA, 5000);
    request.failLast();

    expect(info).toHaveBeenCalledWith(
      '[Reminder]',
      'Reminder activity cancel failed',
      'event=reminder.cancel.failed',
      'reason=request_failed',
    );
  });

  it('clears all reminders and cancels every activity', () => {
    const request = mockLuna();
    ReminderService.add(rem({ startMs: 5000 }));
    ReminderService.add(rem({ startMs: 6000 }));
    request.mockClear();

    ReminderService.clearAll();

    expect(ReminderService.list()).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith('luna://com.webos.service.activitymanager',
      expect.objectContaining({ method: 'cancel', parameters: { activityName: `iptvReminder-${keyA}-5000` } }));
    expect(request).toHaveBeenCalledWith('luna://com.webos.service.activitymanager',
      expect.objectContaining({ method: 'cancel', parameters: { activityName: `iptvReminder-${keyA}-6000` } }));
  });

  it('replaces the scheduled activity after an EPG offset change', () => {
    const request = mockLuna();
    const startMs = new Date(2030, 0, 2, 15, 0, 0).getTime();
    ReminderService.add(rem({
      startMs,
      stopMs: startMs + 3_600_000,
      epgSourceUrl: 'http://host/epg.xml',
    }));
    request.mockClear();

    ReminderService.migrateEpgOffsets(
      {},
      { 'http://host/epg.xml': 30 },
      {},
      startMs - 3_600_000,
    );

    expect(request).toHaveBeenNthCalledWith(1,
      'luna://com.webos.service.activitymanager',
      expect.objectContaining({
        method: 'cancel',
        parameters: { activityName: `iptvReminder-${keyA}-${startMs}` },
      }));
    const create = request.mock.calls[1][1] as {
      parameters: { activity: { name: string; schedule: { start: string } } };
    };
    expect(create.parameters.activity.name)
      .toBe(`iptvReminder-${keyA}-${startMs + 30 * 60_000}`);
    expect(create.parameters.activity.schedule.start).toBe('2030-01-02 15:30:00');
  });

  it('does not reschedule an answered reminder after an offset change', () => {
    const request = mockLuna();
    const startMs = new Date(2030, 0, 2, 15, 0, 0).getTime();
    ReminderService.add(rem({
      startMs,
      stopMs: startMs + 3_600_000,
      answered: true,
      epgSourceUrl: 'http://host/epg.xml',
    }));
    request.mockClear();

    ReminderService.migrateEpgOffsets(
      {},
      { 'http://host/epg.xml': 30 },
      {},
      startMs - 3_600_000,
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([, options]) =>
      (options as { method: string }).method === 'cancel')).toBe(true);
  });

  it('no-ops scheduling when Luna is unavailable', () => {
    ReminderService.add(rem({ startMs: 5000 }));
    expect(ReminderService.has(keyA, 5000)).toBe(true); // still stored
  });

  it('schedules a fireReminderAlert callback in dev mode', () => {
    const request = mockLuna();
    ReminderService.setDevMode(true);
    const startMs = new Date(2030, 0, 2, 15, 4, 5).getTime();
    ReminderService.add(rem({ startMs, title: 'Alpha' }));

    const [, opts] = request.mock.calls[0];
    const a = (opts as { parameters: { activity: Record<string, unknown> } }).parameters.activity;
    expect((a.callback as { method: string }).method)
      .toBe(`luna://${CONFIG.SERVICE_ID}/fireReminderAlert`);
    expect((a.callback as { params: Record<string, unknown> }).params).toEqual({
      copyVersion: 1,
      title: 'Alpha',
      channelName: 'A',
      channelKey: keyA,
      appId: CONFIG.APP_ID,
      alertTitle: 'Program reminder',
      alertMessage: 'A — Alpha is now live. Watch now?',
      watchLabel: 'Watch now',
      cancelLabel: 'Cancel',
    });
    ReminderService.setDevMode(false);
  });

  it('reschedules only future unanswered reminders', () => {
    const future = rem({ startMs: 5000, stopMs: 6000 });
    ReminderService.add(future);
    ReminderService.add(rem({ startMs: 7000, stopMs: 8000, answered: true }));
    ReminderService.add(rem({ startMs: 1000, stopMs: 2000 }));
    const request = mockLuna();

    ReminderService.reschedulePending(3000);

    expect(request).toHaveBeenCalledTimes(1);
    const [, opts] = request.mock.calls[0];
    expect((opts as { parameters: { activity: { name: string } } }).parameters.activity.name)
      .toBe(`iptvReminder-${keyA}-5000`);
  });

  it('replaces a retail fallback with a dev-mode alert', () => {
    const request = mockLuna();
    const future = rem({ startMs: 5000, stopMs: 6000 });
    ReminderService.add(future);
    request.mockClear();

    ReminderService.reschedulePending(3000);
    ReminderService.setDevMode(true);
    ReminderService.reschedulePending(3000);

    expect(request).toHaveBeenCalledTimes(2);
    const first = request.mock.calls[0][1] as {
      parameters: { activity: { name: string; callback: { method: string } }; replace: boolean };
    };
    const second = request.mock.calls[1][1] as typeof first;
    expect(first.parameters.activity.name).toBe(second.parameters.activity.name);
    expect(first.parameters.replace).toBe(true);
    expect(second.parameters.replace).toBe(true);
    expect(first.parameters.activity.callback.method)
      .toBe('luna://com.webos.notification/createToast');
    expect(second.parameters.activity.callback.method)
      .toBe(`luna://${CONFIG.SERVICE_ID}/fireReminderAlert`);
    ReminderService.setDevMode(false);
  });
});

describe('ReminderService launch params', () => {
  it('resolves reminderChannelKey from a JSON string (cold launch)', () => {
    expect(ReminderService.resolveLaunchChannel(JSON.stringify({ reminderChannelKey: keyA }))).toBe(0);
  });

  it('resolves reminderChannelKey from an object (relaunch detail)', () => {
    expect(ReminderService.resolveLaunchChannel({ reminderChannelKey: keyA })).toBe(0);
  });

  it('returns -1 for missing, unresolvable, or malformed params', () => {
    expect(ReminderService.resolveLaunchChannel(undefined)).toBe(-1);
    expect(ReminderService.resolveLaunchChannel('not json')).toBe(-1);
    expect(ReminderService.resolveLaunchChannel({})).toBe(-1);
    expect(ReminderService.resolveLaunchChannel({ reminderChannelKey: 'gone' })).toBe(-1);
    expect(ReminderService.resolveLaunchChannel({ reminderChannelKey: 42 })).toBe(-1);
  });
});
