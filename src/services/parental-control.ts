import type {
  CatalogCategoryTarget,
  CatalogItemTarget,
  Channel,
  LiveChannelTarget,
  LiveGroupTarget,
  ParentalAccessDecision,
  ParentalAccessRequest,
  ParentalControlConfig,
  ParentalPinThrottle,
  ParentalItemTarget,
  ParentalParentTarget,
  ParentalRuleValue,
  ParentalUnlockDuration,
  PlaylistEntry,
  ResumeEntry,
  SeriesItem,
  VodItem,
  VodQueueItem,
  WatchlistEntry,
} from '../types';
import { CONFIG } from '../config';
import type { CatalogConcealment } from '../utils/catalog-concealment';
import { StorageService } from './storage-service';
import { createParentalPin, verifyParentalPin } from './parental-pin';
import { channelKey } from '../utils/channel';
import { groupKeyOf } from './channel-customization';
import { createLogger } from '../utils/logger';

const log = createLogger('Parental');

export interface ParentalPinSubmitResult {
  accepted: boolean;
  blockedForMs: number;
}

type DeferredAction = () => void | Promise<void>;
type ChallengeHandler = (request: ParentalAccessRequest) => void;

function emptyConfig(): ParentalControlConfig {
  return {
    version: CONFIG.PARENTAL_CONTROL_VERSION,
    enabled: false,
    pin: null,
    concealMode: 'show-locked',
    unlockDuration: 'once',
    groupRules: {},
    itemRules: {},
    approvedSources: [],
  };
}

function part(value: string): string {
  return encodeURIComponent(value);
}

export type ParentalSourceKind = 'live' | 'vod' | 'series';

function sourceKey(kind: ParentalSourceKind, id: string): string {
  return `${kind}|${part(id)}`;
}

function parentSourceKey(parent: LiveGroupTarget | CatalogCategoryTarget): string {
  return parent.kind === 'live-group'
    ? sourceKey('live', parent.playlistId)
    : sourceKey(parent.kind === 'vod-category' ? 'vod' : 'series', parent.accountId);
}

// What a source plays; a change means new content the parent hasn't reviewed.
// An Xtream password change keeps it, and so does an upload stored before
// revisions were recorded.
function sourceContentChange(previous: PlaylistEntry, next: PlaylistEntry): string | null {
  if ((previous.source ?? 'url') !== (next.source ?? 'url')) return 'type';
  if (next.source === 'upload') {
    return previous.revision !== undefined && previous.revision !== next.revision
      ? 'revision'
      : null;
  }
  if (previous.url !== next.url) return 'url';
  return previous.xtream?.username !== next.xtream?.username ? 'account' : null;
}

function currentSourceKeys(): string[] {
  const keys: string[] = [];
  for (const entry of StorageService.getPlaylists()) {
    keys.push(sourceKey('live', entry.id));
    if (entry.source === 'xtream') keys.push(sourceKey('vod', entry.id), sourceKey('series', entry.id));
  }
  return keys;
}

export type ParentalLockState = 'locked' | 'unlocked' | null;

// Why a session ended or a pending challenge was dropped, for diagnostics.
export type ParentalLockReason =
  | 'reload'
  | 'pin-created'
  | 'disabled'
  | 'removed'
  | 'duration-changed'
  | 'lock-now'
  | 'backgrounded'
  | 'account-switched';

export function parentalTargetKey(
  target: ParentalItemTarget | ParentalParentTarget,
): string {
  switch (target.kind) {
    case 'live-group':
      return `live-group|${part(target.playlistId)}|${part(target.groupKey)}`;
    case 'live-channel':
      return `live-channel|${part(target.channelKey)}`;
    case 'vod-category':
    case 'series-category':
      return `${target.kind}|${part(target.accountId)}|${part(target.categoryId)}`;
    case 'vod-item':
    case 'series-item':
      return `${target.kind}|${part(target.accountId)}|${part(target.itemId)}`;
  }
}

export function liveParentalRequest(
  channel: Channel,
  intent: ParentalAccessRequest['intent'] = 'play',
): ParentalAccessRequest {
  const groupKey = groupKeyOf(channel);
  return {
    target: { kind: 'live-channel', channelKey: channelKey(channel) },
    parents: channel.playlistIds.map(playlistId => ({
      kind: 'live-group' as const,
      playlistId,
      groupKey,
    })),
    intent,
    label: channel.name,
  };
}

export function catalogParentalRequest(
  kind: 'vod' | 'series',
  item: Pick<VodItem, 'accountId' | 'categoryId' | 'name'> & { id: string },
): Pick<ParentalAccessRequest, 'target' | 'parents'> {
  return {
    target: {
      kind: kind === 'vod' ? 'vod-item' : 'series-item',
      accountId: item.accountId,
      itemId: item.id,
    },
    parents: [{
      kind: kind === 'vod' ? 'vod-category' : 'series-category',
      accountId: item.accountId,
      categoryId: item.categoryId,
    }],
  };
}

