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

  it('searches an episode by its series ids', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(200, { data: [] }));
    await provider.search({ type: 'episode', title: 'Alpha', imdbId: '123', season: 1, episode: 2 });
    await provider.search({ type: 'episode', title: 'Alpha', tmdbId: '456', season: 1, episode: 2 });
    const first = new URL(String(spy.mock.calls[0][0])).searchParams;
    expect(first.get('parent_imdb_id')).toBe('123');
    expect(first.get('imdb_id')).toBeNull();
    expect(first.get('season_number')).toBe('1');
    expect(new URL(String(spy.mock.calls[1][0])).searchParams.get('parent_tmdb_id')).toBe('456');
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

  it('fails a download the server refuses for another reason without logging in again', async () => {
    token = 'T1';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(503, { message: 'busy' }));
    await expect(provider.download({
      providerId: 'opensubtitles', id: '991', language: 'zh-CN', releaseName: 'r',
      fileName: 'sub.srt', format: 'srt', hearingImpaired: false, downloads: 0,
    })).rejects.toThrow('HTTP 503');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(token).toBe('T1');
  });
});
