import { displayTzRevision, formatTime } from '../utils/time';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { CELL_GAP, CELLS_X, type Cell, type GuideTimeline, type TimelineRow } from './epg-timeline';
import { BELL_PATH, REPLAY_PATH } from './icons';
import { graphemeEnds } from '../utils/graphemes';
import { lockBadge } from './parental-badge';

// Shows a GuideTimeline with pooled, absolutely positioned elements: rows are
// virtualized, cells are windowed by cellsOf, and one layer moved by a
// translate3d carries both the channel column and the cells.
//
// Every clip (overflow: hidden, paint containment) is a paint property node
// the compositor re-layerizes each frame, so text is fitted here rather than
// ellipsized by CSS, and rows and cells contain size and layout but not
// paint. A cell keeps its node while its programme stays on screen, so a
// page turn mostly moves nodes instead of rewriting their text.

const OVERSCAN = 1;
const FIT_CACHE_LIMIT = 4000;
const CELL_PAD = 14;
const NARROW_CELL = 100;
const NARROW_PAD = 8;
// Room for a letter and an ellipsis.
const CELL_TEXT_MIN = 12;
const STATE_BAR = 3;
// The channel column lays out as the Channel schedule's list does
// (.epg-channel-item): its padding, a number column at least 44px wide that
// a longer number widens, then a gap.
const CH_PAD = 18;
const CH_NUM_W = 44;
const CH_GAP = 16;
// Canvas ignores tabular-nums, so the widest number gets some room.
const CH_NUM_SLACK = 2;

export interface TimelineTextStyle {
  fontFamily: string;
  emptyLabel: string;
}

interface CellNode {
  el: HTMLElement;
  titleText: Text;
  time: HTMLElement;
  timeText: Text;
  replay: SVGElement | null;
  bell: SVGElement | null;
  prog: HTMLElement | null;
  key: number;
  cls: string;
  left: number;
  width: number;
  timeV: string;
  progW: number;
  bellOn: boolean;
  replayOn: boolean;
  shown: boolean;
}

interface RowNode {
  el: HTMLElement;
  num: HTMLElement;
  numText: Text;
  name: HTMLElement;
  nameText: Text;
  cells: CellNode[];
  focused: boolean;
  cellsRef: Cell[] | null;
  stamp: string;
  shown: boolean;
  // The channel the row shows; the rows may change under a bound node.
  bound: string;
  locks: { locked: HTMLElement | null; unlocked: HTMLElement | null; shown: TimelineRow['lock'] };
}

interface Nodes {
  host: HTMLElement;
  root: HTMLElement;
  viewport: HTMLElement;
  layer: HTMLElement;
  band: HTMLElement;
  nowLine: HTMLElement;
  day: Text;
  ticks: HTMLElement[];
  labels: { el: HTMLElement; text: Text; day: boolean; hidden: boolean }[];
  rulerNow: HTMLElement;
}

// The nodes the view clones. The markup is fixed: what the guide's feeds
// say reaches these nodes only through Text.data.
interface Templates {
  root: Element;
  row: Element;
  cell: Element;
  prog: Element;
  bell: Element;
  replay: Element;
  locked: Element;
  unlocked: Element;
}
let templates: Templates | null = null;

function parse(markup: Safe): Element {
  const box = document.createElement('div');
  morph(box, markup);
  return box.firstElementChild!;
}

function template(): Templates {
  if (!templates) {
    const icon = (cls: string, path: string): Safe =>
      html`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"></path></svg>`;
    const slots = [0, 1, 2, 3, 4, 5].map(() => html`<i class="tl-ruler-tick"></i><span class="tl-ruler-label"> </span>`);
    templates = {
      root: parse(html`<div class="tl-root"><i class="tl-column"></i><div class="tl-ruler"><span class="tl-ruler-day"> </span>${slots}<i class="tl-ruler-now"></i></div><div class="tl-viewport"><div class="tl-layer"><i class="tl-band"></i></div><i class="tl-now-line"></i></div></div>`),
      row: parse(html`<div class="tl-row"><span class="tl-num"> </span><span class="tl-name"> </span></div>`),
      cell: parse(html`<div class="tl-cell"><span class="tl-title"> </span><span class="tl-time"> </span></div>`),
      prog: parse(html`<i class="tl-prog"></i>`),
      bell: parse(icon('tl-bell', BELL_PATH)),
      replay: parse(icon('tl-replay', REPLAY_PATH)),
      locked: parse(html`${raw(lockBadge('locked'))}`),
      unlocked: parse(html`${raw(lockBadge('unlocked'))}`),
    };
  }
  return templates;
}