export function isVodConcealed(item: VodItem): boolean {
  return ParentalControlService.isConcealed(
    catalogParentalRequest('vod', { ...item, id: item.streamId }),
  );
}

export function isSeriesConcealed(item: SeriesItem): boolean {
  return ParentalControlService.isConcealed(
    catalogParentalRequest('series', { ...item, id: item.seriesId }),
  );
}

export function isResumeConcealed(entry: ResumeEntry): boolean {
  const series = entry.kind === 'episode';
  return ParentalControlService.isConcealed(catalogParentalRequest(series ? 'series' : 'vod', {
    accountId: entry.accountId,
    categoryId: entry.categoryId ?? '',
    name: entry.name,
    id: series ? entry.watchlistOwner?.itemId ?? entry.itemId : entry.itemId,
  }));
}

export function isWatchlistConcealed(entry: WatchlistEntry): boolean {
  return ParentalControlService.isConcealed(catalogParentalRequest(entry.kind, {
    accountId: entry.accountId,
    categoryId: entry.categoryId,
    name: entry.name,
    id: entry.itemId,
  }));
}

export function vodParentalRequest(
  item: VodQueueItem,
  intent: ParentalAccessRequest['intent'] = 'play',
): ParentalAccessRequest {
  const series = item.kind === 'episode';
  const parents: CatalogCategoryTarget[] = [{
    kind: series ? 'series-category' : 'vod-category',
    accountId: item.accountId,
    categoryId: item.categoryId ?? '',
  }];
  return {
    target: {
      kind: series ? 'series-item' : 'vod-item',
      accountId: item.accountId,
      itemId: item.parentalItemId ?? item.itemId,
    },
    parents,
    intent,
    label: item.title,
  };
}

function emptyThrottle(): ParentalPinThrottle {
  return { failures: 0, lockouts: 0, blockedUntil: 0 };
}

function validThrottle(value: ParentalPinThrottle | null): ParentalPinThrottle {
  const count = (n: unknown) => typeof n === 'number' && n >= 0 && isFinite(n) ? Math.floor(n) : 0;
  return value && typeof value === 'object'
    ? { failures: count(value.failures), lockouts: count(value.lockouts), blockedUntil: count(value.blockedUntil) }
    : emptyThrottle();
}

class ParentalControlServiceImpl {
  private config = emptyConfig();
  private challengeHandler: ChallengeHandler | null = null;
  private pending: { request: ParentalAccessRequest; action: DeferredAction } | null = null;
  private unlockedUntil = 0;
  private lockGeneration = 0;
  private throttle: ParentalPinThrottle = emptyThrottle();
  private revealAll = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(concealmentChanged: boolean) => void>();
  private concealKey = '';
  private badgeKey = '';
  private ruleTables: [object, object] | null = null;
  private ruleRevision = 0;

  reload(): void {
    const stored = StorageService.getParentalControl();
    this.throttle = validThrottle(StorageService.getParentalThrottle());
    const fixes: string[] = [];
    if (stored && stored.version !== CONFIG.PARENTAL_CONTROL_VERSION) {
      fixes.push(`version-reset:${String(stored.version)}`);
    }
    this.config = stored?.version === CONFIG.PARENTAL_CONTROL_VERSION
      ? stored
      : emptyConfig();
    // Off means no PIN; drop one left by an older build so it can't be forgotten.
    if (!this.config.enabled && this.config.pin) {
      this.config = { ...this.config, pin: null };
      fixes.push('pin-dropped');
    }
    if (!Array.isArray(this.config.approvedSources)) {
      this.config = { ...this.config, approvedSources: currentSourceKeys() };
      fixes.push('sources-approved');
    }
    // Hidden content can't be reached by asking every time, since an unlock
    // that lapses at once leaves nothing visible to open.
    if (this.config.concealMode === 'hide-locked' && this.config.unlockDuration === 'once') {
      this.config = { ...this.config, unlockDuration: '5-minutes' };
      fixes.push('duration-raised');
    }
    if (fixes.length) {
      log.warn('Parental config repaired on load', 'event=parental.config.repaired',
        `fixes=${fixes.join(',')}`);
    }
    this.lock('reload');
    this.notify();
    this.logState('reload');
  }

