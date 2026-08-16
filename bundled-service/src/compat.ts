import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as nodeUrl from 'url';

type NativeUrl = {
  pathname: string;
  protocol: string;
  hostname: string;
  searchParams: { get(name: string): string | null };
};

type NativeUrlConstructor = new (input: string, base?: string) => NativeUrl;

export interface ParsedUrl {
  pathname: string;
  protocol: string;
  hostname: string;
  query(name: string): string | null;
}

function nativeUrlConstructor(): NativeUrlConstructor | undefined {
  return (nodeUrl as unknown as { URL?: NativeUrlConstructor }).URL;
}

export function parseUrl(input: string, base?: string): ParsedUrl {
  const NativeUrl = nativeUrlConstructor();
  if (NativeUrl) {
    const parsed = new NativeUrl(input, base);
    return {
      pathname: parsed.pathname,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      query: (name: string) => parsed.searchParams.get(name),
    };
  }

  const parsed = nodeUrl.parse(base ? nodeUrl.resolve(base, input) : input, true);
  return {
    pathname: parsed.pathname || '/',
    protocol: parsed.protocol || '',
    hostname: parsed.hostname || '',
    query: (name: string) => {
      const value = parsed.query[name];
      if (typeof value === 'string') return value;
      return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
    },
  };
}

type RuntimeBuffer = {
  new (input: string, inputEncoding: BufferEncoding): Buffer;
  from?: (input: string, inputEncoding: BufferEncoding) => Buffer;
};

export function bufferFromRuntime(
  value: string,
  encoding: BufferEncoding,
  NativeBuffer: RuntimeBuffer,
): Buffer {
  return NativeBuffer.from
    ? NativeBuffer.from(value, encoding)
    : new NativeBuffer(value, encoding);
}

export function bufferFrom(value: string, encoding: BufferEncoding): Buffer {
  return bufferFromRuntime(value, encoding, Buffer as unknown as RuntimeBuffer);
}

function randomIntFallback(maxExclusive: number): number {
  const range = 0x100000000;
  const limit = range - (range % maxExclusive);
  let value: number;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return value % maxExclusive;
}

export function secureRandomInt(maxExclusive: number): number {
  const nativeRandomInt = (crypto as unknown as {
    randomInt?: (min: number, max: number) => number;
  }).randomInt;
  return nativeRandomInt
    ? nativeRandomInt(0, maxExclusive)
    : randomIntFallback(maxExclusive);
}

export function mkdirRecursive(dir: string): void {
  if (fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return;
  } catch {
    const parent = path.dirname(dir);
    if (parent !== dir) mkdirRecursive(parent);
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      if (!fs.existsSync(dir)) throw error;
    }
  }
}

export function padStart(value: string, length: number, fill: string): string {
  const nativePadStart = (value as unknown as {
    padStart?: (targetLength: number, padString: string) => string;
  }).padStart;
  if (nativePadStart) return nativePadStart.call(value, length, fill);
  if (value.length >= length || !fill) return value;
  let padding = '';
  while (padding.length < length - value.length) padding += fill;
  return padding.slice(0, length - value.length) + value;
}

export function stringEndsWith(value: string, search: string): boolean {
  const nativeEndsWith = (value as unknown as {
    endsWith?: (searchString: string) => boolean;
  }).endsWith;
  return nativeEndsWith
    ? nativeEndsWith.call(value, search)
    : value.slice(-search.length) === search;
}

export function isSafeInteger(value: number): boolean {
  const nativeIsSafeInteger = (Number as unknown as {
    isSafeInteger?: (candidate: number) => boolean;
  }).isSafeInteger;
  return nativeIsSafeInteger
    ? nativeIsSafeInteger(value)
    : isFinite(value) && Math.floor(value) === value &&
      Math.abs(value) <= 9007199254740991;
}
