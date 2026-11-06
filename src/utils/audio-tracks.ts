import type { AudioOption, AudioPref, ManifestAudio } from '../types';
import { t } from '../i18n';
import { languageKey } from './subtitle-tracks';

// The hls.js audio-track fields we read, structural to avoid an hls.js type dep.
export interface HlsAudioTrackLike {
  name?: string;
  lang?: string;
  default?: boolean;
}

/** Display label for a rendition: its name, then language, then a positional fallback. */
export function audioLabel(opt: AudioOption): string {
  return opt.name || opt.lang || t('player.audioFallback', { number: opt.index + 1 });
}

/** Normalize hls.js renditions. `currentIdx` is hls.audioTrack (the active one). */
export function hlsAudioOptions(tracks: readonly HlsAudioTrackLike[], currentIdx: number): AudioOption[] {
  return tracks.map((t, index) => ({
    index,
    name: t.name || '',
    lang: t.lang || '',
    isDefault: !!t.default, // hls.js parses the manifest DEFAULT flag
    active: index === currentIdx,
  }));
}

/** Normalize the native HTMLMediaElement.audioTracks list. */
export function nativeAudioOptions(list: AudioTrackList): AudioOption[] {
  return Array.from({ length: list.length }, (_, i) => {
    const t = list[i];
    const lang = t.language && t.language !== 'und' ? t.language : '';
    // The native API exposes no manifest DEFAULT; the UA's pick stands in.
    return { index: i, name: t.label || '', lang, isDefault: t.enabled, active: t.enabled };
  });
}

/** Pick a track index for `options`, preferring `pref` (name then language), else the default. */
export function chooseAudioIndex(options: AudioOption[], pref: AudioPref | null): number {
  if (!options.length) return -1;
  if (pref) {
    const byName = pref.name && options.find(o => o.name.toLowerCase() === pref.name.toLowerCase());
    if (byName) return byName.index;
    const byLang = pref.lang && (options.find(o => o.lang.toLowerCase() === pref.lang.toLowerCase())
      ?? options.find(o => sameLanguageCode(o.lang, pref.lang)));
    if (byLang) return byLang.index;
  }
  return (options.find(o => o.isDefault) ?? options[0]).index;
}

/** Whether `pref` actually matched `opt` (vs. falling back to the stream default). */
export function isPrefMatch(opt: AudioOption | undefined, pref: AudioPref | null): boolean {
  return !!pref && !!opt
    && ((!!pref.name && opt.name.toLowerCase() === pref.name.toLowerCase())
      || (!!pref.lang && (opt.lang.toLowerCase() === pref.lang.toLowerCase()
        || sameLanguageCode(opt.lang, pref.lang))));
}

// Luna reports ISO 639-2 codes (ger/deu) where a manifest says de; a regional
// code still needs an exact match.
function sameLanguageCode(a: string, b: string): boolean {
  if (/[-_]/.test(a) || /[-_]/.test(b)) return false;
  const key = languageKey(a);
  return !!key && key === languageKey(b);
}

// Parse the EXT-X-MEDIA:TYPE=AUDIO renditions from an HLS master playlist, in
// declaration order, deduped by name+language (some manifests repeat the audio
// group per quality tier). webOS native exposes these tracks with empty
// name/language, so the manifest is the only source of real names on-device.
export function parseAudioRenditions(manifest: string): ManifestAudio[] {
  const out: ManifestAudio[] = [];
  const seen = new Set<string>();
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO(?:,|$)/.test(line)) continue;
    // Anchor each attribute on a `:`/`,` so LANGUAGE doesn't match ASSOC-LANGUAGE.
    const attr = (k: string): string => line.match(new RegExp(`[:,]${k}="([^"]*)"`))?.[1] ?? '';
    const name = attr('NAME');
    const lang = attr('LANGUAGE');
    const key = JSON.stringify([name, lang]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, lang, isDefault: /[:,]DEFAULT=YES(?:,|$)/.test(line) });
  }
  return out;
}

/** Overlay manifest names/languages onto native track options, by index. Only
 *  applies when the counts line up, so a collapsed native list isn't mislabelled. */
export function mergeManifestNames(opts: AudioOption[], manifest: ManifestAudio[]): AudioOption[] {
  if (!manifest.length || manifest.length !== opts.length) return opts;
  return opts.map((o, i) => ({
    ...o,
    name: manifest[i].name || o.name,
    lang: manifest[i].lang || o.lang,
  }));
}

export type LunaAudioNaming =
  'manifest' | 'order' | 'no_manifest' | 'count_mismatch' | 'lang_mismatch';

/**
 * Pairs UMS's audio list (languages only) with the manifest's renditions: by
 * language, in order among same-language renditions; by position when UMS
 * lists no language at all (webOS 4). Null with the reason when the two can't
 * be paired one-to-one.
 */
export function mapLunaAudio(
  luna: ReadonlyArray<{ language: string }>,
  manifest: ManifestAudio[],
): { renditions: ManifestAudio[] | null; naming: LunaAudioNaming } {
  if (!manifest.length) return { renditions: null, naming: 'no_manifest' };
  if (manifest.length !== luna.length) return { renditions: null, naming: 'count_mismatch' };
  if (luna.every(track => !track.language)) return { renditions: manifest.slice(), naming: 'order' };
  const used = new Set<number>();
  const renditions: ManifestAudio[] = [];
  for (const track of luna) {
    const key = languageKey(track.language);
    const match = manifest.findIndex((item, i) => !used.has(i) && languageKey(item.lang) === key);
    if (match < 0) return { renditions: null, naming: 'lang_mismatch' };
    used.add(match);
    renditions.push(manifest[match]);
  }
  return { renditions, naming: 'manifest' };
}