function clone<T extends Element>(node: Element): T {
  return node.cloneNode(true) as T;
}

// The empty Text node a template's span holds.
function textOf(parent: Element): Text {
  const text = parent.firstChild as Text;
  text.data = '';
  return text;
}

function boundKey(label: TimelineRow): string {
  return `${label.number}|${label.name}|${label.lock ?? ''}`;
}

function setText(node: Text, value: string): void {
  if (node.data !== value) node.data = value;
}

function show(e: HTMLElement | SVGElement, on: boolean): void {
  e.style.display = on ? '' : 'none';
}

export class TimelineView {
  private nodes: Nodes | null = null;
  private rulerKey = '';
  private readonly active = new Map<number, RowNode>();
  private readonly free: RowNode[] = [];
  private styleKey = '';
  private layerY = NaN;
  private bandRow = -2;
  private viewportH = -1;
  private nowX = NaN;
  private measure: CanvasRenderingContext2D | null = null;
  private measureFont = '';
  private readonly fitCache = new Map<string, string>();
  // Each cell's fitted title and time, kept until its cell is computed again
  // or the font changes.
  private fitted = new WeakMap<Cell, { title: string; time: string }>();
  private style: TimelineTextStyle | null = null;
  private fonts = { title: '', time: '', name: '', ruler: '', num: '' };
  private numW = CH_NUM_W;
  private numKey = '';
  private publishedNum = '';
  private cover: [number, number] | null = null;
  private rowH = 80;
  private iconSize = 20;
  private replaySize = 16;
  private nameW = 0;
  private lockW = 0;

  // scope holds the number column's custom properties, for text outside the
  // view that aligns with the names; the host when not given.
  constructor(private readonly tl: GuideTimeline, private readonly scope: HTMLElement | null = null) {}

  setStyle(style: TimelineTextStyle): void {
    this.style = style;
  }

  // Shows a frame in host; true while the scroll still needs frames.
  draw(host: HTMLElement, now: number, frameAt: number): boolean {
    if (!this.style || !this.tl.fontScale) return false;
    const n = this.mount(host);
    const animating = this.tl.advance(frameAt);
    this.applyStyle(n);
    this.fitNumbers(n);
    const rowsH = Math.max(0, this.tl.viewHeight - this.tl.rulerHeight);
    if (rowsH !== this.viewportH) {
      this.viewportH = rowsH;
      n.viewport.style.height = `${rowsH}px`;
    }
    const nowX = Math.round(this.tl.xAt(now));
    const inWindow = now >= this.tl.windowStartMs && now < this.tl.windowStartMs + this.tl.spanMs;
    this.paintRuler(n, inWindow ? nowX : null);
    const lineX = inWindow ? nowX : -1;
    if (lineX !== this.nowX) {
      this.nowX = lineX;
      show(n.nowLine, lineX >= 0);
      if (lineX >= 0) n.nowLine.style.left = `${lineX - 1}px`;
    }
    const scrollY = this.tl.scrollOffset;
    if (scrollY !== this.layerY) {
      this.layerY = scrollY;
      n.layer.style.transform = `translate3d(0, ${-scrollY}px, 0)`;
    }
    const count = this.tl.rowCount();
    const focusRow = count ? this.tl.row : -1;
    if (focusRow !== this.bandRow) {
      show(n.band, focusRow >= 0);
      if (focusRow >= 0) n.band.style.transform = `translate3d(0, ${focusRow * this.rowH}px, 0)`;
      this.bandRow = focusRow;
    }
    // Rows for the whole scroll are bound up front, so the animation's frames
    // only move the layer and never lay out.
    const goal = this.tl.scrollGoal;
    const top = Math.min(scrollY, goal);
    const bottom = Math.max(scrollY, goal) + rowsH - 1;
    const first = Math.max(0, Math.floor(top / this.rowH) - OVERSCAN);
    const last = Math.min(count - 1, Math.floor(bottom / this.rowH) + OVERSCAN);
    const released: RowNode[] = [];
    this.active.forEach((node, index) => {
      if (index < first || index > last) {
        this.active.delete(index);
        released.push(node);
      }
    });
    for (const node of released) this.free.push(node);
    const stamp = `${Math.floor(now / 60000)}|${nowX}`;
    for (let i = first; i <= last; i++) {
      let node = this.active.get(i);
      const label = this.tl.rowLabel(i);
      if (!node) {
        node = this.free.pop() ?? this.createRow(n);
        this.bindRow(node, i, label);
        this.active.set(i, node);
      } else if (node.bound !== boundKey(label)) {
        this.bindRow(node, i, label);
      }
      this.fillRow(node, i, now, nowX, stamp);
    }
    // Hidden rather than undisplayed: a released row then costs a repaint, not a layout.
    for (const node of this.free) {
      if (node.shown) {
        node.shown = false;
        node.el.style.visibility = 'hidden';
      }
    }
    return animating;
  }

