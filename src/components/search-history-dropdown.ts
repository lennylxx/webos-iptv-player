import type { Action } from '../types';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { t } from '../i18n';
import { TRASH_ICON } from './icons';
import { createLogger } from '../utils/logger';
import { Focus, Tier, type FocusScope } from '../navigation/focus-scope';

const log = createLogger('SearchHistory');

export type SearchHistoryCloseReason =
  'pick' | 'clear' | 'back' | 'dismiss' | 'typed' | 'account-menu' | 'view-change' | 'empty';

export interface SearchHistoryAnchor {
  right: number;
  bottom: number;
  width: number;
}

export interface SearchHistoryHandlers {
  onPick: (query: string) => void;
  onCleared: () => void;
  // Hand focus back to the search box (Up from the top row, Back).
  onReturnToInput: () => void;
  // A click on the dimmed view: leave search altogether.
  onDismiss: () => void;
}

// Recent searches, dropped down from the tab bar's empty search box over a
// dimmed copy of the current view. The scrim catches the pointer, so a click
// outside the panel never reaches the view behind it.
export class SearchHistoryDropdown {
  private readonly root: HTMLElement;
  private readonly nav: SpatialNav;
  private readonly scope: FocusScope;
  private _open = false;

  constructor(private handlers: SearchHistoryHandlers) {
    this.root = document.createElement('div');
    this.root.className = 'search-history-dropdown hidden';
    this.root.setAttribute('data-self-activate', '');
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e: MouseEvent) => this.onClick(e));
    // Takes the keys once the search box hands them down; the bar above it
    // keeps them while the box has the caret.
    this.scope = Focus.register({
      id: 'search.history',
      root: this.root,
      restrict: 'self-only',
      tier: Tier.overlay,
      onAction: (action) => this.handleAction(action),
      defaultKey: () => {
        const el = this.nav.focused;
        return el && this.root.contains(el) ? el.dataset.key ?? null : null;
      },
    });
    this.nav = new SpatialNav(this.root, undefined, { scope: this.scope });
  }

  get isOpen(): boolean { return this._open; }

  /** True when a click on `hit` dismisses search (it lands on the scrim). */
  dismissedBy(hit: Element): boolean {
    return this.root.contains(hit) && !!hit.closest('.search-history-scrim');
  }

  /** Opens under the search box when there is history; false when there is none. */
  open(anchor: SearchHistoryAnchor): boolean {
    const items = StorageService.getSearchHistory().length;
    if (!items) {
      this.close('empty');
      return false;
    }
    if (!this._open) log.debug('Recent searches opened', 'event=search.history.opened', `items=${String(items)}`);
    this._open = true;
    this.render();
    Focus.push(this.scope);
    this.root.classList.remove('hidden', 'search-history-dropdown--menu');
    const panel = this.root.querySelector<HTMLElement>('.search-history-panel')!;
    panel.style.top = `${anchor.bottom + 12}px`;
    panel.style.right = `${Math.max(0, window.innerWidth - anchor.right)}px`;
    panel.style.width = `${anchor.width}px`;
    // A long "clear" label at a large text size can outgrow the box's width;
    // widen leftward so the head row never spills past the border.
    const overflow = headOverflow(panel.querySelector<HTMLElement>('.search-history-head'));
    if (overflow > 0) panel.style.width = `${panel.offsetWidth + overflow}px`;
    return true;
  }

  close(reason: SearchHistoryCloseReason): void {
    const wasOpen = this._open;
    if (wasOpen) log.debug('Recent searches closed', 'event=search.history.closed', `reason=${reason}`);
    this._open = false;
    Focus.pop(this.scope);
    this.nav.focus(null);
    // The account menu hides only the panel: the scrim stays, so a click
    // outside the menu dismisses search instead of reaching the view behind.
    const scrimOnly = reason === 'account-menu' && (wasOpen || this.scrimOnly);
    this.root.classList.toggle('search-history-dropdown--menu', scrimOnly);
    this.root.classList.toggle('hidden', !scrimOnly);
  }

  private get scrimOnly(): boolean {
    return this.root.classList.contains('search-history-dropdown--menu');
  }

  // The box handed off with Down / Enter: land on the first query, not on the
  // clear button above it.
  focusFirst(): boolean {
    const first = this.root.querySelector<HTMLElement>('.search-history-tile');
    if (!this._open || !first) return false;
    this.nav.focus(first);
    return true;
  }

  handleAction(action: Action): void {
    // Nothing focused yet (the box lost focus to a pointer click): never let
    // spatial nav pick its first candidate, the clear button.
    const focused = this.nav.focused;
    if ((!focused || !this.root.contains(focused))
        && (action === 'up' || action === 'down' || action === 'left'
          || action === 'right' || action === 'select')) {
      if (action === 'up') this.returnToInput();
      else this.focusFirst();
      return;
    }
    // A key after the pointer hid the ring only shows it again: Right must
    // not read that as the row's end and land on the clear button.
    if (isFocusMove(action) && this.nav.showConcealed()) return;
    switch (action) {
      // Tiles go straight back to the box, past the clear button, so Up then
      // OK can't wipe the history by accident; Right reaches it.
      case 'up':
        if (this.inTopRow(focused) || !this.nav.move('up')
            || this.nav.focused?.hasAttribute('data-history-clear')) this.returnToInput();
        return;
      case 'right':
        this.nav.move('right');
        if (this.nav.focused === focused && this.inTopRow(focused)) {
          this.nav.focus(this.root.querySelector<HTMLElement>('[data-history-clear]'));
        }
        return;
      case 'down':
      case 'left':
        this.nav.move(action);
        return;
      case 'select':
        this.activate(this.nav.focused, 'key');
        return;
      case 'back':
        this.close('back');
        this.handlers.onReturnToInput();
        return;
      default:
        return; // modal: color and media keys don't reach the view behind
    }
  }

  private inTopRow(el: HTMLElement | null): boolean {
    const first = this.root.querySelector<HTMLElement>('.search-history-tile');
    return !!el && !!first && el.classList.contains('search-history-tile')
      && el.offsetTop === first.offsetTop;
  }

  private returnToInput(): void {
    this.nav.focus(null);
    this.handlers.onReturnToInput();
  }

  private onClick(e: MouseEvent): void {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const inside = !!hit && this.root.contains(hit);
    const el = inside ? hit.closest<HTMLElement>('[data-focusable]') : null;
    const source = !hit ? 'none' : !inside ? 'miss'
      : el ? (el.hasAttribute('data-history-clear') ? 'clear' : 'item')
        : hit.closest('.search-history-panel') ? 'panel' : 'scrim';
    // Coordinates show whether a pointer that missed was mapped elsewhere.
    log.debug(
      'Recent searches click',
      'event=search.history.click',
      `source=${source}`,
      `count=${String(Math.round(e.clientY))}`,
      `total=${String(Math.round(e.clientX))}`,
    );
    if (!hit || !inside) return;
    if (el) {
      this.nav.focus(el, 'pointer');
      this.activate(el, 'pointer');
    } else if (!hit.closest('.search-history-panel')) {
      this.close('dismiss');
      this.handlers.onDismiss();
    }
  }

  private activate(el: HTMLElement | null, mode: 'key' | 'pointer'): void {
    if (!el) return;
    if (el.dataset.historyQuery !== undefined) {
      const query = el.dataset.historyQuery;
      const history = StorageService.getSearchHistory();
      // Position only: the query text itself stays out of the logs.
      log.debug(
        'Recent search picked',
        'event=search.history.picked',
        `mode=${mode}`,
        `count=${String(history.indexOf(query) + 1)}`,
        `items=${String(history.length)}`,
      );
      this.close('pick');
      this.handlers.onPick(query);
    } else if (el.hasAttribute('data-history-clear')) {
      const items = StorageService.getSearchHistory().length;
      if (!StorageService.clearSearchHistory()) return;
      log.debug('Recent searches cleared', 'event=search.history.cleared', `mode=${mode}`, `items=${String(items)}`);
      this.close('clear');
      this.handlers.onCleared();
    }
  }

  private render(): void {
    const history = StorageService.getSearchHistory();
    morph(this.root, html`
      <div class="search-history-scrim" data-key="scrim"></div>
      <div class="search-history-panel" data-key="panel" data-nav-container>
        <div class="search-history-head">
          <h2 class="search-history-title">${t('search.recent')}</h2>
          <div class="search-history-clear" data-focusable data-key="history-clear"
               data-history-clear>${raw(TRASH_ICON)}<span>${t('search.clearHistory')}</span></div>
        </div>
        <div class="search-history-tiles" data-nav-container data-nav-straight
             data-nav-leave-left="" data-nav-leave-right="">
          ${history.map(query => html`
            <div class="search-history-tile" data-focusable data-key="history:${query}"
                 data-history-query="${query}">${query}</div>
          `)}
        </div>
      </div>
    `);
  }
}

function headOverflow(head: HTMLElement | null): number {
  if (!head) return 0;
  let needed = 0;
  for (const child of Array.from(head.children) as HTMLElement[]) {
    const cs = getComputedStyle(child);
    needed += Math.max(child.offsetWidth, child.scrollWidth) + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
  }
  return Math.ceil(needed - head.clientWidth);
}
