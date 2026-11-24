// Query-time Cyrillic <-> Latin transliteration for search. Input and output
// are search-folded text, which has already lost й/ё/ї marks (и/е/і).

export type SearchScript = 'latin' | 'cyrillic' | 'ukrainian';

const CYRILLIC_RE = /[\u0400-\u04ff]/;
const LATIN_RE = /[a-z]/;
const UKRAINIAN_RE = /[\u0454\u0456\u0491]/;
const LATIN_LETTER_RE = /[a-z]/;

const TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh', з: 'z',
  и: 'i', і: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ў: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// Ukrainian writes и as y and г as h; a word with і/є/ґ is taken as Ukrainian.
const UKRAINIAN_TO_LATIN: Record<string, string> = { и: 'y', г: 'h' };

// Longest first, so letter groups win over their single letters. j stands
// for й (folded to и), as Slavic names write it.
const TO_RUSSIAN: Array<[string, string]> = [
  ['shch', 'щ'],
  ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'],
  ['yu', 'ю'], ['ya', 'я'], ['yo', 'е'], ['ye', 'е'], ['ju', 'ю'], ['ja', 'я'], ['jo', 'е'], ['je', 'е'],
  ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'], ['f', 'ф'], ['g', 'г'],
  ['h', 'х'], ['i', 'и'], ['j', 'и'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'],
  ['o', 'о'], ['p', 'п'], ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
  ['v', 'в'], ['w', 'в'], ['x', 'кс'], ['y', 'и'], ['z', 'з'],
];

// Ukrainian romanization: h is г, i is і (ї folds to і), y is и.
const UKRAINIAN_LETTERS: Record<string, string> = { h: 'г', i: 'і', yi: 'і', ye: 'є', je: 'є' };
const TO_UKRAINIAN: Array<[string, string]> = [['yi', 'і']].concat(
  TO_RUSSIAN.map(([latin, cyrillic]) => [latin, UKRAINIAN_LETTERS[latin] ?? cyrillic]),
) as Array<[string, string]>;

export function hasScript(value: string, script: SearchScript): boolean {
  if (script === 'ukrainian') return UKRAINIAN_RE.test(value);
  return (script === 'latin' ? LATIN_RE : CYRILLIC_RE).test(value);
}

function toLatin(word: string): string {
  const ukrainian = UKRAINIAN_RE.test(word);
  let out = '';
  for (const char of word) {
    const mapped = (ukrainian ? UKRAINIAN_TO_LATIN[char] : undefined) ?? TO_LATIN[char];
    out += mapped === undefined ? char : mapped;
  }
  return out;
}

function toCyrillic(value: string, table: Array<[string, string]>): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    let matched = false;
    for (const [latin, cyrillic] of table) {
      if (value.slice(i, i + latin.length) !== latin) continue;
      // A word-final ts is t + s ("sports"), not ц.
      const end = i + latin.length;
      out += latin === 'ts' && !LATIN_LETTER_RE.test(value.charAt(end)) ? 'тс' : cyrillic;
      i = end;
      matched = true;
      break;
    }
    if (!matched) out += value.charAt(i++);
  }
  return out;
}

export interface Transliteration {
  text: string;
  // The script the searched items must use for this spelling to be worth a pass.
  script: SearchScript;
}

/**
 * The folded query written in the other script: Latin for a Cyrillic query;
 * Russian and, when it differs, Ukrainian spelling for a Latin one. Empty
 * when the query has no letters to convert or mixes both scripts.
 */
export function transliterateQuery(folded: string): Transliteration[] {
  const cyrillic = CYRILLIC_RE.test(folded);
  const latin = LATIN_RE.test(folded);
  if (cyrillic === latin) return [];
  if (cyrillic) {
    const text = folded.split(' ').map(toLatin).join(' ');
    return text === folded ? [] : [{ text, script: 'latin' }];
  }
  const russian = toCyrillic(folded, TO_RUSSIAN);
  const ukrainian = toCyrillic(folded, TO_UKRAINIAN);
  const spellings: Transliteration[] = [{ text: russian, script: 'cyrillic' }];
  if (ukrainian !== russian) spellings.push({ text: ukrainian, script: 'ukrainian' });
  return spellings;
}