  // Up to the column's right border.
  private nameWidth(): number {
    return CELLS_X - 1 - CH_PAD - (CH_PAD + this.numW + CH_GAP);
  }

  // Sizes the number column for the longest number in the whole list, as the
  // schedule's list lets a number push its name; fixed for one list, so
  // scrolling never moves the names.
  private fitNumbers(n: Nodes): void {
    const key = `${this.tl.rowsKey()}|${this.styleKey}`;
    if (key !== this.numKey) {
      this.numKey = key;
      const digits = String(Math.max(1, this.tl.maxNumber())).length;
      const width = Math.max(CH_NUM_W, Math.ceil(this.width(this.fonts.num, '0'.repeat(digits))) + CH_NUM_SLACK);
      if (width !== this.numW) {
        this.numW = width;
        this.nameW = this.nameWidth();
        this.active.forEach((node) => { node.bound = ''; });
      }
    }
    const published = `${this.numW}`;
    if (published === this.publishedNum) return;
    this.publishedNum = published;
    const scope = this.scope ?? n.host;
    scope.style.setProperty('--tl-num-w', `${this.numW}px`);
    scope.style.setProperty('--tl-name-left', `${CH_PAD + this.numW + CH_GAP}px`);
  }

  // Hides the ruler's times that the span of x cover lies over; true when it changed.
  setCover(cover: [number, number] | null): boolean {
    const same = cover && this.cover ? cover[0] === this.cover[0] && cover[1] === this.cover[1] : cover === this.cover;
    if (same) return false;
    this.cover = cover;
    return true;
  }

  // Lets go of the nodes once the host leaves the page.
  detach(): void {
    this.nodes = null;
    this.active.clear();
    this.free.length = 0;
  }

  private mount(host: HTMLElement): Nodes {
    if (this.nodes && this.nodes.host === host && this.nodes.root.parentNode === host) return this.nodes;
    this.detach();
    this.styleKey = '';
    this.rulerKey = '';
    this.layerY = NaN;
    this.bandRow = -2;
    this.viewportH = -1;
    this.nowX = NaN;
    this.publishedNum = '';
    const root = clone<HTMLElement>(template().root);
    const ruler = root.querySelector('.tl-ruler')!;
    const ticks = Array.from(ruler.querySelectorAll<HTMLElement>('.tl-ruler-tick'));
    const labels = Array.from(ruler.querySelectorAll<HTMLElement>('.tl-ruler-label'))
      .map(label => ({ el: label, text: textOf(label), day: false, hidden: false }));
    const viewport = root.querySelector<HTMLElement>('.tl-viewport')!;
    const day = textOf(ruler.querySelector('.tl-ruler-day')!);
    const rulerNow = ruler.querySelector<HTMLElement>('.tl-ruler-now')!;
    const layer = viewport.querySelector<HTMLElement>('.tl-layer')!;
    const band = layer.querySelector<HTMLElement>('.tl-band')!;
    const nowLine = viewport.querySelector<HTMLElement>('.tl-now-line')!;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(root);
    this.nodes = { host, root, viewport, layer, band, nowLine, day, ticks, labels, rulerNow };
    return this.nodes;
  }

