const LATIN_RANGES = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF';
const CYRILLIC_RANGES = '\\u0400-\\u0481\\u048A-\\u052F\\uA640-\\uA66E\\uA67F-\\uA69D';
const ARABIC_RANGES = '\\u0620-\\u063F\\u0641-\\u064A\\u066E-\\u066F\\u0671-\\u06D3\\u06D5\\u06EE-\\u06EF\\u06FA-\\u06FC\\u06FF\\u0750-\\u077F\\u08A0-\\u08B4\\u08B6-\\u08C7';
const HAN_RANGES = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
const LETTER_RANGES = `${LATIN_RANGES}${CYRILLIC_RANGES}${ARABIC_RANGES}${HAN_RANGES}`;

let supportsUnicodeProperties = true;
// Runtime feature detection: Chrome 53 throws when compiling property escapes.
try {
  // eslint-disable-next-line no-restricted-syntax -- this probe is the feature detection
  new RegExp('\\p{L}', 'u');
} catch {
  supportsUnicodeProperties = false;
}

function createUnicodeRegExp(
  unicodePattern: string,
  fallbackPattern: string,
  flags: string,
): RegExp {
  return new RegExp(
    supportsUnicodeProperties ? unicodePattern : fallbackPattern,
    flags,
  );
}

const DIACRITIC_MARKS_RE = createUnicodeRegExp(
  '[\\p{Diacritic}ٕٓٔ]',
  '[\\u0300-\\u036F\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06ED\\u08D3-\\u08E1\\u08E3-\\u08FF]',
  'gu',
);
const COMBINING_DIACRITIC_MARKS_RE = /[\u0300-\u036F]/gu;
// Arabic tashkeel and the hamza/madda NFD splits off its carriers, Quranic
// marks, and the tatweel that stretches a word.
const ARABIC_MARKS = '\\u0610-\\u061A\\u0640\\u064B-\\u065F\\u0670\\u06D6-\\u06ED\\u08D3-\\u08E1\\u08E3-\\u08FF';
const SEARCH_MARKS_RE = new RegExp(`[\\u0300-\\u036F${ARABIC_MARKS}]`, 'g');
const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/;
const ARABIC_PRESENTATION_FORMS_RE = /[\uFB50-\uFDFF\uFE70-\uFEFC]+/g;
const ARABIC_PRESENTATION_FORM_RE = /[\uFB50-\uFDFF\uFE70-\uFEFC]/;
// NFKD writes an isolated tashkeel form as a space before the mark.
const SPACED_ARABIC_MARK_RE = / (?=[\u064B-\u0652])/g;
const ARABIC_LETTER_BASES: Record<string, string> = {
  '\u0622': '\u0627', // آ -> ا
  '\u0623': '\u0627', // أ -> ا
  '\u0625': '\u0627', // إ -> ا
  '\u0671': '\u0627', // ٱ -> ا
  '\u0629': '\u0647', // ة -> ه
  '\u0649': '\u064A', // ى -> ي
  '\u06A9': '\u0643', // Persian ک -> ك
  '\u06C0': '\u0647', // Persian ۀ -> ه; NFD would leave Kurdish ە instead
  '\u06CC': '\u064A', // Persian ی -> ي
};
// ۀ spelled as ە plus hamza above, which NFD would leave as Kurdish ە.
const DECOMPOSED_HEH_WITH_YEH_RE = /\u06D5\u0654/g;
const ARABIC_LETTER_VARIANTS_RE = new RegExp(`[${Object.keys(ARABIC_LETTER_BASES).join('')}]`, 'g');

const LETTER_OR_NUMBER_RE = createUnicodeRegExp(
  '[\\p{L}\\p{N}]',
  `[0-9${LETTER_RANGES}]`,
  'u',
);

const LETTER_NUMBER_SEPARATOR_RE = createUnicodeRegExp(
  '[^\\p{L}\\p{N}]+',
  `[^0-9${LETTER_RANGES}]+`,
  'u',
);

const LETTER_NUMBER_PLUS_SEPARATOR_RE = createUnicodeRegExp(
  '[^\\p{L}\\p{N}+]+',
  `[^+0-9${LETTER_RANGES}]+`,
  'u',
);

const LETTER_NUMBER_WORD_RE = createUnicodeRegExp(
  '^[\\p{L}\\p{N}]+$',
  `^[0-9${LATIN_RANGES}${CYRILLIC_RANGES}]+$`,
  'u',
);

const ARABIC_OR_HAN_RE = createUnicodeRegExp(
  '[\\p{sc=Han}\\p{sc=Arabic}]',
  `[${ARABIC_RANGES}${HAN_RANGES}]`,
  'u',
);

