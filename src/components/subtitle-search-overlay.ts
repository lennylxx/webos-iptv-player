import type { Action } from '../types';
import type { OnlineSubtitleResult } from '../services/subtitle-search/types';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { languageName } from '../utils/subtitle-tracks';
import { DOWNLOAD_ICON } from './icons';
import { t } from '../i18n';

const PROVIDER_LABEL: Record<string, string> = { opensubtitles: 'OpenSubtitles', subdl: 'SubDL', assrt: 'Assrt' };

// Group digits into thousands (Chromium 53-safe, no Intl/locale dependency).
function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Terminal status messages (errors / empty) auto-dismiss after this long; the
// transient "Searching…" / "Downloading…" ones are replaced by the next state.
const STATUS_AUTO_HIDE_MS = 3000;

/** Modal list of online subtitle search results shown over the player. Owns its
 *  own focus index and visibility; selection routes back through `onPick`. A
 *  persistent search box at the top lets the user refine the query (Enter →
 *  `onSearch`). All provider/release text is untrusted and rendered through
 *  `html` (escaped). */
export class SubtitleSearchOverlay {
  private el: HTMLElement;
  private onPick: (r: OnlineSubtitleResult) => void;
  private onClose: () => void;
  private onSearch: (query: string) => void;
  private results: OnlineSubtitleResult[] = [];
  private focusIdx = 0;
  private isVisible = false;
  private query = '';
  private statusMessage: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    container: HTMLElement,
    onPick: (r: OnlineSubtitleResult) => void,
    onClose: () => void,
    onSearch: (query: string) => void = () => { /* no-op */ },
  ) {
    this.el = container;
    this.onPick = onPick;
    this.onClose = onClose;
    this.onSearch = onSearch;
    // Activate the result under the pointer on click. This overlay lives inside
    // the player view's `data-self-activate` subtree, so the global click handler
    // skips it — even though result rows are `[data-focusable]` — avoiding a
    // double-fire.
    this.el.addEventListener('click', (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-result-index]');
      if (!row) return;
      const i = Number(row.dataset.resultIndex);
      if (!Number.isNaN(i)) this.pick(i);
    });
    // The global key handler ignores INPUT keydowns (see key-handler.ts), so the
    // box owns Enter (submit), Down (hand off to results), and Escape (same).
    // Back still routes to the app → handleAction('back').
    this.el.addEventListener('keydown', (e: KeyboardEvent) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !t.classList.contains('subs-search-input')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = t.value.trim();
        t.blur();
        if (q) this.onSearch(q);
      } else if (e.key === 'ArrowDown' || e.key === 'Escape') {
        e.preventDefault();
        t.blur();
        this.focusList();
      }
    });
  }

  get visible(): boolean { return this.isVisible; }

  /** Prefill the search box (used before the initial "Searching…" so the box
   *  shows the auto-detected title while results load). */
  setQuery(query: string): void {
    this.query = query;
    if (this.isVisible) this.render();
  }

  open(results: OnlineSubtitleResult[], _preferredLanguage: string, query = this.query): void {
    this.clearStatusTimer();
    this.statusMessage = null;
    this.query = query;
    this.results = results;
    this.focusIdx = 0;
    this.isVisible = true;
    this.el.classList.remove('hidden');
    this.render();
  }

  /** Show a status line (kept beneath the persistent search box). `autoClose`
   *  dismisses the overlay after a few seconds — used only for the post-pick
   *  "Download failed" message; search errors stay so the user can retry. */
  showStatus(message: string, autoClose = false): void {
    this.clearStatusTimer();
    this.statusMessage = message;
    this.isVisible = true;
    this.el.classList.remove('hidden');
    this.render();
    if (autoClose) {
      this.statusTimer = setTimeout(() => { this.close(); this.onClose(); }, STATUS_AUTO_HIDE_MS);
    }
  }

  close(): void {
    this.clearStatusTimer();
    this.isVisible = false;
    this.el.classList.add('hidden');
    this.results = [];
    this.statusMessage = null;
  }

  private clearStatusTimer(): void {
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
  }

  private inputEl(): HTMLInputElement | null {
    return this.el.querySelector<HTMLInputElement>('.subs-search-input');
  }

  private focusList(): void {
    this.focusIdx = 0;
    this.render();
    this.el.querySelector<HTMLElement>('.subs-row.focused')?.scrollIntoView?.({ block: 'nearest' });
  }

  handleAction(action: Action): void {
    if (!this.isVisible) return;
    const input = this.inputEl();
    const inputFocused = !!input && this.el.ownerDocument.activeElement === input;
    if (action === 'back') {
      if (inputFocused) { input.blur(); this.focusList(); return; }
      this.close();
      this.onClose();
      return;
    }
    if (action === 'up') {
      if (this.focusIdx === 0 && input) { input.focus(); return; } // top → search box
      this.focusIdx = Math.max(0, this.focusIdx - 1);
      this.render();
      this.el.querySelector<HTMLElement>('.subs-row.focused')?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    // Below: list navigation — only meaningful when a results list is showing.
    if (this.statusMessage || !this.results.length) return;
    if (action === 'down') this.focusIdx = Math.min(this.results.length - 1, this.focusIdx + 1);
    else if (action === 'select') { this.pick(this.focusIdx); return; }
    this.render();
    this.el.querySelector<HTMLElement>('.subs-row.focused')?.scrollIntoView?.({ block: 'nearest' });
  }

  private pick(i: number): void {
    const r = this.results[i];
    if (r) this.onPick(r);
  }

  private label(r: OnlineSubtitleResult): string {
    const lang = r.language ? languageName(r.language) : '';
    const parts = [PROVIDER_LABEL[r.providerId] ?? r.providerId, lang, r.releaseName].filter(Boolean);
    let s = parts.join(' · ');
    if (r.hearingImpaired) s += ' · HI';
    return s;
  }

  private render(): void {
    const body = this.statusMessage != null
      ? html`<div class="subs-status">${this.statusMessage}</div>`
      : html`
        <div class="subs-list">
          ${this.results.map((r, i) => html`
            <div class="subs-row ${i === this.focusIdx ? 'focused' : ''}"
                 data-key="${r.providerId}:${r.id}:${i}" data-focusable data-result-index="${i}">
              <span class="subs-row-label">${this.label(r)}</span>
              ${r.downloads ? html`<span class="subs-count" title="${t('subtitle.downloads')}">${raw(DOWNLOAD_ICON)}${formatCount(r.downloads)}</span>` : ''}
            </div>
          `)}
        </div>
      `;
    morph(this.el, html`
      <div class="subs-overlay">
        <div class="subs-overlay-header">${t('subtitle.online')}</div>
        <input class="subs-search-input" data-key="subs-input" type="text"
               placeholder="${t('subtitle.searchTitle')}" aria-label="${t('subtitle.searchAria')}" value="${this.query}">
        ${body}
      </div>
    `);
  }
}
