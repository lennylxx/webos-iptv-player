import type { Programme } from '../types';
import { displayTzRevision, formatDayLabel, formatTime, startOfDisplayHalfHour } from '../utils/time';
import { getLocale } from '../i18n';

const HALF_HOUR_MS = 30 * 60000;
// Three hours on screen, paged by half hours, as broadcast guides do. A
// programme starting within the last half hour turns the page.
const SPAN_MS = 6 * HALF_HOUR_MS;
const TAIL_MS = HALF_HOUR_MS;
const LOOKAROUND_MS = 24 * 3600000;
export const CELLS_X = 480;
export const CELL_GAP = 4;
const SCROLL_MS = 160;

export interface TimelineRow {
  number: number;
  name: string;
  // Behind the parental PIN, or open while an unlock session lasts.
  lock: 'locked' | 'unlocked' | null;
}

export interface CellMarks {
  reminder: boolean;
  replay: boolean;
}

export interface TimelineSource {
  rowCount(): number;
  row(index: number): TimelineRow;
  // Programmes intersecting [from, to), sorted by start.
  programmes(index: number, from: number, to: number): readonly Programme[];
  // Changes whenever rows or their programmes change.
  revision(): string;
  // Changes when the list of rows does, not with their programmes or marks.
  rowsKey(): string;
  // The largest channel number in the rows.
  maxNumber(): number;
  // Earliest and latest programme start, bounding the pages.
  bounds(): { min: number; max: number } | null;
  marks(index: number, programme: Programme, now: number): CellMarks;
}

export interface Cell {
  x0: number;
  x1: number;
  programme: Programme;
  // The programme's span once trimmed to start after the one before it.
  start: number;
  stop: number;
  clipLeft: boolean;
  clipRight: boolean;
  marks?: CellMarks;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface RulerLabel { x: number; text: string; day: boolean }

export type MoveResult = 'moved' | 'none' | 'leave-up';
export type PointResult = 'changed' | 'same' | null;
export type TimelineMove = 'up' | 'down' | 'left' | 'right' | 'page-up' | 'page-down' | 'now';

interface Span { programme: Programme; start: number; stop: number }

// The timeline's state: its page, rows, focus, and scroll. TimelineView shows it.
export class GuideTimeline {
  readonly width: number;
  private height = 0;
  private rulerH = 52;
  private rowH = 80;
  private scale = 1;
  private textScale = 0;
  private rowIndex = 0;
  // Two programmes may share a start, so the focus holds the programme itself.
  private focusProg: Programme | null = null;
  private anchor = 0;
  private windowStart = 0;
  private scrollY = 0;
  private scrollFrom = 0;
  private scrollTarget = 0;
  private scrollAt = 0;
  private cellKey = '';
  private readonly cellCache = new Map<number, Cell[]>();
  private rulerCache: { key: string; day: string; labels: RulerLabel[] } | null = null;
  private tzRev = displayTzRevision();
  // The present page as of the last look at the clock.
  private present = NaN;

  constructor(private readonly source: TimelineSource, width = 1920) {
    this.width = width;
  }

  get row(): number { return this.rowIndex; }
  get windowStartMs(): number { return this.windowStart; }
  get spanMs(): number { return SPAN_MS; }
  get cellsLeft(): number { return CELLS_X; }
  get cellsRight(): number { return this.width; }
  get rowHeight(): number { return this.rowH; }
  get rulerHeight(): number { return this.rulerH; }
  get fontScale(): number { return this.textScale; }
  get scaleFactor(): number { return this.scale; }
  get scrollOffset(): number { return this.scrollY; }
  get scrollGoal(): number { return this.scrollTarget; }
  get viewHeight(): number { return this.height; }

  // The text size setting's scale, which sizes the rows and the ruler.
  setFontScale(fontScale: number): void {
    if (fontScale === this.textScale) return;
    if (this.textScale) this.scrollY = this.scrollTarget = 0;
    this.textScale = fontScale;
    // Rows grow with the text size setting, never below the 100% height.
    this.scale = Math.max(1, 0.1 + 0.9 * fontScale);
    this.rulerH = Math.round(52 * this.scale);
    this.rowH = Math.round(80 * this.scale);
    this.cellKey = '';
    this.rulerCache = null;
    this.ensureVisible(false);
  }

