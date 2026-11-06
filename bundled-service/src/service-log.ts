import * as fs from 'fs';
import * as util from 'util';
import { isLoggerEmitting } from './logger';

const MAX_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 8 * 1024;
const RETRY_MS = 60 * 1000;
// How many writes pass between checks that the file was not deleted.
const UNLINK_CHECK_EVERY = 64;
const LEVELS = ['log', 'info', 'warn', 'error'];
// Userinfo runs to the last '@' of the token, since providers hand out
// passwords with unescaped '@', '/', or '?'.
const URL_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:\S*@)?((?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d+)?)?(\S*)/gi;
const SECRET_PATTERN =
  /\b((?:proxy-)?authorization|(?:set-)?cookie|password|passwd|username|token|secret|api[_-]?key)(["']?\s*[:=]\s*)(?:(?:bearer|basic|digest)\s+)?("[^"]*"|'[^']*'|[^\s,;&}]+)/gi;

type LogSink = Pick<
  typeof fs,
  'openSync' | 'writeSync' | 'closeSync' | 'fstatSync' | 'fchmodSync' | 'renameSync'
>;
type LogTarget = { [level: string]: unknown };

// The developer shell reads this file; scripts/tv-logs.mjs and
// scripts/tv-diag.mjs mirror the rule.
export function serviceLogDir(nodeVersion: string): string {
  return Number(nodeVersion.split('.')[0]) >= 20 ? '/media/developer/temp' : '/tmp';
}

// The file is world-readable, and playlist URLs carry credentials in their
// userinfo, path, or query; keep only the scheme and host, and mask values
// of credential-like keys.
export function scrubServiceLogText(text: string): string {
  return text
    .replace(URL_PATTERN, (_match, scheme: string, host: string | undefined, rest: string) =>
      scheme + (host || '') + (rest ? '/...' : ''))
    .replace(SECRET_PATTERN, (_match, key: string, separator: string) => key + separator + '***');
}

// Copies the service's createLogger lines, and every warning and error,
// into a file that `tv.sh logs --service` and `tv.sh diag` read. The webOS
// journal is closed to the developer shell. One rotated copy caps it at 2x maxBytes.
export function installServiceLog(
  file: string,
  target: LogTarget = console as unknown as LogTarget,
  sink: LogSink = fs,
  maxBytes: number = MAX_BYTES,
  now: () => Date = () => new Date(),
): void {
  let fd: number | null = null;
  let size = 0;
  let writes = 0;
  let retryAt = 0;
  let dropped = 0;
  const originals: { [level: string]: (...args: unknown[]) => void } = {};

  const close = () => {
    if (fd === null) return;
    try { sink.closeSync(fd); } catch (e) { /* already gone */ }
    fd = null;
  };
  const open = (flags: string) => {
    fd = sink.openSync(file, flags, 0o644);
    // The developer shell runs as another uid; the umask or an older file
    // could otherwise keep it out.
    try { sink.fchmodSync(fd, 0o644); } catch (e) { /* not the owner */ }
    size = sink.fstatSync(fd).size;
  };
  // Returns a note to log when rotation could not keep the older copy.
  const rotate = (): string => {
    close();
    try {
      sink.renameSync(file, file + '.1');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code || String(e);
      if (code === 'ENOENT') return '';
      open('w');
      return 'warn [service] log rotation failed: ' + code + ', truncated';
    }
    return '';
  };
  const append = (stamp: string, line: string) => {
    const bytes = Buffer.byteLength(line);
    if (fd !== null && ++writes % UNLINK_CHECK_EVERY === 0 && sink.fstatSync(fd).nlink === 0) close();
    if (fd === null) open('a');
    if (size > 0 && size + bytes > maxBytes) {
      const note = rotate();
      if (fd === null) open('a');
      if (note) append(stamp, stamp + ' ' + note + '\n');
    }
    sink.writeSync(fd as number, line);
    size += bytes;
  };

  const write = (level: string, args: unknown[]) => {
    if ((level === 'log' || level === 'info') && !isLoggerEmitting()) return;
    let text = util.format.apply(util, args as [unknown, ...unknown[]]);
    const date = now();
    if (date.getTime() < retryAt) { dropped++; return; }
    if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + ' ...[truncated]';
    const stamp = date.toISOString();
    try {
      if (dropped) {
        append(stamp, stamp + ' warn [service] log file resumed, dropped=' + dropped + '\n');
        dropped = 0;
      }
      append(stamp, stamp + ' ' + level + ' ' + scrubServiceLogText(text) + '\n');
      retryAt = 0;
    } catch (e) {
      close();
      dropped++;
      if (!retryAt) {
        originals.warn.call(target, '[service] log file paused: ' +
          ((e as NodeJS.ErrnoException).code || String(e)));
      }
      retryAt = date.getTime() + RETRY_MS;
    }
  };

  LEVELS.forEach((level) => {
    const original = target[level] as (...args: unknown[]) => void;
    originals[level] = original;
    target[level] = function () {
      const args = Array.prototype.slice.call(arguments);
      original.apply(target, args);
      write(level, args);
    };
  });
}
