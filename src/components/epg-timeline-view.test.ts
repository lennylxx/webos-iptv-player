// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Programme } from '../types';
import { GuideTimeline, type CellMarks, type TimelineRow, type TimelineSource } from './epg-timeline';
import { TimelineView } from './epg-timeline-view';

const DAY = new Date(2024, 5, 15);
const at = (h: number, m = 0) => new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate(), h, m).getTime();

function prog(h1: number, m1: number, h2: number, m2: number, title: string): Programme {
  return { start: new Date(at(h1, m1)), stop: new Date(at(h2, m2)), title, description: '', category: '', icon: '' };
}

let rows: Programme[][];
let names: string[];
let locks: TimelineRow['lock'][];
let numbers: number[];
let marks: (programme: Programme) => CellMarks;
let revision = 0;

const source: TimelineSource = {
  rowCount: () => rows.length,
  row: (index) => ({ number: numbers[index] ?? index + 1, name: names[index] ?? `ch${index + 1}`, lock: locks[index] ?? null }),
  programmes: (index, from, to) => rows[index]
    .filter(p => p.stop.getTime() > from && p.start.getTime() < to)
    .sort((a, b) => a.start.getTime() - b.start.getTime()),
  revision: () => `${rows.length}|${revision}`,
  rowsKey: () => String(rows.length),
  maxNumber: () => rows.reduce((max, _row, i) => Math.max(max, numbers[i] ?? i + 1), 0),
  bounds: () => ({ min: at(0), max: at(23) }),
  marks: (_index, programme) => marks(programme),
};

let host: HTMLElement;

function setup(height = 52 + 80 * 4, fontScale = 1): { tl: GuideTimeline; view: TimelineView; draw: () => void } {
  const tl = new GuideTimeline(source);
  tl.setFontScale(fontScale);
  tl.setHeight(height);
  tl.reset(Date.now());
  const view = new TimelineView(tl);
  view.setStyle({ fontFamily: 'sans-serif', emptyLabel: 'No information' });
  return { tl, view, draw: () => { view.draw(host, Date.now(), 0); } };
}

const shownRows = () => Array.from(host.querySelectorAll<HTMLElement>('.tl-row'))
  .filter(row => row.style.visibility !== 'hidden');
const shownCells = (row: Element) => Array.from(row.querySelectorAll<HTMLElement>('.tl-cell'))
  .filter(cell => cell.style.display !== 'none');
const rowAt = (index: number) => shownRows().find(row => row.style.top === `${index * 80}px`)!;
const cellTitled = (row: Element, title: string) =>
  shownCells(row).find(cell => cell.querySelector('.tl-title')?.textContent === title);
