import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { gzipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LegacyAbortController } from '../test/legacy-fetch';
import { faultFetch } from '../test/fault-fetch';
import { fetchAndParseXMLTVInWorker } from './xmltv-loader';
import { writeHeldValue } from '../workers/held-values';
import {
  isPackedEpg,
  unpackEpg,
  type PackedEpg,
} from '../services/epg-cache-codec';
import { PACKED_EPG_FORMAT } from '../services/idb-schema';
import type { XMLTVWorkerChunk, XMLTVWorkerRequest, XMLTVWorkerResponse } from '../workers/tasks';
import type { ParsedEpg } from '../types';

const start = '20260814190000 +0000';
const stop = '20260814200000 +0000';

function responseInChunks(bytes: Uint8Array, chunkSize: number): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  }));
}

function packedFrom(chunks: XMLTVWorkerChunk[]): PackedEpg {
  const packed: Required<PackedEpg> = {
    format: PACKED_EPG_FORMAT, meta: {}, channels: [], programmes: [], catchupIds: [],
  };
  for (const chunk of chunks) {
    if (chunk.kind === 'guide') packed[chunk.part].push(...chunk.blocks);
  }
  return packed;
}

// Loads the way the app worker does, then decodes the blocks it sent.
async function load(request: XMLTVWorkerRequest): Promise<{
  result: XMLTVWorkerResponse;
  guide: ParsedEpg;
}> {
  const chunks: XMLTVWorkerChunk[] = [];
  const result = await fetchAndParseXMLTVInWorker(request, chunk => chunks.push(chunk));
  return { result, guide: unpackEpg(packedFrom(chunks)) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchAndParseXMLTV', () => {
  it('incrementally decodes an uncompressed UTF-8 response', async () => {
    const xml = `<tv><channel id="ch1"><display-name>Alpha é</display-name></channel>`
      + `<programme channel="ch1" start="${start}" stop="${stop}">`
      + '<title>Bravo é</title></programme></tv>';
    vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 7)));

    const { guide } = await load({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
      },
    });

    expect(guide.channels.ch1.name).toBe('Alpha é');
    expect(guide.programmes.ch1[0].title).toBe('Bravo é');
  });

  it('gives the page the programmes nearest now when the guide is over its ceiling', async () => {
    // Sorted by time: two ended programmes per channel come before the airing ones.
    const slot = (channel: string, title: string, from: string, to: string) =>
      `<programme channel="${channel}" start="${from}" stop="${to}"><title>${title}</title></programme>`;
    const xml = '<tv>'
      + slot('ch1', 'A1', '20260814170000 +0000', '20260814180000 +0000')
      + slot('ch2', 'B1', '20260814170000 +0000', '20260814180000 +0000')
      + slot('ch1', 'A2', '20260814180000 +0000', '20260814190000 +0000')
      + slot('ch2', 'B2', '20260814180000 +0000', '20260814190000 +0000')
      + slot('ch1', 'A3', start, stop)
      + slot('ch2', 'B3', start, stop)
      + '</tv>';
    vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 64)));

    const { result, guide } = await load({
      url: 'http://host/a',
      timeout: 1000,
      options: { nowMs: new Date('2026-08-14T19:30:00Z').getTime(), maxProgrammes: 4, pastWeight: 2 },
    });

    expect(guide.programmes.ch1.map(entry => entry.title)).toEqual(['A2', 'A3']);
    expect(guide.programmes.ch2.map(entry => entry.title)).toEqual(['B2', 'B3']);
    expect(result.stats.droppedBudget).toBe(2);
  });

  it('carries program catch-up ids to the page', async () => {
    const xml = `<tv><programme channel="ch1" start="${start}" stop="${stop}" catchup-id="p1">`
      + '<title>Bravo</title></programme></tv>';
    vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 64)));

    const { guide } = await load({
      url: 'http://host/a',
      timeout: 1000,
      options: { nowMs: new Date('2026-08-14T19:30:00Z').getTime() },
    });

    expect(guide.programmes.ch1[0].catchupId).toBe('p1');
  });

  it('incrementally decompresses a gzip response', async () => {
    const xml = `<tv><channel id="ch1"><display-name>Alpha</display-name></channel>`
      + `<programme channel="ch1" start="${start}" stop="${stop}">`
      + '<title>Bravo</title></programme></tv>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      responseInChunks(gzipSync(strToU8(xml)), 5)));

    const { result, guide } = await load({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
      },
    });

    expect(result.stats.programmesKept).toBe(1);
    expect(guide.programmes.ch1[0].title).toBe('Bravo');
    expect(result.metrics).toMatchObject({
      transport: 'stream',
      encoding: 'gzip',
      attempts: 1,
    });
    expect(result.metrics.inputBytes).toBeGreaterThan(0);
    expect(result.metrics.chunks).toBeGreaterThan(0);
  });

  it('refetches when name filtering discovers a channel after its programmes', async () => {
    const xml = `<tv><programme channel="ch1" start="${start}" stop="${stop}">`
      + '<title>Bravo</title></programme>'
      + '<channel id="ch1"><display-name>Alpha</display-name></channel></tv>';
    const fetchMock = vi.fn(async () => responseInChunks(strToU8(xml), 11));
    vi.stubGlobal('fetch', fetchMock);

    const { result, guide } = await load({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
        channelNames: ['alpha'],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(guide.programmes.ch1[0].title).toBe('Bravo');
    expect(result.metrics.attempts).toBe(2);
  });

  it('sends only the final pass, once, as packed guide blocks', async () => {
    const programmes = Array.from({ length: 257 }, (_, index) =>
      `<programme channel="ch1" start="${start}" stop="${stop}">`
      + `<title>P${String(index)}</title></programme>`)
      .join('');
    const xml = `<tv>${programmes}`
      + '<channel id="ch1"><display-name>Alpha</display-name></channel></tv>';
    vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 1024)));
    const chunks: XMLTVWorkerChunk[] = [];

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
        channelNames: ['alpha'],
      },
    }, chunk => chunks.push(chunk));

    expect(result.metrics.attempts).toBe(2);
    expect(result.data.programmes).toEqual({});
    expect(chunks.every(chunk => chunk.kind === 'guide')).toBe(true);
    const guide = unpackEpg(packedFrom(chunks));
    expect(guide.channels).toEqual({ ch1: { name: 'Alpha', icon: '' } });
    expect(guide.programmes.ch1).toHaveLength(result.stats.programmesKept);
  });

  it('lets the first pass guide go before an order retry parses', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const { WeakRef } = globalThis as unknown as {
      WeakRef: new <T extends object>(target: T) => { deref(): T | undefined };
    };
    const xml = '<tv><channel id="ch2"><display-name>Alpha</display-name></channel>'
      + `<programme channel="ch2" start="${start}" stop="${stop}"><title>Charlie</title></programme>`
      + `<programme channel="ch1" start="${start}" stop="${stop}"><title>Bravo</title></programme>`
      + '<channel id="ch1"><display-name>Alpha</display-name></channel></tv>';
    let finish: () => void = () => undefined;
    let fetches = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (++fetches === 1) return responseInChunks(strToU8(xml), 11);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          finish = () => {
            controller.enqueue(strToU8(xml));
            controller.close();
          };
        },
      }));
    }));
    const RealDate = Date;
    const firstPass: { deref(): object | undefined }[] = [];
    vi.stubGlobal('Date', class extends RealDate {
      constructor(...args: [number]) {
        super(...args);
        if (fetches === 1 && args.length) firstPass.push(new WeakRef(this));
      }
    });

    const parsing = fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new RealDate('2026-08-14T19:30:00Z').getTime(),
        channelNames: ['alpha'],
      },
    }, () => undefined);
    await vi.waitFor(() => expect(fetches).toBe(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.stubGlobal('Date', RealDate);
    gc();

    try {
      expect(firstPass.length).toBeGreaterThan(0);
      expect(firstPass.every(ref => ref.deref() === undefined)).toBe(true);
    } finally {
      finish();
    }
    expect((await parsing).metrics.attempts).toBe(2);
  });

  it('splits a large guide across bounded messages', async () => {
    const description = 'd'.repeat(600);
    const programmes = Array.from({ length: 4000 }, (_, index) =>
      `<programme channel="ch${String(index % 50)}" start="${start}" stop="${stop}">`
      + `<title>P${String(index)}</title><desc>${description}</desc></programme>`)
      .join('');
    vi.stubGlobal('fetch', vi.fn(async () =>
      responseInChunks(strToU8(`<tv>${programmes}</tv>`), 65536)));
    const chunks: XMLTVWorkerChunk[] = [];

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 1000,
      options: { nowMs: new Date('2026-08-14T19:30:00Z').getTime() },
    }, chunk => chunks.push(chunk));

    const messages = chunks.filter(chunk => chunk.kind === 'guide' && chunk.part === 'programmes');
    expect(messages.length).toBeGreaterThan(1);
    const guide = unpackEpg(packedFrom(chunks));
    expect(Object.values(guide.programmes).flat()).toHaveLength(result.stats.programmesKept);
  });

  describe('a guide held for its cache write', () => {
    const programme = (title: string, from: string, to: string): string =>
      `<programme channel="ch1" start="${from}" stop="${to}"><title>${title}</title></programme>`;
    const nowMs = new Date('2026-08-14T19:30:00Z').getTime();

    async function heldGuide(token: string): Promise<unknown> {
      let value: unknown;
      await writeHeldValue(
        { token, timeoutMs: 1000, field: 'data', writes: [{ store: 's', value: { key: 'k' } }] },
        async writes => { value = writes[0].value?.data; },
      );
      // The worker caches the guide packed, which the page reads back sliced.
      expect(isPackedEpg(value)).toBe(true);
      return unpackEpg(value as PackedEpg);
    }

    it('holds the guide the page rebuilds, after an order retry', async () => {
      const later = '20260814200000 +0000';
      const end = '20260814210000 +0000';
      const xml = '<tv>'
        + programme('Later', later, end)
        + programme('Earlier', start, stop)
        + '<channel id="ch1"><display-name>Alpha</display-name></channel></tv>';
      vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 16)));

      const result = await fetchAndParseXMLTVInWorker({
        url: 'http://host/a',
        timeout: 1000,
        options: { nowMs, channelNames: ['alpha'] },
        holdForCache: true,
      }, () => undefined);

      expect(result.metrics.attempts).toBe(2);
      const guide = await heldGuide(result.held!.token) as {
        channels: Record<string, { name: string }>;
        programmes: Record<string, { title: string }[]>;
      };
      expect(Object.keys(guide.channels)).toEqual(['ch1']);
      expect(guide.programmes.ch1.map(entry => entry.title)).toEqual(['Earlier', 'Later']);
    });

    it('holds nothing unless asked, or for a guide the page never caches', async () => {
      const two = `<tv>${programme('P1', start, stop)}${programme('P2', start, stop)}</tv>`;
      const run = async (xml: string, holdForCache: boolean, maxProgrammes?: number) => {
        vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 64)));
        return fetchAndParseXMLTVInWorker({
          url: 'http://host/a',
          timeout: 1000,
          options: { nowMs, ...(maxProgrammes ? { maxProgrammes } : {}) },
          ...(holdForCache ? { holdForCache } : {}),
        }, () => undefined);
      };

      expect((await run(two, true)).held).toEqual({ token: expect.any(String) });
      expect((await run(two, false)).held).toBeUndefined();
      expect((await run(two, true, 1)).held).toBeUndefined();
      expect((await run('<tv></tv>', true)).held).toBeUndefined();
    });
  });

  it('uses the arrayBuffer fallback when streaming bodies are unavailable', async () => {
    const xml = '<tv><channel id="ch1"><display-name>Alpha</display-name></channel></tv>';
    const bytes = strToU8(xml);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
      arrayBuffer: async () => bytes.buffer,
    })));

    const { guide } = await load({
      url: 'http://host/a',
      timeout: 30000,
      options: {},
    });

    expect(guide.channels.ch1.name).toBe('Alpha');
  });

  it('times out a body that stalls after its headers on webOS 4', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    vi.stubGlobal('AbortController', LegacyAbortController);
    vi.stubGlobal('fetch', faultFetch(() => ({ body: '<?xml version="1.0"?><tv><channel id="a"></channel></tv>', stallAfterBytes: 41 })));

    const loading = fetchAndParseXMLTVInWorker({ url: 'http://host/a', timeout: 1000, options: {} }, () => undefined);
    const assertion = expect(loading).rejects.toMatchObject({ details: { stage: 'read', reason: 'timeout' } });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('times out a guide server that never answers', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    vi.stubGlobal('fetch', faultFetch(() => ({ hang: true })));

    const loading = fetchAndParseXMLTVInWorker({ url: 'http://host/a', timeout: 1000, options: {} }, () => undefined);
    const assertion = expect(loading).rejects.toMatchObject({ details: { stage: 'fetch', reason: 'timeout' } });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('fails a guide whose connection is cut partway through', async () => {
    vi.stubGlobal('fetch', faultFetch(() => ({
      body: '<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name></channel></tv>',
      resetAfterBytes: 30,
    })));

    await expect(fetchAndParseXMLTVInWorker({ url: 'http://host/a', timeout: 30000, options: {} }, () => undefined))
      .rejects.toMatchObject({ details: { stage: 'read', reason: 'exception', inputBytes: 30 } });
  });

  it('fails an unreachable guide host before reading anything', async () => {
    vi.stubGlobal('fetch', faultFetch(() => ({ networkError: true })));

    await expect(fetchAndParseXMLTVInWorker({ url: 'http://host/a', timeout: 30000, options: {} }, () => undefined))
      .rejects.toMatchObject({ details: { stage: 'fetch', reason: 'exception', inputBytes: 0 } });
  });

  it('holds no cache copy of a guide that ends before its closing tag', async () => {
    const programme = (h: number) => `<programme channel="a" start="${String(20240601000000 + h * 10000)} +0000" `
      + `stop="${String(20240601000000 + (h + 1) * 10000)} +0000"><title>T</title></programme>`;
    vi.stubGlobal('fetch', faultFetch(() => ({ body: `<?xml version="1.0"?><tv><channel id="a"/>${programme(11)}` })));

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a', timeout: 30000, options: { nowMs: Date.UTC(2024, 5, 1, 12) }, holdForCache: true,
    }, () => undefined);

    expect(result.stats).toMatchObject({ incomplete: true, programmesKept: 1 });
    expect(result.held).toBeUndefined();
  });

  it('logs a structured failure without committing a partial result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('', { status: 503, statusText: 'Unavailable' })));

    await expect(fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 30000,
      options: {},
    }, () => undefined)).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 503'),
      details: {
        pass: 'initial',
        stage: 'fetch',
        reason: 'http',
        retried: false,
      },
    });
  });
});