  // One line a bug report can quote: everything that decides access, without
  // the PIN record or any content names.
  diagnostics(): string[] {
    const itemValues = Object.keys(this.config.itemRules).map(key => this.config.itemRules[key]);
    const current = currentSourceKeys();
    const now = performance.now();
    const session = !this.enabled || !this.isUnlocked()
      ? 'none'
      : this.unlockedUntil === Infinity
        ? 'until-backgrounded'
        : `${Math.round((this.unlockedUntil - now) / 1000)}s`;
    return [
      `enabled=${String(this.enabled)}`,
      `configured=${String(this.configured)}`,
      `pinAlgorithm=${this.config.pin?.algorithm ?? 'none'}`,
      `conceal=${this.config.concealMode}`,
      `duration=${this.config.unlockDuration}`,
      `session=${session}`,
      `concealing=${String(this.concealing)}`,
      `revealAll=${String(this.revealAll)}`,
      `pending=${this.pending ? this.pending.request.intent : 'none'}`,
      `groupRules=${Object.keys(this.config.groupRules).length}`,
      `itemProtect=${itemValues.filter(value => value === 'protect').length}`,
      `itemAllow=${itemValues.filter(value => value === 'allow').length}`,
      `approved=${this.config.approvedSources.length}`,
      `unreviewed=${current.filter(key => this.config.approvedSources.indexOf(key) < 0).join(',') || 'none'}`,
      `failures=${this.throttle.failures}`,
      `lockouts=${this.throttle.lockouts}`,
      `blockedMs=${Math.max(0, this.throttle.blockedUntil - Date.now())}`,
    ];
  }

  logState(trigger: string): void {
    log.info('Parental state', 'event=parental.state', `trigger=${trigger}`, ...this.diagnostics());
  }

