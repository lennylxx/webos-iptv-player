import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bufferFrom,
  bufferFromRuntime,
  isSafeInteger,
  mkdirRecursive,
  padStart,
  parseUrl,
  secureRandomInt,
  stringEndsWith,
} from './compat';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withoutMethod<T>(
  owner: object,
  name: string,
  run: () => T,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  Object.defineProperty(owner, name, { configurable: true, value: undefined });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(owner, name, descriptor);
    else delete (owner as Record<string, unknown>)[name];
  }
}

describe('service runtime compatibility', () => {
  it('prefers native methods when they are available', () => {
    const nativePadStart = vi.spyOn(String.prototype, 'padStart')
      .mockReturnValue('native');

    expect(padStart('7', 4, '0')).toBe('native');
    expect(nativePadStart).toHaveBeenCalledWith(4, '0');
  });

  it('falls back when modern String and Number methods are missing', () => {
    const padded = withoutMethod(String.prototype, 'padStart',
      () => padStart('7', 4, '0'));
    const endsWith = withoutMethod(String.prototype, 'endsWith',
      () => stringEndsWith('playlist.m3u', '.m3u'));
    const safe = withoutMethod(Number, 'isSafeInteger',
      () => isSafeInteger(42));
    const unsafe = withoutMethod(Number, 'isSafeInteger',
      () => isSafeInteger(9007199254740992));

    expect({ padded, endsWith, safe, unsafe }).toEqual({
      padded: '0007',
      endsWith: true,
      safe: true,
      unsafe: false,
    });
  });

  it('uses Buffer.from when available and supports the legacy constructor', () => {
    const native = bufferFrom('Alpha', 'utf-8').toString('utf-8');
    const LegacyBuffer = function (value: string, encoding: BufferEncoding): Buffer {
      return Buffer.from(value, encoding);
    } as unknown as {
      new (value: string, encoding: BufferEncoding): Buffer;
    };
    const fallback = bufferFromRuntime('Bravo', 'utf-8', LegacyBuffer)
      .toString('utf-8');

    expect({ native, fallback }).toEqual({ native: 'Alpha', fallback: 'Bravo' });
  });

  it('parses absolute and request URLs through the runtime URL implementation', () => {
    const absolute = parseUrl('https://host/a?token=abc');
    const request = parseUrl('/uploads?name=Alpha%20Bravo', 'http://host:1234');

    expect([absolute.protocol, absolute.hostname, absolute.query('token')])
      .toEqual(['https:', 'host', 'abc']);
    expect([request.pathname, request.query('name')])
      .toEqual(['/uploads', 'Alpha Bravo']);
  });

  it('creates nested directories and generates bounded secure integers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-compat-'));
    tempDirs.push(root);
    const nested = path.join(root, 'a', 'b');

    mkdirRecursive(nested);
    const values = Array.from({ length: 100 }, () => secureRandomInt(10000));

    expect(fs.statSync(nested).isDirectory()).toBe(true);
    expect(values.every(value => value >= 0 && value < 10000)).toBe(true);
  });
});
