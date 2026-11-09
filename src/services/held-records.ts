// A large value the app worker still holds after sending it over, so its
// cache write can happen there instead of cloning it on the UI thread.

export interface HeldWrite {
  store: string;
  value: Record<string, unknown>;
}

export interface HeldWriteRequest {
  /** Written in one transaction; the held value goes into `writes[0]`. */
  writes: HeldWrite[];
  field: string;
}

export type HeldWriteResult = 'written' | 'missing' | 'quota_exceeded' | 'failed';

export interface HeldRecord {
  /** `serializedBytes` of the held value. */
  bytes: number;
  /** The page has no copy, so a lost worker value cannot be written from here. */
  detached?: boolean;
  write(request: HeldWriteRequest): Promise<HeldWriteResult>;
  release(): void;
}

const held = new WeakMap<object, HeldRecord>();
// Stand-ins for a worker's value: never cached as themselves.
const standIns = new WeakSet<object>();

// Release runs once, and only from the record still held for the value.
export function holdRecord(value: object, record: HeldRecord): void {
  const entry: HeldRecord = {
    bytes: record.bytes,
    ...(record.detached ? { detached: true } : {}),
    write: request => record.write(request),
    release: () => {
      if (held.get(value) !== entry) return;
      held.delete(value);
      record.release();
    },
  };
  held.set(value, entry);
  if (record.detached) standIns.add(value);
}

/** A stand-in whose worker value is written or gone, so it has nothing to cache. */
export function isSpentStandIn(value: unknown): boolean {
  return !!value && typeof value === 'object' && standIns.has(value) && !held.has(value);
}

/** Lets the worker drop a list that will not be cached after all. */
export function releaseHeldRecord(value: unknown): void {
  heldRecord(value)?.release();
}

export function heldRecord(value: unknown): HeldRecord | null {
  return value && typeof value === 'object' ? held.get(value) ?? null : null;
}
