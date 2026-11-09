import { CONFIG } from '../config';
import { withHeldValue, type HeldWriteRequest, type HeldWriteResult } from '../services/held-records';
import { serializedBytes } from '../utils/serialized-bytes';
import { SearchCacheError, type CacheWrite } from './search-cache-reader';

export interface HeldValueWriteRequest extends HeldWriteRequest {
  token: string;
  timeoutMs: number;
}

interface HeldValue {
  read(): unknown;
  timer: ReturnType<typeof setTimeout>;
}

// Vod and series lists for the active account, one being replaced, and the
// loaded playlist's channels.
const HOLD_LIMIT = 4;

const values = new Map<string, HeldValue>();
let counter = 0;
// Distinct per worker, so a token from a replaced worker never matches.
const workerId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function hold(read: () => unknown): string {
  const token = `${workerId}-${String(++counter)}`;
  while (values.size >= HOLD_LIMIT) releaseHeldValue(values.keys().next().value as string);
  values.set(token, { read, timer: setTimeout(() => releaseHeldValue(token), CONFIG.XTREAM.HELD_LIST_MS) });
  return token;
}

export function holdValue(value: unknown): string {
  return hold(() => value);
}

// Joined only once cached, so the task that kept them doesn't wait on it.
export function holdBatches(batches: unknown[][]): string {
  let pending: unknown[][] | null = batches;
  let joined: unknown[] = [];
  return hold(() => {
    if (pending) {
      joined = joined.concat(...pending);
      pending = null;
    }
    return joined;
  });
}

/** `serializedBytes` of the held value, or null once it is gone. */
export function measureHeldValue(token: string): number | null {
  const held = values.get(token);
  return held ? serializedBytes(held.read()) : null;
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
  const value = withHeldValue(first.value, request.field, held.read());
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
