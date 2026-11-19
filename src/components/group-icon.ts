// Genre-icon matching for channel groups. Group titles are short, noisy and
// multilingual: we fold (lowercase, strip diacritics), tokenize, and score
// every genre in group-icon-lexicon.ts. A phrase scores 3, a word or stem 2,
// a weak keyword 1, plus 0.5 when the keyword is in the group's language
// (from its prefix or letters, else the playlist's main language); the best
// score wins and ties go to genre priority. See the lexicon for how keywords
// match.
//
// Icons are Twemoji artwork (https://github.com/jdecked/twemoji), licensed
// under CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/); assets live
// in assets/group-icons/ and assets/icons/.

import {
  containsArabicOrHan,
  isLetterNumberWord,
  splitLetterNumberPlusTokens,
  stripDiacritics,
} from '../utils/unicode-text';
import {
  EXTRA_LEXICONS,
  GENRES,
  UI_LEXICONS,
  WEAK_KEYWORDS,
  ADULT_HINTS,
  type Genre,
  type Lexicon,
} from './group-icon-lexicon';
import type { SupportedLocale } from '../i18n';
import { TRIANGLE_ICON } from './icons';

const GROUP_ICON_DIR = 'assets/group-icons';

const GENRE_ICONS: Record<Genre, string> = {
  kids: 'teddy_bear',
  sports: 'soccer_ball',
  gaming: 'gaming',
  news: 'newspaper',
  music: 'musical_note',
  cooking: 'cooking',
  shopping: 'shopping',
  adult: 'no_one_under_eighteen',
  documentary: 'world_map',
  religion: 'church',
  movies: 'clapper_board',
  series: 'television',
  weather: 'sun_behind_cloud',
  business: 'chart_increasing',
  public: 'classical_building',
  classic: 'film_frames',
  outdoor: 'camping',
  auto: 'automobile',
  culture: 'amphora',
  lifestyle: 'couch_and_lamp',
  relax: 'person_in_lotus_position',
  entertainment: 'entertainment',
};

const WEAK = 1;
const WORD = 2;
const PHRASE = 3;
// Less than a step, so it only settles a tie between equal-strength genres.
const LANGUAGE_BONUS = 0.5;

// Normalize for matching: strip diacritics ("Fútbol" -> "futbol"), fold
// letters NFD leaves alone (Polish ł, Turkish ı), unify Arabic
// alef/hamza/teh-marbuta/alef-maksura variants ("الأطفال" -> "اطفال"), and
// lowercase.
function fold(value: string): string {
  // Printable ASCII has nothing to fold but case; most catalog names are.
  if (/^[\x20-\x7e]*$/.test(value)) return value.toLowerCase();
  return stripDiacritics(value.normalize('NFD')) // accents + Arabic tashkeel/hamza/madda
    .replace(/[łŁ]/gu, 'l')
    .replace(/ı/gu, 'i')
    .replace(/[آأإٱ]/gu, 'ا')        // آأإٱ -> ا
    .replace(/ى/gu, 'ي')             // ى -> ي
    .replace(/ة/gu, 'ه')             // ة -> ه
    .toLowerCase();
}

// Split into word tokens on anything that isn't a letter, digit or '+', so
// markers like "18+" survive. An index range ("A-Z", "0-9") is dropped first,
// so "Serie A-Z" is not the "serie a" league.
function tokenize(folded: string): string[] {
  return splitLetterNumberPlusTokens(folded.replace(/(^|[^a-z0-9])[a-z0-9]\s*[-\u2013]\s*[a-z0-9](?![a-z0-9])/g, '$1 '));
}

interface Match {
  genre: Genre;
  score: number;
  // Lexicons that list the keyword; a group in one of them gets LANGUAGE_BONUS.
  langs: string[];
}

const weak = new Set(WEAK_KEYWORDS.map(fold));
const exactWords = new Map<string, Match>();
const stems = new Map<string, Match>();
let longestStem = 0;
const phrases = new Map<string, Match>();
// Phrases indexed by their first token, so a title only checks the phrases
// it could contain.
const phrasesByStart = new Map<string, Array<{ parts: string[]; match: Match }>>();
const substrings = new Map<string, Match>();

function register(table: Map<string, Match>, text: string, genre: Genre, score: number, lang: string): void {
  const match = table.get(text);
  if (match) {
    if (match.langs.indexOf(lang) < 0) match.langs.push(lang);
  } else {
    table.set(text, { genre, score, langs: [lang] });
  }
}

