// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Channel } from '../types';
import { rankByName, rankChannels, rankByFields } from './channel-search';

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

  it('breaks ties by earlier match position', () => {
    const cs = [ch('XXAlpha'), ch('XAlpha')]; // both mid-word; pos 2 vs pos 1
    expect(names(rankByName(cs, 'alpha'))).toEqual(['XAlpha', 'XXAlpha']);
  });

  it('breaks remaining ties by shorter name', () => {
    const cs = [ch('Alpha International'), ch('Alpha HD')]; // both prefix, pos 0
    expect(names(rankByName(cs, 'alpha'))).toEqual(['Alpha HD', 'Alpha International']);
  });

  it('breaks full ties by original order (deterministic on Chrome 68 unstable sort)', () => {
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
});
