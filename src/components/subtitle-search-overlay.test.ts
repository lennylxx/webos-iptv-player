// @vitest-environment jsdom
// src/components/subtitle-search-overlay.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SubtitleSearchOverlay } from './subtitle-search-overlay';
import { Focus, Tier } from '../navigation/focus-scope';
import { setInputMode } from '../navigation/input-mode';
import type { OnlineSubtitleResult } from '../services/subtitle-search/types';
import { scopeId } from '../test/scope-id';

function res(over: Partial<OnlineSubtitleResult>): OnlineSubtitleResult {
  return { providerId: 'subdl', id: 'i', language: 'l1', releaseName: 'Rel', fileName: 'f.srt', format: 'srt', hearingImpaired: false, downloads: 0, ...over };
}

afterEach(() => {
  Focus.uninstall();
  setInputMode('pointer');
  document.body.innerHTML = '';
});

describe('SubtitleSearchOverlay', () => {
  it('lists results and fires onPick on select', () => {
    const container = document.createElement('div');
    const onPick = vi.fn();
    const overlay = new SubtitleSearchOverlay(container, onPick, vi.fn());
    overlay.open([res({ id: 'a', releaseName: 'A' }), res({ id: 'b', releaseName: 'B' })], '');
    expect(overlay.visible).toBe(true);
    expect(container.querySelectorAll('[data-result-index]').length).toBe(2);
    overlay.handleAction('down');
    overlay.handleAction('select');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('escapes untrusted release text', () => {
    const container = document.createElement('div');
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn());
    overlay.open([res({ releaseName: '<img src=x onerror=alert(1)>' })], '');
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img');
  });

  it('shows a status message', () => {
    const container = document.createElement('div');
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn());
    overlay.showStatus('No subtitles found');
    expect(container.textContent).toContain('No subtitles found');
  });

  it('labels an Assrt result as Assrt', () => {
    const container = document.createElement('div');
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn());
    overlay.open([res({ providerId: 'assrt', releaseName: 'Rel' })], '');
    expect(container.textContent).toContain('Assrt');
  });

  it('shows a thousands-formatted download count when known', () => {
    const container = document.createElement('div');
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn());
    overlay.open([res({ downloads: 12345 })], '');
    const count = container.querySelector('.subs-count');
    expect(count?.textContent?.trim()).toBe('12,345');
  });

  it('omits the download count when it is unknown (zero)', () => {
    const container = document.createElement('div');
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn());
    overlay.open([res({ downloads: 0 })], '');
    expect(container.querySelector('.subs-count')).toBeNull();
  });

  it('auto-dismisses a terminal status after a few seconds', () => {
    vi.useFakeTimers();
    try {
      const container = document.createElement('div');
      const onClose = vi.fn();
      const overlay = new SubtitleSearchOverlay(container, vi.fn(), onClose);
      overlay.showStatus('Download failed', true);
      expect(overlay.visible).toBe(true);
      vi.advanceTimersByTime(3000);
      expect(overlay.visible).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a transient status visible (no auto-close)', () => {
    vi.useFakeTimers();
    try {
      const container = document.createElement('div');
      const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn());
      overlay.showStatus('Searching…');
      vi.advanceTimersByTime(10000);
      expect(overlay.visible).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefills the search box with the provided query', () => {
    const container = document.createElement('div');
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({})], '', 'Silent Harbor');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input');
    expect(input?.value).toBe('Silent Harbor');
  });

  it('keeps the search box present (with its query) while showing a status', () => {
    const container = document.createElement('div');
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.setQuery('Silent Harbor');
    overlay.showStatus('No subtitles found');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('Silent Harbor');
    expect(container.textContent).toContain('No subtitles found');
  });

  it('submits the trimmed query on Enter and ignores a blank query', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onSearch = vi.fn();
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), onSearch);
    overlay.open([res({})], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    input.value = '  hello world  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSearch).toHaveBeenCalledWith('hello world');
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it('ArrowDown in the search box moves focus into the results', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' })], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    input.focus();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).not.toBe(input);
    expect(container.querySelector('.subs-row.focused')?.getAttribute('data-result-index')).toBe('0');
    container.remove();
  });

  it('Up from the top result focuses the search box', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' })], '', 'Title');
    overlay.handleAction('up');
    expect(document.activeElement).toBe(container.querySelector('.subs-search-input'));
    container.remove();
  });

  it('moves the ring with the pointer, and the next key steps from where it rests', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' }), res({ id: 'c' }), res({ id: 'd' })], '', 'Title');
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.subs-row'));
    rows()[2].dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(rows().map((r) => r.classList.contains('focused'))).toEqual([false, false, true, false]);
    overlay.handleAction('down');
    expect(rows().map((r) => r.classList.contains('focused'))).toEqual([false, false, false, true]);
  });

  it('hides the list ring while the search box has the caret, and restores it on the way back', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' })], '', 'Title');
    overlay.handleAction('up');
    Focus.flush();
    expect(container.querySelectorAll('.focused')).toHaveLength(0);
    overlay.handleAction('back');
    expect(container.querySelector('.subs-row')!.classList.contains('focused')).toBe(true);
  });

  it('keeps the ring off a row hovered while the box has the caret, and Down lands on it', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' }), res({ id: 'c' }), res({ id: 'd' })], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.subs-row'));
    overlay.handleAction('up');
    expect(document.activeElement).toBe(input);
    rows()[2].dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    Focus.flush();
    expect(container.querySelectorAll('.focused')).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).not.toBe(input);
    expect(rows().map((r) => r.classList.contains('focused'))).toEqual([false, false, true, false]);
  });

  it('gives up the caret to a scope that takes the keys, and is back in the list after it', () => {
    const container = document.createElement('div');
    const menu = document.createElement('div');
    document.body.append(container, menu);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' })], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    overlay.handleAction('up');
    Focus.flush();
    expect(document.activeElement).toBe(input);
    const above = Focus.register({ id: scopeId('test.menu'), root: menu, tier: Tier.overlay });
    Focus.push(above);
    Focus.flush();
    expect(document.activeElement).not.toBe(input);
    Focus.pop(above);
    Focus.flush();
    expect(container.querySelector('.subs-row')!.classList.contains('focused')).toBe(true);
  });

  it('leaves no reveal waiting when the caret leaves while another scope owns the keys', () => {
    setInputMode('keys');
    const container = document.createElement('div');
    const menu = document.createElement('div');
    document.body.append(container, menu);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' })], '', 'Title');
    overlay.handleAction('up');
    Focus.flush();
    const row = container.querySelector<HTMLElement>('.subs-row')!;
    // Below the fold, so a reveal would scroll it.
    row.getBoundingClientRect = () =>
      ({ top: 2000, bottom: 2050, left: 0, right: 100, width: 100, height: 50 } as DOMRect);
    const scrolled = vi.fn();
    row.scrollIntoView = scrolled;
    const above = Focus.register({ id: scopeId('test.menu'), root: menu, tier: Tier.overlay });
    Focus.push(above);
    Focus.flush();
    expect(document.activeElement).not.toBe(container.querySelector('.subs-search-input'));

    Focus.pop(above);
    Focus.flush();

    expect(scrolled).not.toHaveBeenCalled();
    expect(container.querySelector('.subs-row')!.classList.contains('focused')).toBe(true);
  });

  it('drops the focused row when a status replaces the list, so nothing reports it repaired', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, () => overlay.showStatus('Downloading…'), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' })], '', 'Title');
    overlay.handleAction('down');
    overlay.handleAction('select');
    Focus.flush();
    await Promise.resolve();
    expect(container.textContent).toContain('Downloading…');
    expect(logs.filter((l) => l.includes('event=nav.focus.repaired'))).toEqual([]);
    vi.restoreAllMocks();
  });

  it('leaves results that arrive while the box has the caret unlit until Down', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' })], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    overlay.handleAction('up');
    overlay.showStatus('Searching…');
    overlay.open([res({ id: 'b' }), res({ id: 'c' })], '', 'Title');
    Focus.flush();
    expect(document.activeElement).toBe(input);
    expect(container.querySelectorAll('.focused')).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(container.querySelector('.subs-row')!.classList.contains('focused')).toBe(true);
  });

  it('lights the row it rests on however the caret leaves the box, so Down steps from it', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' }), res({ id: 'b' }), res({ id: 'c' }), res({ id: 'd' })], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.subs-row'));
    const lit = () => rows().map((r) => r.classList.contains('focused'));

    overlay.handleAction('up');
    input.blur();
    expect(lit()).toEqual([true, false, false, false]);
    overlay.handleAction('down');
    expect(lit()).toEqual([false, true, false, false]);

    overlay.handleAction('up');
    overlay.handleAction('up');
    expect(document.activeElement).toBe(input);
    rows()[2].dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    input.blur();
    expect(lit()).toEqual([false, false, true, false]);
    overlay.handleAction('down');
    expect(lit()).toEqual([false, false, false, true]);
  });

  it('takes the caret out of the box when it closes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), vi.fn(), vi.fn());
    overlay.open([res({ id: 'a' })], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    input.focus();
    overlay.close();
    expect(document.activeElement).not.toBe(input);
  });

  it('Back from the search box returns to the list; Back from the list closes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onClose = vi.fn();
    const overlay = new SubtitleSearchOverlay(container, vi.fn(), onClose, vi.fn());
    overlay.open([res({ id: 'a' })], '', 'Title');
    const input = container.querySelector<HTMLInputElement>('.subs-search-input')!;
    input.focus();
    overlay.handleAction('back');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    overlay.handleAction('back');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(overlay.visible).toBe(false);
    container.remove();
  });
});
