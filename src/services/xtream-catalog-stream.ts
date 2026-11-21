import { JsonArrayStream, JsonArrayStreamError } from '../parsers/json-array-stream';
import { holdValue } from '../workers/held-values';
import { sameCatalogItems } from '../utils/catalog-items';
import { serializedBytes } from '../utils/serialized-bytes';
import { FetchSession } from '../utils/fetch-session';
import type { SeriesItem, VodItem } from '../types';
import {
  seriesItemFrom,
  vodItemFrom,
  type XtreamRequestErrorCode,
} from './xtream-client';

export interface XtreamCatalogStreamRequest {
  url: string;
  kind: 'vod' | 'series';
  accountId: string;
  /** The panel's category order; items outside it are dropped. */
  categoryIds: string[];
  /** Stale category ids miss newer categories, so keep their items last. */
  keepUnknownCategories?: boolean;
  /** Names the load for xtream.catalog-stream.cancel. */
  token?: string;
  /** Panels build the whole list before the headers, so this wait is longer. */
  headersTimeout: number;
  /** Abort when no bytes arrive for this long once the body starts. */
  idleTimeout: number;
  timeout: number;
  maxBytes: number;
  /** Keep the list here for the cache write instead of sending it to the page. */
  detached?: boolean;
  /** The cached list to compare with, so an unchanged catalog is not rewritten. */
  previous?: { key: string; timestamp: number };
}

export type XtreamCatalogStreamChunk =
  | { kind: 'vod'; items: VodItem[] }
  | { kind: 'series'; items: SeriesItem[] };

export interface XtreamCatalogStreamResponse {
  failure?: XtreamRequestErrorCode;
  items: number;
  inputBytes: number;
  elapsedMs: number;
  /** The merged list, kept here for the page's cache write. */
  held?: { token: string; bytes: number };
  /** The list matches `previous`; nothing is held or sent. */
  unchanged?: boolean;
}

const BATCH_SIZE = 4000;
const activeStreams = new Map<string, FetchSession>();

export function cancelXtreamCatalogStream(token: string): void {
  activeStreams.get(token)?.stop('cancelled');
}

// Orders items like the per-category load: by category, first copy of an id
// wins. Runs here because a 200k-entry Set on the UI thread's big heap
// stalls on GC for tens of seconds on slow TVs.
export function mergeByCategory<T extends { categoryId: string }>(
  items: T[],
  categoryIds: string[],
  itemId: (item: T) => string,
  keepUnknownCategories = false,
): T[] {
  const byCategory = new Map<string, T[]>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const partition = byCategory.get(item.categoryId);
    if (partition) partition.push(item);
    else byCategory.set(item.categoryId, [item]);
  }
  const result: T[] = [];
  const seen = new Set<string>();
  for (let c = 0; c < categoryIds.length; c++) {
    const partition = byCategory.get(categoryIds[c]);
    if (!partition) continue;
    for (let i = 0; i < partition.length; i++) {
      const id = itemId(partition[i]);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(partition[i]);
    }
  }
  if (keepUnknownCategories) {
    for (let i = 0; i < items.length; i++) {
      // The per-category load never shows an item without a category.
      if (!items[i].categoryId) continue;
      const id = itemId(items[i]);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(items[i]);
    }
  }
  return result;
}

function itemIdOf(item: VodItem | SeriesItem): string {
  return 'streamId' in item ? item.streamId : item.seriesId;
}

/** Worker side of the whole-catalog load: never throws, so the UI thread logs. */
export async function streamXtreamCatalogInWorker(
  request: XtreamCatalogStreamRequest,
  emitChunk: (chunk: XtreamCatalogStreamChunk) => void,
  previousList: (ref: { key: string; timestamp: number }) => Promise<unknown[] | null>
    = () => Promise.resolve(null),
): Promise<XtreamCatalogStreamResponse> {
  const started = Date.now();
  const session = new FetchSession(request.url, {
    timeout: request.timeout,
    headersTimeout: request.headersTimeout,
    idleTimeout: request.idleTimeout,
  });
  if (request.token) activeStreams.set(request.token, session);
  let inputBytes = 0;
  let elements = 0;
  let items = 0;
  const parsed: Array<VodItem | SeriesItem> = [];
  const parser = new JsonArrayStream(value => {
    elements++;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const source = value as Record<string, unknown>;
    const item = request.kind === 'vod'
      ? vodItemFrom(source, request.accountId)
      : seriesItemFrom(source, request.accountId);
    if (itemIdOf(item) === '') return;
    items++;
    parsed.push(item);
  });
  const fail = (failure: XtreamRequestErrorCode): XtreamCatalogStreamResponse =>
    ({ failure, items, inputBytes, elapsedMs: Date.now() - started });
  try {
    const response = await session.open();
    // close() cancels the body of a response left unread.
    if (!response.ok) return fail('request_failed');
    const declared = Number(response.headers?.get('content-length') || 0);
    if (declared > request.maxBytes) return fail('too_large');
    const decoder = new TextDecoder('utf-8');
    if (!session.streaming) {
      const bytes = await session.readAll();
      inputBytes = bytes.length;
      if (inputBytes > request.maxBytes) return fail('too_large');
      parser.write(decoder.decode(bytes));
    } else {
      while (true) {
        const next = await session.read();
        if (next.done) break;
        if (!next.value?.length) continue;
        inputBytes += next.value.length;
        if (inputBytes > request.maxBytes) return fail('too_large');
        parser.write(decoder.decode(next.value, { stream: true }));
      }
      parser.write(decoder.decode());
    }
    parser.finish();
    // Mirrors the per-category check: a list with no usable ids is an error page.
    if (elements && !items) return fail('request_failed');
    const merged = mergeByCategory(parsed, request.categoryIds, itemIdOf, request.keepUnknownCategories);
    // Every batch is a clone; drop the unordered copy before making them.
    parsed.length = 0;
    if (request.previous) {
      const previous = await previousList(request.previous);
      if (session.stopReason) return fail(session.stopReason);
      if (previous && sameCatalogItems(previous as object[], merged)) {
        return { items: merged.length, inputBytes, elapsedMs: Date.now() - started, unchanged: true };
      }
    }
    if (!request.detached) {
      for (let i = 0; i < merged.length; i += BATCH_SIZE) {
        emitChunk({ kind: request.kind, items: merged.slice(i, i + BATCH_SIZE) } as XtreamCatalogStreamChunk);
      }
    }
    return {
      items: merged.length,
      inputBytes,
      elapsedMs: Date.now() - started,
      held: { token: holdValue(merged), bytes: serializedBytes(merged) },
    };
  } catch (error) {
    if (session.stopReason) return fail(session.stopReason);
    // A cut connection may come back whole; a malformed list won't.
    if (error instanceof JsonArrayStreamError) return fail(error.truncated ? 'request_failed' : 'invalid_json');
    return fail('request_failed');
  } finally {
    if (request.token) activeStreams.delete(request.token);
    session.close();
  }
}