function addKeyword(raw: string, genre: Genre, lang: string): void {
  const score = weak.has(fold(raw)) ? WEAK : WORD;
  const forced = /^\*(.+)\*$/.exec(raw);
  if (forced) {
    register(substrings, fold(forced[1]), genre, score, lang);
    return;
  }
  const isStem = raw.endsWith('*');
  const text = fold(isStem ? raw.slice(0, -1) : raw);
  const tokens = tokenize(text);
  if (containsArabicOrHan(text) || !tokens.length || tokens.join(' ') !== text) {
    register(substrings, text, genre, score, lang);
  } else if (tokens.length > 1) {
    // A brand phrase ("nat geo") names a channel, not a genre: it claims its
    // tokens but scores like a word, so "Nat Geo Kids" stays kids.
    const phraseScore = weak.has(text) ? WEAK : lang === 'other' ? WORD : PHRASE;
    register(phrases, text, genre, phraseScore, lang);
  } else if (!isLetterNumberWord(text)) {
    register(substrings, text, genre, score, lang);
  } else if (isStem) {
    register(stems, text, genre, score, lang);
    longestStem = Math.max(longestStem, text.length);
  } else {
    register(exactWords, text, genre, score, lang);
  }
}

function addLexicon(lexicon: Partial<Lexicon>, lang: string): void {
  for (const genre of GENRES) {
    for (const keyword of lexicon[genre] ?? []) addKeyword(keyword, genre, lang);
  }
}

(Object.keys(UI_LEXICONS) as SupportedLocale[]).forEach(locale => addLexicon(UI_LEXICONS[locale], locale));
Object.keys(EXTRA_LEXICONS).forEach(name => addLexicon(EXTRA_LEXICONS[name], name));

phrases.forEach((match, text) => {
  const parts = text.split(' ');
  const list = phrasesByStart.get(parts[0]) ?? [];
  list.push({ parts, match });
  phrasesByStart.set(parts[0], list);
});
// Han and Arabic keywords can't occur in a printable-ASCII title.
const ASCII_RE = /^[\x20-\x7e]*$/;
const asciiSubstrings: string[] = [];
const otherSubstrings: string[] = [];
substrings.forEach((_match, text) => (ASCII_RE.test(text) ? asciiSubstrings : otherSubstrings).push(text));

// A symbol keyword with a digit at its edge ("18+") must not sit inside a
// longer number ("2018+").
function containsKeyword(folded: string, text: string): boolean {
  const digitStart = /^[0-9]/.test(text);
  const digitEnd = /[0-9]$/.test(text);
  let at = folded.indexOf(text);
  while (at >= 0) {
    const before = folded.charAt(at - 1);
    const after = folded.charAt(at + text.length);
    if (!(digitStart && /[0-9]/.test(before)) && !(digitEnd && /[0-9]/.test(after))) return true;
    at = folded.indexOf(text, at + 1);
  }
  return false;
}

function phraseHits(tokens: string[], visit: (start: number, parts: string[], match: Match) => void): void {
  tokens.forEach((token, start) => {
    for (const { parts, match } of phrasesByStart.get(token) ?? []) {
      if (start + parts.length > tokens.length) continue;
      if (parts.every((part, offset) => tokens[start + offset] === part)) visit(start, parts, match);
    }
  });
}

function substringHits(folded: string): string[] {
  const hits: string[] = [];
  const scan = (text: string): void => { if (containsKeyword(folded, text)) hits.push(text); };
  asciiSubstrings.forEach(scan);
  if (!ASCII_RE.test(folded)) otherSubstrings.forEach(scan);
  return hits;
}

const GLUED_SUFFIX_RE = /(?:tv|hd|fhd|uhd|[0-9+])+$/;

// A whole-word keyword wins; otherwise the longest stem that prefixes the
// token; otherwise the same without a glued suffix ("KidsTV", "News24").
function tokenMatch(token: string): Match | undefined {
  const match = wordMatch(token);
  if (match) return match;
  const bare = token.replace(GLUED_SUFFIX_RE, '');
  return bare && bare !== token ? wordMatch(bare) : undefined;
}

function wordMatch(token: string): Match | undefined {
  const exact = exactWords.get(token);
  if (exact) return exact;
  for (let end = Math.min(token.length, longestStem); end > 0; end--) {
    const match = stems.get(token.slice(0, end));
    if (match) return match;
  }
  return undefined;
}

