import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelXtreamCatalogStream,
  streamXtreamCatalogInWorker,
  type XtreamCatalogStreamChunk,
  type XtreamCatalogStreamRequest,
} from './xtream-catalog-stream';
import { writeHeldValue } from '../workers/held-values';
import type { CacheWrite } from '../workers/search-cache-reader';
import { serializedBytes } from '../utils/serialized-bytes';

const request = (categoryIds: string[]): XtreamCatalogStreamRequest => ({
  url: 'http://host/a',
  kind: 'vod',
  accountId: 'x1',
  categoryIds,
  headersTimeout: 1000,
  idleTimeout: 1000,
  timeout: 1000,
  maxBytes: 1 << 20,
});

function serve(body: string, init?: ResponseInit): void {
  const bytes = new TextEncoder().encode(body);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      // Split mid-token so the parser has to carry state between reads.
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7));
      controller.close();
    },
  }), init)));
}

async function run(categoryIds: string[]) {
  const chunks: XtreamCatalogStreamChunk[] = [];
  const response = await streamXtreamCatalogInWorker(request(categoryIds), chunk => chunks.push(chunk));
  const ids = chunks.flatMap(chunk => chunk.items.map(item => 'streamId' in item ? item.streamId : ''));
  return { response, chunks, ids };
}

const movie = (id: string | number, category: string) => ({ stream_id: id, name: `Movie ${id}`, category_id: category });

