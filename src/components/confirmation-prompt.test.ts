// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationPrompt } from './confirmation-prompt';

let prompt: ConfirmationPrompt;
let onConfirm: ReturnType<typeof vi.fn>;
let onCancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = '';
  prompt = new ConfirmationPrompt();
  onConfirm = vi.fn();
  onCancel = vi.fn();
  prompt.show({
    title: 'Clear data?',
    message: 'This removes local data.',
    confirmLabel: 'Clear',
    cancelLabel: 'Cancel',
    onConfirm,
    onCancel,
  });
});

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

  it('cancels on Back', () => {
    prompt.handleAction('back');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('supports pointer activation', () => {
    document.querySelector<HTMLElement>('[data-confirm-action="cancel"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
