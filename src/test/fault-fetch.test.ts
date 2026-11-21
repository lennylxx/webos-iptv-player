import { afterEach, describe, expect, it, vi } from 'vitest';
import { faultFetch } from './fault-fetch';

async function readAll(response: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('faultFetch', () => {
  it('answers with a real response that reports the URL it served', async () => {
    const fetch = faultFetch({ 'http://host/a': { status: 404, body: 'gone', headers: { 'content-type': 'text/plain' } } });
    const response = await fetch('http://host/a');

    expect([response.status, response.url, response.headers.get('content-type')]).toEqual([404, 'http://host/a', 'text/plain']);
    expect(await readAll(response)).toBe('gone');
    expect(fetch.calls.map(call => call.url)).toEqual(['http://host/a']);
  });

  it('plays a sequence per URL, repeating its last fault', async () => {
    const fetch = faultFetch({ 'http://host/a': [{ status: 503 }, { body: 'ok' }] });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch('http://host/a')).status);
    expect(statuses).toEqual([503, 200, 200]);
  });

  it('fails a network error and an unrouted URL as an unreachable host', async () => {
    const fetch = faultFetch({ 'http://host/a': { networkError: true } });
    await expect(fetch('http://host/a')).rejects.toBeInstanceOf(TypeError);
    await expect(fetch('http://host/b')).rejects.toBeInstanceOf(TypeError);
  });

  it('never answers a hang until the request is aborted', async () => {
    const fetch = faultFetch({ 'http://host/a': { hang: true } });
    const controller = new AbortController();
    const pending = fetch('http://host/a', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stalls after some bytes until an abort fails the body', async () => {
    const fetch = faultFetch({ 'http://host/a': { body: 'abcdef', stallAfterBytes: 2 } });
    const controller = new AbortController();
    const reader = (await fetch('http://host/a', { signal: controller.signal })).body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe('ab');
    const next = reader.read();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cuts the connection after some bytes', async () => {
    const fetch = faultFetch({ 'http://host/a': { body: 'abcdef', resetAfterBytes: 3 } });
    const reader = (await fetch('http://host/a')).body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe('abc');
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
  });

  it('sends a slow body in timed pieces', async () => {
    vi.useFakeTimers();
    const fetch = faultFetch({ 'http://host/a': { body: 'abcd', chunkSize: 1, chunkDelayMs: 1000 } });
    let text: string | null = null;
    void fetch('http://host/a').then(readAll).then(value => { text = value; });

    await vi.advanceTimersByTimeAsync(2500);
    expect(text).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(text).toBe('abcd');
  });

  it('waits out a delay before the headers', async () => {
    vi.useFakeTimers();
    const fetch = faultFetch({ 'http://host/a': { body: 'ok', delayMs: 500 } });
    let status = 0;
    void fetch('http://host/a').then(response => { status = response.status; });

    await vi.advanceTimersByTimeAsync(499);
    expect(status).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toBe(200);
  });
});
