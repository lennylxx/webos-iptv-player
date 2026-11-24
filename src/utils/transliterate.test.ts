import { describe, expect, it } from 'vitest';
import { foldSearchText } from './channel-search';
import { transliterateQuery } from './transliterate';

const texts = (folded: string): string[] => transliterateQuery(folded).map(spelling => spelling.text);

describe('transliterateQuery', () => {
  it('writes a Cyrillic query in Latin letters, letter groups included', () => {
    expect(transliterateQuery(foldSearchText('Шорка Жуцх 2'))).toEqual([{ text: 'shorka zhutskh 2', script: 'latin' }]);
    expect(texts(foldSearchText('Щёлк ъя'))).toEqual(['shchelk ya']);
  });

  it('uses Ukrainian letter values in a word with і, є, or ґ', () => {
    expect(texts('гилі гили')).toEqual(['hyli gili']);
  });

  it('writes a Latin query in Cyrillic, longest letter group first', () => {
    expect(texts('shorka zhutskh')).toEqual(['шорка жуцх']);
    expect(texts('shchelk yaro')).toEqual(['щелк яро']);
  });

  it('keeps a word-final ts as two letters', () => {
    expect(texts('zorts tsorb')).toEqual(['зортс цорб']);
  });

  it('reads j as й before a vowel and on its own', () => {
    expect(texts('zorbija maj')[0]).toBe(foldSearchText('зорбия май'));
  });

  it('adds a Ukrainian spelling, which only Ukrainian items are searched with', () => {
    expect(transliterateQuery('hrabadske')).toEqual([
      { text: 'храбадске', script: 'cyrillic' },
      { text: 'грабадске', script: 'ukrainian' },
    ]);
  });

  it('matches folded Cyrillic, which has no й', () => {
    expect(texts('maiak')[0]).toBe(foldSearchText('майак'));
  });

  it('leaves a query with no letters or with both scripts alone', () => {
    expect(transliterateQuery('123')).toEqual([]);
    expect(transliterateQuery('alpha шорка')).toEqual([]);
  });
});
