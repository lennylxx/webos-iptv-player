import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DiagnosticRedactor,
  assembleDiagnosticReport,
  extractPlaybackTimeline,
  extractXtreamTimeline,
  normalizeNetworkRecords,
  parseNativeMetricOutput,
  parseDiagnosticArgs,
  formatDiagnosticSummary,
  runNativeProbe,
  inspectorWebSocketUrl,
  startAresInspector,
  startNativeMetricWindow,
} from './tv-diag.mjs';

describe('tv-diag arguments', () => {
  it('parses capture and render options', () => {
    expect(parseDiagnosticArgs([
      '--app', 'app.id',
      '--device', 'tv',
      '--timeout', '45',
      '--attach',
      '--duration', '25',
      '--output', 'report.json',
      '--full',
    ])).toMatchObject({
      appId: 'app.id',
      device: 'tv',
      timeoutMs: 45000,
      durationMs: 25000,
      attach: true,
      outputPath: 'report.json',
      full: true,
    });

    expect(parseDiagnosticArgs(['--summary', 'report.json']).summaryPath).toBe('report.json');
  });

  it('rejects invalid options', () => {
    expect(() => parseDiagnosticArgs(['--port', '0'])).toThrow('Invalid value for --port');
    expect(() => parseDiagnosticArgs(['--play-channel', '1.5']))
      .toThrow('Invalid value for --play-channel');
    expect(() => parseDiagnosticArgs(['--attach', '--play-channel', '0']))
      .toThrow('--attach cannot be combined with --play-channel');
    expect(() => parseDiagnosticArgs(['--attach', '--duration', '0']))
      .toThrow('Invalid value for --duration');
    expect(() => parseDiagnosticArgs(['--duration', '20']))
      .toThrow('--duration requires --attach or --play-channel');
    expect(() => parseDiagnosticArgs(['--unknown'])).toThrow('Unknown option');
  });
});

describe('ares-inspect lifecycle', () => {
  it('extracts the page WebSocket from inspector output', () => {
    expect(inspectorWebSocketUrl(
      'Application Debugging - http://localhost:62090/devtools/inspector.html'
      + '?ws=localhost:62090/devtools/page/ABC',
    )).toBe('ws://localhost:62090/devtools/page/ABC');
  });

  describe('native playback metrics', () => {
    const output = [
      '@ticks|before|100',
      '@proc|before|1|umediaserver|10|5|1000|2|1000000|2000000',
      '@psi|before|cpu|0.10|1000',
      '@psi|before|memory|0.00|2000',
      '@psi|before|io|0.00|3000',
      '@net|before|1000|2000',
      '@tcp|before|4',
      '@native-ready',
      '@ticks|after|100',
      '@proc|after|1|umediaserver|20|10|1200|3|4000000|7000000',
      '@proc|after|2|starfish|40|10|14000|5|8000000|9000000',
      '@psi|after|cpu|0.20|4000',
      '@psi|after|memory|0.00|2000',
      '@psi|after|io|0.01|5000',
      '@net|after|1500|2700',
      '@tcp|after|6',
    ].join('\n');

    it('calculates process, pressure, network, and retransmit deltas', () => {
      const metrics = parseNativeMetricOutput(output, 10000);
      expect(metrics).toMatchObject({
        durationMs: 10000,
        network: { rxBytes: 500, txBytes: 700 },
        tcpRetransmits: 2,
        pressure: {
          cpu: { avg10: 0.2, stallMs: 3 },
          memory: { avg10: 0, stallMs: 0 },
          io: { avg10: 0.01, stallMs: 2 },
        },
      });
      expect(metrics.processes).toEqual([
        expect.objectContaining({
          pid: 1,
          kind: 'umediaserver',
          startedDuringWindow: false,
          cpuPercent: 1.5,
          schedulerWaitMs: 5,
        }),
        expect.objectContaining({
          pid: 2,
          kind: 'starfish',
          startedDuringWindow: true,
          cpuPercent: 5,
        }),
      ]);
    });

    it('waits for the remote baseline before resolving readiness', async () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; };
      const session = startNativeMetricWindow(10000, {
        spawn: () => child,
        timeoutMs: 1000,
      });
      child.stdout.emit('data', `${output}\n`);
      await session.ready;
      child.emit('close', 0);
      expect(await session.result).toMatchObject({
        network: { rxBytes: 500, txBytes: 700 },
        tcpRetransmits: 2,
      });
    });
  });

  it('starts a persistent inspector without waiting for process exit', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const inspector = startAresInspector('app.id', 'tv', {
      spawn: () => child,
      timeoutMs: 1000,
    });
    child.stdout.emit(
      'data',
      'http://localhost:62090/devtools/inspector.html?ws=localhost:62090/devtools/page/ABC',
    );
    expect(await inspector.wsUrl).toBe('ws://localhost:62090/devtools/page/ABC');
    expect(child.killed).toBe(false);
  });
});

