import { JsonArrayStream, JsonArrayStreamError } from '../parsers/json-array-stream';
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
}

export type XtreamCatalogStreamChunk =
  | { kind: 'vod'; items: VodItem[] }
  | { kind: 'series'; items: SeriesItem[] };

export interface XtreamCatalogStreamResponse {
  failure?: XtreamRequestErrorCode;
  items: number;
  inputBytes: number;
  elapsedMs: number;
}

const BATCH_SIZE = 4000;
const activeStreams = new Map<string, (reason: XtreamRequestErrorCode) => void>();

export function cancelXtreamCatalogStream(token: string): void {
  activeStreams.get(token)?.('cancelled');
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
): Promise<XtreamCatalogStreamResponse> {
  const started = Date.now();
  const controller = new AbortController();
  let abortReason: XtreamRequestErrorCode | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const abort = (reason: XtreamRequestErrorCode): void => {
    if (!abortReason) abortReason = reason;
    controller.abort();
    // Chromium 53's polyfilled abort stops only the fetch, not a body read.
    if (reader) void reader.cancel().catch(() => undefined);
  };
  if (request.token) activeStreams.set(request.token, abort);
  const totalTimer = setTimeout(() => abort('timeout'), request.timeout);
  let idleTimer = setTimeout(() => abort('timeout'), Math.min(request.headersTimeout, request.timeout));
  const touch = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort('timeout'), request.idleTimeout);
  };
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
  let complete = false;
  try {
    const response = await fetch(request.url, { signal: controller.signal });
    touch();
    // Chromium 53's polyfilled abort can't stop a body nobody reads.
    const discard = (failure: XtreamRequestErrorCode): XtreamCatalogStreamResponse => {
      void response.body?.cancel().catch(() => undefined);
      return fail(failure);
    };
    if (!response.ok) return discard('request_failed');
    const declared = Number(response.headers?.get('content-length') || 0);
    if (declared > request.maxBytes) return discard('too_large');
    const decoder = new TextDecoder('utf-8');
    reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null;
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (abortReason) return fail(abortReason);
      inputBytes = bytes.length;
      if (inputBytes > request.maxBytes) return fail('too_large');
      parser.write(decoder.decode(bytes));
    } else {
      while (true) {
        const next = await reader.read();
        if (abortReason) return fail(abortReason);
        if (next.done) {
          complete = true;
          break;
        }
        touch();
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
    for (let i = 0; i < merged.length; i += BATCH_SIZE) {
      emitChunk({ kind: request.kind, items: merged.slice(i, i + BATCH_SIZE) } as XtreamCatalogStreamChunk);
    }
    return {
      items: merged.length,
      inputBytes,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (abortReason) return fail(abortReason);
    // A cut connection may come back whole; a malformed list won't.
    if (error instanceof JsonArrayStreamError) return fail(error.truncated ? 'request_failed' : 'invalid_json');
    return fail('request_failed');
  } finally {
    if (request.token) activeStreams.delete(request.token);
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    if (reader && !complete) void reader.cancel().catch(() => undefined);
    if (!complete) controller.abort();
  }
}
