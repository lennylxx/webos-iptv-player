import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndParseXMLTV } from './xmltv-loader';
import { retainAppWorker, terminateAppWorker } from '../workers/app-worker-client';
import { heldRecord, releaseHeldRecord } from '../services/held-records';
import { packEpg } from '../services/epg-cache-codec';
import { yieldToEventLoop } from '../utils/yield';
import type { Programme } from '../types';

vi.mock('../utils/yield', () => ({ yieldToEventLoop: vi.fn(() => Promise.resolve()) }));

class FakeWorker {
  static url = '';
  static request: unknown = null;
  static terminations = 0;
  static instances: FakeWorker[] = [];
  static respond = true;
  static chunks: unknown[] = [];
  static held: { token: string } | null = null;
  static attempts = 1;
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;

  constructor(url: string) {
    FakeWorker.url = url;
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    if ((message as { kind?: string }).kind === 'ack') return;
    FakeWorker.request = message;
    if (!FakeWorker.respond) return;
    const id = (message as { id: number }).id;
    queueMicrotask(() => {
      for (const chunk of FakeWorker.chunks) {
        this.messageListener?.({
          data: { kind: 'progress', id, chunk },
        } as MessageEvent<unknown>);
      }
      this.messageListener?.({ data: {
        kind: 'success',
        id,
        result: {
          data: { channels: {}, programmes: {}, tzOffsetMinutes: null },
          stats: { programmesKept: 0, droppedBudget: 0 },
          ...(FakeWorker.held ? { held: FakeWorker.held } : {}),
          metrics: {
            transport: 'stream',
            encoding: 'gzip',
            attempts: FakeWorker.attempts,
            inputBytes: 10,
            chunks: 1,
            elapsedMs: 2,
          },
        },
      } } as MessageEvent<unknown>);
    });
  }

  terminate(): void {
    FakeWorker.terminations++;
  }

  emitError(message: string): void {
    this.errorListener?.({ message } as ErrorEvent);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === 'message') this.messageListener = listener;
    if (type === 'error') {
      this.errorListener = listener as (event: ErrorEvent) => void;
    }
  }
}

afterEach(() => {
  vi.mocked(yieldToEventLoop).mockImplementation(() => Promise.resolve());
  terminateAppWorker();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.request = null;
  FakeWorker.url = '';
  FakeWorker.terminations = 0;
  FakeWorker.instances = [];
  FakeWorker.respond = true;
  FakeWorker.chunks = [];
  FakeWorker.held = null;
  FakeWorker.attempts = 1;
  vi.useRealTimers();
});

