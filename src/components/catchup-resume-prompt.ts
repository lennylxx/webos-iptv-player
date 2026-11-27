import type { Action } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import type { ScopeId } from '../navigation/scope-ids';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { formatPosition } from '../utils/time';

const KEYS = ['resume', 'start-over', 'cancel'] as const;

interface ResumeHandlers {
  onResume: () => void;
  onStartOver: () => void;
  onCancel: () => void;
}

export class CatchupResumePrompt {
  private el: HTMLElement | null = null;
  private handlers: ResumeHandlers | null = null;
  private focusIdx = 0;
  private title = '';
  private position = 0;
  private scope: FocusScope | null = null;

  // `id` names the focus scope, registered on the first show.
  constructor(private readonly id: ScopeId) {}

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(title: string, position: number, handlers: ResumeHandlers): void {
    if (!this.scope) {
      this.scope = Focus.register({
        id: this.id,
        root: () => this.el,
        restrict: 'self-only',
        onAction: (action) => this.handleAction(action),
        defaultKey: () => KEYS[this.focusIdx],
      });
    }
    this.handlers = handlers;
    this.focusIdx = 0;
    this.title = title;
    this.position = position;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'catchup-resume-prompt';
      // Self-activates on click; mark so the global click handler skips it.
      this.el.setAttribute('data-self-activate', '');
      this.bindEvents();
    }
    // Last in <body>, so it paints above a prompt of its tier shown before it.
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    Focus.push(this.scope);
    this.moveTo(this.focusIdx, 'key');
  }

  hide(): void {
    this.el?.classList.add('hidden');
    this.handlers = null;
    if (this.scope) Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    switch (action) {
      case 'left':
        if (this.focusIdx > 0) this.moveTo(this.focusIdx - 1, 'key');
        break;
      case 'right':
        if (this.focusIdx < KEYS.length - 1) this.moveTo(this.focusIdx + 1, 'key');
        break;
      case 'select':
        this.activate(this.focusIdx);
        break;
      case 'back':
        this.doCancel();
        break;
      default:
        break;
    }
  }

  private moveTo(idx: number, via: Via): void {
    this.focusIdx = idx;
    this.scope?.focus(KEYS[idx], via);
    Focus.flush();
  }

  private activate(idx: number): void {
    const h = this.handlers;
    this.hide();
    if (idx === 0) h?.onResume();
    else if (idx === 1) h?.onStartOver();
    else h?.onCancel();
  }

  private doCancel(): void {
    const h = this.handlers;
    this.hide();
    h?.onCancel();
  }

  private render(): void {
    if (!this.el) return;
    morph(this.el, html`
      <div class="catchup-resume-dialog">
        <p class="catchup-resume-message">${t('prompt.resume', {
          title: this.title,
          position: formatPosition(this.position),
        })}</p>
        <div class="catchup-resume-buttons">
          <button class="catchup-resume-btn" data-focusable
                  data-key="resume" data-action="resume">${t('common.resume')}</button>
          <button class="catchup-resume-btn" data-focusable
                  data-key="start-over" data-action="start-over">${t('prompt.startOver')}</button>
          <button class="catchup-resume-btn" data-focusable
                  data-key="cancel" data-action="cancel">${t('common.cancel')}</button>
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    this.el!.addEventListener('nav:hover', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      const idx = btn ? KEYS.indexOf(btn.dataset.action as typeof KEYS[number]) : -1;
      if (idx >= 0) this.moveTo(idx, 'pointer');
    });

    // Hit-test the button under the pointer.
    this.el!.addEventListener('click', (e: MouseEvent) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const btn = hit?.closest<HTMLElement>('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'resume') this.activate(0);
      else if (action === 'start-over') this.activate(1);
      else if (action === 'cancel') this.activate(2);
    });
  }
}
