import type { Action, PlaylistEntry } from '../types';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { avatarColor, firstLetter } from '../utils/avatar';
import { t } from '../i18n';
import { CHECK_ICON } from './icons';

interface AccountSwitcherHandlers {
  onSelect: (accountId: string) => void;
}

// The circular account avatar + dropdown, mounted in a tab-bar slot. Owns its
// own DOM (preserved across the tab bar's morph via data-morph-preserve) and its
// pointer hit-testing. The tab bar drives focus/keys; selection flows back out
// through onSelect.
export class AccountSwitcher {
  private slot: HTMLElement;
  private handlers: AccountSwitcherHandlers;
  private accounts: PlaylistEntry[] = [];
  private selectedId = '';
  private focused = false;
  private open = false;
  private menuIndex = 0;

  constructor(slot: HTMLElement, handlers: AccountSwitcherHandlers) {
    this.slot = slot;
    this.handlers = handlers;
  }

  get shown(): boolean { return this.accounts.length > 0; }
  get menuOpen(): boolean { return this.open; }

  setAccounts(accounts: PlaylistEntry[], selectedId: string): void {
    this.accounts = accounts;
    this.selectedId = selectedId;
    if (!this.shown) this.open = false;
    this.render();
  }

  setFocused(on: boolean): void {
    if (on === this.focused) return;
    this.focused = on;
    this.render();
  }

  openMenu(): void {
    if (!this.shown) return;
    this.open = true;
    const cur = this.accounts.findIndex((a) => a.id === this.selectedId);
    this.menuIndex = cur >= 0 ? cur : 0;
    this.render();
  }

  closeMenu(): void {
    if (!this.open) return;
    this.open = false;
    this.render();
  }

  handleAction(action: Action): void {
    if (!this.open) return;
    const n = this.accounts.length;
    switch (action) {
      case 'up':
        this.menuIndex = (this.menuIndex - 1 + n) % n;
        this.render();
        break;
      case 'down':
        this.menuIndex = (this.menuIndex + 1) % n;
        this.render();
        break;
      case 'select':
        this.choose(this.accounts[this.menuIndex].id);
        break;
      case 'back':
      case 'left':
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  init(): void {
    // Hit-test the row / avatar under the pointer. The menu renders inside the tab
    // bar's `data-self-activate` subtree, so the global click handler already skips
    // it (no double-fire).
    document.addEventListener('click', (e: MouseEvent) => {
      if (!this.shown) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (!hit) return;
      const row = hit.closest<HTMLElement>('.account-menu-item');
      if (row && row.dataset.accountId) { this.choose(row.dataset.accountId); return; }
      if (hit.closest('.account-avatar')) { this.open ? this.closeMenu() : this.openMenu(); return; }
      if (this.open) this.closeMenu(); // a click elsewhere dismisses the menu
    });
    // Pointer hover moves the highlight onto the row under the cursor, so the
    // mouse and D-pad share one selection (OK then picks the hovered row).
    document.addEventListener('mouseover', (e: MouseEvent) => {
      if (!this.open) return;
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.account-menu-item');
      if (!row || !row.dataset.accountId) return;
      const idx = this.accounts.findIndex((a) => a.id === row.dataset.accountId);
      if (idx >= 0 && idx !== this.menuIndex) { this.menuIndex = idx; this.render(); }
    });
  }

  private choose(id: string): void {
    this.open = false;
    const changed = id !== this.selectedId;
    if (changed) this.selectedId = id;
    this.render();
    if (changed) this.handlers.onSelect(id);
  }

  private render(): void {
    if (!this.shown) { morph(this.slot, html``); return; }
    const active = this.accounts.find((a) => a.id === this.selectedId) ?? this.accounts[0];
    morph(this.slot, html`
      <button class="account-avatar ${this.focused ? 'focused' : ''}" data-key="account-avatar"
              aria-label="${t('nav.switchAccount')}" style="background:${avatarColor(active.name)}">${firstLetter(active.name)}</button>
      ${this.open ? html`
        <div class="account-menu" data-nav-container>
          ${this.accounts.map((a, i) => html`
            <div class="account-menu-item ${i === this.menuIndex ? 'focused' : ''} ${a.id === this.selectedId ? 'current' : ''}"
                 data-key="acc:${a.id}" data-account-id="${a.id}">
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
