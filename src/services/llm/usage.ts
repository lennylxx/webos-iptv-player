import type { LlmConfig, TokenUsage } from './types';

export interface FeatureUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageDay {
  // Local calendar day, YYYY-MM-DD; a new day starts from zero.
  day: string;
  features: Record<string, FeatureUsage>;
}

export type CapHit = 'requests' | 'tokens';

export function localDay(time: number): string {
  const d = new Date(time);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function num(value: unknown): number {
  return typeof value === 'number' && isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Today's counters from storage, or empty ones when stored data is from another day. */
export function usageFor(raw: unknown, now: number): UsageDay {
  const day = localDay(now);
  const empty: UsageDay = { day, features: {} };
  if (!raw || typeof raw !== 'object') return empty;
  const value = raw as { day?: unknown; features?: unknown };
  if (value.day !== day || !value.features || typeof value.features !== 'object') return empty;
  const source = value.features as Record<string, Partial<FeatureUsage>>;
  const features: Record<string, FeatureUsage> = {};
  Object.keys(source).forEach((id) => {
    const f = source[id] || {};
    features[id] = { requests: num(f.requests), inputTokens: num(f.inputTokens), outputTokens: num(f.outputTokens) };
  });
  return { day, features };
}

export function addUsage(usage: UsageDay, feature: string, tokens: TokenUsage | null): UsageDay {
  const features: Record<string, FeatureUsage> = {};
  Object.keys(usage.features).forEach((id) => { features[id] = { ...usage.features[id] }; });
  const entry = features[feature] || { requests: 0, inputTokens: 0, outputTokens: 0 };
  entry.requests++;
  if (tokens) {
    entry.inputTokens += num(tokens.inputTokens);
    entry.outputTokens += num(tokens.outputTokens);
  }
  features[feature] = entry;
  return { day: usage.day, features };
}

export function totals(usage: UsageDay): FeatureUsage {
  const sum: FeatureUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  Object.keys(usage.features).forEach((id) => {
    sum.requests += usage.features[id].requests;
    sum.inputTokens += usage.features[id].inputTokens;
    sum.outputTokens += usage.features[id].outputTokens;
  });
  return sum;
}

export function capHit(config: LlmConfig, usage: UsageDay): CapHit | null {
  const sum = totals(usage);
  if (config.dailyRequestCap > 0 && sum.requests >= config.dailyRequestCap) return 'requests';
  if (config.dailyTokenCap > 0 && sum.inputTokens + sum.outputTokens >= config.dailyTokenCap) return 'tokens';
  return null;
}
