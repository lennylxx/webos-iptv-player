// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
