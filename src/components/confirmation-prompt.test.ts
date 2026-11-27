// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Focus } from '../navigation/focus-scope';
import { ConfirmationPrompt } from './confirmation-prompt';
import { ReminderPrompt } from './reminder-prompt';
import { scopeId } from '../test/scope-id';

let prompt: ConfirmationPrompt;
type Options = Parameters<ConfirmationPrompt['show']>[0];
let onConfirm: Mock<Options['onConfirm']>;
let onCancel: Mock<Options['onCancel']>;

beforeEach(() => {
  document.body.innerHTML = '';
  prompt = new ConfirmationPrompt(scopeId('prompt.test'));
  onConfirm = vi.fn<Options['onConfirm']>();
  onCancel = vi.fn<Options['onCancel']>();
  prompt.show({
    title: 'Clear data?',
    message: 'This removes local data.',
    confirmLabel: 'Clear',
    cancelLabel: 'Cancel',
    onConfirm,
    onCancel,
  });
});

afterEach(() => Focus.uninstall());

describe('ConfirmationPrompt', () => {
  it('defaults focus to Cancel for destructive actions', () => {
    prompt.handleAction('select');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(prompt.visible).toBe(false);
  });

  it('moves to the destructive action and activates it with the D-pad', () => {
    prompt.handleAction('left');
    prompt.handleAction('select');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('defaults focus to the action when it destroys nothing', () => {
    prompt.show({
      title: 'Find', message: 'About 5 requests', confirmLabel: 'Find', cancelLabel: 'Cancel',
      danger: false, onConfirm, onCancel,
    });
    prompt.handleAction('select');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps focus on Cancel when a busy prompt turns ready, so OK still cancels', () => {
    prompt.show({
      title: 'Turn on?', message: 'Checking', confirmLabel: 'Turn on', cancelLabel: 'Cancel',
      danger: false, busy: true, onConfirm, onCancel,
    });
    prompt.update({ message: 'About 5 requests', busy: false });
    expect(Array.from(document.querySelectorAll('.focused')).map((el) => el.getAttribute('data-key')))
      .toEqual(['cancel']);
    prompt.handleAction('select');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels on Back', () => {
    prompt.handleAction('back');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('supports pointer activation', () => {
    document.querySelector<HTMLElement>('[data-confirm-action="cancel"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the button under the pointer', () => {
    document.querySelector<HTMLElement>('[data-confirm-action="confirm"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    expect(document.querySelector('[data-confirm-action="confirm"]')!
      .classList.contains('focused')).toBe(true);
    expect(document.querySelector('[data-confirm-action="cancel"]')!
      .classList.contains('focused')).toBe(false);

    prompt.handleAction('select');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('owns the keys while shown and hands them back when closed', () => {
    const base = Focus.register({ id: scopeId('view.test'), root: document.body });
    Focus.setBase(() => base);
    expect(Focus.owner()?.id).toBe('prompt.test');
    expect(Focus.owner()?.modal).toBe(true);

    Focus.owner()!.handle('left');
    Focus.owner()!.handle('select');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(Focus.owner()).toBe(base);
    expect(document.querySelectorAll('.focused')).toHaveLength(0);
  });

  it('shows one ring, on Cancel, again after a reopen', () => {
    prompt.handleAction('left');
    prompt.handleAction('back');
    prompt.show({ title: 'T', message: 'M', confirmLabel: 'Yes', cancelLabel: 'No', onConfirm, onCancel });
    expect(Array.from(document.querySelectorAll('.focused')).map((el) => el.getAttribute('data-key')))
      .toEqual(['cancel']);
  });

  it('stays hidden when another prompt holds its scope id', () => {
    const other = new ConfirmationPrompt(scopeId('prompt.test'));
    expect(() => other.show({ title: 'T', message: 'M', confirmLabel: 'Yes', cancelLabel: 'No',
      onConfirm, onCancel })).toThrow(/already registered/);
    expect(document.querySelectorAll('.confirmation-prompt:not(.hidden)')).toHaveLength(1);
    expect(Focus.owner()?.id).toBe('prompt.test');
    expect(prompt.visible).toBe(true);
  });

  it('paints above a prompt of its tier that was shown before it', () => {
    prompt.hide();
    const reminder = new ReminderPrompt();
    reminder.show('Alpha', 'ch1', { onConfirm: vi.fn(), onCancel: vi.fn() });
    reminder.hide();
    const later = new ConfirmationPrompt(scopeId('prompt.later'));
    later.show({ title: 'T', message: 'M', confirmLabel: 'Yes', cancelLabel: 'No', onConfirm, onCancel });
    later.hide();

    reminder.show('Bravo', 'ch2', { onConfirm: vi.fn(), onCancel: vi.fn() });
    expect(Focus.owner()?.id).toBe('prompt.reminder');
    expect(document.body.lastElementChild?.classList.contains('reminder-prompt')).toBe(true);

    later.show({ title: 'T', message: 'M', confirmLabel: 'Yes', cancelLabel: 'No', onConfirm, onCancel });
    expect(Focus.owner()?.id).toBe('prompt.later');
    expect(document.body.lastElementChild?.classList.contains('confirmation-prompt')).toBe(true);
  });
});
