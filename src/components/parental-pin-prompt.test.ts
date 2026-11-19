// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const parental = vi.hoisted(() => ({
  cancelChallenge: vi.fn(),
  createPin: vi.fn(async () => {}),
  replacePin: vi.fn(async () => {}),
  submitPin: vi.fn(async () => ({ accepted: true, blockedForMs: 0 })),
  verifyManagementPin: vi.fn(async () => ({ accepted: true, blockedForMs: 0 })),
  retryBlockedForMs: vi.fn(() => 0),
}));

vi.mock('../services/parental-control', () => ({
  ParentalControlService: parental,
}));

import { Focus, Tier } from '../navigation/focus-scope';
import { ParentalPinPrompt } from './parental-pin-prompt';

describe('ParentalPinPrompt', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });
  afterEach(() => Focus.uninstall());

  const type = (pin: string) => {
    const input = document.querySelector<HTMLInputElement>('.parental-pin-input')!;
    input.value = pin;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('submits on the last digit and creates a PIN after confirmation', async () => {
    const created = vi.fn();
    const prompt = new ParentalPinPrompt();
    prompt.showCreate(created);
    expect(document.querySelector('[data-pin-action="submit"]')).toBeNull();

    type('123');
    expect(document.querySelectorAll('.parental-pin-slots .filled')).toHaveLength(3);
    expect(document.querySelector('h2')?.textContent).not.toContain('Confirm');

    type('1234');
    await vi.waitFor(() =>
      expect(document.querySelector('h2')?.textContent).toContain('Confirm'));
    expect(document.querySelector<HTMLInputElement>('.parental-pin-input')!.value).toBe('');
    expect(parental.createPin).not.toHaveBeenCalled();

    type('1234');
    await vi.waitFor(() => expect(parental.createPin).toHaveBeenCalledWith('1234'));
    expect(created).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('rejects mismatched confirmation without persisting', async () => {
    const prompt = new ParentalPinPrompt();
    prompt.showCreate(vi.fn());

    type('1234');
    await vi.waitFor(() =>
      expect(document.querySelector('h2')?.textContent).toContain('Confirm'));
    type('5678');

    await vi.waitFor(() =>
      expect(document.querySelector('.parental-pin-error')?.textContent).not.toBe(''));
    expect(parental.createPin).not.toHaveBeenCalled();
    expect(document.querySelector('h2')?.textContent).not.toContain('Confirm');
  });

  it('replaces the PIN after a new PIN is confirmed', async () => {
    const changed = vi.fn();
    const prompt = new ParentalPinPrompt();
    prompt.showChange(changed);
    expect(document.querySelector('h2')?.textContent).toBe('Enter a new PIN');

    type('5678');
    await vi.waitFor(() =>
      expect(document.querySelector('h2')?.textContent).toBe('Confirm the new PIN'));
    type('5678');
    await vi.waitFor(() => expect(parental.replacePin).toHaveBeenCalledWith('5678'));
    expect(parental.createPin).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);

    prompt.showCreate(vi.fn());
    expect(document.querySelector('h2')?.textContent).toBe('Set a PIN to turn on parental controls');
  });

  it('warns about a forgotten PIN only while a new PIN is chosen', async () => {
    const prompt = new ParentalPinPrompt();
    const warning = () => document.querySelector('.parental-pin-warning');
    prompt.showCreate(vi.fn());
    expect(warning()?.textContent).toContain('use "Reset App" or reinstall the app');

    type('1234');
    await vi.waitFor(() => expect(document.querySelector('h2')?.textContent).toBe('Confirm parental PIN'));
    expect(warning()).toBeNull();

    prompt.showVerify('Parental controls', vi.fn());
    expect(warning()).toBeNull();
  });

  describe('lockout', () => {
    const error = () => document.querySelector('.parental-pin-error')?.textContent;
    const input = () => document.querySelector<HTMLInputElement>('.parental-pin-input')!;
    const cancel = () => document.querySelector('[data-pin-action="cancel"]');

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('disables the input and counts down whole minutes until it ends', async () => {
      parental.verifyManagementPin.mockResolvedValueOnce({ accepted: false, blockedForMs: 120_000 });
      const prompt = new ParentalPinPrompt();
      prompt.showVerify('Verify', vi.fn());
      type('1111');
      await vi.waitFor(() => expect(error()).toBe('Too many attempts. Try again in 2 minutes.'));
      expect(input().disabled).toBe(true);
      expect(document.activeElement).toBe(cancel());

      await vi.advanceTimersByTimeAsync(59_000);
      expect(error()).toBe('Too many attempts. Try again in 2 minutes.');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(error()).toBe('Too many attempts. Try again in 1 minute.');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(error()).toBe('');
      expect(input().disabled).toBe(false);
      expect(document.activeElement).toBe(input());
    });

    it('shows a short lockout in seconds without ticking', async () => {
      parental.verifyManagementPin.mockResolvedValueOnce({ accepted: false, blockedForMs: 30_000 });
      const prompt = new ParentalPinPrompt();
      prompt.showVerify('Verify', vi.fn());
      type('1111');
      await vi.waitFor(() => expect(error()).toBe('Too many attempts. Try again in 30 seconds.'));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(error()).toBe('Too many attempts. Try again in 30 seconds.');
      expect(input().disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(input().disabled).toBe(false);
    });

    it('opens disabled while a lockout is still running, and stops it on hide', async () => {
      parental.retryBlockedForMs.mockReturnValueOnce(61_000);
      const prompt = new ParentalPinPrompt();
      prompt.showVerify('Verify', vi.fn());
      expect(error()).toBe('Too many attempts. Try again in 2 minutes.');
      expect(input().disabled).toBe(true);

      prompt.hide();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(error()).not.toContain('1 minute');
      prompt.showVerify('Verify', vi.fn());
      expect(input().disabled).toBe(false);
      expect(error()).toBe('');
    });

    it('does not apply a lockout to choosing a new PIN', () => {
      parental.retryBlockedForMs.mockReturnValue(30_000);
      const prompt = new ParentalPinPrompt();
      prompt.showChange(vi.fn());
      expect(input().disabled).toBe(false);
      parental.retryBlockedForMs.mockReturnValue(0);
    });
  });

  it('asks generically for a request that keeps its name hidden', () => {
    const prompt = new ParentalPinPrompt();
    prompt.showChallenge({ target: { kind: 'live', id: 'ch1' }, parents: [], intent: 'reminder', label: '' } as never);
    expect(document.querySelector('h2')?.textContent).toBe('Enter PIN to watch a locked program');
  });

  it('types a digit pressed while Cancel has focus into the field', async () => {
    const prompt = new ParentalPinPrompt();
    prompt.showVerify('Verify', vi.fn());
    prompt.handleAction('down');
    for (const digits of ['1', '12', '123', '4']) prompt.handleAction('number_input', { number: Number(digits), digits });

    const input = document.querySelector<HTMLInputElement>('.parental-pin-input')!;
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(parental.verifyManagementPin).toHaveBeenCalledWith('1234'));
  });

  it('rings Cancel by key and by hover, and hides the ring while the field has the caret', () => {
    const prompt = new ParentalPinPrompt();
    prompt.showVerify('Verify', vi.fn());
    const input = document.querySelector<HTMLInputElement>('.parental-pin-input')!;
    const cancel = document.querySelector<HTMLElement>('[data-pin-action="cancel"]')!;
    const rings = () => { Focus.flush(); return Array.from(document.querySelectorAll('.focused')); };
    expect(document.activeElement).toBe(input);
    expect(rings()).toEqual([]);

    prompt.handleAction('down');
    expect(document.activeElement).toBe(cancel);
    expect(rings()).toEqual([cancel]);

    prompt.handleAction('up');
    expect(document.activeElement).toBe(input);
    expect(rings()).toEqual([]);

    cancel.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    expect(rings()).toEqual([cancel]);
  });

  it('ignores a PIN check that finishes after Back closed the prompt', async () => {
    let finish: (value: { accepted: boolean; blockedForMs: number }) => void = () => {};
    parental.verifyManagementPin.mockImplementationOnce(() =>
      new Promise(resolve => { finish = resolve; }));
    const first = vi.fn();
    const second = vi.fn();
    const prompt = new ParentalPinPrompt();
    prompt.showVerify('First', first);
    type('1234');
    await vi.waitFor(() => expect(parental.verifyManagementPin).toHaveBeenCalled());

    prompt.handleAction('back');
    prompt.showVerify('Second', second);
    finish({ accepted: true, blockedForMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(prompt.visible).toBe(true);
    expect(document.querySelector('h2')?.textContent).toBe('Second');
  });

  it('keeps the keys over a prompt pushed after it, until it closes', () => {
    const prompt = new ParentalPinPrompt();
    prompt.showVerify('First', vi.fn());
    const later = Focus.register({ id: 'prompt.later', root: document.body, restrict: 'self-only' });
    Focus.push(later);
    expect(Focus.owner()?.id).toBe('prompt.parental_pin');
    expect(Focus.owner()?.modal).toBe(true);

    prompt.handleAction('back');
    expect(Focus.owner()).toBe(later);
    expect(Tier.critical).toBeGreaterThan(Tier.prompt);
  });
});
