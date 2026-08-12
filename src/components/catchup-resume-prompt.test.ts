// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CatchupResumePrompt } from './catchup-resume-prompt';

let prompt: CatchupResumePrompt;
beforeEach(() => {
  document.body.innerHTML = '';
  prompt = new CatchupResumePrompt();
});

const buttons = () => Array.from(document.querySelectorAll('.catchup-resume-btn'));
const focused = () => document.querySelector('.catchup-resume-btn.focused');

describe('CatchupResumePrompt', () => {
  it('is not visible before show', () => {
    expect(prompt.visible).toBe(false);
  });

  it('renders title, formatted position, three buttons, Resume focused by default', () => {
    prompt.show('My Show', 125, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() });
    expect(prompt.visible).toBe(true);
    const msg = document.querySelector('.catchup-resume-message')!;
    expect(msg.textContent).toContain('My Show');
    expect(msg.textContent).toContain('2:05');
    expect(buttons().map(b => b.textContent?.trim())).toEqual(['Resume', 'Start Over', 'Cancel']);
    expect(focused()!.textContent?.trim()).toBe('Resume');
  });

  it('select on Resume invokes onResume and hides', () => {
    const onResume = vi.fn();
    prompt.show('S', 10, { onResume, onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.handleAction('select');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('right moves focus to Start Over', () => {
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.handleAction('right');
    expect(focused()!.textContent?.trim()).toBe('Start Over');
  });

  it('right right moves focus to Cancel', () => {
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.handleAction('right');
    prompt.handleAction('right');
    expect(focused()!.textContent?.trim()).toBe('Cancel');
  });

  it('right does not wrap past Cancel', () => {
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.handleAction('right');
    prompt.handleAction('right');
    prompt.handleAction('right');
    expect(focused()!.textContent?.trim()).toBe('Cancel');
  });

  it('left does not move past Resume (no wrapping)', () => {
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.handleAction('left');
    expect(focused()!.textContent?.trim()).toBe('Resume');
  });

  it('right then left returns focus to Resume', () => {
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.handleAction('right');
    prompt.handleAction('left');
    expect(focused()!.textContent?.trim()).toBe('Resume');
  });

  it('right then select invokes onStartOver and hides', () => {
    const onStartOver = vi.fn();
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver, onCancel: vi.fn() });
    prompt.handleAction('right');
    prompt.handleAction('select');
    expect(onStartOver).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('right right then select invokes onCancel and hides', () => {
    const onCancel = vi.fn();
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel });
    prompt.handleAction('right');
    prompt.handleAction('right');
    prompt.handleAction('select');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('back always invokes onCancel and hides', () => {
    const onCancel = vi.fn();
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel });
    prompt.handleAction('back');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('hides before invoking callback', () => {
    let hiddenAtCallTime = false;
    prompt.show('S', 0, {
      onResume: () => { hiddenAtCallTime = !prompt.visible; },
      onStartOver: vi.fn(),
      onCancel: vi.fn(),
    });
    prompt.handleAction('select');
    expect(hiddenAtCallTime).toBe(true);
  });

  it('handlers are cleared after activation — no double invocation', () => {
    const onResume = vi.fn();
    prompt.show('S', 0, { onResume, onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.handleAction('select');
    // prompt is now hidden; handleAction on a hidden prompt is a no-op
    prompt.handleAction('select');
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('XSS: untrusted title markup does not create elements', () => {
    prompt.show('<img src=x onerror=alert(1)>', 0, {
      onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn(),
    });
    expect(document.querySelector('.catchup-resume-message img')).toBeNull();
  });

  it('does not attach duplicate DOM nodes on repeated show calls', () => {
    const h = { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() };
    prompt.show('S', 0, h);
    prompt.hide();
    prompt.show('S2', 10, h);
    expect(document.querySelectorAll('.catchup-resume-prompt').length).toBe(1);
  });

  it('focus resets to Resume on each show', () => {
    const h = { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() };
    prompt.show('S', 0, h);
    prompt.handleAction('right');
    prompt.hide();
    prompt.show('S2', 0, h);
    expect(focused()!.textContent?.trim()).toBe('Resume');
  });

  it('moves focus to the button under the pointer', () => {
    const onCancel = vi.fn();
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel });
    document.querySelector<HTMLElement>('[data-action="cancel"]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(focused()!.textContent?.trim()).toBe('Cancel');
    prompt.handleAction('select');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('handleAction is a no-op when not visible', () => {
    const onResume = vi.fn();
    prompt.show('S', 0, { onResume, onStartOver: vi.fn(), onCancel: vi.fn() });
    prompt.hide();
    prompt.handleAction('select');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('Magic Remote OK (click) via elementFromPoint activates Resume', () => {
    const onResume = vi.fn();
    prompt.show('S', 0, { onResume, onStartOver: vi.fn(), onCancel: vi.fn() });
    const btn = document.querySelector('[data-action="resume"]')!;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => btn;
    document.querySelector('.catchup-resume-prompt')!.dispatchEvent(
      new MouseEvent('click', { clientX: 100, clientY: 100, bubbles: true }),
    );
    document.elementFromPoint = orig;
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('Magic Remote OK (click) via elementFromPoint activates Start Over', () => {
    const onStartOver = vi.fn();
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver, onCancel: vi.fn() });
    const btn = document.querySelector('[data-action="start-over"]')!;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => btn;
    document.querySelector('.catchup-resume-prompt')!.dispatchEvent(
      new MouseEvent('click', { clientX: 100, clientY: 100, bubbles: true }),
    );
    document.elementFromPoint = orig;
    expect(onStartOver).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('Magic Remote OK (click) via elementFromPoint activates Cancel', () => {
    const onCancel = vi.fn();
    prompt.show('S', 0, { onResume: vi.fn(), onStartOver: vi.fn(), onCancel });
    const btn = document.querySelector('[data-action="cancel"]')!;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => btn;
    document.querySelector('.catchup-resume-prompt')!.dispatchEvent(
      new MouseEvent('click', { clientX: 100, clientY: 100, bubbles: true }),
    );
    document.elementFromPoint = orig;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it('click outside any action button does nothing', () => {
    const onResume = vi.fn();
    prompt.show('S', 0, { onResume, onStartOver: vi.fn(), onCancel: vi.fn() });
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector('.catchup-resume-dialog');
    document.querySelector('.catchup-resume-prompt')!.dispatchEvent(
      new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }),
    );
    document.elementFromPoint = orig;
    expect(onResume).not.toHaveBeenCalled();
    expect(prompt.visible).toBe(true);
  });
});
