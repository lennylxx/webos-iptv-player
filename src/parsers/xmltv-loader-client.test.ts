import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndParseXMLTV } from './xmltv-loader';
import { retainAppWorker, terminateAppWorker } from '../workers/app-worker-client';
import { heldRecord, releaseHeldRecord } from '../services/held-records';

class FakeWorker {
  static url = '';
  static request: unknown = null;
  static terminations = 0;
  static instances: FakeWorker[] = [];
  static respond = true;
  static chunks: unknown[] = [];
  static held: { token: string } | null = null;
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;

  constructor(url: string) {
    FakeWorker.url = url;
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
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
            attempts: 1,
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

  it('reconstructs and sorts batched XMLTV results after a reset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('document', { baseURI: 'http://host/app/index.html' });
    vi.stubGlobal('Worker', FakeWorker);
    const later = new Date('2026-08-14T20:00:00Z');
    const earlier = new Date('2026-08-14T19:00:00Z');
    FakeWorker.chunks = [
      { kind: 'reset', attempt: 1 },
      {
        kind: 'programmes',
        attempt: 1,
        entries: [['old', [{
          start: earlier,
          stop: later,
          title: 'Discarded',
          description: '',
          category: '',
          icon: '',
        }]]],
      },
      { kind: 'reset', attempt: 2 },
      {
        kind: 'channels',
        attempt: 2,
        entries: [['ch1', { name: 'Alpha', icon: '' }]],
      },
      {
        kind: 'programmes',
        attempt: 2,
        entries: [['ch1', [
          {
            start: later,
            stop: new Date('2026-08-14T21:00:00Z'),
            title: 'Later',
            description: '',
            category: '',
            icon: '',
          },
          {
            start: earlier,
            stop: later,
            title: 'Earlier',
            description: '',
            category: '',
            icon: '',
          },
        ]]],
      },
    ];

    const result = await fetchAndParseXMLTV('http://host/a');

    expect(result.data.channels).toEqual({ ch1: { name: 'Alpha', icon: '' } });
    expect(result.data.programmes.ch1.map(programme => programme.title))
      .toEqual(['Earlier', 'Later']);
    expect(result.data.programmes.old).toBeUndefined();
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