  private applyStyle(n: Nodes): void {
    const style = this.style!;
    const fs = this.tl.fontScale;
    const key = `${fs}|${this.tl.rowHeight}|${style.fontFamily}|${style.emptyLabel}`;
    if (key === this.styleKey) return;
    this.styleKey = key;
    const scale = this.tl.scaleFactor;
    const size = (px: number) => Math.round(px * fs);
    this.rowH = this.tl.rowHeight;
    const cellH = this.rowH - CELL_GAP * 2 - 1;
    this.iconSize = Math.round(20 * scale);
    this.replaySize = Math.round(16 * scale);
    const titleLine = Math.round(22 * fs * 1.25);
    const timeLine = Math.round(18 * fs * 1.25);
    // A lock badge is 0.9em wide with a 0.35em gap.
    this.lockW = Math.ceil(1.25 * size(20));
    const vars: Record<string, string> = {
      '--tl-font': style.fontFamily,
      '--tl-ruler-h': `${this.tl.rulerHeight}px`,
      '--tl-row-h': `${this.rowH}px`,
      '--tl-cell-h': `${cellH}px`,
      '--tl-f-ruler': `${size(20)}px`,
      '--tl-f-empty': `${size(20)}px`,
      '--tl-f-title': `${size(22)}px`,
      '--tl-f-time': `${size(18)}px`,
      '--tl-title-line': `${titleLine}px`,
      '--tl-time-line': `${timeLine}px`,
      '--tl-title-top': `${Math.round(cellH * 0.36 - titleLine / 2) - 1}px`,
      '--tl-mid-top': `${Math.round((cellH - titleLine) / 2) - 1}px`,
      '--tl-time-top': `${Math.round(cellH * 0.74 - timeLine / 2) - 1}px`,
      '--tl-icon': `${this.iconSize}px`,
      '--tl-icon-top': `${Math.round((cellH - this.iconSize) / 2)}px`,
      '--tl-replay': `${this.replaySize}px`,
      '--tl-replay-top': `${Math.round((timeLine - this.replaySize) / 2)}px`,
    };
    // The custom properties sit on the root alone; one write sets them all.
    n.root.style.cssText = Object.keys(vars).map(k => `${k}: ${vars[k]}`).join('; ');
    this.fonts = {
      title: `500 ${size(22)}px ${style.fontFamily}`,
      time: `400 ${size(18)}px ${style.fontFamily}`,
      // The focused row's weight, the wider one.
      name: `600 ${size(20)}px ${style.fontFamily}`,
      ruler: `500 ${size(20)}px ${style.fontFamily}`,
      num: `600 ${size(16)}px ${style.fontFamily}`,
    };
    this.numKey = '';
    this.nameW = this.nameWidth();
    this.measureFont = '';
    this.fitCache.clear();
    this.fitted = new WeakMap();
    this.rulerKey = '';
    this.bandRow = -2;
    // The draw binds them again at the new size.
    this.active.forEach((node) => { node.bound = ''; });
  }

  private paintRuler(n: Nodes, nowX: number | null): void {
    const cover = this.cover;
    const key = `${this.tl.windowStartMs}|${displayTzRevision()}|${nowX}|${this.styleKey}|${cover ? cover.join('-') : ''}`;
    if (key === this.rulerKey) return;
    this.rulerKey = key;
    const ruler = this.tl.ruler();
    setText(n.day, ruler.day);
    ruler.labels.forEach((label, i) => {
      const tick = n.ticks[i];
      const slot = n.labels[i];
      if (!tick || !slot) return;
      tick.style.left = `${label.x}px`;
      slot.el.style.left = `${label.x + 8}px`;
      if (slot.day !== label.day) {
        slot.day = label.day;
        slot.el.className = label.day ? 'tl-ruler-label is-day' : 'tl-ruler-label';
      }
      setText(slot.text, label.text);
      const x = label.x + 8;
      const hidden = !!cover && x < cover[1] && x + this.width(this.fonts.ruler, label.text) > cover[0];
      if (hidden !== slot.hidden) {
        slot.hidden = hidden;
        slot.el.style.visibility = hidden ? 'hidden' : '';
      }
    });
    show(n.rulerNow, nowX !== null);
    if (nowX !== null) n.rulerNow.style.left = `${nowX - 7}px`;
  }

  private createRow(n: Nodes): RowNode {
    const row = clone<HTMLElement>(template().row);
    const num = row.firstElementChild as HTMLElement;
    const numText = textOf(num);
    const name = row.lastElementChild as HTMLElement;
    const nameText = textOf(name);
    n.layer.appendChild(row);
    return {
      el: row, num, numText, name, nameText, cells: [], focused: false, cellsRef: null, stamp: '', shown: true, bound: '',
      locks: { locked: null, unlocked: null, shown: null },
    };
  }

