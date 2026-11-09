// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  ParentalAccessRequest,
  ParentalControlConfig,
  ParentalPinThrottle,
  PlaylistEntry,
  VodQueueItem,
} from '../types';
import { CONFIG } from '../config';

const storage = vi.hoisted(() => ({
  config: null as ParentalControlConfig | null,
  throttle: null as ParentalPinThrottle | null,
  playlists: [] as PlaylistEntry[],
}));
const sources: PlaylistEntry[] = [
  { id: 'p1', name: 'P1', url: 'http://host/p1' },
  { id: 'p2', name: 'P2', url: 'http://host/p2' },
  { id: 'a|b', name: 'AB', url: 'http://host/ab' },
  ...['a1', 'a2'].map(id => ({ id, name: id, url: 'http://host/x', source: 'xtream' as const })),
];

vi.mock('./storage-service', () => ({
  StorageService: {
    getParentalControl: () => storage.config,
    getParentalThrottle: () => storage.throttle,
    getPlaylists: () => storage.playlists,
    setParentalThrottle: (throttle: ParentalPinThrottle | null) => { storage.throttle = throttle; },
    setParentalControl: (config: ParentalControlConfig) => {
      storage.config = JSON.parse(JSON.stringify(config)) as ParentalControlConfig;
    },
    clearParentalControl: () => { storage.config = null; },
  },
}));

vi.mock('./parental-pin', () => ({
  createParentalPin: async (pin: string) => ({
    algorithm: 'sha256',
    salt: 'salt',
    digest: pin,
  }),
  verifyParentalPin: async (pin: string, record: { digest: string }) =>
    pin === record.digest,
}));

import {
  isResumeConcealed,
  isVodConcealed,
  ParentalControlService,
  liveParentalRequest,
  parentalTargetKey,
  vodParentalRequest,
} from './parental-control';
import { catalogConcealmentTest } from '../utils/catalog-concealment';

const request = (parents: ParentalAccessRequest['parents'] = []): ParentalAccessRequest => ({
  target: { kind: 'live-channel', channelKey: 'ch1' },
  parents,
  intent: 'play',
  label: 'ch1',
});

