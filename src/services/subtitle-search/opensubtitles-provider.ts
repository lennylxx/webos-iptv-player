import type { SubtitleProvider, SubtitleQuery, OnlineSubtitleResult, SubtitleText } from './types';
import { formatFromName } from './types';
import { FetchTextError, fetchWithTimeout } from '../../utils/fetch-helper';
import { createLogger } from '../../utils/logger';

const log = createLogger('OpenSubs');
const BASE = 'https://api.opensubtitles.com/api/v1';

export interface OsProviderConfig {
  getApiKey: () => string;
  getCredentials: () => { username: string; password: string };
  getToken: () => string;
  setToken: (token: string) => void;
}

export function createOpenSubtitlesProvider(cfg: OsProviderConfig): SubtitleProvider {
  const headers = (): Record<string, string> => ({ 'Api-Key': cfg.getApiKey(), 'Content-Type': 'application/json' });

  async function login(): Promise<string> {
    const { username, password } = cfg.getCredentials();
    const res = await fetchWithTimeout(`${BASE}/login`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ username, password }),
    });
    const body = await res.json() as { token?: string };
    const token = body.token ?? '';
    cfg.setToken(token);
    return token;
  }

  return {
    id: 'opensubtitles',
    label: 'OpenSubtitles',
    isConfigured: () => {
      const { username, password } = cfg.getCredentials();
      return cfg.getApiKey().trim() !== '' && username.trim() !== '' && password.trim() !== '';
    },

    async search(q: SubtitleQuery): Promise<OnlineSubtitleResult[]> {
      const p = new URLSearchParams();
      p.set('type', q.type);
      if (q.manualQuery) p.set('query', q.manualQuery);
      else if (q.imdbId) p.set('imdb_id', q.imdbId);
      else if (q.tmdbId) p.set('tmdb_id', q.tmdbId);
      else p.set('query', q.title);
      if (q.type === 'episode') {
        if (q.season != null) p.set('season_number', String(q.season));
        if (q.episode != null) p.set('episode_number', String(q.episode));
      }
      try {
        const res = await fetchWithTimeout(`${BASE}/subtitles?${p.toString()}`, { headers: headers() });
        const body = await res.json() as { data?: Array<{ attributes?: Record<string, unknown> }> };
        const out: OnlineSubtitleResult[] = [];
        for (const d of body.data ?? []) {
          const a = d.attributes ?? {};
          const files = (a.files as Array<{ file_id?: number; file_name?: string }> | undefined) ?? [];
          const f = files[0];
          if (!f?.file_id) continue;
          const fileName = String(f.file_name ?? '');
          out.push({
            providerId: 'opensubtitles',
            id: String(f.file_id),
            language: String(a.language ?? ''),
            releaseName: String(a.release ?? fileName),
            fileName,
            format: formatFromName(fileName),
            hearingImpaired: a.hearing_impaired === true,
            downloads: Number(a.download_count ?? 0) || 0,
          });
        }
        return out;
      } catch (e) {
        log.warn('search failed:', e);
        return [];
      }
    },

    async download(r: OnlineSubtitleResult): Promise<SubtitleText> {
      const request = (token: string): Promise<Response> =>
        fetchWithTimeout(`${BASE}/download`, {
          method: 'POST',
          headers: { ...headers(), Authorization: `Bearer ${token}` },
          body: JSON.stringify({ file_id: Number(r.id) }),
        });

      let token = cfg.getToken() || await login();
      let res: Response;
      try {
        res = await request(token);
      } catch (e) {
        // Only an expired token is worth a fresh login; anything else would just
        // repeat the wait on a server that is down.
        if (!(e instanceof FetchTextError) || e.status !== 401) throw e;
        token = await login();
        res = await request(token);
      }
      const body = await res.json() as { link?: string };
      if (!body.link) throw new Error('OpenSubtitles: no download link');
      const linkRes = await fetchWithTimeout(body.link);
      return { text: await linkRes.text(), format: r.format };
    },
  };
}
