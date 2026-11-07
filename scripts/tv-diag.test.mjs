import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DiagnosticRedactor,
  assembleDiagnosticReport,
  captureDiagnostics,
  extractDiagnosticTimeline,
  extractInputTimeline,
  extractXtreamTimeline,
  normalizeNetworkRecords,
  parseNativeMetricOutput,
  parseDiagnosticArgs,
  activeProbeExpression,
  formatDiagnosticSummary,
  runNativeProbe,
  readServiceLog,
  inspectorWebSocketUrl,
  startAresInspector,
  startNativeMetricWindow,
  evaluateOnLegacyEngine,
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
      '@proc|before|1|umediaserver|10|5|1000|2|1000000|2000000|500|0|2000|1800|1600|700|300|0|100',
      '@proc|before|3|starfish|5|5|50000|3|1000000|1000000|900|100|90000|80000|70000|40000|10000|0|5000',
      '@proc|before|4|webapp|10|5|80000|15|1000000|2000000|888|300|635084|535380|182884|40536|41644|84|4268',
      '@psi|before|cpu|0.10|1000',
      '@psi|before|memory|0.00|2000',
      '@psi|before|io|0.00|3000',
      '@net|before|1000|2000',
      '@tcp|before|4',
      '@mem|before|1000000|400000|200000|100000',
      '@mm|before|normal|normal|596|1',
      '@oom-access|before|1',
      '@oom|before|old oom record',
      '@native-ready',
      '@peak|1|1|umediaserver|1500|3',
      '@peak|1|3|starfish|70000|4',
      '@peak|1|4|webapp|90000|16',
      '@mem-sample|1|300000|90000',
      '@ticks|after|100',
      '@proc|after|1|umediaserver|20|10|1200|3|4000000|7000000|550|0|2100|1900|1700|800|400|0|90',
      '@proc|after|2|starfish|40|10|14000|5|8000000|9000000|700|50|30000|25000|20000|10000|4000|0|1000',
      '@proc|after|4|webapp|20|10|85000|16|4000000|7000000|890|300|640000|540000|185000|43000|41900|100|5000',
      '@psi|after|cpu|0.20|4000',
      '@psi|after|memory|0.00|2000',
      '@psi|after|io|0.01|5000',
      '@net|after|1500|2700',
      '@tcp|after|6',
      '@mem|after|1000000|350000|200000|95000',
      '@mm|after|low|normal|280|1',
      '@oom-access|after|1',
      '@oom|after|old oom record',
      '@oom|after|Out of memory: Killed process 3 (starfish)',
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
        memory: {
          totalKb: 1000000,
          availableBeforeKb: 400000,
          availableAfterKb: 350000,
          minimumAvailableKb: 300000,
          usedBeforeKb: 600000,
          usedAfterKb: 650000,
          maximumUsedKb: 700000,
          swapTotalKb: 200000,
          swapFreeBeforeKb: 100000,
          swapFreeAfterKb: 95000,
          minimumSwapFreeKb: 90000,
        },
        oomLogAvailable: true,
        oomEvents: ['Out of memory: Killed process 3 (starfish)'],
        appMemory: {
          processCountBefore: 1,
          processCountAfter: 1,
          rssBeforeKb: 80000,
          rssAfterKb: 85000,
          peakObservedRssKb: 90000,
          lifetimeHighWaterKb: 185000,
          virtualSizeAfterKb: 540000,
          anonymousRssAfterKb: 43000,
          fileRssAfterKb: 41900,
          sharedRssAfterKb: 100,
          swapAfterKb: 5000,
          percentOfSystemAtPeak: 9,
        },
        memoryManager: {
          available: true,
          levelBefore: 'normal',
          levelAfter: 'low',
          previousLevelBefore: 'normal',
          previousLevelAfter: 'normal',
          usableBeforeMb: 596,
          usableAfterMb: 280,
          minimumUsableMb: 280,
        },
      });
      expect(metrics.processes).toEqual([
        expect.objectContaining({
          pid: 1,
          kind: 'umediaserver',
          startedDuringWindow: false,
          cpuPercent: 1.5,
          schedulerWaitMs: 5,
          initialRssKb: 1000,
          peakRssKb: 1500,
          initialOomScore: 500,
          oomScore: 550,
        }),
        expect.objectContaining({
          pid: 2,
          kind: 'starfish',
          startedDuringWindow: true,
          cpuPercent: 5,
          initialRssKb: null,
          peakRssKb: 14000,
          oomScore: 700,
        }),
        expect.objectContaining({
          pid: 4,
          kind: 'webapp',
          initialRssKb: 80000,
          rssKb: 85000,
          peakRssKb: 90000,
          vmHwmKb: 185000,
          swapKb: 5000,
        }),
      ]);
      expect(metrics.stoppedProcesses).toEqual([
        expect.objectContaining({
          pid: 3,
          kind: 'starfish',
          initialRssKb: 50000,
          peakRssKb: 70000,
          peakThreads: 4,
          initialOomScore: 900,
          oomScoreAdj: 100,
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
        spawn: (_file, args) => {
          expect(args[1]).toContain('WebAppMgr');
          expect(args[1]).toContain("app_id='com.lennylxx.iptv'");
          expect(args[1]).toContain('*"--app-id=$app_id"*');
          expect(args[1]).toContain('/proc/$p/oom_score');
          expect(args[1]).toContain('MemAvailable');
          expect(args[1]).toContain('dmesg');
          expect(args[1]).toContain('com.webos.memorymanager/getCurrentMemState');
          expect(args[1]).toContain('new pb.Handle');
          return child;
        },
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
    inspector.close();
    expect(child.killed).toBe(true);
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

  it('redacts a short secret only as a whole token, leaving words that contain it', () => {
    const redactor = new DiagnosticRedactor({ secrets: ['pl', 'u1'] });
    const text = redactor.text('completed plain playlist user=pl pass=u1 /pl/u1/ menu1');
    expect(text).toContain('completed plain playlist');
    expect(text).toContain('menu1');
    expect(text).toContain('user=~redacted-2-alnum~ pass=~redacted-2-alnum~');
    expect(text).toContain('/~redacted-2-alnum~/~redacted-2-alnum~/');
  });

  it('leaves values untouched in full mode', () => {
    const redactor = new DiagnosticRedactor({ full: true, secrets: ['pass1'] });
    expect(redactor.url('http://host/a?password=pass1')).toBe('http://host/a?password=pass1');
  });
});

describe('diagnostic report assembly', () => {
  it('parses the native curl preview marker', () => {
    let command = '';
    const result = runNativeProbe('http://host/a', {
      execFile: (_file, args) => {
        command = args[1];
        return "\rEnter passphrase for key '/home/user/.ssh/key': \r\n"
          + '#EXTM3U\n__IPTV_DIAG__206|text/plain';
      },
    });
    expect(command).toContain('temp_root=/media/developer/temp');
    expect(command).toContain('temp_root=/tmp');
    expect(command).toContain('--range 0-2047');
    expect(command).toContain('| head -c 2048 > "$body"');
    expect(command).toContain('[ "$rc" -eq 23 ] && [ "$size" -eq 2048 ]');
    expect(command).not.toContain('-o "$body"');
    expect(result).toEqual({
      status: 206,
      contentType: 'text/plain',
      bodyPreview: '#EXTM3U',
      error: '',
    });
  });

  it('bounds native previews when the server ignores Range', () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'tv-diag-native-'));
    try {
      writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf 12\n', { mode: 0o755 });
      writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
headers=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -D) headers="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: 4096\\r\\n\\r\\n' > "$headers"
head -c 4096 /dev/zero
exit 23
`, { mode: 0o755 });

      const result = runNativeProbe('http://host/a', {
        execFile: (_file, args, options) => execFileSync('/bin/sh', ['-c', args[1]], {
          ...options,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        }),
      }, 15_000);

      expect(result.status).toBe(200);
      expect(result.contentType).toBe('text/plain');
      expect(result.bodyPreview).toHaveLength(2048);
      expect(result.error).toBe('');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('reads the rotated and current service log from the TV temp root', () => {
    let command = '';
    const result = readServiceLog({
      execFile: (_file, args) => {
        command = args[1];
        return "\rEnter passphrase for key '/home/user/.ssh/key': \r\n"
          + 'line 1\r\n\nline 2\n';
      },
    });

    expect(command).toContain('temp_root=/media/developer/temp');
    expect(command).toContain('temp_root=/tmp');
    expect(command).toContain('if [ -e "$log" ] || [ -e "$log.1" ]; then cat "$log.1" "$log"');
    expect(command).toContain('log="$temp_root/com.lennylxx.iptv.service.log"');
    expect(result).toEqual({ lines: ['line 1', 'line 2'], error: '' });
    expect(readServiceLog({
      execFile: () => { throw Object.assign(new Error('x'), { stderr: 'tv.sh: connection timed out\n' }); },
    })).toEqual({ lines: [], error: 'tv.sh: connection timed out' });
    expect(formatDiagnosticSummary({
      capturedAt: '', app: {}, environment: {}, state: {}, playlists: [],
      serviceLog: { lines: [], error: 'tv.sh: connection timed out' },
    })).toContain('Service log: unavailable (tv.sh: connection timed out)');
    expect(formatDiagnosticSummary({
      capturedAt: '', app: {}, environment: {}, state: {}, playlists: [],
      serviceLog: {
        lines: [
          '2026-01-01T00:00:00.000Z log [lan] peer sent warn and error words',
          '2026-01-01T00:00:01.000Z error [service] failed',
        ],
        error: '',
      },
    })).toContain('2 lines, 2026-01-01T00:00:00.000Z to 2026-01-01T00:00:01.000Z | warnings=0 errors=1');
    expect(readServiceLog({ execFile: () => '__IPTV_NO_SERVICE_LOG__\r\n' })).toEqual({
      lines: [],
      error: 'no service log on the TV; has the service started?',
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

  const log = (second, text, level = 'log') => ({
    observedAt: `2026-01-01T00:00:0${String(second)}.000Z`,
    source: 'console',
    level,
    text,
  });
  const summaryOf = (diagnostics, extra = {}) => formatDiagnosticSummary({
    capturedAt: '2026-01-01T00:00:09.000Z',
    app: {},
    environment: {},
    state: {},
    playlists: [],
    diagnostics,
    input: [],
    xtream: [],
    logs: [],
    network: [],
    ...extra,
  });

  it('splits events into diagnostic, input, and Xtream timelines by namespace', () => {
    const logs = [
      log(0, '[Player] event=playback.path.native session=3 load=2'),
      log(1, '[Key] Key down event=key.down code=52 action=number target=app'),
      log(2, '[Xtream] Xtream request failed event=xtream.request.failed'
        + ' endpoint=e1 code=timeout', 'warning'),
      log(3, '[Player] ordinary log'),
    ];

    expect(extractDiagnosticTimeline(logs)).toEqual([
      { observedAt: logs[0].observedAt, code: 'playback.path.native', level: 'log', text: logs[0].text },
      { observedAt: logs[2].observedAt, code: 'xtream.request.failed', level: 'warning', text: logs[2].text },
    ]);
    expect(extractInputTimeline(logs)).toEqual([
      { observedAt: logs[1].observedAt, event: 'key.down', level: 'log', text: logs[1].text },
    ]);
    expect(extractXtreamTimeline(logs)).toEqual([
      { observedAt: logs[2].observedAt, event: 'xtream.request.failed', level: 'warning', text: logs[2].text },
    ]);
  });

  it('summarizes every field after the event name, including unregistered ones', () => {
    const logs = [
      log(0, '[Player] Playback rate change failed event=playback.rate.failed'
        + ' session=2 rate=1.5 errorCode=-7 errorText="e1" newField=v1', 'warning'),
      log(1, '[App] Key routed event=key.action action=number view=player number=42'),
      log(2, '[Playlist] event=xtream.category_filter.applied load=2 mode=include'),
    ];
    const summary = summaryOf(extractDiagnosticTimeline(logs), {
      input: extractInputTimeline(logs),
      xtream: extractXtreamTimeline(logs),
    });

    expect(summary).toContain(
      '- playback.rate.failed session=2 rate=1.5 errorCode=-7 errorText="e1" newField=v1',
    );
    expect(summary).toContain('Input events: 1\n- key.action action=number view=player number=42');
    expect(summary).toContain('Xtream events: 1\n- xtream.category_filter.applied load=2 mode=include');
  });

  it('truncates long event fields in the summary', () => {
    const summary = summaryOf(extractDiagnosticTimeline([
      log(0, `[Player] event=playback.error errorText="${'x'.repeat(400)}"`),
    ]));
    const line = summary.split('\n').find((entry) => entry.startsWith('- playback.error'));

    expect(line).toMatch(/\.\.\.$/);
    expect(line.length).toBeLessThan(260);
  });

  it('reads the State line from the last load event, ignoring quoted text', () => {
    const summary = summaryOf(extractDiagnosticTimeline([
      log(0, '[Playlist] event=playlist.load.completed source=cache channels=5'),
      log(1, '[Playlist] event=playlist.load.completed errorText="channels=99 source=s1"'
        + ' source=network channels=7'),
    ]));

    expect(summary).toContain('channels=7 (network)');
  });

  it('does not treat an event inside quoted error text as a diagnostic event', () => {
    expect(extractDiagnosticTimeline([{
      observedAt: '2026-01-01T00:00:00.000Z',
      source: 'console',
      level: 'warning',
      text: '[Player] errorText="event=playback.rate.failed rate=2"',
    }])).toEqual([]);
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
          channelsRendered: 1,
          media: {
            src: 'http://host/live/user1/pass1/7.ts',
            sources: [{
              src: 'http://host/movie/user1/pass1/7.mkv',
              type: 'video/x-matroska',
              canPlayType: '',
            }],
            readyState: 4,
            networkState: 2,
            paused: false,
            currentTime: 12,
            error: null,
          },
          codecSupport: {
            'video/mp4': 'probably',
            'video/x-matroska': '',
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
        level: 'warning',
        text: '[Playlist] Playlist load completed event=playlist.load.completed'
          + ' source=network channels=0 all=0 groups=0 epg=1 sources=1 failed=1',
      }],
      serviceLog: {
        lines: [
          '2026-01-01T00:00:00.000Z log [fetch] fetchManifest outcome=ok status=200',
          '2026-01-01T00:00:01.000Z warn [lan] fetch http://host/get.php?username=user1 failed',
        ],
        error: '',
      },
      networkEvents: [],
    });
    const serialized = JSON.stringify(report);
    expect(report.schemaVersion).toBe(5);
    expect(report.serviceLog.lines[0]).toContain('fetchManifest outcome=ok');
    expect(serialized).not.toContain('user1');
    expect(serialized).not.toContain('pass1');
    expect(serialized).not.toContain('Alpha.m3u8');
    const summary = formatDiagnosticSummary(report);
    expect(summary).toContain('webview=200');
    expect(summary).toContain('Media: playing');
    expect(summary).toContain('channels=0 (network) rendered=1');
    expect(summary).toContain(
      'Media source: type=video/x-matroska canPlayType="" — source skipped without an error event',
    );
    expect(summary).toContain('Codec support: 1/2 playable | rejected: video/x-matroska');
    expect(summary).toContain(
      'Service log: 2 lines, 2026-01-01T00:00:00.000Z to 2026-01-01T00:00:01.000Z | warnings=1 errors=0',
    );
  });

  it('reports catalog counts as unknown when the app exposes no snapshot', () => {
    const summary = formatDiagnosticSummary({
      capturedAt: '2026-01-01T00:00:00.000Z',
      app: {},
      environment: {},
      state: { view: 'view-channels', channelsRendered: 0 },
      playlists: [],
      diagnostics: [],
      logs: [],
      network: [],
    });

    expect(summary).toContain('channels=? rendered=0');
    expect(summary).not.toContain('Codec support');
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
      diagnostics: [],
      network: [],
      logs: [],
    });
    expect(summary).not.toContain('second line');
    expect(summary.length).toBeLessThan(500);
  });

});

describe('diagnostic capture recovery', () => {
  it('returns a marked partial report when CDP closes after the baseline', async () => {
    const listeners = new Map();
    let evaluations = 0;
    const client = {
      closed: false,
      on(method, listener) {
        const current = listeners.get(method) ?? [];
        current.push(listener);
        listeners.set(method, current);
        return () => {};
      },
      async call(method) {
        if (method !== 'Runtime.evaluate') return {};
        evaluations++;
        if (evaluations === 1) {
          return {
            result: {
              value: {
                app: {},
                state: { view: 'view-player', channelsRendered: 4, media: null },
                storage: {},
                environment: { userAgent: 'ua', viewport: '1920x1080' },
                playlists: [],
              },
            },
          };
        }
        for (const listener of listeners.get('Runtime.consoleAPICalled') ?? []) {
          listener({
            type: 'log',
            timestamp: Date.parse('2026-09-10T05:00:00.000Z'),
            args: [{ value: '[Key] Key down event=key.down code=461 action=back target=app' }],
          });
        }
        client.closed = true;
        throw new Error('CDP connection closed');
      },
      close() {
        client.closed = true;
      },
    };
    const options = parseDiagnosticArgs([
      '--host', 'tv',
      '--attach',
      '--duration', '1',
    ]);

    const report = await captureDiagnostics(options, {
      resolveTarget: async () => ({
        target: { title: 'App', description: 'TV app' },
        wsUrl: 'ws://tv/devtools/page/app',
      }),
      connect: async () => client,
      startNativeMetrics: () => ({
        ready: Promise.resolve(),
        result: Promise.resolve({ durationMs: 1000, processes: [] }),
        child: { killed: false, kill() { this.killed = true; } },
      }),
      now: () => new Date('2026-09-10T05:00:01.000Z'),
      execFile: () => '2026-09-10T05:00:00.500Z error [service] failed\n',
    });

    expect(report.serviceLog).toEqual({
      lines: ['2026-09-10T05:00:00.500Z error [service] failed'],
      error: '',
    });
    expect(report.capture).toEqual({
      complete: false,
      phase: 'capturing-final-state',
      error: 'CDP connection closed',
    });
    expect(report.state).toMatchObject({ view: 'view-player', channelsRendered: 4 });
    expect(report.nativeMetrics).toMatchObject({ durationMs: 1000 });
    expect(report.input).toEqual([
      expect.objectContaining({ event: 'key.down' }),
    ]);
    expect(formatDiagnosticSummary(report))
      .toContain('Capture: incomplete at capturing-final-state (CDP connection closed)');
  });
});

describe('legacy engine probes', () => {
  it('lowers a probe for Chromium 53 and polls its parked result', async () => {
    const sent = [];
    let polls = 0;
    const client = {
      async call(method, params) {
        sent.push(params.expression);
        if (sent.length === 1) return { result: { type: 'undefined' } };
        polls++;
        return { result: { value: polls < 2 ? { done: false } : { done: true, value: { view: 'Alpha' } } } };
      },
    };
    const waits = [];

    await expect(evaluateOnLegacyEngine(client, activeProbeExpression, async (ms) => { waits.push(ms); }))
      .resolves.toEqual({ view: 'Alpha' });
    expect(sent[0]).not.toMatch(/\basync\b|\bawait\b|catch \{|\?\.|\?\?/);
    expect(() => new Function(sent[0])).not.toThrow();
    expect(waits).toEqual([100]);
  });

  it('surfaces a probe that rejected on the page', async () => {
    let calls = 0;
    const client = {
      async call() {
        calls++;
        return calls === 1 ? {} : { result: { value: { done: true, error: 'Error: Bravo' } } };
      },
    };

    await expect(evaluateOnLegacyEngine(client, 'Promise.reject(new Error("Bravo"))', async () => {}))
      .rejects.toThrow('Error: Bravo');
  });
});
