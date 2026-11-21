// @vitest-environment jsdom
import { describe, it, expect, beforeEach, onTestFinished, vi } from 'vitest';
import { faultFetch } from '../../test/fault-fetch';
import type { Fault } from '../../test/fault-plan';
import { createSubdlProvider } from './subdl-provider';
import { createAssrtProvider } from './assrt-provider';
import { createOpenSubtitlesProvider } from './opensubtitles-provider';
import type { SubtitleProvider } from './types';
import { StorageService } from '../storage-service';
import { SubtitleSearchService } from './subtitle-search-service';
import { CONFIG } from '../../config';
import type { OnlineSubtitleResult } from './types';

function r(over: Partial<OnlineSubtitleResult>): OnlineSubtitleResult {
  return { providerId: 'subdl', id: 'i', language: 'en', releaseName: 'r', fileName: 'f.srt', format: 'srt', hearingImpaired: false, downloads: 0, ...over };
}

beforeEach(() => { localStorage.clear(); });

describe('subtitleSearchService', () => {
  it('ranks preferred language first, then by downloads', async () => {
    StorageService.setOnlineSubtitleConfig({
      preferredLanguage: 'zh',
      subdl: { apiKey: 'k' },
      assrt: { apiKey: '' },
      opensubtitles: { apiKey: '', username: '', password: '', token: '', tokenTs: 0 },
    });
    const subtitleSearchService = new SubtitleSearchService([
      { id: 'subdl', label: 'SubDL', isConfigured: () => true,
        search: async () => [r({ language: 'en', downloads: 100 }), r({ language: 'zh-CN', downloads: 5 })],
        download: async () => ({ text: 't', format: 'srt' }) },
    ]);
    const out = await subtitleSearchService.search({ type: 'movie', title: 'Alpha' });
    expect(out[0].language).toBe('zh-CN');
    expect(out[1].language).toBe('en');
  });

  it('survives one provider throwing', async () => {
    StorageService.setOnlineSubtitleConfig({
      preferredLanguage: '',
      subdl: { apiKey: 'k' },
      assrt: { apiKey: '' },
      opensubtitles: { apiKey: 'a', username: 'u', password: 'p', token: '', tokenTs: 0 },
    });
    const subtitleSearchService = new SubtitleSearchService([
      { id: 'subdl', label: 'SubDL', isConfigured: () => true,
        search: async () => { throw new Error('boom'); }, download: async () => ({ text: '', format: 'srt' }) },
      { id: 'opensubtitles', label: 'OpenSubtitles', isConfigured: () => true,
        search: async () => [r({ providerId: 'opensubtitles', language: 'en' })],
        download: async () => ({ text: 'ok', format: 'srt' }) },
    ]);
    const out = await subtitleSearchService.search({ type: 'movie', title: 'Alpha' });
    expect(out).toHaveLength(1);
    expect(out[0].providerId).toBe('opensubtitles');
  });

  // Assrt is always "configured" — it falls back to a public token — so an
  // unreachable endpoint must not hold the whole search on "Searching…".
  it('drops a provider that never answers and keeps the rest', async () => {
    vi.useFakeTimers();
    try {
      StorageService.setOnlineSubtitleConfig({
        preferredLanguage: '',
        subdl: { apiKey: 'k' },
        assrt: { apiKey: '' },
        opensubtitles: { apiKey: 'a', username: 'u', password: 'p', token: '', tokenTs: 0 },
      });
      const subtitleSearchService = new SubtitleSearchService([
        { id: 'assrt', label: 'Assrt', isConfigured: () => true,
          search: () => new Promise(() => { /* never settles */ }),
          download: async () => ({ text: '', format: 'srt' }) },
        { id: 'opensubtitles', label: 'OpenSubtitles', isConfigured: () => true,
          search: async () => [r({ providerId: 'opensubtitles', language: 'en' })],
          download: async () => ({ text: 'ok', format: 'srt' }) },
      ]);
      const pending = subtitleSearchService.search({ type: 'movie', title: 'Alpha' });
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.SUBTITLE_SEARCH_TIMEOUT + 1);
      const out = await pending;
      expect(out).toHaveLength(1);
      expect(out[0].providerId).toBe('opensubtitles');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('subtitle providers over a failing server', () => {
  const providers: Array<[string, () => SubtitleProvider]> = [
    ['subdl', () => createSubdlProvider(() => 'k')],
    ['assrt', () => createAssrtProvider(() => '')],
    ['opensubtitles', () => createOpenSubtitlesProvider({
      getApiKey: () => 'AK',
      getCredentials: () => ({ username: 'u', password: 'p' }),
      getToken: () => 'T1',
      setToken: () => undefined,
    })],
  ];
  const faults: Array<[string, Fault, object]> = [
    ['fails', { status: 503 }, { name: 'FetchTextError', status: 503 }],
    ['cannot be reached', { networkError: true }, { name: 'TypeError' }],
    ['cuts its answer off', { body: '{"subtitles":[{"name":"r"}]}', resetAfterBytes: 6 }, { name: 'TypeError' }],
    ['never answers', { hang: true }, { name: 'FetchStopError', reason: 'timeout' }],
  ];
  const cases = providers.flatMap(([id, make]) =>
    faults.map(([name, fault, error]) => [id, name, make, fault, error] as const));

  it.each(cases)('%s finds nothing and fails a download when its server %s', async (id, _name, make, fault, error) => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', faultFetch(() => fault));
    const provider = make();

    let found: unknown = 'pending';
    void provider.search({ type: 'movie', title: 'Alpha' }).then(results => { found = results; });
    const download = provider.download({
      providerId: id as OnlineSubtitleResult['providerId'], id: '1', language: 'l1', releaseName: 'r', fileName: 'f.srt',
      format: 'srt', hearingImpaired: false, downloads: 0,
    });
    const failed = expect(download).rejects.toMatchObject(error);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(found).toEqual([]);
    await failed;
  });
});