  private bindRow(node: RowNode, index: number, label: TimelineRow): void {
    node.cellsRef = null;
    node.stamp = '';
    if (!node.shown) {
      node.shown = true;
      node.el.style.visibility = '';
    }
    node.el.style.top = `${index * this.rowH}px`;
    node.bound = boundKey(label);
    setText(node.numText, String(label.number));
    this.setLock(node, label.lock);
    setText(node.nameText, this.fit(this.fonts.name, label.name, this.nameW - (label.lock ? this.lockW : 0)));
  }

  // The schedule's lock badge before the name, one node per state, made once.
  private setLock(node: RowNode, lock: TimelineRow['lock']): void {
    const locks = node.locks;
    if (lock === locks.shown) return;
    if (locks.shown) show(locks[locks.shown]!, false);
    locks.shown = lock;
    if (!lock) return;
    let badge = locks[lock];
    if (!badge) {
      badge = clone<HTMLElement>(template()[lock]);
      node.name.insertBefore(badge, node.nameText);
      locks[lock] = badge;
    } else {
      show(badge, true);
    }
  }

  private fillRow(node: RowNode, index: number, now: number, nowX: number, stamp: string): void {
    const focused = index === this.tl.row;
    if (focused !== node.focused) {
      node.focused = focused;
      node.num.className = focused ? 'tl-num is-focused' : 'tl-num';
      node.name.className = focused ? 'tl-name is-focused' : 'tl-name';
    }
    const cells = this.tl.cellsOf(index);
    if (cells === node.cellsRef && stamp === node.stamp) return;
    node.cellsRef = cells;
    node.stamp = stamp;
    if (!cells.length) {
      const c = this.claim(node, [-1])[0];
      this.setCls(c, 'tl-cell is-empty');
      this.setBox(c, CELLS_X, this.tl.cellsRight - CELLS_X);
      setText(c.titleText, this.style!.emptyLabel);
      this.setTime(c, '');
      this.setMarks(c, false, false);
      this.setProg(c, 0);
      return;
    }
    const nodes = this.claim(node, cells.map(cell => cell.start));
    const iconSize = this.iconSize;
    for (let k = 0; k < cells.length; k++) {
      const cell = cells[k];
      const c = nodes[k];
      const aired = cell.stop <= now;
      const live = !aired && cell.start <= now;
      const w = cell.x1 - cell.x0;
      const marks = this.tl.cellMarks(index, cell, now);
      const narrow = w < NARROW_CELL;
      const pad = narrow ? NARROW_PAD : CELL_PAD;
      const inner = w - pad * 2;
      const bell = marks.reminder && inner > iconSize * 3 ? iconSize + 8 : 0;
      const replay = marks.replay && inner > iconSize * 3 ? this.replaySize + 6 : 0;
      // A cell too narrow for its whole time shows its title alone, centered.
      let fit = this.fitted.get(cell);
      if (!fit) {
        const label = `${formatTime(cell.programme.start)} – ${formatTime(cell.programme.stop)}`;
        fit = {
          time: this.width(this.fonts.time, label) <= inner - bell - replay ? label : '',
          title: inner < CELL_TEXT_MIN ? '' : this.fit(this.fonts.title, cell.programme.title, inner - bell),
        };
        this.fitted.set(cell, fit);
      }
      let cls = aired ? 'tl-cell is-aired' : live ? 'tl-cell is-live' : 'tl-cell';
      if (cell.clipLeft) cls += ' clip-l';
      else if (w > STATE_BAR * 3) cls += ' has-bar';
      if (cell.clipRight) cls += ' clip-r';
      if (narrow) cls += ' narrow';
      if (!fit.time) cls += ' no-time';
      this.setCls(c, cls);
      this.setBox(c, cell.x0, w);
      setText(c.titleText, fit.title);
      this.setTime(c, fit.time);
      this.setMarks(c, !!bell, !!(replay && fit.time));
      this.setProg(c, live ? Math.max(0, Math.min(cell.x1, nowX) - cell.x0) : 0);
    }
  }

