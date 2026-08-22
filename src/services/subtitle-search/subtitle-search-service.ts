import type { SubtitleProvider, SubtitleQuery, OnlineSubtitleResult, SubtitleText } from './types';
import { StorageService } from '../storage-service';
import { CONFIG } from '../../config';
import { createSubdlProvider } from './subdl-provider';
import { createOpenSubtitlesProvider } from './opensubtitles-provider';
import { createAssrtProvider } from './assrt-provider';
import { createLogger } from '../../utils/logger';

const log = createLogger('SubSearch');

function buildProviders(): SubtitleProvider[] {
  const subdl = createSubdlProvider(() => StorageService.getOnlineSubtitleConfig().subdl.apiKey);
  const os = createOpenSubtitlesProvider({
    getApiKey: () => StorageService.getOnlineSubtitleConfig().opensubtitles.apiKey,
    getCredentials: () => {
      const o = StorageService.getOnlineSubtitleConfig().opensubtitles;
      return { username: o.username, password: o.password };
    },
    getToken: () => StorageService.getOnlineSubtitleConfig().opensubtitles.token,
    setToken: (token) => {
      const cfg = StorageService.getOnlineSubtitleConfig();
      cfg.opensubtitles.token = token;
      cfg.opensubtitles.tokenTs = Date.now();
      StorageService.setOnlineSubtitleConfig(cfg);
    },
  });
  const assrt = createAssrtProvider(() => StorageService.getOnlineSubtitleConfig().assrt.apiKey);
  return [os, subdl, assrt]; // order defines the tie-break precedence
}

function langMatches(resultLang: string, preferred: string): boolean {
  if (!preferred) return false;
  const base = (s: string) => s.toLowerCase().split('-')[0];
  return base(resultLang) === base(preferred);
}

// The providers are searched together, so the slowest one decides when results
// appear. Assrt in particular is always "configured" (it has a default token),
// so an unreachable endpoint would otherwise hold the overlay on "Searching…"
// for the whole 30s fetch timeout while the others already have answers.
function withTimeout(
  run: () => Promise<OnlineSubtitleResult[]>,
  id: string,
): Promise<OnlineSubtitleResult[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn(id, 'search timed out after', CONFIG.PLAYER.SUBTITLE_SEARCH_TIMEOUT, 'ms');
      resolve([]);
    }, CONFIG.PLAYER.SUBTITLE_SEARCH_TIMEOUT);
    const done = (results: OnlineSubtitleResult[]) => { clearTimeout(timer); resolve(results); };
    const failed = (e: unknown) => { clearTimeout(timer); log.warn(id, 'search failed:', e); resolve([]); };
    try { run().then(done, failed); } catch (e) { failed(e); }
  });
}

export class SubtitleSearchService {
  constructor(private readonly providers: SubtitleProvider[] = buildProviders()) {}

  private configured(): SubtitleProvider[] { return this.providers.filter((p) => p.isConfigured()); }

  isAvailable(): boolean { return this.configured().length > 0; }

  preferredLanguage(): string { return StorageService.getOnlineSubtitleConfig().preferredLanguage; }

  async search(q: SubtitleQuery): Promise<OnlineSubtitleResult[]> {
    const providers = this.configured();
    if (!providers.length) { log.info('online search skipped — no providers configured'); return []; }
    const settled = await Promise.all(providers.map((p) => withTimeout(() => p.search(q), p.id)));
    const merged = settled.reduce<OnlineSubtitleResult[]>((acc, arr) => acc.concat(arr), []);
    const pref = this.preferredLanguage();
    const rank = (x: OnlineSubtitleResult) => (langMatches(x.language, pref) ? 0 : 1);
    const providerOrder = (x: OnlineSubtitleResult) => this.providers.findIndex((p) => p.id === x.providerId);
    const results = merged.sort((a, b) => rank(a) - rank(b) || b.downloads - a.downloads || providerOrder(a) - providerOrder(b));
    log.info('online search:', results.length, 'result(s) from', providers.length, 'provider(s)');
    return results;
  }

  download(r: OnlineSubtitleResult): Promise<SubtitleText> {
    const p = this.providers.find((x) => x.id === r.providerId);
    if (!p) return Promise.reject(new Error(`no provider ${r.providerId}`));
    log.info('downloading subtitle from', r.providerId, '|', r.language || '?');
    return p.download(r);
  }
}

export const subtitleSearchService = new SubtitleSearchService();
