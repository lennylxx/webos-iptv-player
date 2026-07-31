// src/services/subtitle-search/assrt-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAssrtProvider, DEFAULT_ASSRT_TOKEN } from './assrt-provider';

const provider = createAssrtProvider(() => '');

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}
function bytesResponse(bytes: Uint8Array): Response {
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as Response;
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('assrt provider', () => {
  it('is always configured (uses the default token when none supplied)', async () => {
    expect(provider.isConfigured()).toBe(true);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 0, sub: { subs: [] } }));
    await provider.search({ type: 'movie', title: 'Alpha' });
    expect(String(spy.mock.calls[0][0])).toContain(`token=${DEFAULT_ASSRT_TOKEN}`);
  });

  it('builds a title+year query for a movie and maps language + downloads', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      status: 0,
      sub: { subs: [
        { id: 594897, native_name: 'Alpha One', videoname: 'alpha.one', down_count: 7, lang: { desc: '简 双语' } },
        { id: 594898, native_name: 'Alpha Two', videoname: 'alpha.two', lang: { desc: '英' } },
      ] },
    }));
    const out = await provider.search({ type: 'movie', title: 'Alpha', year: 1972 });
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('q=Alpha%201972');
    expect(url).toContain('cnt=15');
    expect(out[0]).toMatchObject({ providerId: 'assrt', id: '594897', language: 'zh-CN', releaseName: 'Alpha One', downloads: 7 });
    expect(out[1].language).toBe('en');
  });

  it('builds a zero-padded SxxEyy query for an episode and drops the series year', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 0, sub: { subs: [] } }));
    await provider.search({ type: 'episode', title: 'Alpha', year: 2008, season: 2, episode: 5 });
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('q=Alpha%20S02E05');
    expect(url).not.toContain('2008');
  });

  it('falls back to the season alone when the episode number is unknown', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 0, sub: { subs: [] } }));
    await provider.search({ type: 'episode', title: 'Alpha', year: 2008, season: 10 });
    expect(String(spy.mock.calls[0][0])).toContain('q=Alpha%20S10');
  });

  it('keeps a manual query verbatim', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 0, sub: { subs: [] } }));
    await provider.search({ type: 'episode', title: 'Alpha', year: 2008, season: 2, episode: 5, manualQuery: 'Bravo S01E01' });
    expect(String(spy.mock.calls[0][0])).toContain('q=Bravo%20S01E01');
  });

  it('falls back to videoname when native_name is an empty string (not just missing)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      status: 0,
      sub: { subs: [{ id: 1, native_name: '', videoname: 'alpha.release.2024', lang: { desc: '双语' } }] },
    }));
    const out = await provider.search({ type: 'movie', title: 'Alpha' });
    expect(out[0].releaseName).toBe('alpha.release.2024');
  });

  it('returns [] for a query shorter than 3 chars and on status != 0', async () => {
    expect(await provider.search({ type: 'movie', title: 'ab' })).toEqual([]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 20001, errmsg: 'invalid token' }));
    expect(await provider.search({ type: 'movie', title: 'Alpha' })).toEqual([]);
  });

  it('downloads the direct filelist file and decodes it', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ status: 0, sub: { subs: [{
        url: 'http://file0/x.rar',
        filelist: [{ url: 'http://file0/onthefly/x.srt?api=1', f: 'x.srt', s: '1KB' }],
      }] } }))
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]))); // 你好 in gb18030
    const out = await provider.download({
      providerId: 'assrt', id: '1', language: 'zh', releaseName: 'r', fileName: 'f', format: 'srt', hearingImpaired: false, downloads: 0,
    });
    expect(out).toEqual({ text: '你好', format: 'srt' });
  });

  it('throws when detail has no downloadable subtitle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 0, sub: { subs: [{ url: 'http://file0/x.rar', filelist: [] }] } }));
    await expect(provider.download({
      providerId: 'assrt', id: '1', language: 'zh', releaseName: 'r', fileName: 'f', format: 'srt', hearingImpaired: false, downloads: 0,
    })).rejects.toThrow();
  });
});
