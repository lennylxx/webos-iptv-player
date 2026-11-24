import type { Action } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { fontScale, html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { AI_ICON } from './icons';
import { doneHint } from './key-hints';

// A 70px row plus an 8px gap, and a 44px section caption, at text size 100;
// rows and captions grow with the text size (see the dialog section of parental-controls.css).
const ROW_HEIGHT = 70;
const ROW_GAP = 8;
const CAPTION_HEIGHT = 44;
// The shortest scrollbar thumb, so a long list still shows one to see.
const MIN_THUMB = 40;
// .suggestion-review-list's top and bottom padding.
const LIST_PADDING = 4;
const LIST_OVERSCAN = 6;
const FALLBACK_LIST_HEIGHT = 560;
const ALL_KEY = 'review:all';
const DONE_KEY = 'review:done';

export interface ReviewTag {
  label: string;
  // warning: what was found; accent: a confident AI pick; plain: anything else.
  tone?: 'warning' | 'accent';
}

export interface ReviewItem {
  key: string;
  title: string;
  // Short labels shown beside the title, such as what was found.
  tags: ReviewTag[];
  // Taken by "accept all high-confidence".
  high: boolean;
  // A caption heads each run of items with the same section.
  section?: string;
  // The section holds AI picks: its caption shows the AI icon.
  ai?: boolean;
}

// A list line: a section caption, or the row of an item by its index.
type Entry = { caption: string; ai?: boolean } | { row: number };

export type ReviewDecision = 'accepted' | 'rejected';

export interface ReviewLabels {
  title: string;
  subtitle?: string;
  notice?: string;
  accept: string;
  reject: string;
  undo: string;
  accepted: string;
  rejected: string;
  acceptAllHigh: (count: number) => string;
}

export interface ReviewOptions {
  labels: ReviewLabels;
  items: ReviewItem[];
  // Applies at once; the row stays with Undo until the review closes.
  onDecide: (keys: string[], decision: ReviewDecision) => void;
  onUndo: (key: string, decision: ReviewDecision) => void;
  onClose: () => void;
  // Opened without the parent asking, such as when a check ends: focus starts
  // on Done, so a key meant for something else can't lock anything.
  unasked?: boolean;
}

type Button = 'a' | 'r' | 'u';

function buttonKey(button: Button, itemKey: string): string {
  return `${button}|${itemKey}`;
}

/**
 * A modal list of suggestions to accept or reject one by one, or all the
 * high-confidence ones at once. Shared by every feature that suggests
 * changes; the caller applies each decision.
 */
export class SuggestionReview {
  private el: HTMLElement | null = null;
  private options: ReviewOptions | null = null;
  private decisions = new Map<string, ReviewDecision>();
  private scope: FocusScope | null = null;
  private focusKey = DONE_KEY;
  private virtualizer = new VirtualList({ overscan: LIST_OVERSCAN, fallbackViewportSize: FALLBACK_LIST_HEIGHT });
  private entries: Entry[] = [];
  // The entry of each item's row.
  private rowEntries: number[] = [];
  private readonly scrollGuard = new VirtualScrollGuard();
  private scrollFrame: number | null = null;

  // `id` names the focus scope, registered on the first show.
  constructor(private readonly id: string) {}

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(options: ReviewOptions): void {
    if (!this.scope) {
      this.scope = Focus.register({
        id: this.id,
        root: () => this.el,
        restrict: 'self-only',
        onAction: action => this.handleAction(action),
        defaultKey: () => this.focusKey,
        has: key => this.has(key),
        reveal: key => this.reveal(key),
      });
    }
    this.options = options;
    this.decisions = new Map();
    this.layOut(fontScale());
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'suggestion-review';
      this.el.setAttribute('data-self-activate', '');
      this.bindEvents();
    }
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    Focus.push(this.scope);
    const first = options.items[0];
    this.moveTo(first && !options.unasked ? buttonKey('a', first.key) : DONE_KEY, 'key');
  }

  private layOut(scale: number): void {
    const entries: Entry[] = [];
    const sizes: number[] = [];
    this.rowEntries = [];
    let section: string | undefined;
    this.items().forEach((item, index) => {
      if (item.section && item.section !== section) {
        entries.push({ caption: item.section, ai: item.ai });
        sizes.push(Math.round(CAPTION_HEIGHT * scale));
      }
      section = item.section;
      this.rowEntries.push(entries.length);
      entries.push({ row: index });
      sizes.push(Math.round(ROW_HEIGHT * scale) + ROW_GAP);
    });
    this.entries = entries;
    this.virtualizer = new VirtualList({ overscan: LIST_OVERSCAN, fallbackViewportSize: FALLBACK_LIST_HEIGHT });
    this.virtualizer.setItemSizes(sizes);
  }

  // Brings a row into view with the captions next to it: the one it heads a
  // section under, and the next section's below the section's last row.
  // The list then starts on a whole line, so no sliver of the line above
  // shows under the pinned buttons.
  private ensureRowVisible(index: number): boolean {
    const entry = this.rowEntries[index];
    const viewport = this.viewport();
    const before = this.virtualizer.scrollOffset;
    const next = this.entries[entry + 1];
    if (next && 'caption' in next) this.virtualizer.ensureVisible(entry + 1, viewport);
    if (entry > 0 && 'caption' in this.entries[entry - 1]) this.virtualizer.ensureVisible(entry - 1, viewport);
    this.virtualizer.ensureVisible(entry, viewport);
    const offset = this.virtualizer.scrollOffset;
    for (let i = 0; i <= entry; i++) {
      const start = this.virtualizer.getItemOffset(i);
      if (start >= offset) {
        this.virtualizer.setScrollOffset(start);
        break;
      }
    }
    return this.virtualizer.scrollOffset !== before;
  }

  hide(): void {
    if (!this.visible) return;
    this.el?.classList.add('hidden');
    this.options = null;
    if (this.scope) Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    if (!this.visible || !this.options) return;
    switch (action) {
      case 'up':
      case 'down':
        this.step(action === 'up' ? -1 : 1);
        break;
      case 'left':
      case 'right':
        this.side(action === 'left' ? 0 : 1);
        break;
      case 'select':
        this.activate(this.focusKey);
        break;
      case 'back':
      case 'yellow':
        this.close();
        break;
    }
  }

  private close(): void {
    const options = this.options;
    this.hide();
    options?.onClose();
  }

  private items(): ReviewItem[] {
    return this.options?.items ?? [];
  }

  private pendingHigh(): ReviewItem[] {
    return this.items().filter(item => item.high && !this.decisions.has(item.key));
  }

  private indexOf(itemKey: string): number {
    const items = this.items();
    for (let i = 0; i < items.length; i++) if (items[i].key === itemKey) return i;
    return -1;
  }

  private parse(key: string): { button: Button; index: number } | null {
    const match = /^([aru])\|([\s\S]*)$/.exec(key);
    if (!match) return null;
    const index = this.indexOf(match[2]);
    return index >= 0 ? { button: match[1] as Button, index } : null;
  }

  // The row's buttons, left to right.
  private buttonsOf(item: ReviewItem): Button[] {
    return this.decisions.has(item.key) ? ['u'] : ['a', 'r'];
  }

  private rowKey(index: number, column: number): string {
    const item = this.items()[index];
    const buttons = this.buttonsOf(item);
    return buttonKey(buttons[Math.min(column, buttons.length - 1)], item.key);
  }

  private columnOf(key: string): number {
    const at = this.parse(key);
    return at && at.button === 'r' ? 1 : 0;
  }

  private step(delta: number): void {
    const items = this.items();
    const key = this.focusKey;
    if (key === ALL_KEY) {
      if (delta > 0 && items.length) this.moveTo(this.rowKey(0, 0), 'key');
      return;
    }
    if (key === DONE_KEY) {
      if (delta < 0 && items.length) this.moveTo(this.rowKey(items.length - 1, 0), 'key');
      return;
    }
    const at = this.parse(key);
    if (!at) return;
    const next = at.index + delta;
    if (next < 0) {
      if (this.pendingHigh().length) this.moveTo(ALL_KEY, 'key');
      return;
    }
    if (next >= items.length) {
      this.moveTo(DONE_KEY, 'key');
      return;
    }
    this.moveTo(this.rowKey(next, this.columnOf(key)), 'key');
  }

  private side(column: number): void {
    const at = this.parse(this.focusKey);
    if (!at) return;
    const key = this.rowKey(at.index, column);
    if (key !== this.focusKey) this.moveTo(key, 'key');
  }

  // `via`: OK advances to the next row; a click stays on the clicked row, so
  // the list doesn't move under the pointer.
  private activate(key: string, via: Via = 'key'): void {
    const options = this.options;
    if (!options) return;
    if (key === DONE_KEY) {
      this.close();
      return;
    }
    if (key === ALL_KEY) {
      const high = this.pendingHigh();
      if (!high.length) return;
      for (const item of high) this.decisions.set(item.key, 'accepted');
      options.onDecide(high.map(item => item.key), 'accepted');
      this.render();
      const first = this.indexOf(high[0].key);
      this.moveTo(this.rowKey(first, 0), via);
      return;
    }
    const at = this.parse(key);
    if (!at) return;
    const item = options.items[at.index];
    if (at.button === 'u') {
      const decision = this.decisions.get(item.key);
      if (!decision) return;
      this.decisions.delete(item.key);
      options.onUndo(item.key, decision);
      this.render();
      this.moveTo(buttonKey(decision === 'accepted' ? 'a' : 'r', item.key), via);
      return;
    }
    const decision: ReviewDecision = at.button === 'a' ? 'accepted' : 'rejected';
    this.decisions.set(item.key, decision);
    options.onDecide([item.key], decision);
    this.render();
    if (via === 'pointer') {
      this.moveTo(buttonKey('u', item.key), via);
      return;
    }
    // On to the next row, so a run of OK presses reviews the list in order.
    const next = at.index + 1 < options.items.length ? at.index + 1 : at.index;
    this.moveTo(this.rowKey(next, next === at.index ? 0 : this.columnOf(key)), 'key');
  }

  private has(key: string): boolean {
    if (key === ALL_KEY) return this.pendingHigh().length > 0;
    if (key === DONE_KEY) return true;
    const at = this.parse(key);
    return !!at && this.buttonsOf(this.items()[at.index]).indexOf(at.button) >= 0;
  }

  private reveal(key: string): boolean | null {
    const at = this.parse(key);
    if (!at) return false;
    if (this.ensureRowVisible(at.index)) this.render();
    return null;
  }

  private moveTo(key: string, via: Via): void {
    this.focusKey = key;
    const at = this.parse(key);
    if (at && via === 'key' && this.ensureRowVisible(at.index)) this.render();
    this.scope?.focus(key, via);
    Focus.flush();
  }

  private list(): HTMLElement | null {
    return this.el?.querySelector<HTMLElement>('[data-review-list]') ?? null;
  }

  private viewport(): number {
    return this.list()?.clientHeight || FALLBACK_LIST_HEIGHT;
  }

  private render(): void {
    const options = this.options;
    if (!this.el || !options) return;
    const { labels, items } = options;
    const high = this.pendingHigh().length;
    const range = this.virtualizer.getRange(this.entries.length, this.viewport());
    const rows: Safe[] = [];
    for (let index = range.start; index < range.end; index++) {
      const entry = this.entries[index];
      const top = this.virtualizer.getItemOffset(index);
      rows.push('caption' in entry
        ? html`<div class="suggestion-review-caption" data-key="caption|${entry.caption}"
                    style="top:${top}px">${entry.ai
          ? html`<span class="ai-icon">${raw(AI_ICON)}</span>` : ''}${entry.caption}</div>`
        : this.row(items[entry.row], top, labels));
    }
    morph(this.el, html`
      <div class="suggestion-review-dialog">
        <header class="suggestion-review-head">
          <h2 class="suggestion-review-title">${labels.title}</h2>
          ${labels.subtitle ? html`<span class="suggestion-review-subtitle">${labels.subtitle}</span>` : ''}
        </header>
        ${labels.notice ? html`<p class="suggestion-review-notice">${labels.notice}</p>` : ''}
        <div class="suggestion-review-actions" data-key="review:actions" data-nav-container>
          ${high ? html`
            <button class="btn" data-focusable data-key="${ALL_KEY}"
                    data-review-all>${labels.acceptAllHigh(high)}</button>` : ''}
        </div>
        <div class="suggestion-review-body" data-key="review:body">
          <div class="suggestion-review-list" data-key="review:list" data-review-list data-nav-container>
            <div class="suggestion-review-spacer" data-key="review:spacer"
                 style="height:${this.spacerHeight()}px">${rows}</div>
          </div>
          <div class="suggestion-review-scrollbar" data-key="review:scrollbar">
            <div class="suggestion-review-thumb"></div>
          </div>
        </div>
        <div class="edit-hints suggestion-review-hints" data-key="review:hints" data-nav-container>
          ${doneHint(DONE_KEY, { 'data-review-done': '' })}
        </div>
      </div>
    `);
    const list = this.list();
    if (list) {
      this.scrollGuard.syncOffset(list, 'vertical', this.virtualizer.scrollOffset);
      this.drawScrollbar(list);
    }
  }

  // Room below the last line so the list can still start on a whole line
  // when scrolled to its end.
  private spacerHeight(): number {
    const total = this.virtualizer.getTotalSize(this.entries.length);
    const viewport = this.list()?.clientHeight;
    if (!viewport || total <= viewport) return total;
    for (let i = 0; i < this.entries.length; i++) {
      const start = this.virtualizer.getItemOffset(i);
      if (total - start <= viewport) return Math.max(total, start + viewport - LIST_PADDING * 2);
    }
    return total;
  }

  // A drawn thumb, since a virtualized list's native bar can't be relied on
  // to show (headless and some TVs hide it); sized for the whole list.
  private drawScrollbar(list: HTMLElement): void {
    const track = this.el?.querySelector<HTMLElement>('.suggestion-review-scrollbar');
    const thumb = track?.querySelector<HTMLElement>('.suggestion-review-thumb');
    if (!track || !thumb) return;
    const viewport = list.clientHeight;
    const total = list.scrollHeight;
    const room = track.clientHeight;
    const scrolls = viewport > 0 && total > viewport + 1;
    track.classList.toggle('hidden', !scrolls);
    if (!scrolls) return;
    const height = Math.max(MIN_THUMB, Math.round(room * viewport / total));
    const max = total - viewport;
    const top = Math.round((room - height) * Math.min(1, Math.max(0, this.virtualizer.scrollOffset / max)));
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${top}px)`;
  }

  private row(item: ReviewItem, top: number, labels: ReviewLabels): Safe {
    const decision = this.decisions.get(item.key);
    return html`
      <div class="suggestion-review-row ${decision ? `is-${decision}` : ''}" style="top:${top}px"
           data-key="row|${item.key}">
        <span class="suggestion-review-name">${item.title}</span>
        <span class="suggestion-review-tags">${item.tags.map(tag =>
          html`<em class="${tag.tone ? `is-${tag.tone}` : ''}">${tag.label}</em>`)}</span>
        ${decision ? html`
          <strong class="suggestion-review-state">${
            decision === 'accepted' ? labels.accepted : labels.rejected}</strong>
          <button class="btn" data-focusable data-key="${buttonKey('u', item.key)}">${labels.undo}</button>
        ` : html`
          <button class="btn" data-focusable data-key="${buttonKey('a', item.key)}">${labels.accept}</button>
          <button class="btn" data-focusable data-key="${buttonKey('r', item.key)}">${labels.reject}</button>
        `}
      </div>`;
  }

  private bindEvents(): void {
    const el = this.el!;
    el.addEventListener('nav:hover', (event: Event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      const key = target?.dataset.key;
      if (key) this.moveTo(key, 'pointer');
    });
    el.addEventListener('click', (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      const key = target?.dataset.key;
      if (!key) return;
      this.focusKey = key;
      this.activate(key, 'pointer');
    });
    el.addEventListener('scroll', (event: Event) => {
      const list = event.target;
      if (!(list instanceof HTMLElement) || !list.hasAttribute('data-review-list')) return;
      const offset = this.scrollGuard.readUserOffset(list, 'vertical');
      if (offset === null || Math.abs(offset - this.virtualizer.scrollOffset) < 1) return;
      this.virtualizer.setScrollOffset(offset);
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.render();
      });
    }, true);
  }
}