describe('ParentalControlService', () => {
  beforeEach(async () => {
    storage.config = null;
    storage.throttle = null;
    storage.playlists = sources;
    ParentalControlService.reload();
    await ParentalControlService.createPin('1234');
    ParentalControlService.lock('lock-now');
  });

  it('guards live channel editing only while a live lock applies', async () => {
    expect(ParentalControlService.guardsLiveEditing).toBe(false);
    ParentalControlService.setItemRule({ kind: 'vod-item', accountId: 'a1', itemId: 'v1' }, 'protect');
    expect(ParentalControlService.guardsLiveEditing).toBe(false);
    ParentalControlService.setGroupProtected(
      { kind: 'live-group', playlistId: 'p1', groupKey: 'News' }, true);
    expect(ParentalControlService.guardsLiveEditing).toBe(true);
    ParentalControlService.setUnlockDuration('5-minutes');
    await ParentalControlService.submitPin('1234');
    // A viewing unlock leaves settings changes behind the PIN.
    expect(ParentalControlService.guardsLiveEditing).toBe(true);
  });

  it('stays locked when it locks while a PIN check is running', async () => {
    ParentalControlService.setGroupProtected(
      { kind: 'live-group', playlistId: 'p1', groupKey: 'News' }, true);
    ParentalControlService.setUnlockDuration('5-minutes');
    ParentalControlService.setChallengeHandler(() => undefined);
    const action = vi.fn();
    ParentalControlService.authorize(request([{ kind: 'live-group', playlistId: 'p1', groupKey: 'News' }]), action);
    const submitted = ParentalControlService.submitPin('1234');
    ParentalControlService.lock('lock-now');
    await submitted;
    expect(action).not.toHaveBeenCalled();
    expect(ParentalControlService.guardsLiveEditing).toBe(true);
    ParentalControlService.setChallengeHandler(null);
  });

  it('locks a source added after turning on until the manager adopts it', () => {
    const news = { kind: 'live-group' as const, playlistId: 'p3', groupKey: 'News' };
    const sport = { kind: 'live-group' as const, playlistId: 'p3', groupKey: 'Sport' };
    const movies = { kind: 'vod-category' as const, accountId: 'a3', categoryId: 'c1' };
    storage.playlists = [
      ...sources,
      { id: 'p3', name: 'P3', url: 'http://host/p1' },
      { id: 'a3', name: 'A3', url: 'http://host/x', source: 'xtream' },
    ];
    expect(ParentalControlService.decision(request([news])).allowed).toBe(false);
    expect(ParentalControlService.groupLockState([movies])).toBe('locked');
    expect(ParentalControlService.decision(request([
      { kind: 'live-group', playlistId: 'p1', groupKey: 'News' }, news,
    ])).allowed).toBe(false);

    ParentalControlService.adoptSource('live', 'p3', [news, sport]);
    expect(ParentalControlService.sourceApproved('live', 'p3')).toBe(true);
    expect(ParentalControlService.groupProtected(sport)).toBe(true);
    ParentalControlService.setGroupProtected(sport, false);
    expect(ParentalControlService.decision(request([sport])).allowed).toBe(true);
    expect(ParentalControlService.decision(request([news])).allowed).toBe(false);
    // Adopting again must not relock what the parent unlocked.
    ParentalControlService.adoptSource('live', 'p3', [news, sport]);
    expect(ParentalControlService.groupProtected(sport)).toBe(false);

    ParentalControlService.clearSourceRules('vod', 'a3');
    expect(ParentalControlService.groupLockState([movies])).toBeNull();
    expect(ParentalControlService.sourceApproved('series', 'a3')).toBe(false);
    ParentalControlService.clearRules();
    expect(ParentalControlService.sourceApproved('series', 'a3')).toBe(true);
  });

  it('locks a source again when its address, account, or uploaded file changes', () => {
    const upload = { id: 'u1', name: 'U1', url: 'http://host/uploads/u1.m3u', source: 'upload' as const, revision: 1 };
    storage.playlists = [...sources, upload];
    ParentalControlService.adoptSource('live', 'u1', []);
    const before = storage.playlists;
    const edit = (id: string, change: Partial<PlaylistEntry>) =>
      before.map(entry => entry.id === id ? { ...entry, ...change } : entry);

    ParentalControlService.reviewChangedSources(before, edit('p1', { name: 'Renamed' }));
    ParentalControlService.reviewChangedSources(before, edit('a1', { xtream: { username: 'u', password: 'new' } }));
    expect(ParentalControlService.sourceApproved('live', 'p1')).toBe(true);

    ParentalControlService.reviewChangedSources(before, edit('p1', { url: 'http://host/other' }));
    expect(ParentalControlService.sourceApproved('live', 'p1')).toBe(false);
    ParentalControlService.reviewChangedSources(before, edit('a2', { url: 'http://host/y' }));
    expect(ParentalControlService.sourceApproved('vod', 'a2')).toBe(false);
    expect(ParentalControlService.sourceApproved('series', 'a2')).toBe(false);
    ParentalControlService.reviewChangedSources(before, edit('u1', { revision: 2, url: 'http://host:9/uploads/u1.m3u' }));
    expect(ParentalControlService.sourceApproved('live', 'u1')).toBe(false);
    expect(ParentalControlService.decision(request([
      { kind: 'live-group', playlistId: 'p1', groupKey: 'Kids' },
    ])).allowed).toBe(false);
  });

  it('approves the current sources for a config saved without the list', () => {
    const saved = { ...storage.config! } as Partial<ParentalControlConfig>;
    delete saved.approvedSources;
    storage.config = saved as ParentalControlConfig;
    ParentalControlService.reload();
    expect(ParentalControlService.sourceApproved('live', 'p1')).toBe(true);
    expect(ParentalControlService.sourceApproved('vod', 'a1')).toBe(true);
    expect(ParentalControlService.sourceApproved('live', 'p3')).toBe(false);
  });

  it('guards removing only a source that owns a lock', async () => {
    expect(ParentalControlService.guardsSourceRemoval('p1')).toBe(false);
    ParentalControlService.setItemRule({ kind: 'vod-item', accountId: 'a1', itemId: 'v1' }, 'allow');
    expect(ParentalControlService.guardsSourceRemoval('a1')).toBe(false);
    ParentalControlService.setItemRule({ kind: 'vod-item', accountId: 'a1', itemId: 'v1' }, 'protect');
    expect(ParentalControlService.guardsSourceRemoval('a1')).toBe(true);
    ParentalControlService.setGroupProtected(
      { kind: 'live-group', playlistId: 'p1', groupKey: 'News' }, true);
    expect(ParentalControlService.guardsSourceRemoval('p1')).toBe(true);
    expect(ParentalControlService.guardsSourceRemoval('p2')).toBe(false);
    ParentalControlService.setUnlockDuration('5-minutes');
    await ParentalControlService.submitPin('1234');
    expect(ParentalControlService.guardsSourceRemoval('p1')).toBe(true);
  });

  it('keeps resume entries saved without a category locked while catalog rules apply', () => {
    ParentalControlService.setConcealMode('hide-locked');
    const movie = {
      accountId: 'a1', kind: 'vod' as const, itemId: 'v1', name: 'Movie 1', poster: '',
      ext: 'mp4', position: 10, duration: 100, updatedAt: 1,
    };
    const episode = { ...movie, kind: 'episode' as const, itemId: 'e1', name: 'Episode 1' };
    expect(isResumeConcealed(movie)).toBe(false);

    ParentalControlService.setGroupProtected(
      { kind: 'vod-category', accountId: 'a1', categoryId: 'c1' }, true);
    expect(isResumeConcealed(movie)).toBe(true);
    expect(isResumeConcealed({ ...movie, accountId: 'a2' })).toBe(false);
    expect(isResumeConcealed(episode)).toBe(false);

    ParentalControlService.setItemRule({ kind: 'series-item', accountId: 'a1', itemId: 's1' }, 'protect');
    expect(isResumeConcealed(episode)).toBe(true);
    expect(ParentalControlService.decision(vodParentalRequest({
      url: 'http://host/a', title: 'Episode 1', poster: '', accountId: 'a1',
      itemId: 'e1', kind: 'episode', subtitles: [],
    })).allowed).toBe(false);
  });

  it('serializes target keys without label collisions', () => {
    expect(parentalTargetKey({
      kind: 'live-group',
      playlistId: 'a|b',
      groupKey: 'x/y',
    })).toBe('live-group|a%7Cb|x%2Fy');
  });

  it('builds live requests for every source membership', () => {
    const channel: Channel = {
      id: 'ch1',
      name: 'Alpha',
      logo: '',
      group: 'News',
      groupKey: 'news-key',
      url: 'http://host/a',
      extras: null,
      playlistIds: ['p1', 'p2'],
      catchup: '',
      catchupSource: '',
      catchupDays: 0,
    };
    expect(liveParentalRequest(channel, 'preview')).toMatchObject({
      target: { kind: 'live-channel' },
      intent: 'preview',
      label: 'Alpha',
      parents: [
        { kind: 'live-group', playlistId: 'p1', groupKey: 'news-key' },
        { kind: 'live-group', playlistId: 'p2', groupKey: 'news-key' },
      ],
    });
  });

  it('uses the owning series and category for episode requests', () => {
    const item: VodQueueItem = {
      url: 'http://host/a',
      title: 'Episode 1',
      poster: '',
      accountId: 'a1',
      itemId: 'e1',
      kind: 'episode',
      categoryId: 'c1',
      parentalItemId: 's1',
      subtitles: [],
    };
    expect(vodParentalRequest(item)).toEqual({
      target: { kind: 'series-item', accountId: 'a1', itemId: 's1' },
      parents: [{ kind: 'series-category', accountId: 'a1', categoryId: 'c1' }],
      intent: 'play',
      label: 'Episode 1',
    });
  });

  it('applies item rules before protected parent rules', () => {
    const parent = { kind: 'live-group', playlistId: 'p1', groupKey: 'g1' } as const;
    ParentalControlService.setGroupProtected(parent, true);
    expect(ParentalControlService.decision(request([parent]))).toMatchObject({
      allowed: false,
      reason: 'parent',
    });

    ParentalControlService.setItemRule(request().target, 'allow');
    expect(ParentalControlService.decision(request([parent]))).toEqual({ allowed: true });

    ParentalControlService.setGroupProtected(parent, false);
    ParentalControlService.setItemRule(request().target, 'protect');
    expect(ParentalControlService.decision(request([parent]))).toMatchObject({
      allowed: false,
      reason: 'item',
    });
  });

  it('locks groups and clears one group of exceptions in single writes', () => {
    const g1 = { kind: 'vod-category', accountId: 'a1', categoryId: 'c1' } as const;
    const g2 = { kind: 'vod-category', accountId: 'a1', categoryId: 'c2' } as const;
    const item = { kind: 'vod-item', accountId: 'a1', itemId: 'i1' } as const;
    ParentalControlService.setGroupsProtected([g1, g2], true);
    ParentalControlService.setItemRule(item, 'allow');
    expect(ParentalControlService.groupProtected(g1)).toBe(true);
    expect(ParentalControlService.groupProtected(g2)).toBe(true);

    ParentalControlService.clearItemRules([item]);
    expect(ParentalControlService.groupProtected(g1)).toBe(true);
    expect(ParentalControlService.itemRule(item)).toBeNull();
    expect(storage.config?.itemRules).toEqual({});
  });

  it('stores an item lock only where it differs from the group', () => {
    const group = { kind: 'vod-category', accountId: 'a1', categoryId: 'c1' } as const;
    const item = { kind: 'vod-item', accountId: 'a1', itemId: 'i1' } as const;
    ParentalControlService.setItemLocked(item, [group], true);
    expect(ParentalControlService.itemRule(item)).toBe('protect');
    expect(ParentalControlService.itemLocked(item, [group])).toBe(true);

    ParentalControlService.setGroupProtected(group, true);
    ParentalControlService.setItemLocked(item, [group], true);
    expect(ParentalControlService.itemRule(item)).toBeNull();
    expect(ParentalControlService.itemLocked(item, [group])).toBe(true);

    ParentalControlService.setItemLocked(item, [group], false);
    expect(ParentalControlService.itemRule(item)).toBe('allow');
    expect(ParentalControlService.itemLocked(item, [group])).toBe(false);
  });

  it('logs access, PIN, and session events without the PIN or its record', async () => {
    await ParentalControlService.replacePin('9876');
    ParentalControlService.setUnlockDuration('5-minutes');
    ParentalControlService.setGroupProtected(
      { kind: 'live-group', playlistId: 'p1', groupKey: 'g1' }, true);
    ParentalControlService.setChallengeHandler(() => {});
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
    ];
    try {
      const locked = {
        ...request([{ kind: 'live-group', playlistId: 'p1', groupKey: 'g1' }]),
        label: 'Label Alpha',
      };
      ParentalControlService.authorize(locked, () => {});
      ParentalControlService.authorize(locked, () => {});
      await ParentalControlService.submitPin('0000');
      await ParentalControlService.submitPin('9876');
      ParentalControlService.logState('test');
      ParentalControlService.lock('lock-now');
    } finally {
      for (const spy of spies) spy.mockRestore();
      ParentalControlService.setChallengeHandler(null);
    }

    const has = (...parts: string[]) =>
      lines.some(line => parts.every(part => line.indexOf(part) >= 0));
    expect(has('event=parental.access', 'result=challenge', 'reason=parent',
      'parents=live-group|p1|g1')).toBe(true);
    expect(has('event=parental.access', 'result=dropped-pending')).toBe(true);
    expect(has('event=parental.pin.checked', 'purpose=challenge', 'result=wrong', 'failures=1'))
      .toBe(true);
    expect(has('event=parental.pin.checked', 'result=accepted')).toBe(true);
    expect(has('event=parental.session.started', 'duration=5-minutes')).toBe(true);
    expect(has('event=parental.state', 'trigger=test', 'enabled=true', 'groupRules=1',
      'session=300s')).toBe(true);
    expect(has('event=parental.session.ended', 'reason=lock-now', 'wasUnlocked=true')).toBe(true);
    expect(lines.join('\n')).not.toContain('9876');
    expect(lines.join('\n')).not.toContain('Label Alpha');
  });

  it('replaces the PIN while keeping controls on', async () => {
    await ParentalControlService.replacePin('5678');
    expect(ParentalControlService.enabled).toBe(true);
    expect(await ParentalControlService.verifyManagementPin('5678')).toMatchObject({ accepted: true });
  });

  it('clears the PIN but keeps the locks when turned off', async () => {
    const group = { kind: 'live-group' as const, playlistId: 'p1', groupKey: 'news' };
    ParentalControlService.setGroupProtected(group, true);
    ParentalControlService.disable();
    expect(ParentalControlService.configured).toBe(false);
    expect(storage.config?.pin).toBeNull();
    expect(ParentalControlService.groupProtected(group)).toBe(true);

    await ParentalControlService.createPin('5678');
    expect(ParentalControlService.enabled).toBe(true);
    expect(ParentalControlService.groupProtected(group)).toBe(true);
  });

  it('drops a PIN stored with controls off by an older build', () => {
    storage.config = { ...storage.config!, enabled: false };
    ParentalControlService.reload();
    expect(ParentalControlService.configured).toBe(false);
  });

  it('clears only the rules owned by one source', () => {
    const vodGroup = { kind: 'vod-category', accountId: 'a1', categoryId: 'c1' } as const;
    const vodItem = { kind: 'vod-item', accountId: 'a1', itemId: 'i1' } as const;
    const seriesGroup = { kind: 'series-category', accountId: 'a1', categoryId: 'c1' } as const;
    const otherVod = { kind: 'vod-category', accountId: 'a2', categoryId: 'c1' } as const;
    const liveGroup = { kind: 'live-group', playlistId: 'p1', groupKey: 'g1' } as const;
    const otherLive = { kind: 'live-group', playlistId: 'p2', groupKey: 'g1' } as const;
    const ch1 = { kind: 'live-channel', channelKey: 'ch1' } as const;
    const ch2 = { kind: 'live-channel', channelKey: 'ch2' } as const;
    ParentalControlService.setGroupsProtected(
      [vodGroup, seriesGroup, otherVod, liveGroup, otherLive],
      true,
    );
    ParentalControlService.setItemRule(vodItem, 'protect');
    ParentalControlService.setItemRule(ch1, 'allow');
    ParentalControlService.setItemRule(ch2, 'protect');

    ParentalControlService.clearSourceRules('vod', 'a1');
    expect(ParentalControlService.groupProtected(vodGroup)).toBe(false);
    expect(ParentalControlService.itemRule(vodItem)).toBeNull();
    expect(ParentalControlService.groupProtected(seriesGroup)).toBe(true);
    expect(ParentalControlService.groupProtected(otherVod)).toBe(true);

    ParentalControlService.clearSourceRules('live', 'p1', ['ch1']);
    expect(ParentalControlService.groupProtected(liveGroup)).toBe(false);
    expect(ParentalControlService.itemRule(ch1)).toBeNull();
    expect(ParentalControlService.groupProtected(otherLive)).toBe(true);
    expect(ParentalControlService.itemRule(ch2)).toBe('protect');
  });

  it('runs a deferred action once after a valid challenge', async () => {
    ParentalControlService.setItemRule(request().target, 'protect');
    const challenged = vi.fn();
    const action = vi.fn();
    ParentalControlService.setChallengeHandler(challenged);

    expect(ParentalControlService.authorize(request(), action)).toBe(false);
    expect(challenged).toHaveBeenCalledWith(request());
    expect(action).not.toHaveBeenCalled();

    await expect(ParentalControlService.submitPin('1234')).resolves.toEqual({
      accepted: true,
      blockedForMs: 0,
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(ParentalControlService.hasPendingChallenge).toBe(false);
  });

  it('supports once-only and timed unlock sessions', async () => {
    ParentalControlService.setItemRule(request().target, 'protect');
    ParentalControlService.setChallengeHandler(() => {});
    ParentalControlService.setUnlockDuration('once');
    ParentalControlService.authorize(request(), () => {});
    await ParentalControlService.submitPin('1234', 1000);
    expect(ParentalControlService.decision(request()).allowed).toBe(false);

    ParentalControlService.setUnlockDuration('5-minutes');
    ParentalControlService.authorize(request(), () => {});
    await ParentalControlService.submitPin('1234', Date.now());
    expect(ParentalControlService.decision(request())).toEqual({ allowed: true });
    ParentalControlService.lock('lock-now');
    expect(ParentalControlService.decision(request()).allowed).toBe(false);
  });

  it('never pairs hide mode with asking every time', () => {
    ParentalControlService.setUnlockDuration('once');
    ParentalControlService.setConcealMode('hide-locked');
    expect(ParentalControlService.snapshot().unlockDuration).toBe('5-minutes');
    ParentalControlService.setUnlockDuration('once');
    expect(ParentalControlService.snapshot().unlockDuration).toBe('5-minutes');

    storage.config = { ...ParentalControlService.snapshot(), unlockDuration: 'once' };
    ParentalControlService.reload();
    expect(ParentalControlService.snapshot().unlockDuration).toBe('5-minutes');

    ParentalControlService.setConcealMode('show-locked');
    ParentalControlService.setUnlockDuration('once');
    expect(ParentalControlService.snapshot().unlockDuration).toBe('once');
  });

  it('conceals denied content when hide mode is enabled', () => {
    ParentalControlService.setConcealMode('hide-locked');
    ParentalControlService.setItemRule(request().target, 'protect');
    expect(ParentalControlService.decision(request())).toEqual({
      allowed: false,
      concealed: true,
      reason: 'item',
    });
  });

  it('delays attempts after repeated failures', async () => {
    const now = 5000;
    for (let i = 0; i < CONFIG.PARENTAL_PIN_MAX_FAILURES - 1; i++) {
      await expect(ParentalControlService.verifyManagementPin('9999', now))
        .resolves.toEqual({ accepted: false, blockedForMs: 0 });
    }
    await expect(ParentalControlService.verifyManagementPin('9999', now))
      .resolves.toEqual({
        accepted: false,
        blockedForMs: CONFIG.PARENTAL_PIN_RETRY_DELAY_MS,
      });
    await expect(ParentalControlService.verifyManagementPin('1234', now + 1))
      .resolves.toEqual({
        accepted: false,
        blockedForMs: CONFIG.PARENTAL_PIN_RETRY_DELAY_MS - 1,
      });
  });

  it('keeps the retry delay across restarts and doubles it on each later wrong PIN', async () => {
    const failRound = async (at: number) => {
      for (let i = 0; i < CONFIG.PARENTAL_PIN_MAX_FAILURES - 1; i++) {
        await ParentalControlService.verifyManagementPin('9999', at);
      }
      return ParentalControlService.verifyManagementPin('9999', at);
    };
    let now = 5000;
    await expect(failRound(now)).resolves.toEqual({
      accepted: false,
      blockedForMs: CONFIG.PARENTAL_PIN_RETRY_DELAY_MS,
    });

    ParentalControlService.reload();
    await expect(ParentalControlService.verifyManagementPin('1234', now + 1))
      .resolves.toEqual({ accepted: false, blockedForMs: CONFIG.PARENTAL_PIN_RETRY_DELAY_MS - 1 });

    expect(ParentalControlService.retryBlockedForMs(now + 1)).toBe(CONFIG.PARENTAL_PIN_RETRY_DELAY_MS - 1);
    now += CONFIG.PARENTAL_PIN_RETRY_DELAY_MS;
    expect(ParentalControlService.retryBlockedForMs(now)).toBe(0);
    // After the first lockout, one more wrong PIN starts the next, longer one.
    await expect(ParentalControlService.verifyManagementPin('9999', now)).resolves.toEqual({
      accepted: false,
      blockedForMs: CONFIG.PARENTAL_PIN_RETRY_DELAY_MS * 2,
    });
    for (let round = 0; round < 10; round++) {
      now += CONFIG.PARENTAL_PIN_MAX_RETRY_DELAY_MS;
      await ParentalControlService.verifyManagementPin('9999', now);
    }
    await expect(ParentalControlService.verifyManagementPin('1234', now))
      .resolves.toEqual({ accepted: false, blockedForMs: CONFIG.PARENTAL_PIN_MAX_RETRY_DELAY_MS });

    // A clock moved backwards cannot extend the wait past the cap.
    now -= 3_600_000;
    await expect(ParentalControlService.verifyManagementPin('1234', now))
      .resolves.toEqual({ accepted: false, blockedForMs: CONFIG.PARENTAL_PIN_MAX_RETRY_DELAY_MS });

    now += CONFIG.PARENTAL_PIN_MAX_RETRY_DELAY_MS;
    await expect(ParentalControlService.verifyManagementPin('1234', now))
      .resolves.toEqual({ accepted: true, blockedForMs: 0 });
    expect(storage.throttle).toBeNull();
  });

  it('starts an unlock session on leaving the manager except with "Once"', () => {
    ParentalControlService.setItemRule(request().target, 'protect');
    ParentalControlService.setRevealAll(true);
    ParentalControlService.setUnlockDuration('once');
    ParentalControlService.endManagement();
    expect(ParentalControlService.decision(request()).allowed).toBe(false);

    ParentalControlService.setRevealAll(true);
    ParentalControlService.setUnlockDuration('until-backgrounded');
    ParentalControlService.endManagement();
    expect(ParentalControlService.decision(request())).toEqual({ allowed: true });
  });

  it('conceals only in hide mode while locked and not revealed', () => {
    ParentalControlService.setItemRule(request().target, 'protect');
    expect(ParentalControlService.isConcealed(request())).toBe(false);

    ParentalControlService.setConcealMode('hide-locked');
    expect(ParentalControlService.concealing).toBe(true);
    expect(ParentalControlService.isConcealed(request())).toBe(true);

    ParentalControlService.setRevealAll(true);
    expect(ParentalControlService.isConcealed(request())).toBe(false);
    ParentalControlService.setRevealAll(false);

    ParentalControlService.disable();
    expect(ParentalControlService.isConcealed(request())).toBe(false);
  });

  it('exports catalog concealment rules that match isVodConcealed', () => {
    expect(ParentalControlService.catalogConcealment('vod', 'a1')).toBeNull();
    ParentalControlService.setConcealMode('hide-locked');
    ParentalControlService.setGroupProtected({ kind: 'vod-category', accountId: 'a1', categoryId: 'c|1' }, true);
    ParentalControlService.setGroupProtected({ kind: 'series-category', accountId: 'a1', categoryId: 'c2' }, true);
    ParentalControlService.setItemRule({ kind: 'vod-item', accountId: 'a1', itemId: 'v/1' }, 'allow');
    ParentalControlService.setItemRule({ kind: 'vod-item', accountId: 'a1', itemId: 'v2' }, 'protect');
    ParentalControlService.setItemRule({ kind: 'vod-item', accountId: 'a2', itemId: 'v3' }, 'protect');
    for (const accountId of ['a1', 'a2', 'unreviewed']) {
      const concealed = catalogConcealmentTest(ParentalControlService.catalogConcealment('vod', accountId));
      for (const id of ['v/1', 'v2', 'v3', 'v4']) {
        for (const categoryId of ['c|1', 'c2', '']) {
          const item = {
            accountId, streamId: id, name: 'Alpha', poster: '', rating: '', categoryId, containerExtension: 'mp4',
          };
          expect(concealed(id, categoryId), `${accountId} ${id} ${categoryId}`).toBe(isVodConcealed(item));
        }
      }
    }
  });

  it('conceals a category only when the category itself is locked', () => {
    const category = { kind: 'vod-category' as const, accountId: 'a1', categoryId: 'c1' };
    ParentalControlService.setConcealMode('hide-locked');
    expect(ParentalControlService.isCategoryConcealed(category)).toBe(false);
    ParentalControlService.setGroupProtected(category, true);
    expect(ParentalControlService.isCategoryConcealed(category)).toBe(true);
    expect(isVodConcealed({
      accountId: 'a1',
      streamId: 's1',
      name: 'Alpha',
      poster: '',
      rating: '',
      categoryId: 'c1',
      containerExtension: 'mp4',
    })).toBe(true);
  });

  it('reports lock badges for protected content and open sessions', () => {
    const group = { kind: 'live-group' as const, playlistId: 'p1', groupKey: 'news' };
    expect(ParentalControlService.lockState(request([group]))).toBeNull();
    ParentalControlService.setGroupProtected(group, true);
    expect(ParentalControlService.lockState(request([group]))).toBe('locked');
    expect(ParentalControlService.groupLockState([group])).toBe('locked');
    ParentalControlService.setItemRule(request().target, 'allow');
    expect(ParentalControlService.lockState(request([group]))).toBeNull();

    expect(ParentalControlService.sessionActive).toBe(false);
    ParentalControlService.setUnlockDuration('until-backgrounded');
    ParentalControlService.endManagement();
    expect(ParentalControlService.sessionActive).toBe(true);
    expect(ParentalControlService.groupLockState([group])).toBe('unlocked');
    ParentalControlService.disable();
    expect(ParentalControlService.sessionActive).toBe(false);
    expect(ParentalControlService.groupLockState([group])).toBeNull();
  });

  it('flags only concealment changes to subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = ParentalControlService.subscribe(listener);
    ParentalControlService.setItemRule(request().target, 'protect');
    expect(listener).toHaveBeenLastCalledWith(false);

    ParentalControlService.setConcealMode('hide-locked');
    expect(listener).toHaveBeenLastCalledWith(true);
    ParentalControlService.setItemRule(request().target, 'allow');
    expect(listener).toHaveBeenLastCalledWith(true);
    expect(listener).toHaveBeenCalledTimes(3);

    ParentalControlService.setUnlockDuration('until-backgrounded');
    ParentalControlService.endManagement();
    expect(listener).toHaveBeenCalledTimes(4);
    ParentalControlService.lock('lock-now');
    expect(listener).toHaveBeenCalledTimes(5);
    ParentalControlService.lock('lock-now');
    expect(listener).toHaveBeenCalledTimes(5);
    unsubscribe();
  });

  it('notifies a hide mode switch while management reveals everything', () => {
    ParentalControlService.setConcealMode('hide-locked');
    ParentalControlService.setRevealAll(true);
    const listener = vi.fn();
    const unsubscribe = ParentalControlService.subscribe(listener);
    ParentalControlService.setConcealMode('show-locked');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    ParentalControlService.setRevealAll(false);
  });

  it('ends a timed unlock on time even when the clock is set back', () => {
    vi.useFakeTimers();
    try {
      ParentalControlService.setConcealMode('hide-locked');
      ParentalControlService.setItemRule(request().target, 'protect');
      ParentalControlService.setUnlockDuration('5-minutes');
      ParentalControlService.endManagement();
      vi.setSystemTime(Date.now() - 3_600_000);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(ParentalControlService.isConcealed(request())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-conceals when a timed unlock expires', async () => {
    vi.useFakeTimers();
    try {
      ParentalControlService.setConcealMode('hide-locked');
      ParentalControlService.setItemRule(request().target, 'protect');
      ParentalControlService.setUnlockDuration('5-minutes');
      ParentalControlService.endManagement();
      const listener = vi.fn();
      const unsubscribe = ParentalControlService.subscribe(listener);
      expect(ParentalControlService.isConcealed(request())).toBe(false);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(ParentalControlService.isConcealed(request())).toBe(true);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
