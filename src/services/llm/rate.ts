// Reads how long a rate-limited server wants us to wait, from its headers
// and error body, and tells a short throttle apart from a spent quota.

export const HOUR_MS = 3600000;
// A reported reset this soon after a request that used the last one pauses the queue.
export const SHORT_RESET_MS = 60000;

interface HeaderSource {
  get(name: string): string | null;
}

// Account or billing codes that no wait fixes.
const QUOTA_CODE_RE = /insufficient_quota|quota_exceeded|_spend_limit_exceeded|billing_hard_limit_reached|exceeded_current_quota_error|credit_balance_exhausted|usage_limit_exceeded/i;
const PER_MINUTE_RE = /\bper[ _-]?min(ute)?s?\b|perminute|\brpm\b|\btpm\b/i;
const PER_DAY_RE = /per[ _-]?day|\bdaily\b|\btoday\b|\brpd\b|\btpd\b/i;
const PER_MONTH_RE = /per[ _-]?month|\bmonthly\b|\bthis month\b/i;
// A limit named without saying which: spent unless a wait or throttle wording says otherwise.
const QUOTA_WORDS_RE = /quota|\bbilling\b|\bspend\b|free tier|usage limit|额度/i;
const THROTTLE_WORDS_RE = /rate[ _-]?limit|throttl|too many requests|resource[ _]?(has been )?exhausted/i;
// Money, not a limit: no wait fixes a spent balance.
// Whole words, so "load balancer" or "suspended" doesn't read as money.
const MONEY_RE = /\bbalance\b|\bcredits?\b|\binsufficient[_ ](quota|balance|credit|funds)|\boverdue\b|\barrear|account (is )?in good standing|\brecharge\b|\btop[ -]?up\b|payment required|欠费|余额|充值/i;
// "try again in 7m12s", "retry after 1.5s": a compact duration.
const RETRY_DURATION_RE = /(?:retry|try again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)(?![a-z])/i;
const RETRY_TEXT_RE = /(?:retry|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)?(?![a-z])/i;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: HOUR_MS };

/** "6m0s", "2m59.56s", "1s", "120ms", "1h", or bare seconds, in ms; 0 when unreadable. */
export function durationMs(text: string): number {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let seen = '';
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    total += Number(match[1]) * UNIT_MS[match[2]];
    seen += match[0];
  }
  return seen.length === value.replace(/\s+/g, '').length ? Math.round(total) : 0;
}

function positive(ms: number): number {
  return isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0;
}

/** The wait the headers ask for: Retry-After, retry-after-ms, then the reset of each limit. */
export function headerWaitMs(headers: HeaderSource, now: number): number {
  const retryAfter = headers.get('Retry-After');
  if (retryAfter) {
    const value = retryAfter.trim();
    const wait = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    if (positive(wait)) return positive(wait);
  }
  const ms = Number(headers.get('retry-after-ms'));
  if (positive(ms)) return positive(ms);
  // The limit that ran out decides; when neither says so, the later reset.
  const limits = ['requests', 'tokens'].map((kind) => ({
    reset: durationMs(headers.get(`x-ratelimit-reset-${kind}`) || ''),
    spent: headers.get(`x-ratelimit-remaining-${kind}`) !== null && Number(headers.get(`x-ratelimit-remaining-${kind}`)) === 0,
  }));
  const spent = limits.filter((limit) => limit.spent && limit.reset);
  const reset = Math.max.apply(null, (spent.length ? spent : limits).map((limit) => limit.reset));
  if (reset) return reset;
  const epoch = Number(headers.get('X-RateLimit-Reset'));
  if (epoch > 1e12) return positive(epoch - now);
  if (epoch > 1e9) return positive(epoch * 1000 - now);
  return 0;
}

/** A retry delay the error body names, as a `retryDelay` field or "retry in 43.2s" text. */
export function bodyRetryMs(body: string): number {
  let found = 0;
  const walk = (value: unknown, depth: number): void => {
    if (found || depth > 8 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1));
      return;
    }
    const fields = value as Record<string, unknown>;
    if (typeof fields.retryDelay === 'string') found = durationMs(fields.retryDelay);
    Object.keys(fields).forEach((key) => walk(fields[key], depth + 1));
  };
  try {
    walk(JSON.parse(body.trim()), 0);
  } catch {
    // Not JSON; the text below may still name a delay.
  }
  if (found) return found;
  const compact = RETRY_DURATION_RE.exec(body);
  if (compact && durationMs(compact[1])) return durationMs(compact[1]);
  const match = RETRY_TEXT_RE.exec(body);
  if (!match) return 0;
  const unit = (match[2] || 's').toLowerCase();
  const scale = unit.indexOf('ms') === 0 || unit.indexOf('milli') === 0 ? 1
    : unit.charAt(0) === 'h' ? HOUR_MS : unit.charAt(0) === 'm' ? 60000 : 1000;
  return positive(Number(match[1]) * scale);
}

export interface RateVerdict {
  // A spent quota or balance: no wait within reason fixes it.
  exhausted: boolean;
  // How long to wait before trying again; 0 when nothing says.
  waitMs: number;
}

/**
 * Throttle or spent quota for a 402/429/403 answer. Per-minute wording wins
 * over quota words, since per-minute limits are often worded as a "quota";
 * per-day wording and money (balance, credit) win over a named wait, which a
 * spent quota may still name; a named wait or throttle wording then wins over
 * a bare "quota".
 */
export function rateVerdict(status: number, body: string, headerWait: number): RateVerdict {
  const exhausted: RateVerdict = { exhausted: true, waitMs: 0 };
  if (status === 402 || QUOTA_CODE_RE.test(body)) return exhausted;
  const bodyWait = bodyRetryMs(body);
  const waitMs = headerWait || bodyWait;
  const throttle: RateVerdict = waitMs > HOUR_MS ? exhausted : { exhausted: false, waitMs };
  if (PER_MINUTE_RE.test(body)) return throttle;
  if (PER_DAY_RE.test(body) || MONEY_RE.test(body)) return exhausted;
  if (waitMs || THROTTLE_WORDS_RE.test(body)) return throttle;
  return QUOTA_WORDS_RE.test(body) ? exhausted : throttle;
}

/** Whether the body carries an account or billing code that no wait fixes. */
export function hasQuotaCode(body: string): boolean {
  return QUOTA_CODE_RE.test(body);
}

/** Whether an error is about the account's money: balance, credit, payment. */
export function namesMoney(text: string): boolean {
  return MONEY_RE.test(text);
}

/** Whether a limit is the account's (per day or month, a quota, a plan's money) rather than the request's size. */
export function namesAccountLimit(text: string): boolean {
  return QUOTA_CODE_RE.test(text) || MONEY_RE.test(text) || QUOTA_WORDS_RE.test(text) || PER_DAY_RE.test(text)
    || PER_MONTH_RE.test(text);
}

/** Whether a 403 is about money or a spent quota rather than the key or the model. */
export function namesQuota(body: string): boolean {
  return QUOTA_CODE_RE.test(body) || MONEY_RE.test(body) || QUOTA_WORDS_RE.test(body) || PER_DAY_RE.test(body);
}

/** How long to hold requests after a success that used the server's last one; 0 for none. */
export function exhaustedResetMs(headers: HeaderSource): number {
  const remaining = headers.get('x-ratelimit-remaining-requests');
  if (remaining === null || Number(remaining) !== 0) return 0;
  const reset = durationMs(headers.get('x-ratelimit-reset-requests') || '');
  return reset > 0 && reset <= SHORT_RESET_MS ? reset : 0;
}