  // The details below the rows change height as the focus moves; the rows
  // scroll only when the focused one would be covered, and a running scroll
  // runs on.
  setHeight(height: number): void {
    if (height === this.height) return;
    this.height = height;
    const rowsH = height - this.rulerH;
    if (rowsH <= 0 || !this.source.rowCount()) return;
    const top = this.rowIndex * this.rowH;
    let target = this.scrollTarget;
    if (top + this.rowH > target + rowsH) target = Math.ceil((top + this.rowH - rowsH) / this.rowH) * this.rowH;
    target = Math.max(0, Math.min(top, target));
    if (target === this.scrollTarget) return;
    if (this.isAnimating()) {
      this.scrollFrom = this.scrollY;
      this.scrollAt = -1;
    } else {
      this.scrollY = target;
    }
    this.scrollTarget = target;
  }

  visibleRows(): number {
    return Math.max(1, Math.floor((this.height - this.rulerH) / this.rowH));
  }

  // Opens on the present.
  reset(now: number): void {
    // The display time zone may have changed the labels of the same instants.
    this.rulerCache = null;
    this.cellKey = '';
    this.tzRev = displayTzRevision();
    this.setWindow(startOfDisplayHalfHour(now));
    this.present = this.presentPage();
    this.anchor = now;
    this.refocus();
  }

  setRow(index: number, animate = false): void {
    const count = this.source.rowCount();
    this.rowIndex = count ? Math.max(0, Math.min(count - 1, index)) : 0;
    this.followTz();
    this.refocus();
    this.ensureVisible(animate);
  }

  // Keeps the window and anchor, picking up whatever the rows now hold.
  sync(): void {
    const count = this.source.rowCount();
    if (this.rowIndex >= count) this.rowIndex = Math.max(0, count - 1);
    this.followTz();
    this.followClock();
    if (this.focusProg === null || !this.focusedCell()) this.refocus();
    this.ensureVisible(false);
  }

  // The present page follows the clock past each half hour, as broadcast
  // guides do, keeping the focused programme if it still shows; a page the
  // user turned to stays where it is. True when the page moved.
  followClock(): boolean {
    const next = this.presentPage();
    if (next === this.present || Number.isNaN(this.present)) {
      this.present = next;
      return false;
    }
    const wasPresent = this.windowStart === this.present;
    this.present = next;
    const before = this.windowStart;
    this.setWindow(wasPresent ? next : this.windowStart);
    if (this.windowStart === before) return false;
    if (!this.focusedCell()) {
      this.anchor = Date.now();
      this.refocus();
    }
    return true;
  }

  private presentPage(): number {
    return this.clampWindow(startOfDisplayHalfHour(Date.now()));
  }

  // A new display time zone may leave the window off its half hours.
  private followTz(): void {
    const rev = displayTzRevision();
    if (rev === this.tzRev) return;
    this.tzRev = rev;
    const wasPresent = this.windowStart === this.present;
    this.setWindow(startOfDisplayHalfHour(wasPresent ? Date.now() : this.windowStart));
    this.present = this.presentPage();
  }

  focusedProgramme(): Programme | null {
    return this.focusedCell()?.programme ?? null;
  }

  move(dir: TimelineMove, animate: boolean): MoveResult {
    const count = this.source.rowCount();
    if (!count) return dir === 'up' ? 'leave-up' : 'none';
    switch (dir) {
      case 'up':
        if (this.rowIndex === 0) return 'leave-up';
        return this.stepRow(-1, animate);
      case 'down':
        return this.stepRow(1, animate);
      case 'page-up':
        return this.stepRow(-(this.visibleRows() - 1), animate);
      case 'page-down':
        return this.stepRow(this.visibleRows() - 1, animate);
      case 'right':
        return this.stepProgramme(1);
      case 'left':
        return this.stepProgramme(-1);
      case 'now': {
        const now = Date.now();
        this.setWindow(startOfDisplayHalfHour(now));
        this.present = this.presentPage();
        this.anchor = now;
        this.refocus();
        return 'moved';
      }
    }
  }

