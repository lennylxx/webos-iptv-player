import type { Action, PlaylistEntry } from '../types';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { avatarColor, firstLetter } from '../utils/avatar';
import { t } from '../i18n';
import { CHECK_ICON } from './icons';
import { Focus, Tier, type FocusScope, type Via } from '../navigation/focus-scope';
import type { ScopeId } from '../navigation/scope-ids';

export type AccountMenuOpenMode = 'key' | 'pointer';
// `outside` is a pointer click away from the switcher, `toggle` one on it;
// `host` is a close the owning component asked for (hidden, color key).
export type AccountMenuCloseReason = 'key' | 'toggle' | 'outside' | 'choose' | 'host';

interface AccountSwitcherHandlers {
  onSelect: (accountId: string) => void;
  onMenuOpen?: (mode: AccountMenuOpenMode) => void;
  // `hit` is the element under an `outside` click or an avatar `toggle`.
  onMenuClose?: (reason: AccountMenuCloseReason, hit?: Element) => void;
  // The pointer moved onto a menu row; a host without a scope keeps its
  // own focus on the avatar slot.
  onMenuHover?: () => void;
}

// The circular account avatar + dropdown, mounted in a tab-bar slot. Owns its
// own DOM (preserved across the tab bar's morph via data-morph-preserve) and its
// pointer hit-testing. The host's scope rings the avatar; selection flows back
// out through onSelect. Given a scope id, the open menu is a focus scope above
// the bar that takes the keys and paints its own ring, while the pointer still
// lights what it rests on below; closing it hands the keys back to the scope
// below. Otherwise the host routes the keys to a scope it pushes for the open
// menu, and the menu paints its highlight itself.
export class AccountSwitcher {
  private slot: HTMLElement;
  private handlers: AccountSwitcherHandlers;
  private accounts: PlaylistEntry[] = [];
  private selectedId = '';
  private open = false;
  private menuIndex = 0;
  private readonly scope: FocusScope | null;

  constructor(slot: HTMLElement, handlers: AccountSwitcherHandlers, scopeId?: ScopeId) {
    this.slot = slot;
    this.handlers = handlers;
    this.scope = scopeId ? Focus.register({
      id: scopeId,
      root: () => this.slot.querySelector<HTMLElement>('.account-menu'),
      // Not modal: a control the pointer rests on below still lights.
      restrict: 'self-first',
      tier: Tier.prompt,
      defaultKey: () => this.rowKey(this.currentIndex()),
      onAction: (action) => this.handleAction(action),
    }) : null;
  }

  get shown(): boolean { return this.accounts.length > 0; }
  get menuOpen(): boolean { return this.open; }
  get menuScope(): FocusScope | null { return this.scope; }

  setAccounts(accounts: PlaylistEntry[], selectedId: string): void {
    this.accounts = accounts;
    this.selectedId = selectedId;
    // Closing pops the menu's scope, so the keys return to the one below.
    if (!this.shown) this.closeMenu('host');
    this.render();
  }

  openMenu(mode: AccountMenuOpenMode = 'key'): void {
    if (!this.shown) return;
    this.open = true;
    this.menuIndex = this.currentIndex();
    this.render();
    if (this.scope) Focus.push(this.scope);
    this.highlight(mode);
    this.handlers.onMenuOpen?.(mode);
  }

  closeMenu(reason: AccountMenuCloseReason = 'host', hit?: Element): void {
    if (!this.open) return;
    this.open = false;
    this.render();
    if (this.scope) Focus.pop(this.scope);
    this.handlers.onMenuClose?.(reason, hit);
  }

  handleAction(action: Action): void {
    if (!this.open) return;
    const n = this.accounts.length;
    switch (action) {
      case 'up':
        this.menuIndex = (this.menuIndex - 1 + n) % n;
        this.highlight('key');
        break;
      case 'down':
        this.menuIndex = (this.menuIndex + 1) % n;
        this.highlight('key');
        break;
      case 'select':
        this.choose(this.accounts[this.menuIndex].id);
        break;
      case 'back':
      case 'left':
        this.closeMenu('key');
        break;
      default:
        break;
    }
  }

  init(): void {
    // Hit-test the row / avatar under the pointer. The menu renders inside the tab
    // bar's `data-self-activate` subtree, so the global click handler already skips
    // it (no double-fire). A scoped menu closes in the capture phase, before
    // that handler hovers what a dismissing click hit, so the hover lands
    // with the keys already handed back.
    document.addEventListener('click', (e: MouseEvent) => {
      if (!this.shown) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (!hit) return;
      // Several switchers can be mounted (tab bar, parental manager); each
      // only answers to its own slot.
      if (!this.slot.contains(hit)) {
        if (this.open) this.closeMenu('outside', hit);
        return;
      }
      const row = hit.closest<HTMLElement>('.account-menu-item');
      if (row && row.dataset.accountId) { this.choose(row.dataset.accountId); return; }
      if (hit.closest('.account-avatar')) {
        if (this.open) this.closeMenu('toggle', hit);
        else this.openMenu('pointer');
        return;
      }
      if (this.open) this.closeMenu('toggle'); // a click on the menu's chrome dismisses it
    }, !!this.scope);
    // Pointer hover moves the highlight onto the row under the cursor, so the
    // mouse and D-pad share one selection (OK then picks the hovered row).
    this.slot.addEventListener('nav:hover', (e: Event) => {
      if (!this.open || !(e.target instanceof Element)) return;
      const row = e.target.closest<HTMLElement>('.account-menu-item');
      const idx = row ? this.accounts.findIndex((a) => a.id === row.dataset.accountId) : -1;
      if (idx < 0) return;
      this.menuIndex = idx;
      this.highlight('pointer');
      this.handlers.onMenuHover?.();
    });
  }

  private currentIndex(): number {
    return Math.max(0, this.accounts.findIndex((a) => a.id === this.selectedId));
  }

  private rowKey(index: number): string | null {
    const account = this.accounts[index];
    return account ? `acc:${account.id}` : null;
  }

  private highlight(via: Via): void {
    if (this.scope) this.scope.focus(this.rowKey(this.menuIndex), via);
    else this.render();
  }

  private choose(id: string): void {
    this.open = false;
    const changed = id !== this.selectedId;
    if (changed) this.selectedId = id;
    this.render();
    if (this.scope) Focus.pop(this.scope);
    if (changed) this.handlers.onSelect(id);
    this.handlers.onMenuClose?.('choose');
  }

  private render(): void {
    if (!this.shown) { morph(this.slot, html``); return; }
    const active = this.accounts.find((a) => a.id === this.selectedId) ?? this.accounts[0];
    // A scope paints the ring itself.
    const painted = !this.scope;
    morph(this.slot, html`
      <button class="account-avatar" data-key="account-avatar"
              aria-label="${t('nav.switchAccount')}" style="background:${avatarColor(active.name)}">${firstLetter(active.name)}</button>
      ${this.open ? html`
        <div class="account-menu" data-nav-container>
          ${this.accounts.map((a, i) => html`
            <div class="account-menu-item ${painted && i === this.menuIndex ? 'focused' : ''} ${a.id === this.selectedId ? 'current' : ''}"
                 data-key="acc:${a.id}" data-account-id="${a.id}" data-hover-target>
              <span class="account-menu-avatar" style="background:${avatarColor(a.name)}">${firstLetter(a.name)}</span>
              <span class="account-menu-name">${a.name}</span>
              <span class="account-menu-check">${a.id === this.selectedId ? raw(CHECK_ICON) : ''}</span>
            </div>
          `)}
        </div>
      ` : ''}
    `);
  }
}
