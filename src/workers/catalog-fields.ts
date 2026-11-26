// Fields with few distinct values across a catalog. IndexedDB's structured
// clone gives every item its own copy of each string.
const SHARED_FIELDS = ['accountId', 'categoryId', 'rating', 'containerExtension', 'genre'];

/** Points equal values of the shared fields at one string, in place. */
export function shareCatalogFields(list: unknown[]): void {
  const pool = new Map<string, string>();
  const last: Array<string | undefined> = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const fields = item as Record<string, unknown>;
    for (let f = 0; f < SHARED_FIELDS.length; f++) {
      const key = SHARED_FIELDS[f];
      const value = fields[key];
      if (typeof value !== 'string') continue;
      // Most runs repeat the previous item's value, which skips hashing.
      let shared = last[f];
      if (shared !== value) {
        shared = pool.get(value);
        if (shared === undefined) {
          pool.set(value, value);
          shared = value;
        }
        last[f] = shared;
      }
      fields[key] = shared;
    }
  }
}