function matchKeywords(group: string): Match[] {
  const folded = fold(group);
  const tokens = tokenize(folded);
  const matches: Match[] = [];
  // A phrase claims its tokens, so "Sci Fi Series" weighs "series" against
  // the phrase, not against "sci" or "fi" too.
  const claimed = tokens.map(() => false);
  phraseHits(tokens, (start, parts, match) => {
    matches.push(match);
    parts.forEach((_part, offset) => { claimed[start + offset] = true; });
  });
  tokens.forEach((token, index) => {
    const match = claimed[index] ? undefined : tokenMatch(token);
    if (match) matches.push(match);
  });
  // As with tokens, a longer substring claims the shorter ones inside it
  // ("老电影" is classic, not the "电影" inside it).
  const hits = substringHits(folded);
  for (const text of hits) {
    if (!hits.some(other => other !== text && other.indexOf(text) >= 0)) {
      matches.push(substrings.get(text) as Match);
    }
  }
  return matches;
}

// Language hints. A "FR|", "[DE]", "UK:" or flag prefix names the group's
// country; letters only one UI language uses name it too. Either outranks the
// playlist's main language.
const PREFIX_LANGS: Record<string, SupportedLocale> = {
  en: 'en', uk: 'en', gb: 'en', us: 'en', usa: 'en', ca: 'en', au: 'en', ie: 'en', nz: 'en',
  de: 'de', ger: 'de', at: 'de',
  fr: 'fr', fra: 'fr',
  it: 'it', ita: 'it',
  es: 'es', esp: 'es', mx: 'es', co: 'es', cl: 'es', pe: 'es', lat: 'es',
  br: 'pt-BR', pt: 'pt-BR', bra: 'pt-BR',
  pl: 'pl', pol: 'pl',
  tr: 'tr', tur: 'tr',
  ru: 'ru', rus: 'ru',
  ua: 'uk', ukr: 'uk',
  cn: 'zh-CN', zh: 'zh-CN', chn: 'zh-CN',
};

const SCRIPT_LANGS: Array<[RegExp, SupportedLocale]> = [
  [/[іїєґ]/, 'uk'],
  [/[ыэъё]/, 'ru'],
  [/[\u4e00-\u9fff]/, 'zh-CN'],
  [/[şğı]/, 'tr'],
  [/[łąęśźżń]/, 'pl'],
  [/ß/, 'de'],
  [/[ãõ]/, 'pt-BR'],
  [/[ñ¿¡]/, 'es'],
];

