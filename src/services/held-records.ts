// A large value the app worker still holds after sending it over, so its
// cache write can happen there instead of cloning it on the UI thread.

export interface HeldWrite {
  store: string;
  value: Record<string, unknown>;
}

export interface HeldWriteRequest {
  /** Written in one transaction; the held value goes into `writes[0]`. */
  writes: HeldWrite[];
  /** Dotted path in `writes[0].value`, e.g. `data` or `data.channels`. */
  field: string;
  /** `writes[0]` is a playlist stored as chunks; its key sits at this path. */
  chunkKeyPath?: string;
}

export type HeldWriteResult = 'written' | 'missing' | 'quota_exceeded' | 'failed';

export interface HeldRecord {
  /** `serializedBytes` of the held value, when the worker sent it along. */
  bytes?: number;
  /** Asks the worker for `bytes` it left out; null once the value is gone. */
  measure?(): Promise<number | null>;
  /** The page has no copy, so a lost worker value cannot be written from here. */
  detached?: boolean;
  write(request: HeldWriteRequest): Promise<HeldWriteResult>;
  release(): void;
}

/** A copy of `record` with `value` at the dotted `field`, copying each object on the path. */
export function withHeldValue(
  record: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  const dot = field.indexOf('.');
  if (dot < 0) return { ...record, [field]: value };
  const head = field.slice(0, dot);
  const inner = record[head];
  return {
    ...record,
    [head]: withHeldValue(
      inner && typeof inner === 'object' ? inner as Record<string, unknown> : {},
      field.slice(dot + 1),
      value,
    ),
  };
}

const held = new WeakMap<object, HeldRecord>();
// Stand-ins for a worker's value: never cached as themselves.
const standIns = new WeakSet<object>();

// Release runs once, and only from the record still held for the value.
export function holdRecord(value: object, record: HeldRecord): void {
  const entry: HeldRecord = {
    ...(record.bytes !== undefined ? { bytes: record.bytes } : {}),
    ...(record.measure ? { measure: () => record.measure!() } : {}),
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