  // Gives each key a node: the one that showed it last if any, else a spare.
  // Any node fits any cell; matching only spares rewriting what it shows.
  private claim(row: RowNode, keys: number[]): CellNode[] {
    const out: CellNode[] = new Array<CellNode>(keys.length);
    const byKey = new Map<number, number>();
    keys.forEach((key, i) => byKey.set(key, i));
    const spare: CellNode[] = [];
    for (const c of row.cells) {
      const i = c.shown ? byKey.get(c.key) : undefined;
      if (i !== undefined && !out[i]) out[i] = c;
      else spare.push(c);
    }
    let s = 0;
    for (let i = 0; i < keys.length; i++) {
      if (out[i]) continue;
      const c = spare[s++] ?? this.createCell(row);
      c.key = keys[i];
      out[i] = c;
    }
    for (const c of out) {
      if (!c.shown) {
        c.shown = true;
        show(c.el, true);
      }
    }
    for (; s < spare.length; s++) {
      const c = spare[s];
      if (c.shown) {
        c.shown = false;
        c.key = NaN;
        show(c.el, false);
      }
    }
    return out;
  }

  private createCell(row: RowNode): CellNode {
    const cell = clone<HTMLElement>(template().cell);
    row.el.appendChild(cell);
    const titleText = textOf(cell.firstElementChild!);
    const time = cell.lastElementChild as HTMLElement;
    const timeText = textOf(time);
    const c: CellNode = {
      el: cell, titleText, time, timeText, replay: null, bell: null, prog: null, key: NaN,
      cls: 'tl-cell', left: NaN, width: NaN, timeV: '', progW: 0, bellOn: false, replayOn: false, shown: true,
    };
    row.cells.push(c);
    return c;
  }

  private ctx(font: string): CanvasRenderingContext2D | null {
    if (!this.measure) this.measure = document.createElement('canvas').getContext('2d');
    if (this.measure && this.measureFont !== font) {
      this.measureFont = font;
      this.measure.font = font;
    }
    return this.measure;
  }

  private width(font: string, text: string): number {
    return this.ctx(font)?.measureText(text).width ?? 0;
  }

  // The text, or its longest prefix with an ellipsis that fits.
  private fit(font: string, text: string, maxW: number): string {
    if (maxW <= 0) return '';
    const key = `${font}|${Math.floor(maxW)}|${text}`;
    const hit = this.fitCache.get(key);
    if (hit !== undefined) return hit;
    const ctx = this.ctx(font);
    let out = text;
    if (ctx && ctx.measureText(text).width > maxW) {
      // Counts whole characters, so a cut never splits one.
      const ends = graphemeEnds(text);
      let lo = 0;
      let hi = ends.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(`${text.slice(0, ends[mid - 1])}…`).width <= maxW) lo = mid;
        else hi = mid - 1;
      }
      out = lo > 0 ? `${text.slice(0, ends[lo - 1]).replace(/\s+$/, '')}…` : '';
    }
    if (this.fitCache.size > FIT_CACHE_LIMIT) this.fitCache.clear();
    this.fitCache.set(key, out);
    return out;
  }

  private setCls(c: CellNode, cls: string): void {
    if (c.cls !== cls) {
      c.cls = cls;
      c.el.className = cls;
    }
  }

  private setBox(c: CellNode, left: number, width: number): void {
    if (c.left !== left) {
      c.left = left;
      c.el.style.left = `${left}px`;
    }
    if (c.width !== width) {
      c.width = width;
      c.el.style.width = `${width}px`;
    }
  }

  private setTime(c: CellNode, text: string): void {
    if (c.timeV === text) return;
    if (!c.timeV !== !text) show(c.time, !!text);
    c.timeV = text;
    setText(c.timeText, text);
  }

  private setMarks(c: CellNode, bell: boolean, replay: boolean): void {
    if (bell !== c.bellOn) {
      c.bellOn = bell;
      if (bell && !c.bell) {
        c.bell = clone<SVGElement>(template().bell);
        c.el.appendChild(c.bell);
      } else if (c.bell) show(c.bell, bell);
    }
    if (replay !== c.replayOn) {
      c.replayOn = replay;
      if (replay && !c.replay) {
        c.replay = clone<SVGElement>(template().replay);
        c.time.insertBefore(c.replay, c.timeText);
      } else if (c.replay) show(c.replay, replay);
    }
  }

  private setProg(c: CellNode, w: number): void {
    if (w === c.progW) return;
    if (!c.prog) c.prog = c.el.appendChild(clone<HTMLElement>(template().prog));
    if (!c.progW !== !w) show(c.prog, w > 0);
    c.progW = w;
    c.prog.style.width = `${w}px`;
  }
}