const PREFIX_RE = /^[\s|#]*(?:vip\s+)?[[(]?\s*([a-z]{2,3})\s*(?:[\])]\s*[|:#\-\u2013\u258e]?|[|:#\-\u2013\u258e])/i;
const FLAG_RE = /^[\s|#]*\ud83c([\udde6-\uddff])\ud83c([\udde6-\uddff])/;

function flagCode(group: string): string | null {
  const flag = FLAG_RE.exec(group);
  if (!flag) return null;
  const letter = (unit: string): string => String.fromCharCode(unit.charCodeAt(0) - 0xdde6 + 97);
  return letter(flag[1]) + letter(flag[2]);
}

export function detectGroupLanguage(group: string): SupportedLocale | null {
  const code = flagCode(group) ?? PREFIX_RE.exec(group)?.[1].toLowerCase();
  if (code && PREFIX_LANGS[code]) return PREFIX_LANGS[code];
  const lower = group.toLowerCase();
  for (const [re, lang] of SCRIPT_LANGS) {
    if (re.test(lower)) return lang;
  }
  return null;
}

// The language most groups point to (a hint, or keywords only one UI
// language uses), when it holds a majority of the groups that point anywhere.
// Pass playlist groups only (built-in labels are in the UI language), and
// cache the result with the group list: it scores every group.
const LANGUAGE_SAMPLE = 1000;

export function playlistLanguage(labels: readonly string[]): SupportedLocale | null {
  const votes = new Map<SupportedLocale, number>();
  let voters = 0;
  // An even sample keeps a huge catalog from stalling the first render.
  const step = Math.max(1, Math.ceil(labels.length / LANGUAGE_SAMPLE));
  for (let i = 0; i < labels.length; i += step) {
    const label = labels[i];
    const lang = detectGroupLanguage(label) ?? keywordLanguage(label);
    if (!lang) continue;
    voters++;
    votes.set(lang, (votes.get(lang) ?? 0) + 1);
  }
  let best: SupportedLocale | null = null;
  for (const lang of Array.from(votes.keys())) {
    const count = votes.get(lang) ?? 0;
    if (count * 2 > voters && count >= 2) best = lang;
  }
  return best;
}

// The one UI language all of a label's language-specific keywords share.
function keywordLanguage(label: string): SupportedLocale | null {
  let found: SupportedLocale | null = null;
  for (const match of matchKeywords(label)) {
    const own = match.langs.filter(lang => lang in UI_LEXICONS) as SupportedLocale[];
    if (own.length !== 1) continue;
    if (found && found !== own[0]) return null;
    found = own[0];
  }
  return found;
}

function scoreGenres(group: string, lang: string | null): Map<Genre, number> {
  const scores = new Map<Genre, number>();
  for (const match of matchKeywords(group)) {
    const score = match.score + (lang && match.langs.indexOf(lang) >= 0 ? LANGUAGE_BONUS : 0);
    scores.set(match.genre, Math.max(scores.get(match.genre) ?? 0, score));
  }
  return scores;
}

/**
 * Map a group title to an icon file name (without extension), or null
 * when nothing matches (the caller falls back to a generic glyph).
 */
const MATCH_CACHE_LIMIT = 5000;
const matchCache = new Map<string, string | null>();

export function matchGroupIcon(group: string, playlistLang?: SupportedLocale | null): string | null {
  const key = `${playlistLang ?? ''}\n${group}`;
  const cached = matchCache.get(key);
  if (cached !== undefined) return cached;
  if (matchCache.size >= MATCH_CACHE_LIMIT) matchCache.clear();
  const icon = scoreIcon(group, playlistLang ?? null);
  matchCache.set(key, icon);
  return icon;
}

function scoreIcon(group: string, playlistLang: SupportedLocale | null): string | null {
  const scores = scoreGenres(group, detectGroupLanguage(group) ?? playlistLang);
  // A full adult keyword always shows the adult icon, never "Adult Cartoons" as kids.
  if ((scores.get('adult') ?? 0) >= WORD) return GENRE_ICONS.adult;
  let best: Genre | null = null;
  for (const genre of GENRES) {
    const score = scores.get(genre) ?? 0;
    if (score > (best ? scores.get(best) ?? 0 : 0)) best = genre;
  }
  return best ? GENRE_ICONS[best] : null;
}

const adultPrefixes: string[] = [];
const adultPhrases: string[] = [];
const adultSubstrings: string[] = [];
ADULT_HINTS.map(fold).forEach(text => (text.indexOf(' ') >= 0 ? adultPhrases : adultPrefixes).push(text));
phrases.forEach((match, text) => { if (match.genre === 'adult') adultPhrases.push(text); });
substrings.forEach((match, text) => { if (match.genre === 'adult') adultSubstrings.push(text); });
// Spanish/Portuguese "sixth"/"Friday" ("La Sexta"), not adult.
const SIXTH_RE = /^sext(?:a|as|o|os|ou|eto|etos)$/;
exactWords.forEach((match, text) => { if (match.genre === 'adult') adultPrefixes.push(text); });
stems.forEach((match, text) => { if (match.genre === 'adult') adultPrefixes.push(text); });

// Adult regardless of the other genres, so "Kids XXX" still counts, and by
// token prefix ("Erwachsenenfilme", "BrazzersTV").
export function isAdultGroupName(group: string): boolean {
  const folded = fold(group);
  const tokens = tokenize(folded);
  if (tokens.some(token => !SIXTH_RE.test(token)
    && adultPrefixes.some(prefix => token.indexOf(prefix) === 0))) return true;
  const spaced = ` ${tokens.join(' ')} `;
  if (adultPhrases.some(text => spaced.indexOf(` ${text} `) >= 0)) return true;
  return adultSubstrings.some(text => containsKeyword(folded, text));
}

function iconImg(name: string): string {
  return `<img class="group-logo" src="${GROUP_ICON_DIR}/${name}.svg" alt="">`;
}

/**
 * Render the group-list icon as an HTML string: a matched `<img>`
 * pointing at its asset path, the dedicated All/Favorites icons, or a generic
 * play-triangle icon for unmatched groups. (Inserted via the caller's `raw()`
 * helper.)
 */
export function groupIcon(
  group: string,
  builtin?: 'all' | 'favorites' | 'recently-watched',
  playlistLang?: SupportedLocale | null,
): string {
  if (builtin === 'all') return iconImg('all');
  if (builtin === 'favorites') return iconImg('star');
  if (builtin === 'recently-watched') return iconImg('three_oclock');
  const icon = matchGroupIcon(group, playlistLang);
  return icon ? iconImg(icon) : TRIANGLE_ICON;
}
