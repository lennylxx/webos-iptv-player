// src/services/subtitle-search/types.ts
export type ProviderId = 'subdl' | 'opensubtitles' | 'assrt';
export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa';

export interface SubtitleQuery {
  type: 'movie' | 'episode';
  imdbId?: string;   // digits only, no "tt"; an episode's are its series'
  tmdbId?: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  manualQuery?: string; // overrides title/ids when set
}

export interface OnlineSubtitleResult {
  providerId: ProviderId;
  id: string;          // provider-native handle passed back to download()
  language: string;    // provider language code/name, as returned
  releaseName: string;
  fileName: string;
  format: SubtitleFormat;
  hearingImpaired: boolean;
  downloads: number;   // 0 when unknown
}

export interface SubtitleText { text: string; format: SubtitleFormat; }

export interface SubtitleProvider {
  id: ProviderId;
  label: string;
  isConfigured(): boolean;
  search(q: SubtitleQuery): Promise<OnlineSubtitleResult[]>;
  download(r: OnlineSubtitleResult): Promise<SubtitleText>;
}

export interface OnlineSubtitleConfig {
  preferredLanguage: string;               // e.g. 'zh', '' = none
  subdl: { apiKey: string };
  assrt: { apiKey: string };
  opensubtitles: { apiKey: string; username: string; password: string; token: string; tokenTs: number };
}

export const EMPTY_ONLINE_CONFIG: OnlineSubtitleConfig = {
  preferredLanguage: '',
  subdl: { apiKey: '' },
  assrt: { apiKey: '' },
  opensubtitles: { apiKey: '', username: '', password: '', token: '', tokenTs: 0 },
};

export interface PickedOnlineSub {
  providerId: ProviderId;
  id: string;
  name: string;
  lang: string;
  format: SubtitleFormat;
}

export function formatFromName(name: string): SubtitleFormat {
  const ext = (name.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (ext === 'vtt' || ext === 'ass' || ext === 'ssa') return ext;
  return 'srt';
}