const shown = (el: Element | null | undefined) => !!el && (el as HTMLElement).style.display !== 'none';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(12, 10));
  // Text measures half its font size a letter.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const ctx = {
      font: '',
      measureText: (text: string) => ({ width: text.length * parseInt(/(\d+)px/.exec(ctx.font)?.[1] ?? '20', 10) / 2 }),
    };
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  rows = [
    [prog(11, 30, 12, 0, 'Aired'), prog(12, 0, 12, 30, 'Live'), prog(12, 30, 14, 0, 'Next'), prog(14, 0, 15, 0, 'Later')],
    [prog(12, 0, 13, 0, 'B1'), prog(13, 0, 15, 0, 'B2')],
    [],
  ];
  names = [];
  locks = [];
  numbers = [];
  marks = () => ({ reminder: false, replay: false });
  revision = 0;
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TimelineView', () => {
  it('shows the ruler, the now line, and each row with its cells by airing state', () => {
    const { draw } = setup();
    draw();

    expect(Array.from(host.querySelectorAll('.tl-ruler-label')).map(l => l.textContent))
      .toEqual(['12:00', '12:30', '13:00', '13:30', '14:00', '14:30']);
    // 12:10 is an eighteenth of the way along the 1440px page from x=480.
    const nowX = Math.round(480 + 1440 * 10 / 180);
    expect(host.querySelector<HTMLElement>('.tl-now-line')!.style.left).toBe(`${nowX - 1}px`);
    expect(host.querySelector<HTMLElement>('.tl-ruler-now')!.style.left).toBe(`${nowX - 7}px`);

    expect(shownRows()).toHaveLength(3);
    const first = rowAt(0);
    expect(first.querySelector('.tl-num')?.textContent).toBe('1');
    expect(first.querySelector('.tl-name')?.textContent).toBe('ch1');
    expect(first.querySelector('.tl-name')?.classList.contains('is-focused')).toBe(true);
    expect(shownCells(first).map(c => c.querySelector('.tl-title')?.textContent)).toEqual(['Live', 'Next', 'Later']);
    const live = cellTitled(first, 'Live')!;
    expect(live.className).toContain('is-live');
    expect(live.querySelector('.tl-time')?.textContent).toBe('12:00 – 12:30');
    // The live cell starts half a gap after 12:00, at x=482, and fills up to now.
    expect(live.querySelector<HTMLElement>('.tl-prog')!.style.width).toBe(`${nowX - 482}px`);
    expect(cellTitled(first, 'Next')!.className).not.toMatch(/is-live|is-aired/);
    expect(shown(cellTitled(first, 'Next')!.querySelector('.tl-prog'))).toBe(false);

    const empty = shownCells(rowAt(2));
    expect(empty).toHaveLength(1);
    expect(empty[0].className).toContain('is-empty');
    expect(empty[0].textContent).toBe('No information');
  });

  it('marks aired programs past the now line and the minute that ends one', () => {
    const { tl, draw } = setup();
    tl.move('left', false);
    draw();
    const aired = cellTitled(rowAt(0), 'Aired')!;
    expect(aired.className).toContain('is-aired');

    vi.setSystemTime(at(12, 31));
    draw();
    expect(cellTitled(rowAt(0), 'Live')!.className).toContain('is-aired');
    expect(cellTitled(rowAt(0), 'Next')!.className).toContain('is-live');
  });

  it('shows a bell on a reminded program and a replay mark on an archived one', () => {
    marks = (p) => ({ reminder: p.title === 'Next', replay: p.title === 'Live' });
    const { draw } = setup();
    draw();

    expect(shown(cellTitled(rowAt(0), 'Next')!.querySelector('.tl-bell'))).toBe(true);
    expect(cellTitled(rowAt(0), 'Later')!.querySelector('.tl-bell')).toBeNull();
    expect(shown(cellTitled(rowAt(0), 'Live')!.querySelector('.tl-time .tl-replay'))).toBe(true);

    marks = () => ({ reminder: false, replay: false });
    revision++;
    draw();
    expect(shown(cellTitled(rowAt(0), 'Next')!.querySelector('.tl-bell'))).toBe(false);
    expect(shown(cellTitled(rowAt(0), 'Live')!.querySelector('.tl-replay'))).toBe(false);
  });

  it('fits a title to its cell and drops the time a narrow cell has no room for', () => {
    rows[0] = [prog(12, 0, 12, 10, 'Detective Story'), prog(12, 10, 13, 0, 'Long Show')];
    const { draw } = setup();
    draw();
    const narrow = shownCells(rowAt(0))[0];

    expect(narrow.className).toContain('narrow');
    expect(narrow.className).toContain('no-time');
    expect(narrow.querySelector('.tl-title')?.textContent).toMatch(/^D.*…$/);
    expect(narrow.querySelector('.tl-time')?.textContent).toBe('');
    expect(cellTitled(rowAt(0), 'Long Show')!.querySelector('.tl-time')?.textContent).toBe('12:10 – 13:00');
  });

  it('keeps every node on a focus move within the page, moving only the band', () => {
    const { tl, draw } = setup();
    draw();
    const before = Array.from(host.querySelectorAll('*'));
    const texts = before.map(el => el.textContent);

    tl.move('down', false);
    tl.move('right', false);
    draw();

    expect(Array.from(host.querySelectorAll('*'))).toEqual(before);
    expect(Array.from(host.querySelectorAll('*')).map(el => el.textContent)).toEqual(texts);
    expect(host.querySelector<HTMLElement>('.tl-band')!.style.transform).toBe('translate3d(0, 80px, 0)');
    expect(rowAt(1).querySelector('.tl-name')?.classList.contains('is-focused')).toBe(true);
    expect(rowAt(0).querySelector('.tl-name')?.classList.contains('is-focused')).toBe(false);
  });

  it('moves the nodes of programs still on screen when the page turns', () => {
    rows[0] = [prog(12, 0, 13, 0, 'One'), prog(13, 0, 14, 40, 'Two'), prog(14, 40, 16, 0, 'Three')];
    const { tl, draw } = setup();
    draw();
    const one = cellTitled(rowAt(0), 'One')!;
    const two = cellTitled(rowAt(0), 'Two')!;
    const left = two.style.left;

    tl.move('right', false);
    tl.move('right', false);
    expect(tl.windowStartMs).toBe(at(12, 30));
    draw();

    expect(cellTitled(rowAt(0), 'One')).toBe(one);
    expect(one.className).toContain('clip-l');
    expect(cellTitled(rowAt(0), 'Two')).toBe(two);
    expect(two.style.left).not.toBe(left);
  });

  it('binds only the rows on screen and reuses their nodes as the rows scroll', () => {
    rows = Array.from({ length: 100 }, (_, i) => [prog(12, 0, 13, 0, `P${i}`)]);
    const { tl, draw } = setup(52 + 80 * 6);
    draw();
    // Six rows on screen and one of overscan below.
    expect(shownRows().map(row => row.querySelector('.tl-num')?.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7']);

    for (let i = 0; i < 6; i++) tl.move('page-down', false);
    draw();

    const numbers = shownRows().map(row => Number(row.querySelector('.tl-num')?.textContent)).sort((a, b) => a - b);
    expect(numbers[0]).toBeGreaterThan(20);
    expect(numbers).toContain(tl.row + 1);
    // Six on screen and one of overscan on each side, however far it scrolled.
    expect(host.querySelectorAll('.tl-row').length).toBeLessThanOrEqual(8);
    expect(host.querySelector<HTMLElement>('.tl-layer')!.style.transform)
      .toBe(`translate3d(0, ${-tl.scrollOffset}px, 0)`);
  });

  it('fits the names again at another text size', () => {
    names = ['A channel with a rather long name that runs on and on'];
    rows = [[prog(12, 0, 13, 0, 'P')]];
    const { tl, draw } = setup();
    draw();
    const name = () => host.querySelector('.tl-name')?.textContent ?? '';
    const normal = name();
    expect(normal).toMatch(/…$/);

    tl.setFontScale(1.5);
    draw();
    expect(name()).toMatch(/…$/);
    expect(name().length).toBeLessThan(normal.length);
  });

  it('hides only the ruler times under a cover, and shows them again once it goes', () => {
    const { view, draw } = setup();
    const shownLabels = () => Array.from(host.querySelectorAll<HTMLElement>('.tl-ruler-label'))
      .filter(l => l.style.visibility !== 'hidden').map(l => l.textContent);
    draw();
    expect(host.querySelector('.tl-ruler-day')?.textContent).toBe('Sat 06/15');

    // 12:00 is at x=480 and its label at 488, five letters of 10px wide.
    expect(view.setCover([484, 530])).toBe(true);
    draw();
    expect(shownLabels()).toEqual(['12:30', '13:00', '13:30', '14:00', '14:30']);

    expect(view.setCover([484, 530])).toBe(false);
    view.setCover([1500, 1836]);
    draw();
    expect(shownLabels()).toEqual(['12:00', '12:30', '13:00', '13:30', '14:00']);

    view.setCover(null);
    draw();
    expect(shownLabels()).toHaveLength(6);
  });

  it('never cuts a title or a name inside a character', () => {
    names = ['🎬'.repeat(30)];
    rows = [[prog(12, 0, 12, 20, '🎬'.repeat(12)), prog(12, 20, 13, 0, 'P')]];
    const { draw } = setup();
    draw();
    const title = shownCells(rowAt(0))[0].querySelector('.tl-title')?.textContent ?? '';
    const name = host.querySelector('.tl-name')?.textContent ?? '';

    for (const text of [title, name]) {
      expect(text).toMatch(/^(🎬)+…$/);
    }
  });

  it('shows the new channel in a row the rows change under', () => {
    const { draw } = setup();
    draw();
    expect(rowAt(0).querySelector('.tl-name')?.textContent).toBe('ch1');

    names = ['Other'];
    rows = [rows[1], rows[0], rows[2]];
    revision++;
    draw();

    expect(rowAt(0).querySelector('.tl-name')?.textContent).toBe('Other');
    expect(shownCells(rowAt(0)).map(c => c.querySelector('.tl-title')?.textContent)).toEqual(['B1', 'B2']);
  });

  it('shows a lock before the name of a channel behind the PIN, fitting the name beside it', () => {
    names = ['A channel with a rather long name that runs on and on'];
    rows = [[prog(12, 0, 13, 0, 'P')]];
    const { draw } = setup();
    draw();
    const name = () => host.querySelector('.tl-name')!;
    const open = name().textContent ?? '';
    expect(name().querySelector('.lock-badge')).toBeNull();

    locks = ['locked'];
    revision++;
    draw();
    expect(name().querySelector('.lock-badge.is-locked')).not.toBeNull();
    const fitted = name().lastChild!.textContent ?? '';
    expect(fitted).toMatch(/…$/);
    expect(fitted.length).toBeLessThan(open.length);

    locks = ['unlocked'];
    draw();
    const shownBadges = () => Array.from(name().querySelectorAll<HTMLElement>('.lock-badge'))
      .filter(badge => badge.style.display !== 'none').map(badge => badge.className);
    expect(shownBadges()).toEqual(['lock-badge is-unlocked']);

    locks = [];
    draw();
    expect(shownBadges()).toEqual([]);
    expect(name().lastChild!.textContent).toBe(open);
  });

  it('widens the number column for a long number, with room to spare, moving the names on', () => {
    numbers = [12345];
    rows = [[prog(12, 0, 13, 0, 'P')]];
    const { draw } = setup(52 + 80 * 4, 1.5);
    draw();

    // Five digits of 24px text, 12px each, outgrow the 44px column.
    expect(host.style.getPropertyValue('--tl-num-w')).toBe('62px');
    expect(host.style.getPropertyValue('--tl-name-left')).toBe('96px');
  });

  it('sizes the number column for the whole list, so scrolling never moves the names', () => {
    rows = Array.from({ length: 1001 }, () => []);
    const { tl, draw } = setup(52 + 80 * 4, 1.5);
    draw();
    const open = host.style.getPropertyValue('--tl-name-left');
    expect(open).toBe('84px');

    tl.setRow(1000);
    draw();
    expect(host.style.getPropertyValue('--tl-name-left')).toBe(open);
  });

  it('narrows the number column again for a list of short numbers', () => {
    rows = Array.from({ length: 1000 }, () => []);
    const { draw } = setup(52 + 80 * 4, 1.5);
    draw();
    expect(host.style.getPropertyValue('--tl-name-left')).toBe('84px');

    rows = Array.from({ length: 99 }, () => []);
    draw();
    expect(host.style.getPropertyValue('--tl-num-w')).toBe('44px');
    expect(host.style.getPropertyValue('--tl-name-left')).toBe('78px');
  });

  it('builds its nodes again in a new host', () => {
    const { view, tl } = setup();
    view.draw(host, Date.now(), 0);
    const other = document.createElement('div');
    view.detach();
    view.draw(other, Date.now(), 0);

    expect(other.querySelectorAll('.tl-row')).toHaveLength(tl.rowCount());
  });
});
