// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CueTranslationDoc } from './cue-translation';
import { planBatches } from './subtitle-translation';
import { parseSubtitleFile } from '../utils/srt';

function doc(...texts: string[]): CueTranslationDoc {
  return new CueTranslationDoc(texts.map((text, k) => ({ start: k, end: k + 1, text })));
}

function sent(...texts: string[]): string[] {
  return doc(...texts).units.map(unit => unit.text);
}

describe('CueTranslationDoc', () => {
  it('sends a cue without markup as it is, and escapes what comes back', () => {
    const cues = doc(' Alpha said hi.\nSee you later. ', '>> Bravo');
    expect(cues.units.map(unit => unit.text)).toEqual([' Alpha said hi.\nSee you later. ', '>> Bravo']);
    expect(cues.texts([0, 1], ['A < B & C\nD', '>> <i>Bravo'])).toEqual(['A &lt; B &amp; C\nD', '&gt;&gt; Bravo']);
  });

  it('sends an SRT cue placed by {\\an8} without the tag, which became its positioning', () => {
    const [cue] = parseSubtitleFile('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Alpha</i>\n');
    expect(cue.settings).toEqual({ line: 0, snapToLines: true });
    const cues = new CueTranslationDoc([cue]);
    expect(cues.units[0].text).toBe('Alpha');
    expect(cues.texts([0], ['Alfa'])).toEqual(['<i>Alfa</i>']);
  });

  it('keeps a position block and edge styling on the device', () => {
    const cues = doc('{\\an8}Alpha', '<i>{\\an8}Bravo here</i>', '<v Speaker 1>Charlie</v>');
    expect(cues.units.map(unit => unit.text)).toEqual(['Alpha', 'Bravo here', 'Charlie']);
    expect(cues.texts([0, 1, 2], ['Alfa', 'Bravo hier', 'Carla'])).toEqual([
      '{\\an8}Alfa',
      '<i>{\\an8}Bravo hier</i>',
      '<v Speaker 1>Carla</v>',
    ]);
  });

  it('sends inner markup as markers and puts it back where the reply has them', () => {
    const cues = doc('<font color="#ff0000">Hello</font> my <i>friend</i>', '<c.yellow>Hi</c> <00:00:01.000>there');
    expect(cues.units.map(unit => unit.text)).toEqual(['Hello<x1/> my <i>friend</i>', 'Hi<x1/> <x2/>there']);
    expect(cues.texts([0, 1], ['Hallo<x1/> mein <i>Freund</i>', 'Hallo<x1/> <x2/>da'])).toEqual([
      '<font color="#ff0000">Hallo</font> mein <i>Freund</i>',
      '<c.yellow>Hallo</c> <00:00:01.000>da',
    ]);
    expect(cues.tagsDropped).toBe(0);
  });

  it('drops the inner styling, and an edge tag closed inside, when the reply mangles the markers', () => {
    const cues = doc('<font color="#ff0000">Hello</font> my <i>friend</i>', '<v Bob>Hi <b>there</b>');
    expect(cues.texts([0, 1], ['Hallo mein <i>Freund', '<b>Hallo</b> da<x1/>'])).toEqual([
      'Hallo mein Freund',
      '<v Bob>Hallo da',
    ]);
    expect(cues.tagsDropped).toBe(2);
  });

  it('keeps the colors and italics of a cue styled word by word', () => {
    const cues = doc(
      '<c.yellow>Hi</c> <c.cyan>there</c>, <c.white>and</c> you',
      '{\\an8}<font color="#ff0">- Hello <i>there</i> you</font>\n<i>- second</i>',
    );
    expect(cues.units.map(unit => unit.text)).toEqual([
      'Hi<x1/> <x2/>there<x3/>, <x4/>and<x5/> you',
      '- Hello <i>there</i> you<x1/>\n<i>- second</i>',
    ]);
    expect(cues.texts([0, 1], [
      'Hallo<x1/> <x2/>da<x3/>, <x4/>und<x5/> du',
      '- Hallo <i>da</i> du<x1/>\n<i>- zweite</i>',
    ])).toEqual([
      '<c.yellow>Hallo</c> <c.cyan>da</c>, <c.white>und</c> du',
      '{\\an8}<font color="#ff0">- Hallo <i>da</i> du</font>\n<i>- zweite</i>',
    ]);
    expect(cues.tagsDropped).toBe(0);
  });

  it('keeps the line breaks of a multi-line cue', () => {
    const cues = doc('<i>- Alpha</i>\n<i>- Bravo</i>');
    expect(cues.units[0].text).toBe('<i>- Alpha</i>\n<i>- Bravo</i>');
    expect(cues.texts([0], ['<i>- Alfa</i>\n<i>- Bravo</i>'])).toEqual(['<i>- Alfa</i>\n<i>- Bravo</i>']);
  });

  it('sends entities as the characters they stand for and escapes them again', () => {
    const cues = doc('Alpha &amp; Bravo&nbsp;&lt;3 &#x41;');
    expect(cues.units[0].text).toBe('Alpha & Bravo\u00a0<3 A');
    expect(cues.texts([0], ['Alfa & Bravo\u00a0<3 A'])).toEqual(['Alfa &amp; Bravo\u00a0&lt;3 A']);
  });

  it('leaves ruby readings out of a translation, for one ruby word or many', () => {
    const one = '<ruby>Al<rt>l1</rt></ruby>pha';
    const three = '<ruby>A<rt>l1</rt></ruby>b<ruby>C<rt>l2</rt></ruby>d<ruby>E<rt>l3</rt></ruby>f';
    const cues = doc(one, three, '<i><ruby>G<rt>l4</ruby>h</i>');
    expect(cues.units.map(unit => unit.text)).toEqual(['Alpha', 'AbCdEf', 'Gh']);
    expect(cues.texts([0, 1, 2], ['Alfa', 'aBcDeF', 'gH'])).toEqual(['Alfa', 'aBcDeF', '<i>gH</i>']);
  });

  it('sends nothing for a cue of markup alone', () => {
    expect(sent('{\\an8}', '<i> </i>')).toEqual(['', '']);
  });

  it('keeps only an edge tag still paired when nested tags of one name lose their markers', () => {
    const cues = doc(
      '<c.a>A <c.b>B</c></c>',
      '<font color="red">A <font size="2">B</font></font>',
      '<lang l1>A</lang> <lang l2>B</lang>',
    );
    expect(cues.units.map(unit => unit.text)).toEqual(['A <x1/>B', 'A <x1/>B', 'A<x1/> <x2/>B']);
    expect(cues.texts([0, 1, 2], ['x', 'y', 'z'])).toEqual([
      '<c.a>x</c>',
      '<font color="red">y</font>',
      'z',
    ]);
  });

  it('drops the inner markup when the reply swaps markers so a tag would close before it opens', () => {
    const cues = doc('A <font color="red">B</font> C');
    expect(cues.units[0].text).toBe('A <x1/>B<x2/> C');
    expect(cues.texts([0], ['A <x2/>B<x1/> C'])).toEqual(['A B C']);
    expect(cues.tagsDropped).toBe(1);
  });

  it('never leaves more tags unpaired than the cue had, whatever the reply does with the markers', () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 16807) % 2147483647;
      return seed % n;
    };
    const tags: Array<[string, string]> = [
      ['<i>', '</i>'], ['<b>', '</b>'], ['<c.a>', '</c>'], ['<c.b>', '</c>'],
      ['<font color="red">', '</font>'], ['<lang l1>', '</lang>'], ['<v A>', '</v>'],
    ];
    const tree = (depth: number): string => {
      let out = '';
      for (let k = random(3) + 1; k > 0; k--) {
        const pick = random(depth > 2 ? 2 : 4);
        if (pick === 0) out += ['Alpha ', 'Bravo', ' Charlie', '{\\an8}', '<00:00:01.000>'][random(5)];
        else if (pick === 1) out += 'Delta ';
        else {
          const [open, close] = tags[random(tags.length)];
          out += open + tree(depth + 1) + close;
        }
      }
      return out;
    };
    const unpaired = (text: string): number => {
      const open: string[] = [];
      let lost = 0;
      (text.match(/<\/?[a-z][^<>]*>/gi) ?? []).forEach((tag) => {
        const name = /^<(\/?)([a-z]+)/i.exec(tag)!;
        if (!name[1]) open.push(name[2]);
        else if (open[open.length - 1] === name[2]) open.pop();
        else lost++;
      });
      return lost + open.length;
    };
    for (let run = 0; run < 300; run++) {
      const source = tree(0);
      const cues = doc(source);
      const markers = cues.units[0].text.match(/<\/?[ibus]>|<x\d+\/>/g) ?? [];
      const shuffled = markers.slice().sort(() => random(3) - 1);
      const reply = ['w ' + shuffled.join(' w ') + ' w', markers.slice(1).join(' w '), 'w'][random(3)];
      const [text] = cues.texts([0], [reply]);
      expect(unpaired(text), `${source} -> ${text}`).toBeLessThanOrEqual(unpaired(source));
    }
  });

  it('decodes any named entity before sending', () => {
    const cues = doc('Caf&eacute; &hellip; &amp;');
    expect(cues.units[0].text).toBe('Caf\u00e9 \u2026 &');
    expect(cues.texts([0], ['Caf\u00e9 \u2026 &'])).toEqual(['Caf\u00e9 \u2026 &amp;']);
  });

  it('plans batches on the cues as they were, so plain batches keep their cache', () => {
    const cues = Array.from({ length: 30 }, (_, k) => ({
      start: k,
      end: k + 1,
      text: k % 7 === 3 ? `<c.alpha.bravo.charlie.delta>Line ${k}</c> {\\an8}<font color="#ff0000">x</font>` : `Line ${k} of the plain dialogue here`,
    }));
    const units = new CueTranslationDoc(cues).units;
    expect(planBatches(units, 1000)).toEqual(planBatches(cues, 1000));
    expect(planBatches(units, 1000).length).toBeGreaterThan(1);
  });
});