  // The pointer picks a cell of a wholly shown row; it never scrolls.
  pointAt(x: number, y: number): PointResult {
    const top = this.rulerH;
    const bottom = this.height;
    if (y < top || y >= bottom || x < 0 || x >= this.cellsRight) return null;
    const index = Math.floor((y - top + this.scrollY) / this.rowH);
    if (index < 0 || index >= this.source.rowCount()) return null;
    const rowTop = top + index * this.rowH - this.scrollY;
    if (rowTop < top - 0.5 || rowTop + this.rowH > bottom + 0.5) return null;
    if (x < CELLS_X) {
      if (index === this.rowIndex) return 'same';
      this.rowIndex = index;
      this.refocus();
      return 'changed';
    }
    const cells = this.cellsOf(index);
    const cell = cells.find(c => x >= c.x0 && x < c.x1);
    if (!cell && cells.length) return null;
    const programme = cell ? cell.programme : null;
    if (index === this.rowIndex && programme === this.focusProg) return 'same';
    this.rowIndex = index;
    this.focusProg = programme;
    if (cell) this.anchor = Math.max(cell.start, this.windowStart);
    return 'changed';
  }

  // The focused cell in view coordinates; an empty row spans the window.
  focusRect(): Rect | null {
    if (!this.source.rowCount()) return null;
    const y = this.rulerH + this.rowIndex * this.rowH - this.scrollTarget + CELL_GAP;
    const h = this.rowH - CELL_GAP * 2 - 1;
    const cell = this.focusedCell();
    if (cell) return { x: cell.x0, y, w: cell.x1 - cell.x0, h };
    return { x: CELLS_X, y, w: this.cellsRight - CELLS_X, h };
  }

  // Changes whenever a frame would show something else, the clock's minute included.
  paintKey(): string {
    return `${this.rowIndex}|${this.windowStart}|${this.scrollY}|${this.scrollTarget}|${this.height}`
      + `|${this.textScale}|${this.source.revision()}|${displayTzRevision()}`;
  }

  // Edge scrolling: a half hour of the page, or a row of the rows, at a
  // step. The focus stays where it is while still on the page.
  canEdgeStep(axis: 'x' | 'y', direction: number): boolean {
    if (!this.source.rowCount()) return false;
    if (axis === 'x') {
      // The present page's left edge holds the airing column, not the past.
      if (direction < 0 && this.windowStart === this.presentPage()) return false;
      return this.clampWindow(this.windowStart + direction * HALF_HOUR_MS) !== this.windowStart;
    }
    return direction < 0 ? this.scrollTarget > 0 : this.scrollTarget < this.maxScroll();
  }

  edgeStep(axis: 'x' | 'y', direction: number): boolean {
    if (!this.canEdgeStep(axis, direction)) return false;
    if (axis === 'x') {
      this.setWindow(this.windowStart + direction * HALF_HOUR_MS);
      this.anchor = Math.max(this.windowStart, Math.min(this.windowStart + SPAN_MS - 1, this.anchor));
      if (!this.focusedCell()) this.refocus();
      return true;
    }
    const target = Math.max(0, Math.min(this.maxScroll(), this.scrollTarget + direction * this.rowH));
    this.scrollY = this.scrollTarget = target;
    return true;
  }

  // Whether the rows are taller than the view, so they scroll at all.
  rowsOverflow(): boolean {
    return this.maxScroll() > 0;
  }

  // Focuses the wholly shown row nearest the view's y, at the anchor's
  // programme; true when the row changed.
  focusRowAt(y: number): boolean {
    const count = this.source.rowCount();
    if (!count) return false;
    const first = Math.ceil(this.scrollY / this.rowH);
    const last = Math.min(count, Math.floor((this.scrollY + this.height - this.rulerH) / this.rowH)) - 1;
    if (last < first) return false;
    const at = Math.floor((y - this.rulerH + this.scrollY) / this.rowH);
    const index = Math.max(first, Math.min(last, at));
    if (index === this.rowIndex) return false;
    this.rowIndex = index;
    this.refocus();
    return true;
  }

  isAnimating(): boolean {
    return this.scrollY !== this.scrollTarget;
  }

