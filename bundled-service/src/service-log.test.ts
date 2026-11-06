import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger';
import { installServiceLog, scrubServiceLogText, serviceLogDir } from './service-log';

function harness(maxBytes = 1000, initialSize = 0) {
  const files: { [name: string]: string } = {};
  if (initialSize) files['/t/s.log'] = 'x'.repeat(initialSize);
  const open: { [fd: number]: string } = {};
  const unlinked = new Set<number>();
  let nextFd = 3;
  let clock = Date.UTC(2026, 0, 1);
  const sink = {
    openSync: vi.fn((name: string, flags?: string) => {
      files[name] = flags === 'w' ? '' : files[name] || '';
      open[nextFd] = name;
      return nextFd++;
    }),
    fstatSync: vi.fn((fd: number) => ({
      size: unlinked.has(fd) ? 0 : files[open[fd]].length,
      nlink: unlinked.has(fd) ? 0 : 1,
    })),
    fchmodSync: vi.fn(),
    writeSync: vi.fn((fd: number, data: string) => { if (!unlinked.has(fd)) files[open[fd]] += data; }),
    closeSync: vi.fn((fd: number) => { delete open[fd]; }),
    renameSync: vi.fn((from: string, to: string) => { files[to] = files[from]; delete files[from]; }),
  };
  const printed: string[] = [];
  const target = {
    log: (...args: unknown[]) => { printed.push('log ' + args.join(' ')); },
    info: (...args: unknown[]) => { printed.push('info ' + args.join(' ')); },
    warn: (...args: unknown[]) => { printed.push('warn ' + args.join(' ')); },
    error: (...args: unknown[]) => { printed.push('error ' + args.join(' ')); },
  };
  installServiceLog('/t/s.log', target, sink as never, maxBytes, () => new Date(clock));
  const unlink = (name: string) => {
    delete files[name];
    Object.keys(open).forEach((fd) => { if (open[Number(fd)] === name) unlinked.add(Number(fd)); });
  };
  const log = createLogger('a', target);
  return { files, sink, printed, target, log, unlink, advance: (ms: number) => { clock += ms; } };
}

