import { gzipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndParseXMLTVInWorker } from './xmltv-loader';

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