  // Steps the scroll to a frame's time; true while it still needs frames.
  advance(frameAt: number): boolean {
    if (this.scrollY !== this.scrollTarget) {
      if (this.scrollAt < 0) this.scrollAt = frameAt;
      const k = Math.min(1, (frameAt - this.scrollAt) / SCROLL_MS);
      const eased = 1 - Math.pow(1 - k, 3);
      this.scrollY = k >= 1 ? this.scrollTarget : this.scrollFrom + (this.scrollTarget - this.scrollFrom) * eased;
    }
    return this.isAnimating();
  }

  xAt(t: number): number {
    return CELLS_X + (t - this.windowStart) * (this.cellsRight - CELLS_X) / SPAN_MS;
  }

  rowCount(): number {
    return this.source.rowCount();
  }

  rowsKey(): string {
    return this.source.rowsKey();
  }

  maxNumber(): number {
    return this.source.maxNumber();
  }

  rowLabel(index: number): TimelineRow {
    return this.source.row(index);
  }

  cellMarks(index: number, cell: Cell, now: number): CellMarks {
    if (!cell.marks) cell.marks = this.source.marks(index, cell.programme, now);
    return cell.marks;
  }

  // The window's first day, and a label for each half hour, naming a day it crosses into.
  ruler(): { day: string; labels: RulerLabel[] } {
    // Day names follow the language.
    const key = `${this.windowStart}|${displayTzRevision()}|${getLocale()}`;
    if (this.rulerCache?.key === key) return this.rulerCache;
    const labels: RulerLabel[] = [];
    for (let t = this.windowStart; t < this.windowStart + SPAN_MS; t += HALF_HOUR_MS) {
      const time = formatTime(new Date(t));
      const day = time === '00:00' && t !== this.windowStart;
      const dayLabel = day ? formatDayLabel(new Date(t)) : null;
      labels.push({
        x: Math.round(this.xAt(t)),
        text: dayLabel ? `${dayLabel.weekday} ${dayLabel.date}` : time,
        day,
      });
    }
    const first = formatDayLabel(new Date(this.windowStart));
    this.rulerCache = { key, day: `${first.weekday} ${first.date}`, labels };
    return this.rulerCache;
  }

  // ---- layout ----

  cellsOf(index: number): Cell[] {
    const key = `${this.windowStart}|${this.source.revision()}|${displayTzRevision()}`;
    if (key !== this.cellKey) {
      this.cellKey = key;
      this.cellCache.clear();
    }
    const hit = this.cellCache.get(index);
    if (hit) return hit;
    const end = this.windowStart + SPAN_MS;
    const cells: Cell[] = [];
    let prevStop = -Infinity;
    // Feeds overlap; a programme starting inside the previous one is drawn from its end.
    for (const programme of this.source.programmes(index, this.windowStart, end)) {
      const stop = programme.stop.getTime();
      if (stop <= prevStop) continue;
      const start = Math.max(programme.start.getTime(), prevStop);
      prevStop = stop;
      if (stop <= this.windowStart || start >= end) continue;
      const clipLeft = start < this.windowStart;
      const clipRight = stop > end;
      const x0 = clipLeft ? CELLS_X : this.xAt(start) + CELL_GAP / 2;
      const x1 = clipRight ? this.cellsRight : this.xAt(stop) - CELL_GAP / 2;
      if (x1 - x0 >= 1) cells.push({ x0, x1, programme, start, stop, clipLeft, clipRight });
    }
    if (this.cellCache.size > 256) this.cellCache.clear();
    this.cellCache.set(index, cells);
    return cells;
  }

  private focusedCell(): Cell | null {
    if (this.focusProg === null || !this.source.rowCount()) return null;
    return this.cellsOf(this.rowIndex).find(c => c.programme === this.focusProg) ?? null;
  }

  // The programme airing at the anchor, else the next one, else the last before it.
  private refocus(): void {
    if (!this.source.rowCount()) {
      this.focusProg = null;
      return;
    }
    const cells = this.cellsOf(this.rowIndex);
    const at = Math.max(this.anchor, this.windowStart);
    let pick: Cell | undefined;
    for (const cell of cells) {
      if (cell.stop > at) { pick = cell; break; }
    }
    pick = pick ?? cells[cells.length - 1];
    this.focusProg = pick ? pick.programme : null;
  }

