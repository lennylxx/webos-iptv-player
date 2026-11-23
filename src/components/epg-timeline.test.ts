import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Programme } from '../types';
import { setDisplayTz } from '../utils/time';
import { GuideTimeline, type TimelineSource } from './epg-timeline';

const DAY = new Date(2024, 5, 15);
const at = (h: number, m = 0) => new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate(), h, m).getTime();

function prog(h1: number, m1: number, h2: number, m2: number, title: string): Programme {
  return { start: new Date(at(h1, m1)), stop: new Date(at(h2, m2)), title, description: '', category: '', icon: '' };
}

let rows: Programme[][];

const source: TimelineSource = {
  rowCount: () => rows.length,
  row: (index) => ({ number: index + 1, name: `ch${index + 1}`, lock: null }),
  programmes: (index, from, to) => rows[index]
    .filter(p => p.stop.getTime() > from && p.start.getTime() < to)
    .sort((a, b) => a.start.getTime() - b.start.getTime()),
  revision: () => String(rows.length),
  rowsKey: () => String(rows.length),
  maxNumber: () => rows.length,
  bounds: () => ({ min: at(0), max: at(23) }),
  marks: () => ({ reminder: false, replay: false }),
};

function timeline(height = 52 + 80 * 4): GuideTimeline {
  const tl = new GuideTimeline(source);
  tl.setFontScale(1);
  tl.setHeight(height);
  tl.reset(Date.now());
  return tl;
}

const titles = (tl: GuideTimeline, row: number) => tl.cellsOf(row).map(c => c.programme.title);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(12, 10));
  rows = [
    [prog(11, 30, 12, 30, 'A1'), prog(12, 30, 13, 30, 'A2'), prog(13, 30, 14, 40, 'A3'), prog(14, 40, 16, 0, 'A4')],
    [prog(12, 0, 13, 0, 'B1'), prog(13, 0, 15, 0, 'B2')],
    [],
  ];
});

afterEach(() => {
  vi.useRealTimers();
  setDisplayTz('device', null);
});

