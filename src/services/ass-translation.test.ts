import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssTranslationDoc, reassemble, RedrawThrottle, type Marker } from './ass-translation';
import { batchOrder, planBatches } from './subtitle-translation';

const HEAD = [
  '[Script Info]',
  'Title: Alpha',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];

function ass(...events: string[]): string {
  return HEAD.concat(events).join('\n');
}

function dialogue(text: string, start = '0:00:01.00', end = '0:00:02.00', layer = 0): string {
  return `Dialogue: ${layer},${start},${end},Default,Speaker,0,0,0,,${text}`;
}

// Translates every unit by upper-casing what is outside its tags.
function translateAll(doc: AssTranslationDoc, map: (text: string) => string = upper): string {
  doc.apply(doc.units.map((_, k) => k), doc.units.map(unit => map(unit.text)));
  return doc.build();
}

function upper(text: string): string {
  return text.replace(/(<[^>]+>)|([^<]+)/g, (_, tag: string, words: string) => tag || words.toUpperCase());
}

function lastLine(content: string): string {
  const lines = content.split('\n');
  return lines[lines.length - 1];
}

describe('AssTranslationDoc', () => {
  it('sends only the text and keeps the leading tags, the fields, and every other line', () => {
    const source = ass(dialogue('{\\an8\\pos(320,40)\\c&H00FFFF&}Alpha said hi.\\NSee you later.'));
    const doc = AssTranslationDoc.parse(source)!;
    expect(doc.units).toEqual([{ start: 1, end: 2, text: 'Alpha said hi.\nSee you later.' }]);

    doc.apply([0], ['Alpha grüßte.\nBis später.']);
    const out = doc.build();
    expect(out.split('\n').slice(0, -1)).toEqual(source.split('\n').slice(0, -1));
    expect(lastLine(out)).toBe(
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,Speaker,0,0,0,,{\\an8\\pos(320,40)\\c&H00FFFF&}Alpha grüßte.\\NBis später.');
  });

  it('turns line-internal blocks into markers and puts them back where the reply has them', () => {
    const doc = AssTranslationDoc.parse(ass(dialogue('{\\fad(200,200)}I {\\i1}really{\\i0} mean {\\c&H0000FF&}it{\\c}.')))!;
    expect(doc.units[0].text).toBe('I <i>really</i> mean <x1/>it<x2/>.');

    doc.apply([0], ['Ich <x1/>meine<x2/> es <i>wirklich</i>.']);
    expect(lastLine(doc.build())).toMatch(/,,\{\\fad\(200,200\)\}Ich \{\\c&H0000FF&\}meine\{\\c\} es \{\\i1\}wirklich\{\\i0\}\.$/);
    expect(doc.tagsDropped).toBe(0);
  });

  it('drops the line-internal styling when the reply loses a marker', () => {
    const doc = AssTranslationDoc.parse(ass(dialogue('{\\fad(200,200)}I {\\i1}really{\\i0} mean {\\c&H0000FF&}it{\\c}.')))!;
    doc.apply([0], ['Ich meine <i>es</i> <x1/>wirklich.']);
    expect(lastLine(doc.build())).toMatch(/,,\{\\fad\(200,200\)\}Ich meine es wirklich\.$/);
    expect(doc.tagsDropped).toBe(1);
  });

  it('keeps drawings out of the text sent and in the line as they were', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\p1\\c&H202020&}m 0 0 l 100 0 100 30 0 30{\\p0\\pos(50,50)}Bravo Store'),
      dialogue('{\\p1}m 0 0 l 10 0 10 10'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['Bravo Store']);
    expect(doc.skipped).toBe(1);
    expect(lastLine(translateAll(doc))).toBe('Dialogue: 0,0:00:01.00,0:00:02.00,Default,Speaker,0,0,0,,{\\p1}m 0 0 l 10 0 10 10');
    expect(translateAll(doc).split('\n').slice(-2)[0])
      .toMatch(/,,\{\\p1\\c&H202020&\}m 0 0 l 100 0 100 30 0 30\{\\p0\\pos\(50,50\)\}BRAVO STORE$/);
  });

  it('keeps a drawing between text runs as one marker', () => {
    const doc = AssTranslationDoc.parse(ass(dialogue('Alpha {\\p1}m 0 0 l 5 5{\\p0}Bravo')))!;
    expect(doc.units[0].text).toBe('Alpha <x1/>Bravo');
    expect(lastLine(translateAll(doc))).toMatch(/,,ALPHA \{\\p1\}m 0 0 l 5 5\{\\p0\}BRAVO$/);
  });

  it('skips comments, karaoke, empty lines, and zero-length events', () => {
    const doc = AssTranslationDoc.parse(ass(
      'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Alpha note',
      dialogue('{\\k20}a{\\k30}ri{\\kf25}ga'),
      dialogue('{\\an8}\\h\\N'),
      dialogue('Bravo', '0:00:03.00', '0:00:03.00'),
      dialogue('Charlie'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['Charlie']);
    expect(doc.skipped).toBe(3);
    const out = translateAll(doc);
    expect(out).toContain('Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Alpha note');
    expect(out).toContain('{\\k20}a{\\k30}ri{\\kf25}ga');
    expect(out).toContain(',,CHARLIE');
  });

  it('sends one unit for text repeated across layers and events, and translates each the same', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\bord4\\c&H000000&}Delta', '0:00:05.00', '0:00:06.00', 0),
      dialogue('{\\c&HFFFFFF&}Delta', '0:00:05.00', '0:00:06.00', 1),
      dialogue('{\\pos(10,10)}Delta', '0:00:09.00', '0:00:10.00'),
    ))!;
    expect(doc.units).toEqual([{ start: 5, end: 6, text: 'Delta' }]);
    const out = translateAll(doc).split('\n').slice(-3);
    expect(out[0]).toMatch(/\{\\bord4\\c&H000000&\}DELTA$/);
    expect(out[1]).toMatch(/\{\\c&HFFFFFF&\}DELTA$/);
    expect(out[2]).toMatch(/\{\\pos\(10,10\)\}DELTA$/);
  });

  it('orders units by time, so typesetting listed after the dialogue goes in its batch', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('Late', '0:01:00.00', '0:01:02.00'),
      dialogue('Early', '0:00:01.00', '0:00:02.00'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['Early', 'Late']);
    expect(lastLine(translateAll(doc))).toMatch(/,,EARLY$/);
  });

  it('flattens heavy typesetting into plain text and keeps its leading block', () => {
    const doc = AssTranslationDoc.parse(ass(dialogue('{\\pos(5,5)}A{\\c&H1&}l{\\c&H2&}p{\\c&H3&}h{\\c&H4&}a{\\c&H5&}!')))!;
    expect(doc.units[0].text).toBe('Alpha!');
    doc.apply([0], ['Alfa!']);
    expect(lastLine(doc.build())).toMatch(/,,\{\\pos\(5,5\)\}Alfa!$/);
    expect(doc.tagsDropped).toBe(1);
  });

  it('keeps \\h padding and edge line breaks, and sends \\n as a space unless \\q2 makes it a break', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('\\h\\hAlpha\\nBravo\\h'),
      dialogue('{\\q2}Charlie\\nDelta', '0:00:03.00', '0:00:04.00'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['Alpha Bravo', 'Charlie\nDelta']);
    const out = translateAll(doc).split('\n').slice(-2);
    expect(out[0]).toMatch(/,,\\h\\hALPHA BRAVO\\h$/);
    expect(out[1]).toMatch(/,,\{\\q2\}CHARLIE\\NDELTA$/);
  });

  it('reads a custom Format order, commas in the text, CRLF, a BOM, and SSA files', () => {
    const source = '\uFEFF[Script Info]\r\nScriptType: v4.00\r\n\r\n[Events]\r\n'
      + 'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n'
      + 'Dialogue: Marked=0,0:00:01.00,0:00:02.50,Default,,0000,0000,0000,,Well, Alpha, well.\r\n';
    const doc = AssTranslationDoc.parse(source)!;
    expect(doc.units).toEqual([{ start: 1, end: 2.5, text: 'Well, Alpha, well.' }]);
    doc.apply([0], ['Nun, Alpha, nun.']);
    expect(doc.build()).toBe(source.replace('Well, Alpha, well.', 'Nun, Alpha, nun.'));
  });

  it('batches a repeated line by its earliest showing, so later batches still go first after a seek', () => {
    const at = (s: number): string => `0:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const lines = Array.from({ length: 80 }, (_, i) => dialogue(i === 39 ? 'Echo' : `Line ${i}`, `${at(i)}.00`, `${at(i)}.50`));
    const doc = AssTranslationDoc.parse(ass(...lines, dialogue('Echo', '0:01:30.00', '0:01:31.00')))!;
    expect(doc.units[39]).toEqual({ start: 39, end: 39.5, text: 'Echo' });
    const batches = planBatches(doc.units, 16000);
    expect(batches.map(batch => batch.length)).toEqual([40, 40]);
    expect(batchOrder(batches, doc.units, 70)[0]).toBe(1);
    // A redraw still sees the later copy near playback.
    expect(doc.touches([39], 85, 95)).toBe(true);
  });

  it('carries an edge toggle paired inside the line as a marker', () => {
    const start = AssTranslationDoc.parse(ass(dialogue('{\\an8}{\\i1}Title{\\i0} said Bravo')))!;
    expect(start.units[0].text).toBe('<i>Title</i> said Bravo');
    start.apply([0], ['Bravo sagte <i>Titel</i>']);
    expect(lastLine(start.build())).toMatch(/,,\{\\an8\}Bravo sagte \{\\i1\}Titel\{\\i0\}$/);

    const end = AssTranslationDoc.parse(ass(dialogue('Bravo said {\\i1}Title{\\i0}{\\fad(1,1)}')))!;
    expect(end.units[0].text).toBe('Bravo said <i>Title</i>');
    end.apply([0], ['<i>Titel</i>, sagte Bravo']);
    expect(lastLine(end.build())).toMatch(/,,\{\\i1\}Titel\{\\i0\}, sagte Bravo\{\\fad\(1,1\)\}$/);
  });

  it('keeps whole-line toggles when the reply loses the markers, and drops an edge toggle paired inside', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\an8}{\\i1}Hello {\\b1}world{\\b0}'),
      dialogue('{\\i1} Charlie{\\i0} Delta', '0:00:03.00', '0:00:04.00'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['Hello <b>world</b>', 'Charlie<x1/> Delta']);
    doc.apply([0, 1], ['Hola mundo', 'Charlie Delta</i>']);
    const out = doc.build().split('\n').slice(-2);
    expect(out[0]).toMatch(/,,\{\\an8\}\{\\i1\}Hola mundo$/);
    expect(out[1]).toMatch(/,, Charlie Delta$/);
    expect(doc.tagsDropped).toBe(2);
  });

  it('drops a toggle paired inside the line from a mixed edge block when the reply loses the markers', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\pos(1,2)\\i1}A{\\i0}B'),
      dialogue('{\\i1}C{\\b0}D{\\fad(1,1)\\b1}', '0:00:03.00', '0:00:04.00'),
      dialogue('{\\an8\\b1}E{\\i0\\b0}F', '0:00:05.00', '0:00:06.00'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['A<x1/>B', 'C<x1/>D', 'E<x1/>F']);
    doc.apply([0, 1, 2], ['AB', 'CD', 'EF']);
    const out = doc.build().split('\n').slice(-3);
    expect(out[0]).toMatch(/,,\{\\pos\(1,2\)\}AB$/);
    expect(out[1]).toMatch(/,,\{\\i1\}CD\{\\fad\(1,1\)\}$/);
    expect(out[2]).toMatch(/,,\{\\an8\}EF$/);
  });

  it('reads a reset inside the line as turning the edge toggles off when the reply loses the markers', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\pos(1,2)\\i1}A{\\r}B'),
      dialogue('{\\i1}C{\\rAlt}D', '0:00:03.00', '0:00:04.00'),
      dialogue('{\\u1}E{\\rnd2}F', '0:00:05.00', '0:00:06.00'),
    ))!;
    doc.apply([0, 1, 2], ['ZZZ', 'YYY', 'XXX']);
    const out = doc.build().split('\n').slice(-3);
    expect(out[0]).toMatch(/,,\{\\pos\(1,2\)\}ZZZ$/);
    expect(out[1]).toMatch(/,,YYY$/);
    expect(out[2]).toMatch(/,,\{\\u1\}XXX$/);
  });

  it('keeps an edge toggle turned off when the reply loses the markers', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\an8\\i0}A{\\i1}B'),
      dialogue('{\\i0}C {\\i1}D', '0:00:03.00', '0:00:04.00'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['A<x1/>B', 'C <x1/>D']);
    doc.apply([0, 1], ['XX', 'YY']);
    const out = doc.build().split('\n').slice(-2);
    expect(out[0]).toMatch(/,,\{\\an8\\i0\}XX$/);
    expect(out[1]).toMatch(/,,\{\\i0\}YY$/);
  });

  it('reads \\b400 as not bold when the reply loses the markers', () => {
    const doc = AssTranslationDoc.parse(ass(dialogue('{\\pos(1,2)\\b700}A{\\b400}B')))!;
    expect(doc.units[0].text).toBe('A<x1/>B');
    doc.apply([0], ['AB']);
    expect(lastLine(doc.build())).toMatch(/,,\{\\pos\(1,2\)\}AB$/);
  });

  it('keeps an edge toggle facing away from the text out of what is sent', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('A{\\i1}B{\\i0}C{\\i1}'),
      dialogue('{\\i0}D{\\i1}E{\\i0}', '0:00:03.00', '0:00:04.00'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['A<i>B</i>C', 'D<i>E</i>']);
    doc.apply([0, 1], ['a<i>b</i>c', 'd<i>e</i>']);
    const out = doc.build().split('\n').slice(-2);
    expect(out[0]).toMatch(/,,a\{\\i1\}b\{\\i0\}c\{\\i1\}$/);
    expect(out[1]).toMatch(/,,\{\\i0\}d\{\\i1\}e\{\\i0\}$/);
    expect(doc.tagsDropped).toBe(0);
  });

  it('keeps a whole-line toggle on a flattened line', () => {
    const doc = AssTranslationDoc.parse(ass(dialogue('{\\i1}A{\\c&H1&}l{\\c&H2&}p{\\c&H3&}h{\\c&H4&}a{\\c&H5&}!')))!;
    expect(doc.units[0].text).toBe('Alpha!');
    doc.apply([0], ['Alfa!']);
    expect(lastLine(doc.build())).toMatch(/,,\{\\i1\}Alfa!$/);
  });

  it('sends a toggle with no partner in the line as a kept block', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\pos(1,2)\\i1}Hello{\\i0} world'),
      dialogue('Hello {\\i0}world', '0:00:03.00', '0:00:04.00'),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['Hello<x1/> world', 'Hello <x1/>world']);
    doc.apply([0, 1], ['<i>Hola</i> mundo', 'Hola <x1/>mundo']);
    const out = doc.build().split('\n').slice(-2);
    expect(out[0]).toMatch(/,,\{\\pos\(1,2\)\}Hola mundo$/);
    expect(out[1]).toMatch(/,,Hola \{\\i0\}mundo$/);
  });

  it('sends layers that differ only in their unpaired toggles once', () => {
    const doc = AssTranslationDoc.parse(ass(
      dialogue('{\\pos(1,2)\\i1}Hello{\\i0} world', '0:00:01.00', '0:00:02.00', 0),
      dialogue('{\\pos(1,2)\\b1}Hello{\\b0} world', '0:00:01.00', '0:00:02.00', 1),
    ))!;
    expect(doc.units.map(unit => unit.text)).toEqual(['Hello<x1/> world']);
    doc.apply([0], ['Hola<x1/> mundo']);
    const out = doc.build().split('\n').slice(-2);
    expect(out[0]).toMatch(/,,\{\\pos\(1,2\)\\i1\}Hola\{\\i0\} mundo$/);
    expect(out[1]).toMatch(/,,\{\\pos\(1,2\)\\b1\}Hola\{\\b0\} mundo$/);
  });

  it('keeps an inline drawing in place when it flattens heavy typesetting', () => {
    const doc = AssTranslationDoc.parse(ass(dialogue('{\\pos(5,5)}A{\\c&H1&}l{\\c&H2&}p{\\c&H3&}h{\\p1}m 0 0 l 4 4{\\p0}a{\\c&H5&}!')))!;
    expect(doc.units[0].text).toBe('Alph<x1/>a!');
    doc.apply([0], ['Alf<x1/>a!']);
    expect(lastLine(doc.build())).toMatch(/,,\{\\pos\(5,5\)\}Alf\{\\p1\}m 0 0 l 4 4\{\\p0\}a!$/);
  });

  it('leaves out sections assjs does not read', () => {
    const source = ass(dialogue('Alpha')).replace('[Events]', '[Fonts]\nfontname: a.ttf\nAAAA\n\n[Graphics]\nfilename: b.png\nBBBB\n\n[Events]');
    const doc = AssTranslationDoc.parse(source)!;
    doc.apply([0], ['Alfa']);
    const out = doc.build();
    expect(out).not.toMatch(/\[Fonts\]|AAAA|\[Graphics\]|BBBB/);
    expect(out).toBe(ass(dialogue('Alfa')));
  });

  it('is null for a file with nothing to translate', () => {
    expect(AssTranslationDoc.parse(ass('Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Alpha', dialogue('{\\k20}a{\\k30}b')))).toBeNull();
  });

  it('is null for a file with no events to translate', () => {
    expect(AssTranslationDoc.parse('1\n00:00:01,000 --> 00:00:02,000\nAlpha\n')).toBeNull();
  });

  it('builds the source unchanged before any translation lands', () => {
    const source = ass(dialogue('{\\i1}Alpha{\\i0}'));
    expect(AssTranslationDoc.parse(source)!.build()).toBe(source);
  });
});

function parts(prefix: string, markers: Marker[]) {
  return { prefix, suffix: '', barePrefix: prefix, bareSuffix: '', markers };
}

describe('reassemble', () => {
  it('never lets the reply open an override block or an escape', () => {
    expect(reassemble(parts('{\\an8}', []), 'Alpha {\\pos(1,1)} \\N Bravo\nCharlie').text)
      .toBe('{\\an8}Alpha pos(1,1) N Bravo\\NCharlie');
  });

  it('puts repeated toggles back in order, and drops a marker the reply invented', () => {
    const markers = [
      { token: '<i>', raw: '{\\i1}' }, { token: '</i>', raw: '{\\i0}' },
      { token: '<i>', raw: '{\\i1\\c}' }, { token: '</i>', raw: '{\\i}' },
    ];
    expect(reassemble(parts('', markers), '<i>A</i> <i>B</i>').text).toBe('{\\i1}A{\\i0} {\\i1\\c}B{\\i}');
    expect(reassemble(parts('', markers), '<i>A</i> <i>B</i> <x1/>')).toEqual({ text: 'A B ', dropped: true });
  });

  it('drops the styling when a closing marker comes before its opening one', () => {
    const markers = [{ token: '<i>', raw: '{\\i1}' }, { token: '</i>', raw: '{\\i0}' }];
    expect(reassemble(parts('', markers), '</i>A<i> B')).toEqual({ text: 'A B', dropped: true });
  });
});

describe('RedrawThrottle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('redraws soon for a change near playback and at most every 60 s otherwise', () => {
    vi.useFakeTimers();
    const redraw = vi.fn();
    const throttle = new RedrawThrottle(redraw);
    throttle.changed(false);
    vi.advanceTimersByTime(1000);
    expect(redraw).toHaveBeenCalledTimes(1);

    throttle.changed(false);
    vi.advanceTimersByTime(10000);
    expect(redraw).toHaveBeenCalledTimes(1);
    throttle.changed(true);
    vi.advanceTimersByTime(1000);
    expect(redraw).toHaveBeenCalledTimes(2);

    throttle.changed(false);
    vi.advanceTimersByTime(59000);
    expect(redraw).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(redraw).toHaveBeenCalledTimes(3);

    throttle.changed(false);
    throttle.flush();
    expect(redraw).toHaveBeenCalledTimes(4);
    throttle.flush();
    expect(redraw).toHaveBeenCalledTimes(4);

    throttle.changed(false);
    throttle.cancel();
    vi.advanceTimersByTime(60000);
    expect(redraw).toHaveBeenCalledTimes(4);
  });
});
