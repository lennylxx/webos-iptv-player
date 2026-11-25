import { describe, expect, it } from 'vitest';
import { bodyRetryMs, durationMs, exhaustedResetMs, headerWaitMs, rateVerdict } from './rate';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const headers = (values: Record<string, string>) => new Headers(values);

describe('rate limit headers', () => {
  it('reads reset durations', () => {
    expect(durationMs('6m0s')).toBe(360000);
    expect(durationMs('2m59.56s')).toBe(179560);
    expect(durationMs('1s')).toBe(1000);
    expect(durationMs('120ms')).toBe(120);
    expect(durationMs('1h')).toBe(3600000);
    expect(durationMs('7')).toBe(7000);
    expect(durationMs('soon')).toBe(0);
  });

  it('prefers Retry-After, then retry-after-ms, then the limit resets, then an epoch reset', () => {
    expect(headerWaitMs(headers({ 'Retry-After': '7', 'retry-after-ms': '100' }), NOW)).toBe(7000);
    expect(headerWaitMs(headers({ 'Retry-After': 'Thu, 01 Jan 2026 00:00:30 GMT' }), NOW)).toBe(30000);
    expect(headerWaitMs(headers({ 'retry-after-ms': '1500' }), NOW)).toBe(1500);
    expect(headerWaitMs(headers({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' }), NOW)).toBe(360000);
    expect(headerWaitMs(headers({ 'X-RateLimit-Reset': String(NOW + 45000) }), NOW)).toBe(45000);
    expect(headerWaitMs(headers({}), NOW)).toBe(0);
  });

  it('waits for the reset of the limit that ran out', () => {
    expect(headerWaitMs(headers({
      'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1s',
      'x-ratelimit-remaining-tokens': '5000', 'x-ratelimit-reset-tokens': '6m0s',
    }), NOW)).toBe(1000);
    expect(headerWaitMs(headers({
      'x-ratelimit-remaining-requests': '12', 'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2s',
    }), NOW)).toBe(2000);
  });

  it('holds requests only after one used the last of a short limit', () => {
    expect(exhaustedResetMs(headers({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '20s' }))).toBe(20000);
    expect(exhaustedResetMs(headers({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6h0m0s' }))).toBe(0);
    expect(exhaustedResetMs(headers({ 'x-ratelimit-remaining-requests': '2', 'x-ratelimit-reset-requests': '20s' }))).toBe(0);
    expect(exhaustedResetMs(headers({}))).toBe(0);
  });
});

describe('rate limit bodies', () => {
  it('reads a retry delay from a details field or from the text', () => {
    expect(bodyRetryMs(JSON.stringify([{ error: { details: [{ retryDelay: '1.5s' }] } }]))).toBe(1500);
    expect(bodyRetryMs('{"error":{"message":"Please try again in 20s."}}')).toBe(20000);
    expect(bodyRetryMs('{"error":{"message":"Please try again in 350ms."}}')).toBe(350);
    expect(bodyRetryMs('{"error":"slow down"}')).toBe(0);
    expect(bodyRetryMs('{"error":{"message":"Rate limit reached. Please try again in 7m12s."}}')).toBe(432000);
    expect(bodyRetryMs('{"error":{"message":"Please try again in 1m30.5s."}}')).toBe(90500);
  });

  it('lets a named wait or throttle wording win over a bare quota, but not over money or a daily limit', () => {
    const rateQuota = '{"error":{"code":"Throttling.RateQuota","message":"Requests rate limit exceeded, please try again later."}}';
    expect(rateVerdict(429, rateQuota, 5000)).toEqual({ exhausted: false, waitMs: 5000 });
    expect(rateVerdict(429, rateQuota, 0)).toEqual({ exhausted: false, waitMs: 0 });
    expect(rateVerdict(429, '{"error":{"message":"Quota exceeded, please slow down"}}', 5000)).toEqual({ exhausted: false, waitMs: 5000 });
    const exhaustedResource = '[{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}]';
    expect(rateVerdict(429, exhaustedResource, 0)).toEqual({ exhausted: false, waitMs: 0 });
    expect(rateVerdict(429, '{"error":{"message":"Rate limit exceeded: free-models-per-min. Check your quota."}}', 0))
      .toEqual({ exhausted: false, waitMs: 0 });
    expect(rateVerdict(429, 'Your credit balance is too low', 5000)).toEqual({ exhausted: true, waitMs: 0 });
    expect(rateVerdict(429, '{"error":{"message":"Too many requests to the load balancer"}}', 0)).toEqual({ exhausted: false, waitMs: 0 });
    expect(rateVerdict(429, '{"error":{"message":"Requests from this suspended region are delayed"}}', 0))
      .toEqual({ exhausted: false, waitMs: 0 });
    expect(rateVerdict(429, 'Daily quota exceeded', 5000)).toEqual({ exhausted: true, waitMs: 0 });
    expect(rateVerdict(429, 'Quota exceeded', 0)).toEqual({ exhausted: true, waitMs: 0 });
  });

  it('sees a per-minute throttle through quota wording, and a per-day one as spent', () => {
    const perMinute = 'You exceeded your current quota, check your billing. requests per minute limit exceeded on Free Tier.';
    expect(rateVerdict(429, perMinute, 0)).toEqual({ exhausted: false, waitMs: 0 });
    expect(rateVerdict(429, 'quotaId: RequestsPerDayPerProject. Please retry in 21s.', 0)).toEqual({ exhausted: true, waitMs: 0 });
    expect(rateVerdict(429, 'Your credit balance is too low', 0)).toEqual({ exhausted: true, waitMs: 0 });
    expect(rateVerdict(429, 'slow down', 2 * 3600000)).toEqual({ exhausted: true, waitMs: 0 });
    expect(rateVerdict(429, 'slow down', 5000)).toEqual({ exhausted: false, waitMs: 5000 });
  });
});