  // Pages stay within the guide, and always reach the present, even past a
  // guide that has run out.
  private setWindow(start: number): void {
    this.windowStart = this.clampWindow(start);
  }

  private clampWindow(start: number): number {
    const present = startOfDisplayHalfHour(Date.now());
    const bounds = this.source.bounds();
    // Without a guide every page would say the same: there is only the present one.
    if (!bounds) return present;
    const min = Math.min(present, startOfDisplayHalfHour(bounds.min));
    const max = Math.max(present, min, startOfDisplayHalfHour(bounds.max));
    return Math.max(min, Math.min(max, start));
  }

  // The rows' furthest scroll: the last row whole at the foot.
  private maxScroll(): number {
    const rowsH = this.height - this.rulerH;
    return Math.max(0, Math.ceil((this.source.rowCount() * this.rowH - rowsH) / this.rowH) * this.rowH);
  }

  private stepRow(delta: number, animate: boolean): MoveResult {
    const next = Math.max(0, Math.min(this.source.rowCount() - 1, this.rowIndex + delta));
    if (next === this.rowIndex) return 'none';
    this.rowIndex = next;
    this.refocus();
    this.ensureVisible(animate);
    return 'moved';
  }

  private stepProgramme(dir: 1 | -1): MoveResult {
    const cell = this.focusedCell();
    if (!cell) {
      const before = this.windowStart;
      this.setWindow(this.windowStart + dir * HALF_HOUR_MS);
      if (this.windowStart === before) return 'none';
      this.anchor = this.windowStart;
      this.refocus();
      return 'moved';
    }
    const spans = this.spans(cell.start - LOOKAROUND_MS, cell.stop + LOOKAROUND_MS);
    const i = spans.findIndex(span => span.programme === cell.programme);
    // A clipped cell shows only part of a programme too short for a span of its own.
    let target: Span | undefined;
    if (i >= 0) target = spans[i + dir];
    else if (dir > 0) target = spans.find(span => span.start > cell.start);
    else target = spans.filter(span => span.start < cell.start).pop();
    if (!target) return 'none';
    const tStart = target.start;
    let window = this.windowStart;
    if (dir > 0) {
      while (tStart >= window + SPAN_MS - TAIL_MS) window += HALF_HOUR_MS;
    } else if (tStart < window && target.stop - window < HALF_HOUR_MS) {
      window = startOfDisplayHalfHour(tStart);
    }
    const before = this.windowStart;
    this.setWindow(window);
    this.focusProg = target.programme;
    this.anchor = Math.max(tStart, this.windowStart);
    if (!this.focusedCell()) this.refocus();
    return this.focusProg === cell.programme && this.windowStart === before ? 'none' : 'moved';
  }

  // The row's programmes as cellsOf trims them, keeping only those wide
  // enough to get a cell, so a step never lands on one that has none.
  private spans(from: number, to: number): Span[] {
    const perMs = (this.cellsRight - CELLS_X) / SPAN_MS;
    const out: Span[] = [];
    let prevStop = -Infinity;
    for (const programme of this.source.programmes(this.rowIndex, from, to)) {
      const stop = programme.stop.getTime();
      if (stop <= prevStop) continue;
      const start = Math.max(programme.start.getTime(), prevStop);
      prevStop = stop;
      if ((stop - start) * perMs - CELL_GAP >= 1) out.push({ programme, start, stop });
    }
    return out;
  }

  // Keeps a row of context above and below the focused one.
  private ensureVisible(animate: boolean): void {
    const count = this.source.rowCount();
    const visible = this.visibleRows();
    let top = Math.round(this.scrollTarget / this.rowH);
    if (this.rowIndex < top + 1) top = this.rowIndex - 1;
    if (this.rowIndex > top + visible - 2) top = this.rowIndex - visible + 2;
    top = Math.max(0, Math.min(Math.max(0, count - visible), top));
    const target = top * this.rowH;
    if (target === this.scrollTarget && target === this.scrollY) return;
    this.scrollFrom = this.scrollY;
    this.scrollTarget = target;
    this.scrollAt = -1;
    if (!animate || Math.abs(target - this.scrollY) > 2 * this.rowH) this.scrollY = target;
  }
}
