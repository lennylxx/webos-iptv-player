import type { SubtitleOption, SubtitlePref, ManifestSubtitle, ManifestClosedCaption } from '../types';
import { CONFIG } from '../config';
import ISO6391 from 'iso-639-1';
import { iso6392BTo1 } from 'iso-639-2/2b-to-1';
import { iso6392TTo1 } from 'iso-639-2/2t-to-1';
import { t } from '../i18n';

// The hls.js subtitle-track fields we read, structural to avoid an hls.js type dep.
export interface HlsSubtitleTrackLike {
  name?: string;
  lang?: string;
  default?: boolean;
  forced?: boolean;
}

// Endonym for a language code (so a NAME-less track reads "Deutsch", not "de"), via
// `iso-639-1` (2-letter native names) + `iso-639-2` to fold 3-letter codes (deu/ger → de).
// Anything unknown falls through to the raw code. The TV's fonts render these scripts —
// `LG Smart UI` covers Latin/Cyrillic/Greek/Korean directly, `LG Display` (system fallback)
// covers CJK/Arabic/Hebrew/Thai — 中文 confirmed on-device.
export function languageName(lang: string): string {
  const code = lang.toLowerCase().split('-')[0];
  const two = code.length === 3 ? (iso6392BTo1[code] || iso6392TTo1[code]) : code;
  return (two && ISO6391.getNativeName(two)) || lang;
}

/** Display label for a subtitle: its name, then the language (as an endonym when known),
 *  then a positional fallback. */
export function subtitleLabel(opt: SubtitleOption): string {
  if (opt.name) return opt.name;
  if (opt.lang) return languageName(opt.lang);
  return t('player.subtitleFallback', { number: opt.index + 1 });
}

/** Normalize hls.js subtitle renditions. `currentIdx` is hls.subtitleTrack (-1 = off). */
export function hlsSubtitleOptions(tracks: readonly HlsSubtitleTrackLike[], currentIdx: number): SubtitleOption[] {
  return tracks.map((t, index) => ({
    index,
    name: t.name || '',
    lang: t.lang || '',
    isDefault: !!t.default,
    isForced: !!t.forced,
    active: index === currentIdx,
  }));
}

/** Picker options from the parsed HLS master subtitle renditions, used on the
 *  webOS native path where in-manifest WebVTT is self-rendered rather than
 *  surfaced as switchable textTracks. `activeIndex` is the rendition currently
 *  self-rendered (-1 = off). */
export function manifestSubtitleOptions(manifest: readonly ManifestSubtitle[], activeIndex: number): SubtitleOption[] {
  return manifest.map((m, i) => ({
    index: i,
    name: m.name,
    lang: m.lang,
    isDefault: m.isDefault,
    isForced: m.isForced,
    active: i === activeIndex,
  }));
}

/** Picker options from the native `HTMLMediaElement.textTracks` — the VOD path,
 *  where in-container subtitles surface as switchable text tracks. Only
 *  subtitle/caption kinds are kept (chapters/metadata are ignored), each carrying
 *  its original textTracks index so a pick maps straight back to the list. The
 *  active one is whichever has `mode === 'showing'`. */
export function nativeSubtitleOptions(list: TextTrackList): SubtitleOption[] {
  const out: SubtitleOption[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
    const lang = t.language && t.language !== 'und' ? t.language : '';
    out.push({ index: i, name: t.label || '', lang, isDefault: false, isForced: false, active: t.mode === 'showing' });
  }
  return out;
}

/** Pick a subtitle index for `options`, or -1 for off. Honors an explicit "off"
 *  pref, else matches by name then language; with no usable pref the stream
 *  default is the forced track if any, otherwise off (subtitles stay off). */
export function chooseSubtitleIndex(options: SubtitleOption[], pref: SubtitlePref | null): number {
  if (pref) {
    if (pref.off) return -1;
    const byName = pref.name && options.find(o => o.name.toLowerCase() === pref.name.toLowerCase());
    if (byName) return byName.index;
    const byLang = pref.lang && options.find(o => o.lang.toLowerCase() === pref.lang.toLowerCase());
    if (byLang) return byLang.index;
  }
  const forced = options.find(o => o.isForced);
  return forced ? forced.index : -1;
}

/** Whether `pref` actually matched `opt` by name/language (vs. off / a fallback). */
export function isSubtitlePrefMatch(opt: SubtitleOption | undefined, pref: SubtitlePref | null): boolean {
  return !!pref && !pref.off && !!opt
    && ((!!pref.name && opt.name.toLowerCase() === pref.name.toLowerCase())
      || (!!pref.lang && opt.lang.toLowerCase() === pref.lang.toLowerCase()));
}

