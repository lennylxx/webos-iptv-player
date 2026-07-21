import type { Action, Channel } from '../types';
import { CONFIG } from '../config';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { $, html } from '../utils/dom';
import { morph } from '../utils/morph';
import { rankChannels } from '../utils/channel-search';

type SidebarEntry = { ch: Channel; globalIdx: number };

const AUTO_HIDE_MS = 5000;

/**
 * The channel overlay shown on the left edge during playback. Owns its own
 * visibility, auto-hide timer, focus index and playlist tab. Delegated DOM
 * listeners are bound once in the constructor so they do not accumulate across
 * re-renders.
 */
export class Sidebar {
  private el: HTMLElement | null;
  private getCurrentIndex: () => number;
  private onSelectChannel: (index: number) => void;
  private isVisible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private focusIdx = -1; // -1 here means the search box is focused
  private playlist = ''; // '' = All
  private searchQuery = ''; // persists across opens (show() doesn't reset it)
  keyboardOn = false; // while on, the sidebar never auto-hides
  private hoverCleared = false; // highlight removed on mouseleave; next hover re-shows it

  constructor(
    container: HTMLElement,
    getCurrentIndex: () => number,
    onSelectChannel: (index: number) => void,
  ) {
    this.getCurrentIndex = getCurrentIndex;
    this.onSelectChannel = onSelectChannel;
    this.el = $('#player-sidebar', container);
    this.bindEvents();
  }

  get visible(): boolean {
    return this.isVisible;
  }

