import { describe, expect, it } from 'vitest';
import type { Channel, Programme } from '../../types';
import type { AskFilter } from './ask-query';
import { askChannels, askPrograms, interleave, matchPrograms, namesByCount, programKey, rankNames, wantsType } from './execute';

const channel = (id: string, group: string): Channel => ({
  id, name: id, logo: '', group, url: `http://host/${id}`, extras: null, playlistIds: ['l1'],
} as Channel);

const programme = (title: string, category: string, start: number, stop: number): Programme => ({
  title, category, description: '', icon: '', start: new Date(start), stop: new Date(stop),
});

const filter = (patch: Partial<AskFilter>): AskFilter => ({
  types: [], keywords: [], groups: [], categories: [], genres: [],
  time: 'any', fromHour: -1, toHour: -1, ...patch,
});

const NOW = 10_000;
const ch1 = channel('ch1', 'Group A');
const ch2 = channel('ch2', 'Group B');
const ch3 = channel('ch3', 'Group A');
const guide: Record<string, Programme[]> = {
  ch1: [programme('Alpha past', 'Genre A', 1000, 2000), programme('Bravo live', 'Genre B', 9000, 11000)],
  ch2: [programme('Alpha next', 'Genre A', 12000, 13000), programme('Charlie later', 'Genre A', 20000, 21000)],
};
const source = {
  // ch3 shares ch1's guide, which lists its programs once.
  channels: [ch1, ch2, ch3],
  guideId: (c: Channel): string | null => (c.id === 'ch3' ? 'ch1' : c.id),
  programmes: (id: string): Programme[] | null => guide[id] ?? null,
};
const titles = (list: Array<{ programme: Programme }> | null): string[] | null => (
  list ? list.map(item => item.programme.title) : null
);

describe('execute', () => {
  it('counts names, most used first', () => {
    expect(namesByCount(['b', 'a', 'b', ' ', 'c', 'b', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('asks for programs alone when a time is named and no kind is', () => {
    expect(wantsType(filter({}), 'movie', true)).toBe(false);
    expect(wantsType(filter({}), 'program', true)).toBe(true);
    expect(wantsType(filter({ types: ['movie'] }), 'movie', true)).toBe(true);
    expect(wantsType(filter({}), 'channel', false)).toBe(true);
  });

  it('lists the channels of the named groups, keyword matches first', () => {
    expect(askChannels([ch1, ch2, ch3], filter({}), 10)).toBeNull();
    expect(askChannels([ch1, ch2, ch3], filter({ groups: ['Group A'], keywords: ['ch3'] }), 10))
      .toEqual([ch3, ch1]);
  });

  it('orders programs live, then upcoming, then past', () => {
    expect(titles(askPrograms(source, filter({ genres: ['Genre A', 'Genre B'] }), null, NOW, 10)))
      .toEqual(['Bravo live', 'Alpha next', 'Charlie later', 'Alpha past']);
  });

  it('filters programs by group, genre, and time window', () => {
    expect(askPrograms(source, filter({}), null, NOW, 10)).toBeNull();
    expect(titles(askPrograms(source, filter({ groups: ['Group B'], genres: ['Genre A'] }), [[11500, 15000]], NOW, 10)))
      .toEqual(['Alpha next']);
  });

  it('filters by the genre the source gives a program, in place of its category', () => {
    const genre = (p: Programme): string => (p.title === 'Charlie later' ? 'Genre C' : p.category);
    expect(titles(askPrograms({ ...source, genre }, filter({ genres: ['Genre C'] }), null, NOW, 10)))
      .toEqual(['Charlie later']);
  });

  it('narrows by keywords with only a time, and ranks them first with a topic', () => {
    expect(titles(askPrograms(source, filter({ keywords: ['alpha'] }), [[0, 30000]], NOW, 10)))
      .toEqual(['Alpha next', 'Alpha past']);
    expect(titles(askPrograms(source, filter({ genres: ['Genre A'], keywords: ['charlie'] }), null, NOW, 10)))
      .toEqual(['Charlie later', 'Alpha next', 'Alpha past']);
  });

  it('merges keyword matches for names, keeping the rest only under a topic', () => {
    const items = [{ name: 'Alpha one' }, { name: 'Bravo two' }, { name: 'Charlie three' }];
    expect(rankNames(items, ['bravo', 'alpha'], false, 10)).toEqual([items[1], items[0]]);
    expect(rankNames(items, ['charlie'], true, 10)).toEqual([items[2], items[0], items[1]]);
  });
});

describe('interleave', () => {
  it('merges equal programs that arrive as different objects once', () => {
    const one = (): { channel: Channel; channelIndex: number; programme: Programme } => ({
      channel: ch1, channelIndex: 0, programme: programme('Alpha Bravo', '', 1000, 2000),
    });
    expect(interleave([[one()], [one()]], 10, programKey)).toHaveLength(1);
  });
});

describe('matchPrograms', () => {
  it('matches every chunk, a step at a time', () => {
    const candidates = Array.from({ length: 600 }, (_unused, index) => ({
      channel: ch1, channelIndex: 0, programme: programme(index % 300 === 0 ? 'Alpha' : 'Bravo', '', index, index + 1),
    }));
    const matcher = matchPrograms(candidates, ['alpha']);
    let steps = 1;
    while (!matcher.step()) steps++;
    expect(steps).toBe(3);
    expect(matcher.matched.size).toBe(2);
  });
});

describe('AI keyword matching', () => {
  it('lists no program that only a typo or the middle of a word matches', () => {
    const summary = { ...programme('Weekly Summary', 'News', 12000, 13000), description: 'Lo más visto de la semana.' };
    const source9 = { channels: [ch1], guideId: () => 'g', programmes: () => [summary, programme('Smarsh', 'News', 14000, 15000)] };
    expect(titles(askPrograms(source9, filter({ keywords: ['underwater', 'chess', 'tournaments', 'mars'] }), [[0, 30000]], NOW, 10)))
      .toEqual([]);
    expect(titles(askPrograms(source9, filter({ keywords: ['semana', 'mas'] }), [[0, 30000]], NOW, 10)))
      .toEqual(['Weekly Summary']);
  });
});

describe('group names with stray spaces', () => {
  it('match the trimmed names the AI was given', () => {
    const spaced = channel('ch9', 'Sports ');
    const named = filter({ groups: [namesByCount([spaced.group])[0]] });
    expect(askChannels([spaced], named, 10)).toEqual([spaced]);
    const source9 = { channels: [spaced], guideId: () => 'g9', programmes: () => [programme('Alpha', '', 1, 2)] };
    expect(titles(askPrograms(source9, named, null, NOW, 10))).toEqual(['Alpha']);
  });
});

describe('rankPrograms', () => {
  it('keeps the first programs by airing without a full sort', () => {
    const many = Array.from({ length: 500 }, (_unused, index) => ({
      channel: ch1, channelIndex: 0, programme: programme(`P${String(index)}`, 'Genre A', 20000 + (499 - index) * 10, 20005 + (499 - index) * 10),
    }));
    const live = { channel: ch1, channelIndex: 0, programme: programme('Live', 'Genre A', 9000, 11000) };
    const source9 = { channels: [ch1], guideId: () => 'g', programmes: () => many.map(item => item.programme).concat(live.programme) };
    expect(titles(askPrograms(source9, filter({ genres: ['Genre A'] }), null, NOW, 3))).toEqual(['Live', 'P499', 'P498']);
  });
});