  // Fires when lock badges or concealment may have changed. The flag is true
  // only when what is hidden changed, so callers can skip rebuilding lists.
  subscribe(listener: (concealmentChanged: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Badge for a list row: 'locked' asks for the PIN, 'unlocked' is locked
  // content inside an open unlock session, null is not locked at all.
  lockState(request: Pick<ParentalAccessRequest, 'target' | 'parents'>): ParentalLockState {
    if (!this.enabled || this.ruleDecision(request).allowed) return null;
    return this.isUnlocked() ? 'unlocked' : 'locked';
  }

  groupLockState(targets: Array<LiveGroupTarget | CatalogCategoryTarget>): ParentalLockState {
    if (!this.enabled) return null;
    if (!targets.some(target => this.groupLocked(target))) return null;
    return this.isUnlocked() ? 'unlocked' : 'locked';
  }

  // A PIN entry left locked content open (timed or until backgrounded).
  get sessionActive(): boolean {
    return this.enabled && this.isUnlocked();
  }

  // Whether hide mode keeps this hidden when no unlock session is open, for
  // text that outlives the session, such as a scheduled system notification.
  concealedWhenLocked(request: Pick<ParentalAccessRequest, 'target' | 'parents'>): boolean {
    return this.enabled
      && this.config.concealMode === 'hide-locked'
      && !this.ruleDecision(request).allowed;
  }

  // Whether a rule guards this content, whatever the current session.
  protects(request: Pick<ParentalAccessRequest, 'target' | 'parents'>): boolean {
    return this.enabled && !this.ruleDecision(request).allowed;
  }

  get concealing(): boolean {
    return this.enabled
      && this.config.concealMode === 'hide-locked'
      && !this.revealAll
      && !this.isUnlocked();
  }

  // Leaving the PIN-gated manager counts as a PIN entry, timed by the duration
  // chosen there last, so switching to "Once" takes effect immediately.
  endManagement(): void {
    log.info('Parental management ended', 'event=parental.manager.ended',
      `duration=${this.config.unlockDuration}`);
    this.revealAll = false;
    this.pending = null;
    if (this.enabled) this.unlockFor(this.config.unlockDuration);
    else this.notify();
  }

  // Management lists every target regardless of concealment; the entry PIN
  // proved the viewer is the parent even when the unlock duration is "Once".
  setRevealAll(reveal: boolean): void {
    if (this.revealAll === reveal) return;
    this.revealAll = reveal;
    this.notify();
  }

  isConcealed(request: Pick<ParentalAccessRequest, 'target' | 'parents'>): boolean {
    if (!this.concealing) return false;
    const decision = this.decision(request as ParentalAccessRequest);
    return !decision.allowed && decision.concealed;
  }

  // isConcealed for every item of one catalog, as rules the worker can apply;
  // null when nothing is concealed.
  catalogConcealment(kind: 'vod' | 'series', accountId: string): CatalogConcealment | null {
    if (!this.concealing) return null;
    const category = kind === 'vod' ? 'vod-category' : 'series-category';
    const categoryPrefix = `${category}|${part(accountId)}|`;
    const itemPrefix = `${kind === 'vod' ? 'vod-item' : 'series-item'}|${part(accountId)}|`;
    const lockedCategories: string[] = [];
    for (const key of Object.keys(this.config.groupRules)) {
      if (key.startsWith(categoryPrefix) && this.config.groupRules[key] === 'protect') {
        lockedCategories.push(decodeURIComponent(key.slice(categoryPrefix.length)));
      }
    }
    const allowedItems: string[] = [];
    const protectedItems: string[] = [];
    for (const key of Object.keys(this.config.itemRules)) {
      if (!key.startsWith(itemPrefix)) continue;
      const id = decodeURIComponent(key.slice(itemPrefix.length));
      if (this.config.itemRules[key] === 'allow') allowedItems.push(id);
      else if (this.config.itemRules[key] === 'protect') protectedItems.push(id);
    }
    const parent: CatalogCategoryTarget = { kind: category, accountId, categoryId: '' };
    return {
      sourceApproved: this.config.approvedSources.indexOf(parentSourceKey(parent)) >= 0,
      lockedCategories,
      allowedItems,
      protectedItems,
      uncategorizedLocked: this.protectsAnyCatalogItem(parent),
    };
  }

  // A catalog category disappears as a whole only when the category itself is
  // locked; item exceptions inside it are still found through Search.
  isCategoryConcealed(target: CatalogCategoryTarget | LiveGroupTarget): boolean {
    return this.concealing && this.groupLocked(target);
  }

  // A source added while parental controls are on, from Settings or the
  // phone, stays wholly locked until the parent reviews it in the manager;
  // otherwise re-adding a source under a new id would shed its locks.
  sourceApproved(kind: ParentalSourceKind, id: string): boolean {
    return this.config.approvedSources.indexOf(sourceKey(kind, id)) >= 0;
  }

  // The parent opened the source in the manager: its blanket lock becomes a
  // lock on each of its groups, which can then be unlocked one by one.
  adoptSource(
    kind: ParentalSourceKind,
    id: string,
    groups: Array<LiveGroupTarget | CatalogCategoryTarget>,
  ): void {
    if (this.sourceApproved(kind, id)) return;
    const groupRules = { ...this.config.groupRules };
    for (const group of groups) groupRules[parentalTargetKey(group)] = 'protect';
    this.config = { ...this.config, groupRules, approvedSources: this.withApproved(sourceKey(kind, id)) };
    this.persist('adopt-source', `source=${sourceKey(kind, id)}`, `groups=${groups.length}`);
  }

  // A source whose address, account, or uploaded file changed is locked again
  // until the parent reviews it, like a newly added one.
  reviewChangedSources(previous: PlaylistEntry[], next: PlaylistEntry[]): void {
    if (!this.enabled) return;
    const changes: string[] = [];
    const revoked = new Set<string>();
    for (const entry of next) {
      const before = previous.find(item => item.id === entry.id);
      const change = before ? sourceContentChange(before, entry) : null;
      if (!change) continue;
      changes.push(`${part(entry.id)}:${change}`);
      for (const kind of ['live', 'vod', 'series'] as const) revoked.add(sourceKey(kind, entry.id));
    }
    if (!changes.length) return;
    const approvedSources = this.config.approvedSources.filter(key => !revoked.has(key));
    if (approvedSources.length === this.config.approvedSources.length) {
      log.debug('Changed sources were already unreviewed', 'event=parental.sources.changed',
        `changes=${changes.join(',')}`, 'relocked=false');
      return;
    }
    this.config = { ...this.config, approvedSources };
    this.persist('sources-relocked', `changes=${changes.join(',')}`);
  }

  private withApproved(key: string): string[] {
    const current = currentSourceKeys();
    const approved = this.config.approvedSources.filter(item => current.indexOf(item) >= 0);
    if (approved.indexOf(key) < 0) approved.push(key);
    return approved;
  }

  private groupLocked(target: LiveGroupTarget | CatalogCategoryTarget): boolean {
    return this.config.approvedSources.indexOf(parentSourceKey(target)) < 0
      || this.config.groupRules[parentalTargetKey(target)] === 'protect';
  }

  snapshot(): ParentalControlConfig {
    return JSON.parse(JSON.stringify(this.config)) as ParentalControlConfig;
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.pin !== null;
  }

  // Channel edits change the group keys that live locks match on.
  // A viewing unlock never lifts these: changing settings always takes the PIN.
  get guardsLiveEditing(): boolean {
    if (!this.enabled) return false;
    return Object.keys(this.config.groupRules).some(key => key.startsWith('live-group|'))
      || Object.keys(this.config.itemRules).some(key =>
        key.startsWith('live-channel|') && this.config.itemRules[key] === 'protect');
  }

  // Re-adding a removed source gives it a new id, which drops its locks.
  guardsSourceRemoval(id: string): boolean {
    if (!id || !this.enabled) return false;
    const source = part(id);
    const owned = (key: string) => key.split('|')[1] === source;
    return Object.keys(this.config.groupRules).some(owned)
      || Object.keys(this.config.itemRules).some(key =>
        this.config.itemRules[key] === 'protect' && /^(vod|series)-item\|/.test(key) && owned(key));
  }

  get configured(): boolean {
    return this.config.pin !== null;
  }

  get hasPendingChallenge(): boolean {
    return this.pending !== null;
  }

  setChallengeHandler(handler: ChallengeHandler | null): void {
    this.challengeHandler = handler;
  }

  decision(request: ParentalAccessRequest): ParentalAccessDecision {
    if (!this.enabled || this.isUnlocked()) return { allowed: true };
    return this.ruleDecision(request);
  }

  // Entries saved before parental controls existed carry no category (nor,
  // for episodes, their series), so they stay locked while any rule could
  // apply to them.
  private protectsAnyCatalogItem(parent: CatalogCategoryTarget): boolean {
    const account = part(parent.accountId);
    const itemKind = parent.kind === 'vod-category' ? 'vod-item' : 'series-item';
    return this.config.approvedSources.indexOf(parentSourceKey(parent)) < 0
      || Object.keys(this.config.groupRules)
      .some(key => key.startsWith(`${parent.kind}|${account}|`))
      || Object.keys(this.config.itemRules).some(key =>
        key.startsWith(`${itemKind}|${account}|`) && this.config.itemRules[key] === 'protect');
  }

  private ruleDecision(
    request: Pick<ParentalAccessRequest, 'target' | 'parents'>,
  ): ParentalAccessDecision {
    const itemRule = this.config.itemRules[parentalTargetKey(request.target)];
    if (itemRule === 'allow') return { allowed: true };
    if (itemRule === 'protect' || this.parentsLocked(request.parents)) {
      return {
        allowed: false,
        concealed: this.config.concealMode === 'hide-locked',
        reason: itemRule === 'protect' ? 'item' : 'parent',
      };
    }
    return { allowed: true };
  }

  // What an item without its own rule inherits from its groups.
  parentsLocked(parents: Array<LiveGroupTarget | CatalogCategoryTarget>): boolean {
    return parents.some(parent => (parent.kind !== 'live-group' && !parent.categoryId
      ? this.protectsAnyCatalogItem(parent)
      : this.groupLocked(parent)));
  }

  authorize(request: ParentalAccessRequest, action: DeferredAction): boolean {
    const decision = this.decision(request);
    if (decision.allowed) {
      if (this.enabled) {
        this.logAccess(request, this.isUnlocked() ? 'allowed-unlocked' : 'allowed-rule', 'debug');
      }
      void action();
      return true;
    }
    // A request dropped here does nothing visible: the usual "OK does nothing" report.
    if (this.pending || !this.challengeHandler) {
      this.logAccess(request, this.pending ? 'dropped-pending' : 'dropped-no-handler', 'warn',
        `reason=${decision.reason}`,
        `pendingIntent=${this.pending ? this.pending.request.intent : 'none'}`);
      return false;
    }
    this.pending = { request, action };
    this.logAccess(request, 'challenge', 'info', `reason=${decision.reason}`);
    this.challengeHandler(request);
    return false;
  }

  private logAccess(
    request: ParentalAccessRequest,
    result: string,
    level: 'debug' | 'info' | 'warn',
    ...extra: string[]
  ): void {
    log[level]('Parental access', 'event=parental.access', `result=${result}`,
      `intent=${request.intent}`, `target=${parentalTargetKey(request.target)}`,
      `parents=${request.parents.map(parentalTargetKey).join(',') || 'none'}`,
      `conceal=${this.config.concealMode}`, ...extra);
  }

  cancelChallenge(): void {
    if (this.pending) {
      log.info('Parental challenge cancelled', 'event=parental.challenge.cancelled',
        `intent=${this.pending.request.intent}`,
        `target=${parentalTargetKey(this.pending.request.target)}`);
    }
    this.pending = null;
    this.lockGeneration++;
  }

  async submitPin(pin: string, now = Date.now()): Promise<ParentalPinSubmitResult> {
    const generation = this.lockGeneration;
    const rejected = await this.checkPin(pin, now, 'challenge');
    if (rejected) return rejected;
    // Locked or canceled while the PIN was being checked.
    if (generation !== this.lockGeneration) {
      log.warn('PIN accepted after the challenge ended; nothing to run',
        'event=parental.challenge.stale');
      return { accepted: true, blockedForMs: 0 };
    }
    const pending = this.pending;
    this.pending = null;
    // The deferred action may hold a list index; rebuild concealed lists after it.
    this.unlockFor(this.config.unlockDuration, false);
    if (pending) {
      try {
        await pending.action();
      } catch (err) {
        log.error('Deferred parental action failed', 'event=parental.action.failed',
          `intent=${pending.request.intent}`,
          `target=${parentalTargetKey(pending.request.target)}`, err);
        throw err;
      } finally {
        this.notify();
      }
    } else {
      log.warn('PIN accepted with no pending action', 'event=parental.challenge.empty');
      this.notify();
    }
    return { accepted: true, blockedForMs: 0 };
  }

  async verifyManagementPin(pin: string, now = Date.now()): Promise<ParentalPinSubmitResult> {
    return await this.checkPin(pin, now, 'manage') ?? { accepted: true, blockedForMs: 0 };
  }

  retryBlockedForMs(now = Date.now()): number {
    const remaining = this.throttle.blockedUntil - now;
    const max = CONFIG.PARENTAL_PIN_MAX_RETRY_DELAY_MS;
    // A clock moved backwards would otherwise stretch the lockout past the cap.
    if (remaining > max) {
      log.warn('PIN lockout capped after a clock change', 'event=parental.pin.lockout.capped',
        `remainingMs=${remaining}`, `capMs=${max}`);
      this.setThrottle({ ...this.throttle, blockedUntil: now + max });
      return max;
    }
    return Math.max(0, remaining);
  }

  // Null when the PIN is right. MAX_FAILURES wrong PINs start a lockout; after
  // that each wrong PIN starts the next one at double the delay, up to the cap.
  private async checkPin(
    pin: string,
    now: number,
    purpose: 'challenge' | 'manage',
  ): Promise<ParentalPinSubmitResult | null> {
    const remaining = this.retryBlockedForMs(now);
    if (remaining > 0) {
      this.logPinCheck(purpose, 'blocked', remaining);
      return { accepted: false, blockedForMs: remaining };
    }
    if (!this.config.pin) {
      log.error('PIN checked with no PIN stored', 'event=parental.pin.missing',
        `purpose=${purpose}`, `enabled=${String(this.config.enabled)}`);
    } else if (await verifyParentalPin(pin, this.config.pin)) {
      this.setThrottle(emptyThrottle());
      this.logPinCheck(purpose, 'accepted', 0);
      return null;
    }
    const failures = this.throttle.failures + 1;
    if (this.throttle.lockouts === 0 && failures < CONFIG.PARENTAL_PIN_MAX_FAILURES) {
      this.setThrottle({ ...this.throttle, failures });
      this.logPinCheck(purpose, 'wrong', 0);
      return { accepted: false, blockedForMs: 0 };
    }
    const delay = Math.min(
      CONFIG.PARENTAL_PIN_RETRY_DELAY_MS * Math.pow(2, this.throttle.lockouts),
      CONFIG.PARENTAL_PIN_MAX_RETRY_DELAY_MS,
    );
    this.setThrottle({
      failures: 0,
      lockouts: this.throttle.lockouts + 1,
      blockedUntil: now + delay,
    });
    this.logPinCheck(purpose, 'lockout', delay);
    return { accepted: false, blockedForMs: delay };
  }

  private logPinCheck(purpose: string, result: string, blockedMs: number): void {
    log[result === 'accepted' ? 'info' : 'warn']('Parental PIN checked',
      'event=parental.pin.checked', `purpose=${purpose}`, `result=${result}`,
      `failures=${this.throttle.failures}`, `lockouts=${this.throttle.lockouts}`,
      `blockedMs=${blockedMs}`);
  }

  private setThrottle(throttle: ParentalPinThrottle): void {
    this.throttle = throttle;
    StorageService.setParentalThrottle(throttle.failures || throttle.lockouts ? throttle : null);
  }

  async createPin(pin: string): Promise<void> {
    const pinRecord = await createParentalPin(pin);
    this.config = {
      ...this.config,
      enabled: true,
      pin: pinRecord,
      approvedSources: currentSourceKeys(),
    };
    this.persist('enabled');
    this.lock('pin-created');
  }

  // The manager is already PIN-gated, so a new PIN needs no current one.
  async replacePin(nextPin: string): Promise<void> {
    this.config = { ...this.config, pin: await createParentalPin(nextPin) };
    this.persist('pin-changed');
  }

  // Turning off clears the PIN but keeps the locks; turning on sets a new PIN.
  disable(): void {
    this.config = { ...this.config, enabled: false, pin: null };
    this.persist('disabled');
    this.setThrottle(emptyThrottle());
    this.lock('disabled');
  }

  remove(): void {
    this.config = emptyConfig();
    StorageService.clearParentalControl();
    log.info('Parental config removed', 'event=parental.config.changed', 'op=removed');
    this.setThrottle(emptyThrottle());
    this.lock('removed');
  }

  setConcealMode(mode: ParentalControlConfig['concealMode']): void {
    const unlockDuration = mode === 'hide-locked' && this.config.unlockDuration === 'once'
      ? '5-minutes'
      : this.config.unlockDuration;
    this.config = { ...this.config, concealMode: mode, unlockDuration };
    this.persist('conceal-mode');
  }

  setUnlockDuration(duration: ParentalUnlockDuration): void {
    if (duration === 'once' && this.config.concealMode === 'hide-locked') {
      log.warn('Ignored "once" while hiding locked content', 'event=parental.config.ignored',
        'op=unlock-duration');
      return;
    }
    this.config = { ...this.config, unlockDuration: duration };
    this.persist('unlock-duration');
    this.lock('duration-changed');
  }

  groupProtected(target: LiveGroupTarget | CatalogCategoryTarget): boolean {
    return this.groupProtectedByKey(parentalTargetKey(target));
  }

  groupProtectedByKey(key: string): boolean {
    return this.config.groupRules[key] === 'protect';
  }

  setGroupProtected(
    target: LiveGroupTarget | CatalogCategoryTarget,
    protectedValue: boolean,
  ): void {
    const groupRules = { ...this.config.groupRules };
    const key = parentalTargetKey(target);
    if (protectedValue) groupRules[key] = 'protect';
    else delete groupRules[key];
    this.config = { ...this.config, groupRules };
    this.persist('group-rule', `target=${key}`, `locked=${String(protectedValue)}`);
  }

  // Rule tables are replaced, never mutated, so identity marks a change.
  get rulesRevision(): number {
    const tables = this.ruleTables;
    if (!tables || tables[0] !== this.config.groupRules || tables[1] !== this.config.itemRules) {
      this.ruleTables = [this.config.groupRules, this.config.itemRules];
      this.ruleRevision++;
    }
    return this.ruleRevision;
  }

  groupRuleKeys(): string[] {
    return Object.keys(this.config.groupRules);
  }

  itemRuleEntries(): Array<[string, ParentalRuleValue]> {
    return Object.keys(this.config.itemRules)
      .map(key => [key, this.config.itemRules[key]] as [string, ParentalRuleValue]);
  }

  itemRule(target: LiveChannelTarget | CatalogItemTarget): ParentalRuleValue | null {
    return this.itemRuleByKey(parentalTargetKey(target));
  }

  hasItemRules(): boolean {
    return Object.keys(this.config.itemRules).length > 0;
  }

  itemRuleByKey(key: string): ParentalRuleValue | null {
    return this.config.itemRules[key] ?? null;
  }

  setItemRule(
    target: LiveChannelTarget | CatalogItemTarget,
    rule: ParentalRuleValue | null,
  ): void {
    const itemRules = { ...this.config.itemRules };
    const key = parentalTargetKey(target);
    if (rule) itemRules[key] = rule;
    else delete itemRules[key];
    this.config = { ...this.config, itemRules };
    this.persist('item-rule', `target=${key}`, `rule=${rule ?? 'inherit'}`);
  }

  itemLocked(
    target: LiveChannelTarget | CatalogItemTarget,
    parents: Array<LiveGroupTarget | CatalogCategoryTarget>,
  ): boolean {
    return !this.ruleDecision({ target, parents }).allowed;
  }

  // Items are simply locked or not; a rule is stored only where the item
  // differs from its group, so locking or unlocking the group still applies.
  setItemLocked(
    target: LiveChannelTarget | CatalogItemTarget,
    parents: Array<LiveGroupTarget | CatalogCategoryTarget>,
    locked: boolean,
  ): void {
    const inherited = parents.some(parent => this.groupProtected(parent));
    this.setItemRule(target, locked === inherited ? null : locked ? 'protect' : 'allow');
  }

  clearRules(): void {
    this.config = { ...this.config, groupRules: {}, itemRules: {}, approvedSources: currentSourceKeys() };
    this.persist('rules-cleared');
  }

  setGroupsProtected(
    targets: Array<LiveGroupTarget | CatalogCategoryTarget>,
    protectedValue: boolean,
  ): void {
    const groupRules = { ...this.config.groupRules };
    for (const target of targets) {
      const key = parentalTargetKey(target);
      if (protectedValue) groupRules[key] = 'protect';
      else delete groupRules[key];
    }
    this.config = { ...this.config, groupRules };
    this.persist('group-rules', `count=${targets.length}`, `locked=${String(protectedValue)}`);
  }

  clearItemRules(items: Array<LiveChannelTarget | CatalogItemTarget>): void {
    const itemRules = { ...this.config.itemRules };
    for (const item of items) delete itemRules[parentalTargetKey(item)];
    this.config = { ...this.config, itemRules };
    this.persist('item-rules-cleared', `count=${items.length}`);
  }

  // Live channel rules are keyed by channel, not playlist, so callers pass the
  // playlist's channel keys; catalog rules carry their account in the key.
  clearSourceRules(
    kind: 'live' | 'vod' | 'series',
    accountId: string,
    channelKeys: string[] = [],
  ): void {
    const groupPrefix = kind === 'live'
      ? `live-group|${part(accountId)}|`
      : `${kind === 'vod' ? 'vod' : 'series'}-category|${part(accountId)}|`;
    const itemPrefix = kind === 'live'
      ? null
      : `${kind === 'vod' ? 'vod' : 'series'}-item|${part(accountId)}|`;
    const liveKeys = new Set(channelKeys.map(key => parentalTargetKey({
      kind: 'live-channel',
      channelKey: key,
    })));
    const groupRules: Record<string, 'protect'> = {};
    for (const key of Object.keys(this.config.groupRules)) {
      if (!key.startsWith(groupPrefix)) groupRules[key] = this.config.groupRules[key];
    }
    const itemRules: Record<string, ParentalRuleValue> = {};
    for (const key of Object.keys(this.config.itemRules)) {
      const owned = itemPrefix ? key.startsWith(itemPrefix) : liveKeys.has(key);
      if (!owned) itemRules[key] = this.config.itemRules[key];
    }
    this.config = {
      ...this.config,
      groupRules,
      itemRules,
      approvedSources: this.withApproved(sourceKey(kind, accountId)),
    };
    this.persist('source-rules-cleared', `source=${sourceKey(kind, accountId)}`);
  }

  lock(reason: ParentalLockReason): void {
    const unlocked = this.unlockedUntil !== 0 && this.isUnlocked();
    if (unlocked || this.pending) {
      log.info('Parental session ended', 'event=parental.session.ended', `reason=${reason}`,
        `wasUnlocked=${String(unlocked)}`,
        `droppedIntent=${this.pending ? this.pending.request.intent : 'none'}`);
    }
    this.pending = null;
    this.lockGeneration++;
    this.unlockedUntil = 0;
    this.clearExpiryTimer();
    this.notify();
  }

  // The session runs on the monotonic clock so setting the wall clock back
  // can't extend it.
  private isUnlocked(): boolean {
    return this.unlockedUntil === Infinity || this.unlockedUntil > performance.now();
  }

  private unlockFor(duration: ParentalUnlockDuration, notify = true): void {
    this.clearExpiryTimer();
    const now = performance.now();
    switch (duration) {
      case '5-minutes':
        this.unlockedUntil = now + 5 * 60 * 1000;
        break;
      case '15-minutes':
        this.unlockedUntil = now + 15 * 60 * 1000;
        break;
      case 'until-backgrounded':
        this.unlockedUntil = Infinity;
        break;
      case 'once':
        this.unlockedUntil = 0;
        break;
    }
    log.info('Parental session started', 'event=parental.session.started',
      `duration=${duration}`,
      `expiresInMs=${this.unlockedUntil === Infinity ? 'background' : Math.max(0, Math.round(this.unlockedUntil - now))}`);
    if (this.unlockedUntil > now && this.unlockedUntil !== Infinity) {
      this.expiryTimer = setTimeout(() => {
        this.expiryTimer = null;
        log.info('Parental session expired', 'event=parental.session.expired',
          `duration=${duration}`);
        this.notify();
      }, this.unlockedUntil - now);
    }
    if (notify) this.notify();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === null) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private notify(): void {
    const rules = `${JSON.stringify(this.config.groupRules)}|${
      JSON.stringify(this.config.itemRules)}|${this.config.approvedSources.join(',')}`;
    const key = this.concealing ? `${this.config.concealMode}|${rules}` : '';
    // The mode rides along even while management reveals everything, so
    // reminder copy follows a switch out of Hide mode.
    const badges = this.enabled ? `${this.isUnlocked()}|${this.config.concealMode}|${rules}` : '';
    const concealmentChanged = key !== this.concealKey;
    if (!concealmentChanged && badges === this.badgeKey) return;
    log.debug('Parental locks changed', 'event=parental.locks.changed',
      `concealing=${String(this.concealing)}`, `concealmentChanged=${String(concealmentChanged)}`,
      `unlocked=${String(this.enabled && this.isUnlocked())}`, `listeners=${this.listeners.size}`);
    this.concealKey = key;
    this.badgeKey = badges;
    this.listeners.forEach(listener => listener(concealmentChanged));
  }

  private persist(op: string, ...extra: string[]): void {
    StorageService.setParentalControl(this.config);
    log.info('Parental config changed', 'event=parental.config.changed', `op=${op}`, ...extra,
      `enabled=${String(this.enabled)}`, `conceal=${this.config.concealMode}`,
      `duration=${this.config.unlockDuration}`,
      `groupRules=${Object.keys(this.config.groupRules).length}`,
      `itemRules=${Object.keys(this.config.itemRules).length}`,
      `approved=${this.config.approvedSources.length}`);
    this.notify();
  }
}

export const ParentalControlService = new ParentalControlServiceImpl();
