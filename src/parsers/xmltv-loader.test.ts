import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { gzipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndParseXMLTVInWorker } from './xmltv-loader';
import { writeHeldValue } from '../workers/held-values';
import {
  isPackedEpg,
  PACKED_EPG_FORMAT,
  unpackEpg,
  type PackedEpg,
} from '../services/epg-cache-codec';
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
  const packed: PackedEpg = { format: PACKED_EPG_FORMAT, meta: {}, channels: [], programmes: [] };
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
        async writes => { value = writes[0].value.data; },
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
