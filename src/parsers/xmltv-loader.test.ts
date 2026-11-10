import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { gzipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndParseXMLTVInWorker } from './xmltv-loader';
import { measureHeldValue, writeHeldValue } from '../workers/held-values';

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

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
      },
    });

    expect(result.data.channels.ch1.name).toBe('Alpha é');
    expect(result.data.programmes.ch1[0].title).toBe('Bravo é');
  });

  it('incrementally decompresses a gzip response', async () => {
    const xml = `<tv><channel id="ch1"><display-name>Alpha</display-name></channel>`
      + `<programme channel="ch1" start="${start}" stop="${stop}">`
      + '<title>Bravo</title></programme></tv>';
    vi.stubGlobal('fetch', vi.fn(async () =>
      responseInChunks(gzipSync(strToU8(xml)), 5)));

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
      },
    });

    expect(result.stats.programmesKept).toBe(1);
    expect(result.data.programmes.ch1[0].title).toBe('Bravo');
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

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
        channelNames: ['alpha'],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.programmes.ch1[0].title).toBe('Bravo');
    expect(result.metrics.attempts).toBe(2);
  });

  it('emits bounded programme batches and resets before an order retry', async () => {
    const programmes = Array.from({ length: 257 }, (_, index) =>
      `<programme channel="ch1" start="${start}" stop="${stop}">`
      + `<title>P${String(index)}</title></programme>`)
      .join('');
    const xml = `<tv>${programmes}`
      + '<channel id="ch1"><display-name>Alpha</display-name></channel></tv>';
    vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 1024)));
    const chunks: Parameters<NonNullable<Parameters<
      typeof fetchAndParseXMLTVInWorker
    >[1]>>[0][] = [];

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 1000,
      options: {
        nowMs: new Date('2026-08-14T19:30:00Z').getTime(),
        channelNames: ['alpha'],
      },
    }, chunk => chunks.push(chunk));

    expect(chunks.filter(chunk => chunk.kind === 'reset').map(chunk => chunk.attempt))
      .toEqual([1, 2]);
    const finalProgrammes = chunks
      .filter(chunk => chunk.kind === 'programmes' && chunk.attempt === 2)
      .flatMap(chunk => chunk.kind === 'programmes' ? chunk.entries : [])
      .flatMap(([, entries]) => entries);
    expect(finalProgrammes).toHaveLength(result.stats.programmesKept);
    expect(result.data.programmes).toEqual({});
    expect(result.metrics.attempts).toBe(2);
  });

  describe('a guide held for its cache write', () => {
    const programme = (title: string, from: string, to: string): string =>
      `<programme channel="ch1" start="${from}" stop="${to}"><title>${title}</title></programme>`;
    const nowMs = new Date('2026-08-14T19:30:00Z').getTime();
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const { WeakRef } = globalThis as unknown as {
      WeakRef: new <T extends object>(target: T) => { deref(): T | undefined };
    };

    async function heldGuide(token: string): Promise<unknown> {
      let value: unknown;
      await writeHeldValue(
        { token, timeoutMs: 1000, field: 'data', writes: [{ store: 's', value: { key: 'k' } }] },
        async writes => { value = writes[0].value.data; },
      );
      return value;
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

    it('lets the batches of a guide past its ceiling go before the parse ends', async () => {
      const body = Array.from({ length: 257 }, (_, index) => programme(`P${String(index)}`, start, stop)).join('');
      let finish: () => void = () => undefined;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(strToU8(`<tv>${body}`));
          finish = () => {
            controller.enqueue(strToU8('</tv>'));
            controller.close();
          };
        },
      }))));
      let firstBatch: { deref(): object | undefined } | null = null;

      const parsing = fetchAndParseXMLTVInWorker({
        url: 'http://host/a',
        timeout: 1000,
        options: { nowMs, maxProgrammes: 256 },
        holdForCache: true,
      }, chunk => {
        if (chunk.kind === 'programmes' && !firstBatch) firstBatch = new WeakRef(chunk.entries);
      });
      await vi.waitFor(() => expect(firstBatch).not.toBeNull());
      await new Promise(resolve => setTimeout(resolve, 0));
      gc();

      expect(firstBatch!.deref()).toBeUndefined();
      finish();
      expect((await parsing).held).toBeUndefined();
    });

    it('lets its batches go once the held guide is built', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        responseInChunks(strToU8(`<tv>${programme('P1', start, stop)}</tv>`), 64)));
      let batch: { deref(): object | undefined } | null = null;

      const result = await fetchAndParseXMLTVInWorker({
        url: 'http://host/a',
        timeout: 1000,
        options: { nowMs },
        holdForCache: true,
      }, chunk => {
        if (chunk.kind === 'programmes') batch = new WeakRef(chunk.entries);
      });
      const token = result.held!.token;
      expect(measureHeldValue(token)).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 0));
      gc();

      expect(batch!.deref()).toBeUndefined();
      const guide = await heldGuide(token) as { programmes: Record<string, { title: string }[]> };
      expect(guide.programmes.ch1.map(entry => entry.title)).toEqual(['P1']);
    });

    it('can build the held guide again after a build that failed', async () => {
      const xml = `<tv>${programme('Later', '20260814200000 +0000', '20260814210000 +0000')}`
        + `${programme('Earlier', start, stop)}</tv>`;
      vi.stubGlobal('fetch', vi.fn(async () => responseInChunks(strToU8(xml), 64)));
      const result = await fetchAndParseXMLTVInWorker({
        url: 'http://host/a',
        timeout: 1000,
        options: { nowMs },
        holdForCache: true,
      }, () => undefined);
      const token = result.held!.token;
      // Sorting the unordered channel is where a large guide runs out of memory.
      const sort = vi.spyOn(Array.prototype, 'sort').mockImplementationOnce(() => {
        throw new RangeError('out of memory');
      });
      expect(() => measureHeldValue(token)).toThrow(RangeError);
      sort.mockRestore();

      const guide = await heldGuide(token) as { programmes: Record<string, { title: string }[]> };
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

    const result = await fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 30000,
      options: {},
    });

    expect(result.data.channels.ch1.name).toBe('Alpha');
  });

  it('logs a structured failure without committing a partial result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('', { status: 503, statusText: 'Unavailable' })));

    await expect(fetchAndParseXMLTVInWorker({
      url: 'http://host/a',
      timeout: 30000,
      options: {},
    })).rejects.toMatchObject({
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
