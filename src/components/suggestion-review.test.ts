// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Focus } from '../navigation/focus-scope';
import { SuggestionReview, type ReviewItem, type ReviewOptions } from './suggestion-review';
import { scopeId } from '../test/scope-id';

let review: SuggestionReview;
let onDecide: Mock<ReviewOptions['onDecide']>;
let onUndo: Mock<ReviewOptions['onUndo']>;
let onClose: Mock<ReviewOptions['onClose']>;

const items: ReviewItem[] = [
  { key: 'k1', title: 'Alpha', tags: [{ label: 'Adult' }, { label: 'Rules' }], high: true },
  { key: 'k2', title: 'Bravo', tags: [{ label: 'Mature' }, { label: 'AI' }, { label: 'Low' }], high: false },
  { key: 'k3', title: 'Charlie', tags: [{ label: 'Adult' }, { label: 'AI' }, { label: 'High' }], high: true },
];

function show(list: ReviewItem[] = items): void {
  review.show({
    labels: {
      title: 'Review',
      accept: 'Lock',
      reject: 'Dismiss',
      undo: 'Undo',
      accepted: 'Locked',
      rejected: 'Dismissed',
      acceptAllHigh: count => `Lock all (${count})`,
    },
    items: list,
    onDecide,
    onUndo,
    onClose,
  });
}

const focused = () => document.querySelector<HTMLElement>('.suggestion-review .focused')?.dataset.key;
const row = (key: string) => document.querySelector(`[data-key="row|${key}"]`)!;

beforeEach(() => {
  document.body.innerHTML = '';
  review = new SuggestionReview(scopeId('prompt.review-test'));
  onDecide = vi.fn<ReviewOptions['onDecide']>();
  onUndo = vi.fn<ReviewOptions['onUndo']>();
  onClose = vi.fn<ReviewOptions['onClose']>();
});

afterEach(() => Focus.uninstall());

describe('SuggestionReview', () => {
  it('starts on the first Lock, accepts a row, and moves to the next one', () => {
    show();
    expect(focused()).toBe('a|k1');
    review.handleAction('select');
    expect(onDecide).toHaveBeenCalledWith(['k1'], 'accepted');
    expect(row('k1').classList.contains('is-accepted')).toBe(true);
    expect(row('k1').textContent).toContain('Locked');
    expect(focused()).toBe('a|k2');
    expect(document.querySelector('[data-review-all]')?.textContent).toContain('Lock all (1)');
  });

  it('starts on Done when it opens unasked', () => {
    review.show({
      labels: { title: 'Review', accept: 'Lock', reject: 'Dismiss', undo: 'Undo', accepted: 'Locked',
        rejected: 'Dismissed', acceptAllHigh: count => `Lock all (${count})` },
      items, onDecide, onUndo, onClose, unasked: true,
    });
    expect(focused()).toBe('review:done');
    review.handleAction('select');
    expect(onDecide).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects with the second button and undoes back to it', () => {
    show();
    review.handleAction('right');
    expect(focused()).toBe('r|k1');
    review.handleAction('right');
    expect(focused()).toBe('r|k1');
    review.handleAction('select');
    expect(onDecide).toHaveBeenCalledWith(['k1'], 'rejected');
    expect(focused()).toBe('r|k2');
    review.handleAction('up');
    expect(focused()).toBe('u|k1');
    review.handleAction('select');
    expect(onUndo).toHaveBeenCalledWith('k1', 'rejected');
    expect(focused()).toBe('r|k1');
    expect(row('k1').classList.contains('is-rejected')).toBe(false);
  });

  it('accepts every pending high-confidence row at once', () => {
    show();
    review.handleAction('up');
    expect(focused()).toBe('review:all');
    review.handleAction('select');
    expect(onDecide).toHaveBeenCalledWith(['k1', 'k3'], 'accepted');
    expect(document.querySelector('[data-review-all]')).toBeNull();
    expect(row('k2').classList.contains('is-accepted')).toBe(false);
    expect(focused()).toBe('u|k1');
  });

  it('reaches Done below the last row and closes on Back', () => {
    show();
    for (let i = 0; i < 4; i++) review.handleAction('down');
    expect(focused()).toBe('review:done');
    review.handleAction('back');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(review.visible).toBe(false);
  });

  it('acts on a pointer click and escapes untrusted names', () => {
    show([{ key: 'x"1', title: '<img src=x onerror=alert(1)>', tags: [{ label: 'Adult' }], high: false }]);
    expect(document.querySelector('.suggestion-review img')).toBeNull();
    expect(document.querySelector('[data-review-all]')).toBeNull();
    document.querySelector<HTMLElement>('[data-key="r|x&quot;1"], [data-key=\'r|x"1\']')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDecide).toHaveBeenCalledWith(['x"1'], 'rejected');
  });

  it('mounts only the rows in view of a long list', () => {
    show(Array.from({ length: 300 }, (_, i) => ({ key: `k${i}`, title: `Group ${i}`, tags: [], high: false })));
    expect(document.querySelectorAll('.suggestion-review-row').length).toBeLessThan(40);
    // Past the rows mounted at first, which number under 40.
    for (let i = 0; i < 60; i++) review.handleAction('down');
    expect(focused()).toBe('a|k60');
  });

  it('spaces rows by the text size', () => {
    document.documentElement.style.setProperty('--font-scale', '1.5');
    try {
      show();
      const tops = Array.from(document.querySelectorAll<HTMLElement>('.suggestion-review-row'))
        .map(row => parseFloat(row.style.top));
      expect(tops.slice(0, 3)).toEqual([0, 113, 226]);
    } finally {
      document.documentElement.style.removeProperty('--font-scale');
    }
  });

  it('heads each section with a caption and steps across it', () => {
    show([
      { key: 'b1', title: 'Alpha', tags: [{ label: 'Adult', tone: 'warning' }], high: true, section: 'Built' },
      { key: 'b2', title: 'Bravo', tags: [], high: true, section: 'Built' },
      { key: 'a1', title: 'Charlie', tags: [{ label: 'Likely', tone: 'accent' }], high: true, section: 'Guess', ai: true },
    ]);
    const tops = Array.from(document.querySelectorAll<HTMLElement>('.suggestion-review-caption, .suggestion-review-row'))
      .map(el => [el.textContent!.trim().split(/\s+/)[0], parseFloat(el.style.top)]);
    // 44px captions and a 78px row step at text size 100.
    expect(tops).toEqual([['Built', 0], ['Alpha', 44], ['Bravo', 122], ['Guess', 200], ['Charlie', 244]]);
    // Only the AI section's caption wears the AI icon.
    expect(Array.from(document.querySelectorAll('.suggestion-review-caption'), el => !!el.querySelector('.ai-icon svg')))
      .toEqual([false, true]);
    expect(document.querySelector('[data-key="row|b1"] em')!.className).toBe('is-warning');
    expect(document.querySelector('[data-key="row|a1"] em')!.className).toBe('is-accent');
    review.handleAction('down');
    review.handleAction('down');
    expect(focused()).toBe('a|a1');
    review.handleAction('up');
    expect(focused()).toBe('a|b2');
  });
});