describe('fetchAndParseXMLTV worker client', () => {
  it('uses the packaged worker URL and serializes parse filters', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);

    await fetchAndParseXMLTV('http://host/a', 1234, {
      channelIds: new Set(['ch1']),
      channelNames: new Set(['alpha']),
      retainChannelCatalog: true,
    });

    expect(FakeWorker.url).toBe('http://host/app/js/app-worker.js');
    expect(FakeWorker.request).toMatchObject({
      kind: 'request',
      task: 'xmltv.load',
      payload: {
        url: 'http://host/a',
        timeout: 1234,
        options: {
          nowMs: 123456,
          channelIds: ['ch1'],
          channelNames: ['alpha'],
          retainChannelCatalog: true,
        },
      },
    });
    expect(info).toHaveBeenCalledWith(
      '[XMLTVLoad]',
      'XMLTV stream loaded',
      'event=epg.xmltv.load.completed',
      'transport=stream',
      'encoding=gzip',
      'attempts=1',
      'bytes=10',
      'chunks=1',
      'programmes=0',
      'dropped=0',
      'elapsedMs=2',
      'decodeMs=0',
      'totalMs=0',
    );
  });

  it('terminates the shared worker after its idle timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);

    await fetchAndParseXMLTV('http://host/a');
    expect(FakeWorker.terminations).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWorker.terminations).toBe(1);
  });

  it('decodes the guide blocks the worker sends, yielding between slices', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);
    const entry = (title: string, hour: number) => ({
      start: new Date(Date.UTC(2026, 7, 14, hour)),
      stop: new Date(Date.UTC(2026, 7, 14, hour + 1)),
      title,
      description: '',
      category: '',
      icon: '',
    });
    const programmes: Record<string, ReturnType<typeof entry>[]> = {};
    for (let index = 0; index < 3000; index++) programmes[`ch${String(index)}`] = [entry('P', 19)];
    programmes.ch1 = [entry('Earlier', 19), entry('Later', 20)];
    const packed = packEpg({ channels: { ch1: { name: 'Alpha', icon: '' } }, programmes });
    FakeWorker.chunks = [
      { kind: 'guide', part: 'channels', blocks: packed.channels },
      { kind: 'guide', part: 'programmes', blocks: packed.programmes.slice(0, 1) },
      { kind: 'guide', part: 'programmes', blocks: packed.programmes.slice(1) },
    ];
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 20));
    const yields = vi.mocked(yieldToEventLoop);
    yields.mockClear();

    const result = await fetchAndParseXMLTV('http://host/a');

    expect(packed.programmes.length).toBeGreaterThan(1);
    expect(yields).toHaveBeenCalled();
    expect(result.data.channels).toEqual({ ch1: { name: 'Alpha', icon: '' } });
    expect(result.data.programmes.ch1.map(programme => programme.title))
      .toEqual(['Earlier', 'Later']);
    expect(Object.keys(result.data.programmes)).toHaveLength(3000);
    expect(result.data.tzOffsetMinutes).toBeNull();
  });

  it('keeps the worker holding the guide alive while the page decodes it', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);
    const programmes: Record<string, Programme[]> = {};
    for (let index = 0; index < 3000; index++) {
      programmes[`ch${String(index)}`] = [{
        start: new Date(0), stop: new Date(1), title: 'P', description: '', category: '', icon: '',
      }];
    }
    const packed = packEpg({ channels: {}, programmes });
    FakeWorker.chunks = [{ kind: 'guide', part: 'programmes', blocks: packed.programmes }];
    FakeWorker.held = { token: 't1' };
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 20));
    // The decode outlasts the worker's idle timeout.
    vi.mocked(yieldToEventLoop).mockImplementation(() => vi.advanceTimersByTimeAsync(1000));

    const result = await fetchAndParseXMLTV('http://host/a', 1000, {}, true);

    expect(FakeWorker.terminations).toBe(0);
    expect(heldRecord(result.data)).not.toBeNull();
    releaseHeldRecord(result.data);
    // The completed event counts the page's decode, which the worker never sees.
    const completed = info.mock.calls.map(call => call.join(' '))
      .find(line => line.includes('event=epg.xmltv.load.completed'));
    const decodeMs = Number(/decodeMs=(\d+)/.exec(completed ?? '')?.[1]);
    expect(decodeMs).toBeGreaterThanOrEqual(1000);
    expect(completed).toContain(`totalMs=${String(decodeMs)}`);
  });

  it('releases the held guide when its blocks fail to decode', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.chunks = [{ kind: 'guide', part: 'programmes', blocks: ['{'] }];
    FakeWorker.held = { token: 't1' };
    FakeWorker.attempts = 2;

    await expect(fetchAndParseXMLTV('http://host/a', 1000, {}, true)).rejects.toThrow(SyntaxError);
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWorker.request).toMatchObject({ task: 'cache.release-held', payload: { token: 't1' } });
    expect(FakeWorker.terminations).toBe(1);
    const failures = errors.mock.calls.map(call => call.join(' '))
      .filter(line => line.includes('event=epg.xmltv.load.failed'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('stage=decode reason=exception attempts=2');
    expect(info.mock.calls.some(call => call.includes('event=epg.xmltv.load.retry'))).toBe(true);
  });

  it('asks for the guide to be held and holds the one it rebuilt', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.held = { token: 't1' };

    const result = await fetchAndParseXMLTV('http://host/a', 1000, {}, true);

    expect(FakeWorker.request).toMatchObject({ payload: { holdForCache: true } });
    expect(result.held).toBeUndefined();
    expect(heldRecord(result.data)).not.toBeNull();
    releaseHeldRecord(result.data);
    expect(heldRecord(result.data)).toBeNull();
  });

  it('keeps the shared worker alive while a client retains it', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);

    const release = retainAppWorker();
    await fetchAndParseXMLTV('http://host/a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWorker.terminations).toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWorker.terminations).toBe(1);
  });

  it('logs a fatal worker error and recreates the client', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.respond = false;

    const first = fetchAndParseXMLTV('http://host/a');
    FakeWorker.instances[0].emitError('worker crashed');

    await expect(first).rejects.toThrow('worker crashed');
    expect(error).toHaveBeenCalledWith(
      '[AppWorker]',
      'App worker failed',
      'event=worker.lifecycle.failed',
      'reason=execution_error',
      expect.stringMatching(/^generation=\d+$/),
      'active=1',
      expect.objectContaining({ message: 'worker crashed' }),
    );

    FakeWorker.respond = true;
    await fetchAndParseXMLTV('http://host/a');

    expect(FakeWorker.instances).toHaveLength(2);
  });
});