describe('DiagnosticRedactor', () => {
  it('preserves URL shape while replacing hosts and credentials', () => {
    const redactor = new DiagnosticRedactor({ secrets: ['user1', 'pass1'] });
    const first = redactor.url('http://host:8080/live/user1/pass1/7.ts?token=abc&output=m3u8');
    const second = redactor.url('http://host:8080/get.php?username=user1&password=pass1');

    expect(first).toContain('http://<host-a>:8080/live/');
    expect(first).toContain('output=m3u8');
    expect(second).toContain('http://<host-a>:8080/get.php');
    expect(first).not.toContain('user1');
    expect(first).not.toContain('pass1');
    expect(first).not.toContain('abc');
    expect(second).not.toContain('user1');
  });

  it('redacts credential-like path segments from plain playlist URLs', () => {
    const report = assembleDiagnosticReport({
      capturedAt: '2026-01-01T00:00:00.000Z',
      full: false,
      app: {},
      environment: {},
      probe: {
        playlists: [{
          source: 'm3u',
          name: '',
          __url: 'http://host/live/user1/pass1/7.ts',
          __secrets: [],
          webview: {},
        }],
      },
      native: [],
      logs: [],
      networkEvents: [],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('user1');
    expect(serialized).not.toContain('pass1');
    expect(report.playlists[0].url).toContain('/live/');
  });

  it('keeps a synthetic playlist filename while redacting parent path tokens', () => {
    const report = assembleDiagnosticReport({
      capturedAt: '2026-01-01T00:00:00.000Z',
      full: false,
      app: {},
      environment: {},
      probe: {
        playlists: [{
          source: 'm3u',
          name: '',
          __url: 'http://host/private/playlist.m3u',
          __secrets: [],
          webview: {},
        }],
      },
      native: [],
      logs: [],
      networkEvents: [],
    });
    expect(report.playlists[0].url).toContain('/~redacted-7-alnum~/playlist.m3u');
  });

  it('redacts media filenames that can reveal channel names', () => {
    const redactor = new DiagnosticRedactor();
    const url = redactor.url('http://host/play/Alpha.m3u8');
    expect(url).not.toContain('Alpha');
    expect(url).toContain('/~redacted-10-mixed~');
  });

  it('redacts credentials and URLs embedded in text', () => {
    const redactor = new DiagnosticRedactor({ secrets: ['pass1'] });
    const text = redactor.text('failed http://host/a?password=pass1 token=pass1');
    expect(text).toContain('<host-a>');
    expect(text).not.toContain('pass1');
  });

  it('leaves values untouched in full mode', () => {
    const redactor = new DiagnosticRedactor({ full: true, secrets: ['pass1'] });
    expect(redactor.url('http://host/a?password=pass1')).toBe('http://host/a?password=pass1');
  });
});

describe('diagnostic report assembly', () => {
  it('parses the native curl preview marker', () => {
    const result = runNativeProbe('http://host/a', {
      execFile: () => "\rEnter passphrase for key '/home/user/.ssh/key': \r\n"
        + '#EXTM3U\n__IPTV_DIAG__206|text/plain',
    });
    expect(result).toEqual({
      status: 206,
      contentType: 'text/plain',
      bodyPreview: '#EXTM3U',
      error: '',
    });
  });

  it('normalizes network events without request headers', () => {
    const redactor = new DiagnosticRedactor();
    const records = normalizeNetworkRecords([
      {
        method: 'Network.requestWillBeSent',
        observedAt: '2026-01-01T00:00:00.000Z',
        params: { requestId: '1', request: { method: 'GET', url: 'http://host/a?token=abc' } },
      },
      {
        method: 'Network.responseReceived',
        observedAt: '2026-01-01T00:00:01.000Z',
        params: {
          requestId: '1',
          response: {
            status: 200,
            url: 'http://host/a?token=abc',
            mimeType: 'text/plain',
            headers: { 'Content-Type': 'text/plain', Authorization: 'secret' },
          },
        },
      },
      {
        method: 'Network.loadingFinished',
        observedAt: '2026-01-01T00:00:02.000Z',
        params: { requestId: '1', encodedDataLength: 42 },
      },
    ], redactor);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      method: 'GET',
      status: 200,
      mimeType: 'text/plain',
      headers: { 'content-type': 'text/plain' },
      encodedBytes: 42,
      durationMs: 2000,
    });
    expect(records[0].url).not.toContain('abc');
    expect(records[0].headers).not.toHaveProperty('authorization');
  });

  it('extracts stable diagnostic events with optional playback labels', () => {
    const timeline = extractPlaybackTimeline([
      {
        observedAt: '2026-01-01T00:00:00.000Z',
        source: 'console',
        level: 'log',
        text: '[Player] event=playback.path.native session=3 load=2 reason=probe',
      },
      {
        observedAt: '2026-01-01T00:00:01.000Z',
        source: 'console',
        level: 'warning',
        text: '[Storage] event=persistence.cache.write.failed category=playlist',
      },
      {
        observedAt: '2026-01-01T00:00:02.000Z',
        source: 'console',
        level: 'log',
        text: '[Player] ordinary log',
      },
    ]);
    expect(timeline).toEqual([
      expect.objectContaining({
        code: 'playback.path.native',
        session: 3,
        load: 2,
      }),
      expect.objectContaining({
        code: 'persistence.cache.write.failed',
        session: null,
        load: null,
      }),
    ]);
  });

  it('extracts structured Xtream request failures from natural-language logs', () => {
    const timeline = extractXtreamTimeline([
      {
        observedAt: '2026-01-01T00:00:00.000Z',
        source: 'console',
        level: 'warning',
        text: '[Xtream] Xtream request failed event=xtream.request.failed'
          + ' endpoint=get_vod_streams operation=browse resource=vod_streams'
          + ' reason=request_failed code=too_large items=12'
          + ' timeoutMs=30000 limitBytes=33554432',
      },
      {
        observedAt: '2026-01-01T00:00:01.000Z',
        source: 'console',
        level: 'log',
        text: '[Xtream] ordinary log',
      },
    ]);
    expect(timeline).toEqual([expect.objectContaining({
      event: 'xtream.request.failed',
      endpoint: 'get_vod_streams',
      operation: 'browse',
      resource: 'vod_streams',
      reason: 'request_failed',
      code: 'too_large',
      items: 12,
      timeoutMs: 30000,
      limitBytes: 33554432,
    })]);
  });

  it('does not leak probe secrets into the assembled report', () => {
    const report = assembleDiagnosticReport({
      capturedAt: '2026-01-01T00:00:00.000Z',
      full: false,
      app: { id: 'app.id', version: '1.0.0' },
      environment: { userAgent: 'ua' },
      probe: {
        state: {
          view: 'view-player',
          channels: 2,
          media: {
            src: 'http://host/live/user1/pass1/7.ts',
            readyState: 4,
            networkState: 2,
            paused: false,
            currentTime: 12,
            error: null,
          },
        },
        storage: {},
        playlists: [{
          source: 'xtream',
          name: 'Alpha',
          __url: 'http://host/get.php?username=user1&password=pass1',
          __secrets: ['user1', 'pass1'],
          webview: { status: 200, bodyPreview: '#EXTM3U pass1' },
          xtreamAuth: { auth: 1 },
        }],
      },
      native: [{ status: 200, contentType: 'text/plain', bodyPreview: '#EXTM3U user1', error: '' }],
      logs: [{
        observedAt: '2026-01-01T00:00:00.000Z',
        source: 'console',
        level: 'error',
        text: 'failed pass1',
      }, {
        observedAt: '2026-01-01T00:00:01.000Z',
        source: 'console',
        level: 'log',
        text: 'Selected native playback event=playback.path.native session=1 load=1',
      }, {
        observedAt: '2026-01-01T00:00:02.000Z',
        source: 'console',
        level: 'warning',
        text: 'Xtream request failed event=xtream.request.failed'
          + ' endpoint=get_series code=timeout timeoutMs=30000 limitBytes=33554432',
      }],
      networkEvents: [],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('user1');
    expect(serialized).not.toContain('pass1');
    expect(serialized).not.toContain('Alpha.m3u8');
    const summary = formatDiagnosticSummary(report);
    expect(summary).toContain('webview=200');
    expect(summary).toContain('playback.path.native');
    expect(summary).toContain(
      'xtream.request.failed endpoint=get_series code=timeout'
        + ' timeoutMs=30000 limitBytes=33554432',
    );
    expect(summary).toContain('Media: playing');
  });

  it('keeps long probe failures concise in the terminal summary', () => {
    const summary = formatDiagnosticSummary({
      capturedAt: '2026-01-01T00:00:00.000Z',
      app: {},
      environment: {},
      state: {},
      playlists: [{
        source: 'm3u',
        url: 'http://<host-a>/playlist.m3u',
        webview: { error: 'first line\nsecond line' },
        native: { error: 'x'.repeat(200) },
      }],
      playback: [],
      network: [],
      logs: [],
    });
    expect(summary).not.toContain('second line');
    expect(summary.length).toBeLessThan(500);
  });
});
