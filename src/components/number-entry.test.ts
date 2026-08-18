// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG } from '../config';

// The indicator keeps a module-level element, so reset the module per test —
// otherwise a cleared body leaves it holding a detached node and the
// assertions below pass against nothing.
let showNumberEntry: typeof import('./number-entry').showNumberEntry;
let hideNumberEntry: typeof import('./number-entry').hideNumberEntry;

const entry = () => document.querySelector<HTMLElement>('.number-entry');
// The label and countdown share the root, so read the digits from their own tiles.
const digits = () => Array.from(document.querySelectorAll('.number-entry-digit'))
  .map((tile) => tile.textContent)
  .join('');
const visible = () => entry()?.classList.contains('visible') ?? false;

describe('number entry indicator', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    vi.resetModules();
    ({ showNumberEntry, hideNumberEntry } = await import('./number-entry'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends the digits as they are typed', () => {
    showNumberEntry('2');
    expect(digits()).toBe('2');
    showNumberEntry('21');
    showNumberEntry('215');
    expect(digits()).toBe('215');
    expect(visible()).toBe(true);
    expect(document.querySelectorAll('.number-entry')).toHaveLength(1);
  });

  it('hides once the digits tune a channel', () => {
    showNumberEntry('215');
    expect(visible()).toBe(true);
    hideNumberEntry();
    expect(visible()).toBe(false);
  });

  it('hides itself if the flush never arrives', () => {
    showNumberEntry('2');
    vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT + 500);
    expect(visible()).toBe(false);
  });

  it('keeps the safety timeout alive while digits keep coming', () => {
    showNumberEntry('2');
    vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
    showNumberEntry('21');
    vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
    expect(visible()).toBe(true);
  });

  it('renders digits as text, never as markup', () => {
    showNumberEntry('<img src=x onerror="window.x=1">');
    expect(entry()).not.toBeNull();
    expect(entry()?.querySelector('img')).toBeNull();
  });
});
