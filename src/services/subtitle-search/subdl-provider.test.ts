import { describe, it, expect, vi, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createSubdlProvider } from './subdl-provider';

const provider = createSubdlProvider(() => 'k1');

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
function zipResponse(bytes: Uint8Array): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('subdl provider', () => {
  it('is not configured without a key', () => {
    expect(createSubdlProvider(() => '').isConfigured()).toBe(false);
    expect(provider.isConfigured()).toBe(true);
  });

  it('builds a movie search by tmdb id and parses results', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      status: true,
      subtitles: [
        { release_name: 'Rel A', name: 'a.srt', language: 'EN', url: '/subtitle/1-2.zip', hi: false },
        { release_name: 'Rel B', name: 'b.ass', language: 'ZH', url: '/subtitle/3-4.zip', hi: true },
      ],
    }));
    const out = await provider.search({ type: 'movie', title: 'Alpha', tmdbId: '27205', year: 2010 });
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('api_key=k1');
    expect(url).toContain('tmdb_id=27205');
    expect(url).toContain('type=movie');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ providerId: 'subdl', language: 'EN', releaseName: 'Rel A', format: 'srt', id: '/subtitle/1-2.zip' });
    expect(out[1]).toMatchObject({ format: 'ass', hearingImpaired: true });
  });

  it('sends season/episode for episodes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: true, subtitles: [] }));
    await provider.search({ type: 'episode', title: 'Bravo', season: 2, episode: 5 });
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('type=tv');
    expect(url).toContain('season_number=2');
    expect(url).toContain('episode_number=5');
    expect(url).toContain('film_name=Bravo');
  });

  it('downloads a zip and returns the subtitle text', async () => {
    const zip = zipSync({ 'x.srt': strToU8('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhi\n') });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(zipResponse(zip));
    const text = await provider.download({
      providerId: 'subdl', id: '/subtitle/1-2.zip', language: 'EN', releaseName: 'r',
      fileName: 'x.srt', format: 'srt', hearingImpaired: false, downloads: 0,
    });
    expect(text.text).toContain('hi');
    expect(text.format).toBe('srt');
  });
});