// Parse the EXT-X-MEDIA:TYPE=SUBTITLES renditions from an HLS master playlist, in
// declaration order, deduped by name+language. Native textTracks can expose these
// with empty name/language, so the manifest is the source of real names on-device.
export function parseSubtitleRenditions(manifest: string): ManifestSubtitle[] {
  const out: ManifestSubtitle[] = [];
  const seen = new Set<string>();
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES(?:,|$)/.test(line)) continue;
    // Anchor each attribute on a `:`/`,` (+ optional space) so LANGUAGE doesn't match
    // ASSOC-LANGUAGE and a packager's `, NAME="…"` spacing doesn't drop the value.
    const attr = (k: string): string => line.match(new RegExp(`[:,]\\s*${k}="([^"]*)"`))?.[1] ?? '';
    const name = attr('NAME');
    const lang = attr('LANGUAGE');
    const key = JSON.stringify([name, lang]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      lang,
      isDefault: /[:,]DEFAULT=YES(?:,|$)/.test(line),
      isForced: /[:,]FORCED=YES(?:,|$)/.test(line),
    });
  }
  return out;
}

// Parse the EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS declarations from an HLS master, in
// order, deduped by INSTREAM-ID (CC1-4 = CEA-608, SERVICE1-63 = CEA-708). Unlike
// SUBTITLES these have no URI — they ride inside the video ES — so the manifest is
// the only place the app can learn a stream advertises captions.
export function parseClosedCaptions(manifest: string): ManifestClosedCaption[] {
  const out: ManifestClosedCaption[] = [];
  const seen = new Set<string>();
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=CLOSED-CAPTIONS(?:,|$)/.test(line)) continue;
    const attr = (k: string): string => line.match(new RegExp(`[:,]\\s*${k}="([^"]*)"`))?.[1] ?? '';
    const instreamId = attr('INSTREAM-ID');
    const name = attr('NAME');
    const lang = attr('LANGUAGE');
    const key = JSON.stringify([name, lang, instreamId]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, lang, instreamId, isDefault: /[:,]DEFAULT=YES(?:,|$)/.test(line) });
  }
  return out;
}

/** Picker label for the single closed-caption toggle. Channel selection isn't
 *  possible (selectTrack decode-freezes the video on webOS), so several declared
 *  tracks collapse to one on/off entry — named only when there's exactly one. */
export function closedCaptionLabel(ccs: ManifestClosedCaption[]): string {
  return ccs.length === 1 && ccs[0].name ? ccs[0].name : 'Closed Captions';
}

/** Clamp an offset to the configured range and quantize to the step. Non-finite input
 *  becomes 0; -0 is normalized to 0. */
export function clampSubtitleOffset(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const { SUBTITLE_OFFSET_STEP: step, SUBTITLE_OFFSET_MAX: max } = CONFIG.PLAYER;
  const clamped = Math.max(-max, Math.min(max, seconds));
  const stepped = Math.round(clamped / step) * step;
  return Math.round(stepped * 1000) / 1000 || 0;
}

/** Display an offset as `+X.XX s` / `0.00 s` / `-X.XX s` (ASCII only — no exotic glyphs). */
export function formatSubtitleOffset(seconds: number): string {
  const s = clampSubtitleOffset(seconds);
  const sign = s > 0 ? '+' : s < 0 ? '-' : '';
  return `${sign}${Math.abs(s).toFixed(2)} s`;
}

// Original (unshifted) times per foreign cue, so re-applying an offset is idempotent and
// absolute (never cumulative). "Foreign" = a native TextTrack we don't build ourselves
// (in-container VOD tracks, the hls.js preview track).
const foreignCueBase = new WeakMap<object, { s: number; e: number }>();

interface ShiftableCue { startTime: number; endTime: number }

/** Shift every cue of a foreign native text track to base + offset. First sight of a cue
 *  captures its original times, so re-running with the same offset is a no-op and changing
 *  the offset is absolute. Best-effort — a platform that rejects cue-time mutation just
 *  leaves the cues unshifted (never throws). */
export function shiftForeignTrack(
  track: { cues: ArrayLike<ShiftableCue> | null } | null,
  offset: number,
): void {
  const cues = track?.cues;
  if (!cues) return;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    let base = foreignCueBase.get(cue);
    if (!base) { base = { s: cue.startTime, e: cue.endTime }; foreignCueBase.set(cue, base); }
    try { cue.startTime = base.s + offset; cue.endTime = base.e + offset; } catch { /* platform-managed */ }
  }
}