describe('streamXtreamCatalogInWorker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('orders by category, keeps the first copy of an id, and drops unknown categories', async () => {
    serve(JSON.stringify([
      movie(10, '1'), movie(20, '2'), movie(30, '9'), movie(10, '2'), movie(11, '1'), movie('', '1'),
    ]));
    const { response, ids } = await run(['2', '1']);
    expect(ids).toEqual(['20', '10', '11']);
    expect(response).toMatchObject({ items: 3 });
    expect(response.failure).toBeUndefined();
  });

  it('keeps items of unknown categories last when the categories are stale', async () => {
    serve(JSON.stringify([
      movie(10, '1'), movie(30, '9'), movie(20, '2'), movie(10, '9'), movie(40, ''), movie(31, '8'),
    ]));
    const chunks: XtreamCatalogStreamChunk[] = [];
    await streamXtreamCatalogInWorker(
      { ...request(['2', '1']), keepUnknownCategories: true },
      chunk => chunks.push(chunk),
    );
    expect(chunks.flatMap(chunk => chunk.items.map(item => 'streamId' in item && item.streamId)))
      .toEqual(['20', '10', '30', '31']);
  });

  it('waits longer for the headers than for a stalled body', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify([movie(1, '1')]));
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(bytes)), 60);
    })));
    const chunks: XtreamCatalogStreamChunk[] = [];
    const response = await streamXtreamCatalogInWorker(
      { ...request(['1']), idleTimeout: 20 },
      chunk => chunks.push(chunk),
    );
    expect(response.failure).toBeUndefined();
    expect(chunks[0].items).toHaveLength(1);
  });

  it('stops a load its token cancels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"stream_id":1,'));
      },
    }))));
    const chunks: XtreamCatalogStreamChunk[] = [];
    const load = streamXtreamCatalogInWorker({ ...request(['1']), token: 't1' }, chunk => chunks.push(chunk));
    await new Promise(resolve => setTimeout(resolve, 10));
    cancelXtreamCatalogStream('t1');
    expect((await load).failure).toBe('cancelled');
    expect(chunks).toEqual([]);
  });

  it('cancels the body of a response it rejects', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 500 })));
    expect((await run(['1'])).response.failure).toBe('request_failed');
    expect(cancel).toHaveBeenCalled();
  });

  it('drops a body read that a cancel overtook, without a stream reader', async () => {
    let deliver: (buffer: ArrayBuffer) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: new Headers(),
      body: null,
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { deliver = resolve; }),
    })));
    const chunks: XtreamCatalogStreamChunk[] = [];
    const load = streamXtreamCatalogInWorker({ ...request(['1']), token: 't2' }, chunk => chunks.push(chunk));
    await new Promise(resolve => setTimeout(resolve, 10));
    cancelXtreamCatalogStream('t2');
    deliver(new TextEncoder().encode(JSON.stringify([movie(1, '1')])).buffer);
    expect((await load).failure).toBe('cancelled');
    expect(chunks).toEqual([]);
  });

  it('holds the merged list for the cache write', async () => {
    serve(JSON.stringify([movie(10, '1'), movie(20, '2'), movie(10, '2')]));
    const { response, chunks } = await run(['2', '1']);
    const items = chunks.flatMap(chunk => chunk.items);
    const writes: CacheWrite[] = [];
    const result = await writeHeldValue(
      { token: response.held!.token, timeoutMs: 1000, field: 'data', writes: [{ store: 's', value: {} }] },
      async batch => { writes.push(...batch); },
    );
    expect(result).toBe('written');
    expect(writes[0].value).toEqual({ data: items });
    expect(response.held!.bytes).toBe(serializedBytes(items));
  });

  it('keeps a detached list in the worker and sends no items', async () => {
    serve(JSON.stringify([movie(10, '1'), movie(20, '1')]));
    const chunks: XtreamCatalogStreamChunk[] = [];
    const response = await streamXtreamCatalogInWorker(
      { ...request(['1']), detached: true }, chunk => chunks.push(chunk),
    );
    expect(chunks).toEqual([]);
    expect(response).toMatchObject({ items: 2, held: { token: expect.any(String) } });
  });

  it('holds nothing when the list matches the cached one', async () => {
    serve(JSON.stringify([movie(10, '1'), movie(20, '1')]));
    const { response: first, chunks } = await run(['1']);
    const cached = chunks.flatMap(chunk => chunk.items);
    serve(JSON.stringify([movie(10, '1'), movie(20, '1')]));
    const previous = { key: 'x1|vod_all', timestamp: 5 };
    const lookups: unknown[] = [];
    const same = await streamXtreamCatalogInWorker(
      { ...request(['1']), detached: true, previous }, () => undefined,
      async (ref) => { lookups.push(ref); return cached; },
    );
    expect(lookups).toEqual([previous]);
    expect(same).toMatchObject({ items: 2, unchanged: true });
    expect(same.held).toBeUndefined();

    serve(JSON.stringify([movie(10, '1'), movie(21, '1')]));
    const changed = await streamXtreamCatalogInWorker(
      { ...request(['1']), detached: true, previous }, () => undefined, async () => cached,
    );
    expect(changed.unchanged).toBeUndefined();
    expect(changed.held).toBeDefined();
    expect(first.held).toBeDefined();
  });

  it('sends a large catalog in batches', async () => {
    serve(JSON.stringify(Array.from({ length: 4001 }, (_, i) => movie(i, '1'))));
    const { chunks, ids } = await run(['1']);
    expect(chunks.map(chunk => chunk.items.length)).toEqual([4000, 1]);
    expect(ids[4000]).toBe('4000');
  });

  it('times out a body that stalls, even when abort cannot reach the fetch', async () => {
    // Like Chromium 53's polyfill: the signal is ignored once headers arrive.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify([movie(1, '1')]).slice(0, -1)));
      },
    }))));
    const chunks: XtreamCatalogStreamChunk[] = [];
    const response = await streamXtreamCatalogInWorker(
      { ...request(['1']), idleTimeout: 20 },
      chunk => chunks.push(chunk),
    );
    expect(response.failure).toBe('timeout');
    expect(chunks).toEqual([]);
  });

  it.each([
    ['an HTTP error', () => serve('[]', { status: 500 }), 'request_failed'],
    ['a declared size over the limit', () => serve('[]', { headers: { 'content-length': String(2 << 20) } }), 'too_large'],
    ['malformed JSON', () => serve('[{"stream_id":1}}'), 'invalid_json'],
    ['a body cut short', () => serve('[{"stream_id":1},'), 'request_failed'],
    ['a list without ids', () => serve(JSON.stringify([{ name: 'x' }])), 'request_failed'],
  ])('reports %s without emitting items', async (_name, setup, failure) => {
    setup();
    const { response, chunks } = await run(['1']);
    expect(response.failure).toBe(failure);
    expect(chunks).toEqual([]);
  });
});