export function stripDiacritics(value: string): string {
  return value.replace(DIACRITIC_MARKS_RE, '');
}

export function stripCombiningDiacritics(value: string): string {
  return value.replace(COMBINING_DIACRITIC_MARKS_RE, '');
}

// What search folding does to each basic Arabic character, so ASCII + basic
// Arabic text folds in one pass without NFD: a mark maps to 0 (dropped), a
// letter to its unified base, which for a letter NFD splits into a base plus
// marks is that base, so the table matches the NFD path.
const BASIC_ARABIC_START = 0x600;
const BASIC_ARABIC_END = 0x700;
const BASIC_ARABIC_FOLD = (() => {
  const marks = new RegExp(`^[${ARABIC_MARKS}]$`);
  const table = new Uint16Array(BASIC_ARABIC_END - BASIC_ARABIC_START);
  for (let i = 0; i < table.length; i++) {
    const char = String.fromCharCode(BASIC_ARABIC_START + i);
    if (!marks.test(char)) table[i] = (ARABIC_LETTER_BASES[char] ?? char).normalize('NFD').charCodeAt(0);
  }
  return table;
})();
const ASCII_UPPERCASE_RE = /[A-Z]/;

// Copies the unchanged runs between changed characters, which beats both a
// per-character rebuild and NFD plus regex passes. Returns null for text
// outside ASCII + basic Arabic.
function foldBasicArabic(value: string): string | null {
  let folded = '';
  let copied = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) continue;
    if (code < BASIC_ARABIC_START || code >= BASIC_ARABIC_END) return null;
    if (code === 0x6D5 && value.charCodeAt(i + 1) === 0x654) {
      folded += `${value.slice(copied, i)}\u0647`;
      copied = i + 2;
      i++;
      continue;
    }
    const base = BASIC_ARABIC_FOLD[code - BASIC_ARABIC_START];
    if (base === code) continue;
    folded += value.slice(copied, i);
    if (base) folded += String.fromCharCode(base);
    copied = i + 1;
  }
  return copied ? folded + value.slice(copied) : value;
}

// Unify Arabic letters typed interchangeably, which no Unicode normalization
// does, and turn contextual glyph codepoints ("ﺣ") back into letters. Runs
// before NFD, which would hide ۀ behind Kurdish ە; text without Arabic
// script returns as is.
export function unifyArabicLetters(value: string): string {
  if (!ARABIC_SCRIPT_RE.test(value)) return value;
  return decomposePresentationForms(value)
    .replace(DECOMPOSED_HEH_WITH_YEH_RE, '\u06C0')
    .replace(ARABIC_LETTER_VARIANTS_RE, letter => ARABIC_LETTER_BASES[letter]);
}

function decomposePresentationForms(value: string): string {
  return value.replace(ARABIC_PRESENTATION_FORMS_RE, forms => forms.normalize('NFKD').replace(SPACED_ARABIC_MARK_RE, ''));
}

// Search folding of non-ASCII text: lowercase, drop Latin accents and, in
// Arabic text, the marks and the letter differences people type
// interchangeably.
export function foldNonAsciiSearchText(value: string): string {
  if (!ARABIC_SCRIPT_RE.test(value)) {
    return value.normalize('NFD').replace(COMBINING_DIACRITIC_MARKS_RE, '').toLowerCase();
  }
  if (ARABIC_PRESENTATION_FORM_RE.test(value)) value = decomposePresentationForms(value);
  // Arabic has no case, so only ASCII letters need lowercasing.
  const basic = foldBasicArabic(ASCII_UPPERCASE_RE.test(value) ? value.toLowerCase() : value);
  if (basic !== null) return basic;
  return unifyArabicLetters(value).normalize('NFD').replace(SEARCH_MARKS_RE, '').toLowerCase();
}

export function splitLetterNumberTokens(value: string): string[] {
  return value.split(LETTER_NUMBER_SEPARATOR_RE).filter(Boolean);
}

export function splitLetterNumberPlusTokens(value: string): string[] {
  return value.split(LETTER_NUMBER_PLUS_SEPARATOR_RE).filter(Boolean);
}

export function isLetterOrNumber(value: string): boolean {
  return LETTER_OR_NUMBER_RE.test(value);
}

export function isLetterNumberWord(value: string): boolean {
  return LETTER_NUMBER_WORD_RE.test(value);
}

export function containsArabicOrHan(value: string): boolean {
  return ARABIC_OR_HAN_RE.test(value);
}
