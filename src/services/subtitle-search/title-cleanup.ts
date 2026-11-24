// Tidies an IPTV catalog name into a title subtitle sites can match:
// "|EN| Title (2019) 4K MULTI" → { title: "Title", year: 2019 }.

export interface CleanTitle {
  title: string;
  // 0 when the name gives none.
  year: number;
}

// Language and country codes providers put around a title. Only these count
// as tags, so a title word such as "QXZ:" or "[QRZ]" stays.
const CODES = [
  'EN', 'ENG', 'FR', 'FRA', 'FRE', 'DE', 'GER', 'DEU', 'UK', 'US', 'USA', 'IT', 'ITA', 'ES', 'ESP', 'SPA',
  'PT', 'POR', 'BR', 'NL', 'AR', 'ARA', 'TR', 'TUR', 'PL', 'POL', 'RU', 'RUS', 'GR', 'RO', 'HU', 'CZ', 'SK',
  'SE', 'SW', 'NO', 'DK', 'FI', 'IN', 'HI', 'JP', 'JA', 'KR', 'KO', 'CN', 'ZH', 'TW', 'HK', 'AL', 'BG', 'HR',
  'RS', 'SR', 'SI', 'UA', 'IR', 'FA', 'IL', 'HE', 'VN', 'TH', 'ID', 'MY', 'PH', 'LAT', 'MX', 'CA', 'AU', 'NZ',
  'IE', 'BE', 'CH', 'AT', 'SA', 'AE', 'EG', 'MA', 'PK', 'BD', 'KU', 'EXYU', 'MULTI',
];
const CODE = `(?:${CODES.join('|')})(?:[-_/ ](?:${CODES.join('|')}))?`;
// "|EN|", "[FR]", "(DE)" in any case; bare "EN - " or "UK: " only in capitals.
const LEADING_TAG = new RegExp(`^\\s*(?:[|[(]\\s*${CODE}\\s*[|\\])]|(?:${CODES.join('|')})\\s*[-:|](?=\\s))\\s*`, 'i');
const LEADING_BARE = new RegExp(`^\\s*(?:${CODES.join('|')})\\s*[-:|](?=\\s)`);
const TRAILING_TAG = new RegExp(`\\s*[|[(]\\s*${CODE}\\s*[|\\])]\\s*$`, 'i');
const TRAILING_BARE = new RegExp(`\\s[-:|]\\s*(?:${CODES.join('|')})\\s*$`);

// Release tags. Word-like ones count only in capitals ("Dual", "Multi" and
// "HD Alpha" are titles); the rest in any case.
const RELEASE_ANY_CASE = /^(?:4K|8K|2160p|1080p|720p|576p|480p|10bit|HDR10\+?|H\.?26[45]|x26[45]|WEB-?DL|WEB-?Rip|BluRay|BDRip|BRRip|DVDRip|E-?AC3|DDP?5\.1|MULTI-?SUBS?)$/i;
const RELEASE_CAPITALS = [
  'UHD', 'FHD', 'HD', 'SD', 'HDR', 'DV', 'HEVC', 'AVC', 'MULTI', 'MULTISUB', 'DUAL', 'VOSTFR', 'VOST',
  'SUBBED', 'DUBBED', 'HDTV', 'REMUX', 'AAC', 'AC3', 'DTS', 'ATMOS',
];

function isRelease(word: string): boolean {
  return RELEASE_ANY_CASE.test(word) || RELEASE_CAPITALS.indexOf(word) >= 0;
}

const BRACKET_YEAR = /[([]\s*((?:19|20)\d{2})\s*[)\]]/;
const TRAILING_YEAR = /\s*[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$/;
// "Title.2019.1080p.WEB": a dotted year marks a release-style name; the last
// one is the year, so "Alpha.2049.2017.1080p" keeps 2049 in the title.
const DOTTED_YEAR = /\.((?:19|20)\d{2})(?=\.|$)/g;
const BRACKET_GROUP = /[([]([^()[\]]*)[)\]]/g;
// The player's episode label: "Series — S1E2 — Episode title".
const EPISODE_LABEL = /^(.*?) — S\d+E\d+(?: — |$)/;

/** The series name from an episode label, else the name itself. */
export function workTitle(name: string): string {
  const label = EPISODE_LABEL.exec(name);
  return label ? label[1] : name;
}

function trimSeparators(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/^[\s\-:–—|]+|[\s\-:–—|]+$/g, '');
}

function isSeparator(word: string): boolean {
  return /^[|\-:–—]$/.test(word);
}

export function cleanSearchTitle(name: string): CleanTitle {
  let text = name.trim();
  let year = 0;
  if (text.indexOf(' ') < 0) {
    let dotted: RegExpExecArray | null = null;
    for (let match = DOTTED_YEAR.exec(text); match; match = DOTTED_YEAR.exec(text)) dotted = match;
    DOTTED_YEAR.lastIndex = 0;
    if (dotted) {
      year = Number(dotted[1]);
      text = text.slice(0, dotted.index).replace(/[._]+/g, ' ');
    }
  }
  for (let i = 0; i < 3; i++) {
    const tag = LEADING_TAG.exec(text);
    if (!tag || tag[0].length >= text.length) break;
    // A bare code counts only in capitals: "Eng: …" may be a title.
    if (!/^\s*[|[(]/.test(tag[0]) && !LEADING_BARE.test(text)) break;
    text = text.slice(tag[0].length);
  }
  // What is left once tags and years go; the title when release tags take it all.
  const untagged = trimSeparators(text.replace(BRACKET_YEAR, ' '));
  // A bracket holding only release tags goes wherever it is: "[4K]", "(HDR, DV)".
  text = text.replace(BRACKET_GROUP, (group, inner: string) => {
    const words = inner.split(/[\s,/+]+/).filter(Boolean);
    return words.length && words.every(isRelease) ? ' ' : group;
  });
  // The end may stack tags, a year, and release tags in any order: "Title [EN] (2019) HD".
  for (let before = ''; before !== text;) {
    before = text;
    const tag = TRAILING_TAG.exec(text) || TRAILING_BARE.exec(text);
    if (tag && tag.index > 0) text = text.slice(0, tag.index);
    const trailingYear = TRAILING_YEAR.exec(text);
    if (trailingYear && trailingYear.index > 0) {
      if (!year) year = Number(trailingYear[1]);
      text = text.slice(0, trailingYear.index);
    }
    const words = trimSeparators(text).split(' ');
    while (words.length && (isRelease(words[words.length - 1]) || isSeparator(words[words.length - 1]))) words.pop();
    text = words.join(' ');
  }
  const bracketYear = BRACKET_YEAR.exec(text);
  if (bracketYear) {
    if (!year) year = Number(bracketYear[1]);
    text = text.slice(0, bracketYear.index) + ' ' + text.slice(bracketYear.index + bracketYear[0].length);
  }
  const title = trimSeparators(text);
  return { title: title || untagged || name.trim(), year };
}
