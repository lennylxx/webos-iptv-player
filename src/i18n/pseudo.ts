const ACCENTS: Record<string, string> = {
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î',
  J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'M', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Q', R: 'Ŕ',
  S: 'Š', T: 'Ţ', U: 'Û', V: 'V', W: 'Ŵ', X: 'X', Y: 'Ý', Z: 'Ž',
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î',
  j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'm', n: 'ñ', o: 'ö', p: 'þ', q: 'q', r: 'ŕ',
  s: 'š', t: 'ţ', u: 'û', v: 'v', w: 'ŵ', x: 'x', y: 'ý', z: 'ž',
};

function expandWords(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => {
    let accented = '';
    for (let i = 0; i < word.length; i++) accented += ACCENTS[word[i]] ?? word[i];
    return accented + '~'.repeat(Math.max(1, Math.ceil(word.length * 0.35)));
  });
}

export function pseudoLocalize(message: string): string {
  const placeholder = /\{[A-Za-z0-9_]+\}/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = placeholder.exec(message)) !== null) {
    result += expandWords(message.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  result += expandWords(message.slice(lastIndex));
  return `[!! ${result} !!]`;
}