  show(): void {
    if (this.isVisible) return;
    this.isVisible = true;
    this.keyboardOn = false;
    this.focusIdx = -1; // highlight the search box, not a channel (no caret yet)
    this.render();
    if (this.el) {
      this.el.classList.remove('hidden');
      // Trigger reflow so transform transition plays
      this.el.offsetHeight;
      this.el.classList.add('visible');
    }
    this.resetTimer();
  }

  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.keyboardOn = false;
    const el = this.el;
    if (el) {
      el.querySelector<HTMLInputElement>('.sidebar-search-input')?.blur(); // dismiss keyboard
      el.classList.remove('visible');
      el.addEventListener('transitionend', () => {
        if (!this.isVisible) el.classList.add('hidden');
      }, { once: true });
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // Stay while the keyboard is on or the pointer is over the sidebar.
      if (this.keyboardOn || this.el?.matches(':hover')) {
        this.resetTimer();
        return;
      }
      this.hide();
    }, AUTO_HIDE_MS);
  }

  // Keyboard off while still on the search box → hide; in the list → stay.
  setKeyboardVisible(visible: boolean): void {
    if (visible === this.keyboardOn) return;
    this.keyboardOn = visible;
    if (visible) {
      this.focusIdx = -1;
      this.updateFocus();
      this.resetTimer();
    } else if (this.focusIdx < 0) {
      this.hide();
    } else {
      this.resetTimer();
    }
  }

  handleAction(action: Action): void {
    if (!this.el) return;

    if (action === 'select' && this.focusIdx === -1) {
      this.openSearchInput(); // OK on the search box
      return;
    }

    const items = this.el.querySelectorAll<HTMLElement>('.sidebar-ch-item');
    const len = items.length;
    this.resetTimer();

    if (action === 'up' || action === 'channel_up') {
      this.focusIdx = this.focusIdx <= 0 ? -1 : this.focusIdx - 1;
    } else if (action === 'down' || action === 'channel_down') {
      if (this.focusIdx < len - 1) this.focusIdx += 1;
    } else if (action === 'select') {
      const item = items[this.focusIdx];
      const idx = parseInt(item?.dataset.sidebarIndex || '-1', 10);
      if (idx >= 0) {
        this.onSelectChannel(idx);
        this.hide();
      }
      return;
    }

    this.updateFocus(items);
  }

  private getChannels(): SidebarEntry[] {
    const all = PlaylistService.channels;
    const q = this.searchQuery.trim();
    // Search spans groups, scoped to the selected playlist tab; ranked by relevance.
    if (q) {
      const pl = this.playlist;
      const pool = pl ? all.filter(c => c.playlistIds.includes(pl)) : all;
      const idxOf = new Map<Channel, number>();
      for (let i = 0; i < all.length; i++) idxOf.set(all[i], i);
      return rankChannels(pool, q).map(ch => ({ ch, globalIdx: idxOf.get(ch)! }));
    }
    if (!this.playlist) {
      return all.map((ch, i) => ({ ch, globalIdx: i }));
    }
    const result: SidebarEntry[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i].playlistIds.includes(this.playlist)) {
        result.push({ ch: all[i], globalIdx: i });
      }
    }
    return result;
  }

  /** OK: focus the search box (caret at end); focus turns the keyboard on. */
  private openSearchInput(): void {
    const input = this.el?.querySelector<HTMLInputElement>('.sidebar-search-input');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    this.resetTimer();
  }

  // Down/Enter: into the list. focusIdx set before blur so keyboard-off keeps it open.
  private exitSearchToList(): void {
    this.focusIdx = 0;
    this.updateFocus();
    this.el?.querySelector<HTMLInputElement>('.sidebar-search-input')?.blur();
    this.resetTimer();
  }

  /** Drop the hover highlight; next hover/d-pad re-shows it (see hoverCleared). */
  private clearHover(): void {
    this.el?.querySelectorAll('.focused').forEach(n => n.classList.remove('focused'));
    this.hoverCleared = true;
  }

  private updateFocus(items?: NodeListOf<HTMLElement>): void {
    this.hoverCleared = false;
    if (!items) {
      if (!this.el) return;
      items = this.el.querySelectorAll<HTMLElement>('.sidebar-ch-item');
    }
    items.forEach((item, i) => {
      item.classList.toggle('focused', i === this.focusIdx);
    });
    this.el?.querySelector('.sidebar-search-input')?.classList.toggle('focused', this.focusIdx === -1);
    if (this.focusIdx >= 0) items[this.focusIdx]?.scrollIntoView({ block: 'nearest' });
  }

  private render(): void {
    const el = this.el;
    if (!el) return;

    const tabs = PlaylistService.playlistTabs;
    // The selected playlist may have just been deleted in settings — fall back to All.
    if (this.playlist && !tabs.some(t => t.id === this.playlist)) this.playlist = '';
    const showTabs = tabs.length > 1;
    const entries = this.getChannels();
    const currentIdx = this.getCurrentIndex();
    const currentTab = tabs.find(t => t.id === this.playlist);
    const searchPlaceholder = currentTab ? `Search ${currentTab.name}...` : 'Search all channels...';

    morph(el, html`
      <div class="sidebar-title">Channels</div>
      <input type="text" class="sidebar-search-input ${this.focusIdx === -1 ? 'focused' : ''}" data-key="search"
             aria-label="Search channels" placeholder="${searchPlaceholder}"
             value="${this.searchQuery}">
      ${showTabs ? html`
        <div class="sidebar-tabs">
          <div class="sidebar-tab ${!this.playlist ? 'active' : ''}"
               data-key="tab:"
               data-sidebar-playlist="">All</div>
          ${tabs.map(t => html`
            <div class="sidebar-tab ${t.id === this.playlist ? 'active' : ''}"
                 data-key="tab:${t.id}"
                 data-sidebar-playlist="${t.id}">${t.name}</div>
          `)}
        </div>
      ` : ''}
      <div class="sidebar-channel-list">
        ${entries.map(({ ch, globalIdx }, i) => {
          const epgId = EpgService.findChannelId(ch);
          const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
          const isPlaying = globalIdx === currentIdx;
          const isFocused = i === this.focusIdx;
          return html`
            <div class="sidebar-ch-item ${isPlaying ? 'playing' : ''} ${isFocused ? 'focused' : ''}"
                 data-key="ch:${String(globalIdx)}"
                 data-focusable data-sidebar-index="${globalIdx}" data-sidebar-pos="${i}">
              <span class="ch-num">${globalIdx + 1}</span>
              ${ch.logo
                ? html`<img class="ch-logo" src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
                : html`<div class="ch-logo-placeholder">${ch.name.charAt(0)}</div>`}
              <div class="ch-info">
                <span class="ch-name">${ch.name}</span>
                ${nowPlaying ? html`<span class="ch-now"><span class="ch-now-text">${nowPlaying.title}</span></span>` : ''}
              </div>
            </div>
          `;
        })}
      </div>
    `);

    // Scroll to the focused channel
    const focusedEl = el.querySelector('.sidebar-ch-item.focused');
    if (focusedEl) focusedEl.scrollIntoView({ block: 'center' });

    // Enable marquee scroll only for overflowing programme names
    requestAnimationFrame(() => {
      el.querySelectorAll<HTMLElement>('.ch-now').forEach(container => {
        const span = container.querySelector<HTMLElement>('.ch-now-text');
        if (!span) return;
        const textWidth = span.offsetWidth;
        const containerWidth = container.offsetWidth;
        if (textWidth > containerWidth) {
          const dist = containerWidth - textWidth;
          span.style.setProperty('--scroll-dist', `${dist}px`);
          span.classList.add('scrolling');
        }
      });
    });
  }

  private bindEvents(): void {
    const el = this.el;
    if (!el) return;

    el.addEventListener('input', (e: Event) => {
      if (!(e.target as HTMLElement).classList.contains('sidebar-search-input')) return;
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.focusIdx = -1;
      this.render();
      this.resetTimer();
    });

    // Desktop fallback for the keyboard signal: the input's focus.
    el.addEventListener('focusin', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('sidebar-search-input')) return;
      this.setKeyboardVisible(true);
    });
    el.addEventListener('focusout', (e: FocusEvent) => {
      if (!(e.target as HTMLElement).classList.contains('sidebar-search-input')) return;
      this.setKeyboardVisible(false);
    });

    // webOS: authoritative keyboard signal (independent of the lingering caret).
    document.addEventListener('keyboardStateChange', (e: Event) => {
      const visible = (e as CustomEvent<{ visibility?: boolean }>).detail?.visibility;
      if (typeof visible !== 'boolean') return;
      this.setKeyboardVisible(visible);
    });

    // Keys typed in the search box are handled here. The global key handler now
    // routes the remote Back key through even from inputs, so stop propagation
    // on the keys we own — otherwise Back would both exit the search box (below)
    // and bubble up to close the whole sidebar / act on the player.
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!t.classList.contains('sidebar-search-input')) return;
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        this.exitSearchToList();
      } else if (e.key === 'Escape' || e.keyCode === CONFIG.KEYS.BACK) {
        e.preventDefault();
        e.stopPropagation();
        (t as HTMLInputElement).blur();
      }
    });

    // Click to select channel or tab
    el.addEventListener('click', (e: MouseEvent) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-sidebar-playlist]');
      if (tab) {
        this.playlist = tab.dataset.sidebarPlaylist!;
        this.focusIdx = 0;
        this.render();
        this.resetTimer();
        return;
      }
      const chItem = (e.target as HTMLElement).closest<HTMLElement>('[data-sidebar-index]');
      if (chItem) {
        const idx = parseInt(chItem.dataset.sidebarIndex!, 10);
        this.onSelectChannel(idx);
        this.hide();
      }
    });

    // Hover moves the highlight onto a channel, or onto the search box (-1).
    // Only re-highlight when the position actually changes.
    el.addEventListener('mouseover', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('[data-sidebar-pos]');
      const pos = item
        ? parseInt(item.dataset.sidebarPos!, 10)
        : (target.closest('.sidebar-search-input') ? -1 : null);
      if (pos === null) return;
      if (pos !== this.focusIdx || this.hoverCleared) {
        this.focusIdx = pos;
        this.updateFocus();
      }
      this.resetTimer();
    });

    // Cursor left the sidebar: drop the hover highlight. focusIdx is kept so a
    // later d-pad press or hover re-shows it.
    el.addEventListener('mouseleave', () => this.clearHover());

    // Scroll wheel moves focus up/down
    el.addEventListener('wheel', (e: WheelEvent) => {
      e.stopPropagation();
      const len = this.getChannels().length;
      if (e.deltaY < 0) {
        this.focusIdx = Math.max(0, this.focusIdx - 1);
      } else if (e.deltaY > 0) {
        this.focusIdx = Math.min(len - 1, this.focusIdx + 1);
      }
      this.updateFocus();
      this.resetTimer();
    }, { passive: false });
  }
}