describe('service log', () => {
  it('writes where the developer shell looks for each Node major', () => {
    expect(serviceLogDir('0.12.2')).toBe('/tmp');
    expect(serviceLogDir('16.20.2')).toBe('/tmp');
    expect(serviceLogDir('20.12.2')).toBe('/media/developer/temp');
    expect(serviceLogDir('22.1.0')).toBe('/media/developer/temp');
  });

  it('keeps logger lines and every warning, skipping framework chatter', () => {
    const { files, printed, target } = harness();

    createLogger('fetch', target).info('fetchManifest outcome=ok');
    target.log('creating activity');
    target.log('[x] bracketed but not ours');
    target.warn('a client attempted to add a subscription');
    target.error('[service] failed', 7);

    expect(files['/t/s.log']).toBe([
      '2026-01-01T00:00:00.000Z log [fetch] fetchManifest outcome=ok',
      '2026-01-01T00:00:00.000Z warn a client attempted to add a subscription',
      '2026-01-01T00:00:00.000Z error [service] failed 7',
      '',
    ].join('\n'));
    // The console still gets everything.
    expect(printed).toHaveLength(5);
  });

  it('keeps only the scheme and host of a URL', () => {
    expect(scrubServiceLogText(
      '[lan] fetch http://u1:p1@host:8080/live/u1/p1/1.ts?token=t1 failed; https://host2 ok',
    )).toBe('[lan] fetch http://host:8080/... failed; https://host2 ok');
    for (const userinfo of ['u1:p@1', 'u1:p?1', 'u1:p/1', 'u1:p#1']) {
      expect(scrubServiceLogText('get http://' + userinfo + '@host/x done')).toBe('get http://host/... done');
    }
    expect(scrubServiceLogText('http://[::1]:80/a')).toBe('http://[::1]:80/...');

    const { files, target } = harness();
    target.warn('[lan] fetch http://host/get.php?username=u1&password=p1 failed');
    expect(files['/t/s.log']).toContain('fetch http://host/... failed');
    expect(files['/t/s.log']).not.toContain('u1');
  });

  it('masks credential-like values', () => {
    expect(scrubServiceLogText(
      "{ headers: { Authorization: 'Bearer t1', Cookie: 'c1' }, password: 'p1' }",
    )).toBe("{ headers: { Authorization: ***, Cookie: *** }, password: *** }");
    expect(scrubServiceLogText('{"username":"u1","token":"t1","count":2}'))
      .toBe('{"username":***,"token":***,"count":2}');
    expect(scrubServiceLogText('authorization=Basic abc; tokens: 5'))
      .toBe('authorization=***; tokens: 5');
  });

  it('opens the file once for many lines', () => {
    const { sink, log } = harness();

    log.info('one');
    log.info('two');
    log.info('three');

    expect(sink.openSync).toHaveBeenCalledTimes(1);
    expect(sink.openSync).toHaveBeenCalledWith('/t/s.log', 'a', 0o644);
    expect(sink.writeSync).toHaveBeenCalledTimes(3);
  });

  it('makes the file readable past the umask on every open', () => {
    const { sink, log } = harness(60);

    log.info('one');
    log.info('two');

    expect(sink.openSync).toHaveBeenCalledTimes(2);
    expect(sink.fchmodSync).toHaveBeenCalledTimes(2);
    expect(sink.fchmodSync).toHaveBeenCalledWith(3, 0o644);
  });

  it('truncates instead of stalling when the older copy cannot be replaced', () => {
    const { files, sink, printed, log } = harness(60);
    sink.renameSync.mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'EACCES' });
    });

    log.info('one');
    log.info('two');
    log.info('three');

    expect(files['/t/s.log']).toContain('[a] three');
    expect(files['/t/s.log']).toContain('log rotation failed: EACCES, truncated');
    expect(printed.some(text => text.includes('paused'))).toBe(false);
  });

  it('treats a vanished file at rotation as already rotated', () => {
    const { files, sink, printed, unlink, log } = harness(60);
    log.info('one');
    unlink('/t/s.log');
    sink.renameSync.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });

    log.info('two');

    expect(files['/t/s.log']).toContain('[a] two');
    expect(printed.some(text => text.includes('paused'))).toBe(false);
  });

  it('reopens the file after it is deleted', () => {
    const { files, unlink, log } = harness(1000 * 1000);
    log.info('first');
    unlink('/t/s.log');

    for (let i = 0; i < 64; i++) log.info('line ' + i);

    expect(files['/t/s.log']).toContain('[a] line 63');
  });

  it('cuts an oversized line', () => {
    const { files, target } = harness(100 * 1000);

    target.error('[a] ' + 'x'.repeat(20 * 1024));

    expect(files['/t/s.log'].length).toBeLessThan(8 * 1024 + 100);
    expect(files['/t/s.log']).toContain('x ...[truncated]\n');
  });

  it('rotates to one older copy when the file would pass the cap', () => {
    const line = '2026-01-01T00:00:00.000Z log [a] ' + 'x'.repeat(30) + '\n';
    const { files, sink, log } = harness(line.length * 2);

    log.info('' + 'x'.repeat(30));
    log.info('' + 'x'.repeat(30));
    log.info('' + 'y'.repeat(30));

    expect(files['/t/s.log.1']).toBe(line + line);
    expect(files['/t/s.log']).toContain('yyy');
    expect(sink.closeSync).toHaveBeenCalledTimes(1);
  });

  it('counts an existing file toward the cap', () => {
    const { sink, log } = harness(100, 90);

    log.info('b');
    log.info('c');

    expect(sink.renameSync).toHaveBeenCalledWith('/t/s.log', '/t/s.log.1');
  });

  it('pauses after a failure, says so once, and resumes a minute later', () => {
    const { files, sink, printed, advance, log } = harness();
    const fail = () => { throw Object.assign(new Error('nope'), { code: 'ENOSPC' }); };
    sink.openSync.mockImplementationOnce(fail);

    log.info('one');
    log.info('two');
    advance(59 * 1000);
    log.info('three');
    advance(1000);
    log.info('four');

    expect(sink.openSync).toHaveBeenCalledTimes(2);
    expect(printed.filter(text => text.includes('log file paused'))).toEqual([
      'warn [service] log file paused: ENOSPC',
    ]);
    expect(files['/t/s.log']).toBe([
      '2026-01-01T00:01:00.000Z warn [service] log file resumed, dropped=3',
      '2026-01-01T00:01:00.000Z log [a] four',
      '',
    ].join('\n'));
  });
});
