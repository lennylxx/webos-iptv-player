import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpenSubtitlesProvider } from './opensubtitles-provider';

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

let token = '';
const provider = createOpenSubtitlesProvider({
  getApiKey: () => 'AK',
  getCredentials: () => ({ username: 'u', password: 'p' }),
  getToken: () => token,
  setToken: (t) => { token = t; },
});

beforeEach(() => { token = ''; vi.restoreAllMocks(); });

describe('opensubtitles provider', () => {
  it('needs api key + credentials to be configured', () => {
    expect(createOpenSubtitlesProvider({
      getApiKey: () => '', getCredentials: () => ({ username: 'u', password: 'p' }),
      getToken: () => '', setToken: () => {},
    }).isConfigured()).toBe(false);
    expect(provider.isConfigured()).toBe(true);
  });

  it('searches with Api-Key header and parses file results', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(200, {
      data: [{ attributes: {
        language: 'zh-CN', release: 'Rel', download_count: 42, hearing_impaired: false,
        files: [{ file_id: 991, file_name: 'sub.srt' }],
      } }],
    }));
    const out = await provider.search({ type: 'movie', title: 'Alpha', tmdbId: '27205' });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('tmdb_id=27205');
    expect((init as RequestInit).headers).toMatchObject({ 'Api-Key': 'AK' });
    expect(out[0]).toMatchObject({ providerId: 'opensubtitles', id: '991', language: 'zh-CN', downloads: 42, format: 'srt' });
  });

  it('logs in then downloads the raw link', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(res(200, { token: 'T1' }))
      .mockResolvedValueOnce(res(200, { link: 'http://host/s.srt' }))
      .mockResolvedValueOnce(new Response('CUE', { status: 200 }));
    const text = await provider.download({
      providerId: 'opensubtitles', id: '991', language: 'zh-CN', releaseName: 'r',
      fileName: 'sub.srt', format: 'srt', hearingImpaired: false, downloads: 0,
    });
    expect(text.text).toBe('CUE');
    expect(token).toBe('T1');
    expect(String(spy.mock.calls[0][0])).toContain('/login');
  });

  it('re-logins once on a 401 download', async () => {
    token = 'STALE';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(res(401, { message: 'expired' }))
      .mockResolvedValueOnce(res(200, { token: 'T2' }))
      .mockResolvedValueOnce(res(200, { link: 'http://host/s.srt' }))
      .mockResolvedValueOnce(new Response('CUE2', { status: 200 }));
    const text = await provider.download({
      providerId: 'opensubtitles', id: '991', language: 'zh-CN', releaseName: 'r',
      fileName: 'sub.srt', format: 'srt', hearingImpaired: false, downloads: 0,
    });
    expect(text.text).toBe('CUE2');
    expect(token).toBe('T2');
  });
});
