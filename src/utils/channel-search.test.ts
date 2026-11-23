// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Channel } from '../types';
import { stripCombiningDiacritics } from './unicode-text';
import {
  foldSearchText,
  prepareSearchItems,
  prepareNameSearchItems,
  rankByName,
  rankChannels,
  rankByFields,
  rankPrepared,
  rankPreparedNamesTopK,
  rankPreparedTopK,
} from './channel-search';

function ch(name: string, id = name): Channel {
  return { id, name, logo: '', group: '', url: '', extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0 };
}
const names = (cs: Channel[]) => cs.map(c => c.name);

describe('rankByName', () => {
  it('returns [] for a blank/whitespace query', () => {
    expect(rankByName([ch('Alpha')], '   ')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(names(rankByName([ch('Alpha')], 'ALPHA'))).toEqual(['Alpha']);
  });

  it('excludes non-matching channels (result set == substring set)', () => {
    expect(names(rankByName([ch('Alpha'), ch('Bravo')], 'alp'))).toEqual(['Alpha']);
  });

  it('orders exact > prefix > word-start > mid-word', () => {
    const cs = [ch('XAlpha'), ch('HD Alpha'), ch('Alpha HD'), ch('Alpha')];
    expect(names(rankByName(cs, 'alpha'))).toEqual(['Alpha', 'Alpha HD', 'HD Alpha', 'XAlpha']);
  });

  it('treats Unicode punctuation as a word boundary', () => {
    const cs = [ch('AlphaNews'), ch('Alpha—News')];
    expect(names(rankByName(cs, 'news'))).toEqual(['Alpha—News', 'AlphaNews']);
  });

  it.each([
    ['hamza on alef', 'أخبار', 'اخبار'],
    ['hamza below alef', 'إسلام', 'اسلام'],
    ['madda', 'قرآن', 'قران'],
    ['hamza on waw', 'مؤمن', 'مومن'],
    ['hamza on yeh', 'رئيس', 'رييس'],
    ['teh marbuta', 'قناة', 'قناه'],
    ['alef maksura', 'مصطفى', 'مصطفي'],
    ['Persian kaf', 'کتب', 'كتب'],
    ['Persian yeh', 'فارسی', 'فارسي'],
    ['tashkeel', 'كِتَاب', 'كتاب'],
    ['tatweel', 'كتـــاب', 'كتاب'],
    ['presentation forms', 'ﺍﺣﻤﺪ', 'احمد'],
    ['Persian heh with yeh', 'خانۀ', 'خانه'],
    ['decomposed Persian heh with yeh', 'خان\u06D5\u0654', 'خانه'],
    ['isolated tashkeel form', 'كﹶتب', 'كتب'],
    ['extended Quranic mark', 'ك\u08F0تاب', 'كتاب'],
    ['lam-alef ligature', 'ﻻعب', 'لاعب'],
    ['Allah ligature', 'ﷲ', 'الله'],
    ['standalone hamza mark', 'ا\u0654خبار', 'اخبار'],
  ])('matches Arabic spelling variants both ways: %s', (_case, stored, typed) => {
    expect(names(rankByName([ch(stored)], typed))).toEqual([stored]);
    expect(names(rankByName([ch(typed)], stored))).toEqual([typed]);
  });

  it('folds basic Arabic in one pass exactly as the NFD path does', () => {
    // A Latin accent sends the same text down the NFD path; pairs cover a
    // rule that looks at the next character.
    const mismatches: string[] = [];
    for (let first = 0x600; first <= 0x6FF; first++) {
      for (let second = 0x600; second <= 0x6FF; second++) {
        const text = String.fromCharCode(first, second);
        if (foldSearchText(`${text}é`) !== `${foldSearchText(text)}e`) {
          mismatches.push(`${first.toString(16)} ${second.toString(16)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps a standalone hamza distinct from alef', () => {
    expect(rankByName([ch('سماء')], 'سماا')).toEqual([]);
  });

  it('breaks ties by earlier match position', () => {
    const cs = [ch('XXAlpha'), ch('XAlpha')]; // both mid-word; pos 2 vs pos 1
    expect(names(rankByName(cs, 'alpha'))).toEqual(['XAlpha', 'XXAlpha']);
  });

  describe('Chrome 53 Unicode fallback', () => {
    it('keeps Unicode punctuation as a search boundary', async () => {
      const NativeRegExp = RegExp;
      const LegacyRegExp = function (pattern: string | RegExp, flags?: string): RegExp {
        if (typeof pattern === 'string' && pattern.includes('\\p{')) {
          throw new SyntaxError('Unsupported Unicode property escape');
        }
        return new NativeRegExp(pattern, flags);
      } as RegExpConstructor;

      vi.stubGlobal('RegExp', LegacyRegExp);
      vi.resetModules();
      try {
        const { rankByName: fallbackRankByName } = await import('./channel-search');
        const channels = [ch('AlphaNews'), ch('Alpha—News')];
        expect(names(fallbackRankByName(channels, 'news')))
          .toEqual(['Alpha—News', 'AlphaNews']);
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    });
  });

  it('breaks remaining ties by shorter name', () => {
    const cs = [ch('Alpha International'), ch('Alpha HD')]; // both prefix, pos 0
    expect(names(rankByName(cs, 'alpha'))).toEqual(['Alpha HD', 'Alpha International']);
  });

  it('breaks full ties by original order on legacy Chromium unstable sort', () => {
    const cs = [ch('Alpha', 'a'), ch('Alpha', 'b'), ch('Alpha', 'c')];
    expect(rankByName(cs, 'alpha').map(c => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats the query as one whole substring', () => {
    const cs = [ch('X a b Y'), ch('b a')];
    expect(names(rankByName(cs, 'a b'))).toEqual(['X a b Y']);
  });

  it('ranks any object with a name field (generic over the item type)', () => {
    const items = [{ streamId: '1', name: 'XAlpha' }, { streamId: '2', name: 'Alpha' }];
    expect(rankByName(items, 'alpha').map(i => i.streamId)).toEqual(['2', '1']); // prefix before mid-word
  });

  it('keeps match position ahead of a large name-length difference in Top-K', () => {
    const items = [
      { name: 'xxxxAlpha with an unusually long suffix' },
      { name: 'xxxxxAlpha' },
    ];
    const prepared = prepareNameSearchItems(items);
    expect(rankPreparedNamesTopK(prepared, 'alpha', 1).items).toEqual([items[0]]);
  });

});

describe('rankChannels', () => {
  it('matches channel groups through genre synonyms and ignores conversational filler', () => {
    const channels = [ch('Alpha'), ch('Bravo')];
    channels[0].group = 'Sports';
    channels[1].group = 'Kids';
    expect(names(rankChannels(channels, 'show me footy channels'))).toEqual(['Alpha']);
    expect(names(rankChannels(channels, 'cartoons'))).toEqual(['Bravo']);
  });

  it('tolerates a one-character typo and adjacent transposition', () => {
    expect(names(rankChannels([ch('Alpha'), ch('Bravo')], 'alhpa'))).toEqual(['Alpha']);
    expect(names(rankChannels([ch('Alpha'), ch('Bravo')], 'brvo'))).toEqual(['Bravo']);
  });

  it('matches multiple query words without requiring an exact phrase', () => {
    expect(names(rankChannels([ch('Alpha News HD'), ch('News Bravo')], 'news alpha'))).toEqual(['Alpha News HD']);
  });
});

describe('rankByFields', () => {
  it('searches secondary metadata while preferring direct name matches', () => {
    const items = [
      { title: 'Alpha', category: 'Drama' },
      { title: 'Bravo', category: 'Alpha' },
    ];
    expect(rankByFields(items, 'alpha', item => [item.title, item.category]).map(item => item.title))
      .toEqual(['Alpha', 'Bravo']);
  });

  it('returns exactly the full ranking prefix for every Top-K size', () => {
    const items = [
      { title: 'X Alpha', category: 'Drama' },
      { title: 'Alpha', category: 'News' },
      { title: 'Bravo', category: 'Alpha' },
      { title: 'Alhpa', category: 'Sports' },
      { title: 'Alpha Two', category: 'Drama' },
    ];
    const prepared = prepareSearchItems(items, item => [item.title, item.category]);
    const full = rankPrepared(prepared, 'alpha');
    for (let limit = 1; limit <= full.length; limit++) {
      expect(rankPreparedTopK(prepared, 'alpha', limit).items)
        .toEqual(full.slice(0, limit));
    }
  });

  it('skips fuzzy results when direct matches fill Top-K', () => {
    const items = [
      { title: 'Alpha' },
      { title: 'Alpha Two' },
      { title: 'Alhpa' },
    ];
    const prepared = prepareSearchItems(items, item => [item.title]);
    const result = rankPreparedTopK(prepared, 'alpha', 2);
    expect(result.items).toEqual(items.slice(0, 2));
  });

  it('ranks fuzzy matches while direct ones are fewer than the fuzzy fill', () => {
    const items = [
      { title: 'Alpha' },
      { title: `${'x'.repeat(900)} alpha` },
      { title: 'Alhpa' },
    ];
    const prepared = prepareSearchItems(items, item => [item.title]);
    expect(rankPreparedTopK(prepared, 'alpha', 2, 3).items).toEqual([items[0], items[2]]);
    expect(rankPreparedTopK(prepared, 'alpha', 3).items.slice(0, 2)).toEqual([items[0], items[2]]);
  });
});

describe('foldSearchText', () => {
  const slowFold = (value: string) => stripCombiningDiacritics(value.normalize('NFD')).toLowerCase();

  it('folds ASCII exactly as the full Unicode path does', () => {
    let all = '';
    for (let code = 0; code < 128; code++) all += String.fromCharCode(code);
    const corpus = [all, '', ' ', 'ABC News HD', 'A+B_C-D.E/F\\G', '\t\r\n\u0000\u007f', 'MiXeD 123 !?#'];
    let seed = 1;
    for (let i = 0; i < 2000; i++) {
      let value = '';
      for (let j = i % 24; j > 0; j--) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        value += String.fromCharCode(seed % 128);
      }
      corpus.push(value);
    }
    for (const value of corpus) expect(foldSearchText(value)).toBe(slowFold(value));
  });

  it('still strips accents from non-ASCII text', () => {
    expect(foldSearchText('Caf\u00c9 Ni\u00f1o')).toBe('cafe nino');
    expect(foldSearchText('A\u0301B')).toBe('ab');
  });
});
