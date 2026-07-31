import type { SubtitleProvider, SubtitleQuery, OnlineSubtitleResult, SubtitleText } from './types';
import { formatFromName } from './types';
import { fetchWithTimeout } from '../../utils/fetch-helper';
import { firstSubtitleBytesFromZip } from '../../utils/unzip';
import { decodeSubtitleBytes } from '../../utils/subtitle-decode';
import { createLogger } from '../../utils/logger';

const log = createLogger('Assrt');
const BASE = 'https://api.assrt.net/v1';
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

// Public OSS token published in AssrtOSS/mpv-assrt (src/assrt.lua) for OSS
// clients — a shared zero-config fallback, overridden by a user token.
export const DEFAULT_ASSRT_TOKEN = 'tNjXZUnOJWcHznHDyalNMYqqP6IdDdpQ';

// Assrt reports language as Chinese descriptions; map to a code for ranking.
function assrtLang(desc: string): string {
  if (desc.includes('简')) return 'zh-CN';
  if (desc.includes('繁')) return 'zh-TW';
  if (desc.includes('英')) return 'en';
  return 'zh';
}

const strip = (u: string): string => u.split('?')[0].split('#')[0];

const pad2 = (n: number): string => String(n).padStart(2, '0');

// Assrt is a free-text match over the release name. A movie's release name
// carries its own year, so title+year narrows well. A series' release name
// carries the *season's* year, not the series' first-air year, so passing the
// series year matches nothing at all — episodes search by "SxxEyy" instead.
function buildQuery(q: SubtitleQuery): string {
  if (q.manualQuery) return q.manualQuery.trim();
  const parts: string[] = [q.title];
  if (q.type === 'episode') {
    if (q.season != null) parts.push(q.episode != null ? `S${pad2(q.season)}E${pad2(q.episode)}` : `S${pad2(q.season)}`);
  } else if (q.year) {
    parts.push(String(q.year));
  }
  return parts.filter(Boolean).join(' ').trim();
}

export function createAssrtProvider(getApiKey: () => string): SubtitleProvider {
  const token = (): string => getApiKey().trim() || DEFAULT_ASSRT_TOKEN;

  return {
    id: 'assrt',
    label: 'Assrt',
    isConfigured: () => true, // a token always exists (default), so Assrt is always available

    async search(q: SubtitleQuery): Promise<OnlineSubtitleResult[]> {
      const query = buildQuery(q);
      if (query.length < 3) return [];
      try {
        const url = `${BASE}/sub/search?token=${encodeURIComponent(token())}&cnt=15&q=${encodeURIComponent(query)}`;
        const body = await (await fetchWithTimeout(url)).json() as
          { status?: number; sub?: { subs?: Array<Record<string, unknown>> } };
        if (body.status !== 0) return [];
        return (body.sub?.subs ?? []).map((s) => {
          const desc = String((s.lang as { desc?: string } | undefined)?.desc ?? '');
          return {
            providerId: 'assrt' as const,
            id: String(s.id ?? ''),
            language: assrtLang(desc),
            releaseName: String(s.native_name || s.videoname || ''),
            fileName: String(s.videoname ?? ''),
            format: 'srt' as const,
            hearingImpaired: false,
            downloads: Number(s.down_count ?? 0) || 0,
          };
        }).filter((x) => x.id !== '');
      } catch (e) {
        log.warn('search failed:', e);
        return [];
      }
    },

    async download(r: OnlineSubtitleResult): Promise<SubtitleText> {
      const url = `${BASE}/sub/detail?token=${encodeURIComponent(token())}&id=${encodeURIComponent(r.id)}`;
      const body = await (await fetchWithTimeout(url)).json() as
        { sub?: { subs?: Array<{ url?: string; filelist?: Array<{ url?: string; f?: string }> }> } };
      const sub = body.sub?.subs?.[0];
      if (!sub) throw new Error('Assrt: no detail');

      const fetchBytes = async (u: string): Promise<Uint8Array> =>
        new Uint8Array(await (await fetchWithTimeout(u)).arrayBuffer());

      // 1) direct subtitle file from the server-side-extracted filelist
      const direct = (sub.filelist ?? []).find((f) => SUB_EXT.test(strip(String(f.f ?? ''))));
      if (direct?.url) {
        return { text: decodeSubtitleBytes(await fetchBytes(String(direct.url))), format: formatFromName(String(direct.f)) };
      }
      // 2) a single non-archive file
      const archive = strip(String(sub.url ?? ''));
      if (sub.url && SUB_EXT.test(archive)) {
        return { text: decodeSubtitleBytes(await fetchBytes(String(sub.url))), format: formatFromName(archive) };
      }
      // 3) a zip fallback (rare — filelist usually covers it)
      if (sub.url && /\.zip$/i.test(archive)) {
        const file = await firstSubtitleBytesFromZip(await fetchBytes(String(sub.url)));
        if (file) return { text: decodeSubtitleBytes(file.bytes), format: formatFromName(file.name) };
      }
      throw new Error('Assrt: no downloadable subtitle');
    },
  };
}
