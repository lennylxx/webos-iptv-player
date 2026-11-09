import { CONFIG } from '../config';
import type { HeldWriteRequest, HeldWriteResult } from '../services/held-records';
import { SearchCacheError, type CacheWrite } from './search-cache-reader';

export interface HeldValueWriteRequest extends HeldWriteRequest {
  token: string;
  timeoutMs: number;
}

interface HeldValue {
  value: unknown;
  timer: ReturnType<typeof setTimeout>;
}

// Vod and series lists for the active account, plus one being replaced.
const HOLD_LIMIT = 3;

const values = new Map<string, HeldValue>();
let counter = 0;
// Distinct per worker, so a token from a replaced worker never matches.
const workerId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function holdValue(value: unknown): string {
  const token = `${workerId}-${String(++counter)}`;
  while (values.size >= HOLD_LIMIT) releaseHeldValue(values.keys().next().value as string);
  values.set(token, { value, timer: setTimeout(() => releaseHeldValue(token), CONFIG.XTREAM.HELD_LIST_MS) });
  return token;
}

export function releaseHeldValue(token: string): void {
  const held = values.get(token);
  if (!held) return;
  clearTimeout(held.timer);
  values.delete(token);
}

export async function writeHeldValue(
  request: HeldValueWriteRequest,
  writeAll: (writes: CacheWrite[], timeoutMs: number) => Promise<void>,
  onWritten?: (store: string, value: Record<string, unknown>) => void,
): Promise<HeldWriteResult> {
  const held = values.get(request.token);
  const [first, ...rest] = request.writes;
  if (!held || !first) return 'missing';
  const value = { ...first.value, [request.field]: held.value };
  try {
    await writeAll([{ store: first.store, value }, ...rest], request.timeoutMs);
  } catch (error) {
    return error instanceof SearchCacheError && error.reason === 'quota_exceeded'
      ? 'quota_exceeded'
      : 'failed';
  }
  releaseHeldValue(request.token);
  onWritten?.(first.store, value);
  return 'written';
}