describe('GuideTimeline', () => {
  it('opens on the half hour around now and the program airing', () => {
    const tl = timeline();

    expect(tl.windowStartMs).toBe(at(12));
    expect(tl.focusedProgramme()?.title).toBe('A1');
  });

  it('draws overlapping programs side by side and drops one inside another', () => {
    rows[0] = [prog(12, 0, 13, 0, 'Long'), prog(12, 15, 12, 45, 'Inside'), prog(12, 50, 13, 30, 'Overlap')];
    const tl = timeline();
    const cells = tl.cellsOf(0);

    expect(cells.map(c => c.programme.title)).toEqual(['Long', 'Overlap']);
    expect(cells[1].x0).toBeGreaterThanOrEqual(cells[0].x1);
  });

  it('turns the page by half hours once the next program starts in its last half hour', () => {
    const tl = timeline();
    tl.move('right', false);
    tl.move('right', false);
    expect(tl.focusedProgramme()?.title).toBe('A3');
    expect(tl.windowStartMs).toBe(at(12));

    tl.move('right', false);
    expect(tl.focusedProgramme()?.title).toBe('A4');
    expect(tl.windowStartMs).toBe(at(12, 30));
  });

  it('pages back to a program the window has all but left behind', () => {
    rows[0] = [prog(10, 0, 12, 10, 'Early'), ...rows[0].slice(1)];
    const tl = timeline();
    expect(tl.focusedProgramme()?.title).toBe('A2');

    tl.move('left', false);
    expect(tl.focusedProgramme()?.title).toBe('Early');
    expect(tl.windowStartMs).toBe(at(10));
  });

  it('steps over a program too short to get a cell', () => {
    const short = (title: string, from: number, to: number): Programme =>
      ({ start: new Date(from), stop: new Date(to), title, description: '', category: '', icon: '' });
    rows[0] = [prog(12, 0, 12, 30, 'A'), short('S', at(12, 30), at(12, 30) + 20000), short('B', at(12, 30) + 20000, at(13))];
    const tl = timeline();
    expect(titles(tl, 0)).toEqual(['A', 'B']);
    tl.move('right', false);
    expect(tl.focusedProgramme()?.title).toBe('B');

    expect(tl.move('left', false)).toBe('moved');
    expect(tl.focusedProgramme()?.title).toBe('A');
    expect(tl.move('left', false)).toBe('none');
  });

  it('steps on from a clipped cell of a program too short for a span', () => {
    const short = (title: string, from: number, to: number): Programme =>
      ({ start: new Date(from), stop: new Date(to), title, description: '', category: '', icon: '' });
    const edge = at(12);
    rows[0] = [
      prog(11, 0, 11, 59, 'Before'),
      short('S', edge - 10000, edge + 25000),
      short('After', edge + 25000, at(13)),
    ];
    const tl = timeline();
    expect(titles(tl, 0)).toEqual(['S', 'After']);
    expect(tl.pointAt(tl.cellsLeft + 0.5, 52 + 40)).toBe('changed');
    expect(tl.focusedProgramme()?.title).toBe('S');

    expect(tl.move('right', false)).toBe('moved');
    expect(tl.focusedProgramme()?.title).toBe('After');
    tl.pointAt(tl.cellsLeft + 0.5, 52 + 40);
    expect(tl.move('left', false)).toBe('moved');
    expect(tl.focusedProgramme()?.title).toBe('Before');
  });

  it('follows a display time zone that arrives while open', () => {
    const tl = timeline();
    const local = -new Date(at(12)).getTimezoneOffset();
    const firstLabel = (): string => tl.ruler().labels[0].text;
    expect(firstLabel()).toBe('12:00');

    setDisplayTz('feed', local + 60);
    tl.sync();
    expect(tl.windowStartMs).toBe(at(12));
    expect(firstLabel()).toBe('13:00');

    // The present page stays the present one in the new zone.
    setDisplayTz('feed', local + 80);
    tl.sync();
    expect(tl.windowStartMs).toBe(at(12, 10));
    expect(firstLabel()).toBe('13:30');
    expect(tl.focusedProgramme()?.title).toBe('A1');
  });

  it('keeps the time it moved to when changing channels', () => {
    const tl = timeline();
    tl.move('right', false);
    tl.move('right', false); // A3 starts 13:30

    tl.move('down', false);
    expect(tl.focusedProgramme()?.title).toBe('B2');
    tl.move('up', false);
    expect(tl.focusedProgramme()?.title).toBe('A3');
  });

  it('leaves upward from the first channel', () => {
    expect(timeline().move('up', false)).toBe('leave-up');
  });

  it('steps an empty channel by half hours, within the guide', () => {
    const tl = timeline();
    tl.move('down', false);
    tl.move('down', false);
    expect(tl.focusedProgramme()).toBeNull();

    expect(tl.move('right', false)).toBe('moved');
    expect(tl.windowStartMs).toBe(at(12, 30));
    for (let i = 0; i < 40; i++) tl.move('right', false);
    expect(tl.windowStartMs).toBe(at(23));
  });

  it('lets the pointer pick a cell of a whole row, never a cut-off one', () => {
    const tl = timeline(52 + 80 * 2 + 40);
    // 13:00 is a third of the way along the 12:00-15:00 page.
    const x = tl.cellsLeft + (tl.cellsRight - tl.cellsLeft) * (70 / 180);

    expect(tl.pointAt(x, 52 + 80 + 40)).toBe('changed');
    expect(tl.row).toBe(1);
    expect(tl.focusedProgramme()?.title).toBe('B2');
    expect(tl.pointAt(x, 52 + 80 + 40)).toBe('same');
    expect(tl.pointAt(x, 52 + 160 + 20)).toBeNull();
    expect(tl.pointAt(x, 20)).toBeNull();
  });

  it('keeps a row of context below the focused channel', () => {
    rows = Array.from({ length: 10 }, () => [prog(12, 0, 13, 0, 'X')]);
    const tl = timeline(52 + 80 * 4);
    tl.move('down', false);
    tl.move('down', false);
    expect(tl.focusRect()?.y).toBeLessThan(52 + 80 * 3);
    tl.move('down', false);

    const rect = tl.focusRect()!;
    expect(rect.y + rect.h).toBeLessThanOrEqual(52 + 80 * 3);
    expect(titles(tl, 3)).toEqual(['X']);
  });
  it('steps through and points at programs that share a start', () => {
    rows[0] = [prog(12, 0, 13, 0, 'A'), prog(13, 0, 13, 30, 'B1'), prog(13, 0, 14, 0, 'B2'), prog(14, 0, 15, 0, 'C')];
    const tl = timeline();
    for (let i = 0; i < 5; i++) tl.move('right', false);
    expect(tl.focusedProgramme()?.title).toBe('C');
    tl.move('left', false);
    expect(tl.focusedProgramme()?.title).toBe('B2');
    tl.move('left', false);
    expect(tl.focusedProgramme()?.title).toBe('B1');

    // B2 shows from B1's end, 13:30, a half of the 12:00-15:00 page in.
    const x = tl.cellsLeft + (tl.cellsRight - tl.cellsLeft) * (105 / 180);
    expect(tl.pointAt(x, 52 + 40)).toBe('changed');
    expect(tl.focusedProgramme()?.title).toBe('B2');
    expect(tl.pointAt(x, 52 + 40)).toBe('same');
  });

  it('goes back to now past a guide that has run out', () => {
    rows = [[prog(4, 0, 5, 0, 'Old')], []];
    const stale: TimelineSource = { ...source, bounds: () => ({ min: at(4), max: at(4) }) };
    const tl = new GuideTimeline(stale);
    tl.setFontScale(1);
    tl.setHeight(52 + 80 * 4);
    tl.reset(Date.now());
    expect(tl.windowStartMs).toBe(at(12));

    for (let i = 0; i < 20; i++) tl.move('left', false);
    expect(tl.focusedProgramme()?.title).toBe('Old');
    expect(tl.move('now', false)).toBe('moved');
    expect(tl.windowStartMs).toBe(at(12));
    expect(tl.focusedProgramme()).toBeNull();
  });

  it('scrolls for a taller details panel only when it would cover the focused row', () => {
    rows = Array.from({ length: 10 }, () => [prog(12, 0, 13, 0, 'X')]);
    const tl = timeline(52 + 80 * 6);
    for (let i = 0; i < 4; i++) tl.move('down', false);
    const y = tl.focusRect()!.y;

    tl.setHeight(52 + 80 * 5);
    expect(tl.focusRect()!.y).toBe(y);
    tl.setHeight(52 + 80 * 6);
    expect(tl.focusRect()!.y).toBe(y);

    tl.setHeight(52 + 80 * 4 + 40);
    expect(tl.focusRect()!.y).toBe(y - 80);
  });

  it('lets a running scroll finish when the details panel changes height', () => {
    rows = Array.from({ length: 10 }, () => [prog(12, 0, 13, 0, 'X')]);
    const tl = timeline(52 + 80 * 6);
    for (let i = 0; i < 4; i++) tl.move('down', false);
    tl.move('down', true);
    expect(tl.isAnimating()).toBe(true);

    tl.setHeight(52 + 80 * 6 + 20);
    expect(tl.isAnimating()).toBe(true);
  });

  it('edge-steps the page by half hours and the rows by one, within the guide', () => {
    rows = Array.from({ length: 10 }, () => [prog(12, 0, 13, 0, 'X')]);
    const tl = timeline(52 + 80 * 4);
    expect(tl.canEdgeStep('y', -1)).toBe(false);
    expect(tl.edgeStep('y', 1)).toBe(true);
    expect(tl.scrollGoal).toBe(80);
    expect(tl.row).toBe(0);
    for (let i = 0; i < 10; i++) tl.edgeStep('y', 1);
    // Ten rows of 80 under a 320 view: the last stays whole at the foot.
    expect(tl.scrollGoal).toBe(480);
    expect(tl.canEdgeStep('y', 1)).toBe(false);

    expect(tl.edgeStep('x', 1)).toBe(true);
    expect(tl.windowStartMs).toBe(at(12, 30));
    expect(tl.focusedProgramme()?.title).toBe('X');
    for (let i = 0; i < 40; i++) tl.edgeStep('x', 1);
    expect(tl.windowStartMs).toBe(at(23));
    expect(tl.canEdgeStep('x', 1)).toBe(false);
  });

  it('keeps to the present page without a guide', () => {
    rows = [[], []];
    const bare: TimelineSource = { ...source, bounds: () => null };
    const tl = new GuideTimeline(bare);
    tl.setFontScale(1);
    tl.setHeight(52 + 80 * 4);
    tl.reset(Date.now());
    expect(tl.windowStartMs).toBe(at(12));

    expect(tl.move('right', false)).toBe('none');
    expect(tl.move('left', false)).toBe('none');
    expect(tl.windowStartMs).toBe(at(12));
    expect(tl.canEdgeStep('x', 1)).toBe(false);
    expect(tl.canEdgeStep('x', -1)).toBe(false);
  });

  it('moves the present page on with the clock without a guide, so Left stays put', () => {
    rows = [[], []];
    vi.setSystemTime(at(10, 20));
    const tl = new GuideTimeline({ ...source, bounds: () => null });
    tl.setFontScale(1);
    tl.setHeight(52 + 80 * 4);
    tl.reset(Date.now());
    expect(tl.windowStartMs).toBe(at(10));

    vi.setSystemTime(at(10, 31));
    tl.sync();
    expect(tl.windowStartMs).toBe(at(10, 30));
    expect(tl.move('left', false)).toBe('none');
    expect(tl.windowStartMs).toBe(at(10, 30));
    expect(tl.canEdgeStep('x', -1)).toBe(false);
    expect(tl.canEdgeStep('x', 1)).toBe(false);
  });

  it('moves the present page on with the clock, keeping a programme that still shows', () => {
    const tl = timeline();
    tl.move('right', false); // A2, 12:30-13:30
    expect(tl.focusedProgramme()?.title).toBe('A2');

    vi.setSystemTime(at(12, 31));
    expect(tl.followClock()).toBe(true);
    expect(tl.windowStartMs).toBe(at(12, 30));
    expect(tl.focusedProgramme()?.title).toBe('A2');
    expect(tl.canEdgeStep('x', -1)).toBe(false);
  });

  it('leaves a page the user turned to where it is as the clock moves on', () => {
    const tl = timeline();
    tl.edgeStep('x', 1);
    tl.edgeStep('x', 1);
    expect(tl.windowStartMs).toBe(at(13));

    vi.setSystemTime(at(12, 31));
    expect(tl.followClock()).toBe(false);
    expect(tl.windowStartMs).toBe(at(13));
  });
});
