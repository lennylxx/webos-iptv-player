import type { Action, BuiltinChannelGroup, CatchupInfo, Channel, ChannelGroupId, NumberEvent } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelKey } from '../utils/channel';
import { formatPosition } from '../utils/time';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { RecentlyWatchedService, type RecentlyWatchedItem } from '../services/recently-watched';
import { groupIcon } from './group-icon';
import { showToast } from './toast';
import { t } from '../i18n';

export class ChannelList {
  private container: HTMLElement;
  private onChannelSelect: (index: number, catchup?: CatchupInfo) => void;
  private nav: SpatialNav;
  private currentGroup: ChannelGroupId = 'builtin:all';
  private currentPlaylist = '';  // '' = All playlists
  private playingIndex = -1;
  private playingCatchupStart: number | null = null;
  private recentItems: RecentlyWatchedItem[] = [];

  constructor(
    container: HTMLElement,
    onChannelSelect: (index: number, catchup?: CatchupInfo) => void,
  ) {
    this.container = container;
    this.onChannelSelect = onChannelSelect;
    this.nav = new SpatialNav(container);

    // Cursor left the view: drop the hover highlight.
    this.container.addEventListener('mouseleave', () => this.nav.clearHighlight());

    // Activate the item under the pointer by coordinate hit-test, so a click plays
    // the channel (or switches group/playlist) regardless of what holds D-pad focus
    // — the global click path would instead route select to the focused tab bar
    // (swallowed while the search box is open). The container is marked
    // `data-self-activate` so that global handler skips this subtree.
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY));
  }

  private onPointerRelease(x: number, y: number): void {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    if (!el || !this.container.contains(el)) return;
    this.nav.focus(el);
    this.handleAction('select');
  }

  render(): void {
    const tabs = PlaylistService.playlistTabs;
    // The selected playlist may have just been deleted in settings — fall back to All.
    if (this.currentPlaylist && !tabs.some(t => t.id === this.currentPlaylist)) this.currentPlaylist = '';
    const showTabs = tabs.length > 1;
    const builtins: { id: ChannelGroupId; label: string; builtin: BuiltinChannelGroup }[] = [
      { id: 'builtin:all', label: t('common.all'), builtin: 'all' },
      { id: 'builtin:favorites', label: t('channel.favorites'), builtin: 'favorites' },
      { id: 'builtin:recently-watched', label: t('channel.recentlyWatched'), builtin: 'recently-watched' },
    ];
    const groups = [
      ...builtins,
      ...PlaylistService.getGroupsForPlaylist(this.currentPlaylist || undefined)
        .map(name => ({ id: `source:${name}` as ChannelGroupId, label: name, builtin: undefined })),
    ];
    this.recentItems = RecentlyWatchedService.getItems(this.currentPlaylist || undefined);
    const showingRecent = this.currentGroup === 'builtin:recently-watched';
    const filteredChannels = PlaylistService.getByGroup(this.currentGroup, this.currentPlaylist || undefined);
    const totalChannels = this.currentPlaylist
      ? PlaylistService.getByGroup('builtin:all', this.currentPlaylist).length
      : PlaylistService.channels.length;
    const favs = StorageService.getFavorites();

    // Capture the current focus key before morph so we can restore it on a
    // reused node. morph treats `class` as authoritative — it will remove the
    // imperative `.focused` class — and we re-apply nav.focus in the same
    // synchronous tick to avoid any flicker.
    const prevFocusedKey = this.nav.focused?.getAttribute('data-key') ?? null;

    morph(this.container, html`
      <div class="channel-view">
        <div class="sidebar" data-nav-container>
          <div class="sidebar-header">
            <div class="channel-count">${t(totalChannels === 1 ? 'channel.countOne' : 'channel.count', {
              count: totalChannels,
            })}</div>
          </div>
          ${showTabs ? html`
            <div class="playlist-tabs">
              <div class="playlist-tab ${!this.currentPlaylist ? 'active' : ''}"
                   data-key="tab:"
                   data-focusable data-playlist="">${t('common.all')}</div>
              ${tabs.map(t => html`
                <div class="playlist-tab ${t.id === this.currentPlaylist ? 'active' : ''}"
                     data-key="tab:${t.id}"
                     data-focusable data-playlist="${t.id}">${t.name}</div>
              `)}
            </div>
          ` : ''}
          <div class="group-list">
            ${groups.map(g => html`
              <div class="group-item ${g.id === this.currentGroup ? 'active' : ''}"
                   data-key="g:${g.id}"
                   data-focusable data-group="${g.id}">
                <span class="group-icon">${raw(groupIcon(g.label, g.builtin))}</span>
                <span class="group-name">${g.label}</span>
                <span class="group-count">${g.id === 'builtin:recently-watched'
                  ? this.recentItems.length
                  : PlaylistService.getByGroup(g.id, this.currentPlaylist || undefined).length}</span>
              </div>
            `)}
          </div>
        </div>
        <div class="channel-main" data-nav-container>
          <div class="channel-list-scroll">
            ${showingRecent
              ? (this.recentItems.length
                  ? this.recentItems.map((item, index) => this.renderRecentItem(item, index, favs))
                  : html`<div class="empty-state">${t('channel.recentEmpty')}</div>`)
              : (filteredChannels.length
                  ? filteredChannels.map(ch => this.renderChannel(ch, favs))
                  : html`<div class="empty-state">${t('channel.empty')}</div>`)}
          </div>
        </div>
      </div>
    `);

    // Restore focus on the reused node (or fall back to a sensible default).
    let target: HTMLElement | null = null;
    if (prevFocusedKey) {
      target = this.container.querySelector<HTMLElement>(
        `[data-key="${attrSelectorEscape(prevFocusedKey)}"]`,
      );
    }
    let playingChannel: HTMLElement | null = null;
    if (!target) {
      playingChannel = this.playingIndex >= 0
        ? this.container.querySelector<HTMLElement>(`.channel-main [data-channel-index="${this.playingIndex}"]`)
        : null;
      // Default focus: the first channel (an empty list falls through to the
      // first focusable — a group or playlist tab — below).
      const target0 = this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]');
      target = playingChannel
        ?? target0
        ?? this.container.querySelector<HTMLElement>('[data-focusable]');
    }
    if (target) {
      this.nav.focus(target);
      if (playingChannel) playingChannel.scrollIntoView({ block: 'center' });
    }
  }

  handleAction(action: Action, event?: NumberEvent): boolean {
    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        return this.nav.move(action);

      case 'channel_up':
        this.nav.move('up');
        break;

      case 'channel_down':
        this.nav.move('down');
        break;

      case 'select': {
        const focused = this.nav.focused;
        if (!focused) break;

        if (focused.dataset.playlist !== undefined) {
          this.currentPlaylist = focused.dataset.playlist;
          this.currentGroup = 'builtin:all';
          this.render();
        } else if (focused.dataset.group !== undefined) {
          this.currentGroup = focused.dataset.group as ChannelGroupId;
          this.render();
        } else if (focused.dataset.recentIndex !== undefined) {
          const item = this.recentItems[parseInt(focused.dataset.recentIndex, 10)];
          if (item?.kind === 'live') {
            this.setPlaying(item.channelIndex);
            this.onChannelSelect(item.channelIndex);
          } else if (item) {
            void this.playRecentCatchup(item);
          }
        } else if (focused.dataset.channelIndex !== undefined) {
          const idx = parseInt(focused.dataset.channelIndex, 10);
          this.setPlaying(idx);
          this.onChannelSelect(idx);
        }
        break;
      }

      case 'green': {
        const focused = this.nav.focused;
        if (focused?.dataset.channelIndex !== undefined) {
          const idx = parseInt(focused.dataset.channelIndex, 10);
          const ch = PlaylistService.getByIndex(idx);
          if (ch) {
            StorageService.toggleFavorite(channelKey(ch));
            this.render();
          }
        }
        break;
      }

      case 'number': {
        if (!event) break;
        const num = event.number - 1;
        if (num >= 0 && num < PlaylistService.channels.length) {
          this.playingIndex = num;
          this.onChannelSelect(num);
        }
        break;
      }
    }
    return false;
  }

  setPlaying(idx: number, catchupStart?: number | null): void {
    this.playingIndex = idx;
    this.playingCatchupStart = catchupStart ?? null;
  }

  /** On entering the view: highlight the first channel (else the first focusable). */
  highlightEntryPoint(): void {
    const entry = this.container.querySelector<HTMLElement>('.channel-main [data-channel-index]')
      ?? this.container.querySelector<HTMLElement>('[data-focusable]');
    if (entry) this.nav.focus(entry);
  }

  private renderChannel(ch: Channel, favs: string[]): Safe {
    const globalIdx = PlaylistService.indexOf(ch);
    const epgId = EpgService.findChannelId(ch);
    const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
    const isPlaying = globalIdx === this.playingIndex && this.playingCatchupStart === null;
    const isFav = favs.includes(channelKey(ch));

    return html`
      <div class="channel-item ${isPlaying ? 'playing' : ''}"
           data-key="ch:${String(globalIdx)}"
           data-focusable data-channel-index="${globalIdx}">
        <div class="channel-number">${globalIdx + 1}</div>
        ${this.renderLogo(ch)}
        <div class="channel-info">
          <div class="channel-name">${isFav ? raw('&#9733; ') : ''}${ch.name}</div>
          ${nowPlaying ? html`<div class="channel-now">${nowPlaying.title}</div>` : ''}
        </div>
        ${isPlaying ? raw('<div class="playing-indicator">&#9654;</div>') : ''}
      </div>
    `;
  }

  private renderRecentItem(item: RecentlyWatchedItem, index: number, favs: string[]): Safe {
    const isFav = favs.includes(channelKey(item.channel));
    if (item.kind === 'live') {
      const epgId = EpgService.findChannelId(item.channel);
      const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
      const isPlaying = item.channelIndex === this.playingIndex && this.playingCatchupStart === null;
      return html`
        <div class="channel-item recent-item recent-live ${isPlaying ? 'playing' : ''}"
             data-key="recent:live:${channelKey(item.channel)}"
             data-focusable data-recent-index="${index}" data-channel-index="${item.channelIndex}">
          <div class="channel-number">${item.channelIndex + 1}</div>
          ${this.renderLogo(item.channel)}
          <div class="channel-info">
            <div class="channel-name">${isFav ? raw('&#9733; ') : ''}${item.channel.name}</div>
            ${nowPlaying ? html`<div class="channel-now">${nowPlaying.title}</div>` : ''}
          </div>
          <div class="recent-kind-badge live">${t('common.live')}</div>
          ${isPlaying ? raw('<div class="playing-indicator">&#9654;</div>') : ''}
        </div>
      `;
    }

    const duration = item.progress.duration > 0
      ? item.progress.duration
      : Math.max(1, (item.progress.progEnd - item.progress.progStart) / 1000);
    const percent = Math.round(Math.max(0, Math.min(1, item.progress.position / duration)) * 100);
    const isPlaying = item.channelIndex === this.playingIndex &&
      this.playingCatchupStart === item.progress.progStart;
    return html`
      <div class="channel-item recent-item recent-catchup ${isPlaying ? 'playing' : ''}"
           data-key="recent:catchup:${channelKey(item.channel)}:${item.progress.progStart}"
           data-focusable data-recent-index="${index}" data-channel-index="${item.channelIndex}">
        <div class="channel-number">${item.channelIndex + 1}</div>
        ${this.renderLogo(item.channel)}
        <div class="channel-info">
          <div class="channel-name">${isFav ? raw('&#9733; ') : ''}${item.progress.title ?? ''}</div>
          <div class="channel-now">${t('channel.resumeAt', {
            channel: item.channel.name,
            position: formatPosition(item.progress.position),
          })}</div>
          <div class="recent-progress"><div class="recent-progress-fill" style="width:${percent}%"></div></div>
        </div>
        <div class="recent-kind-badge catchup">${t('common.catchup')}</div>
        ${isPlaying ? raw('<div class="playing-indicator">&#9654;</div>') : ''}
      </div>
    `;
  }

  private renderLogo(ch: Channel): Safe {
    return html`
      <div class="channel-logo-wrap">
        ${ch.logo
          ? html`<img class="channel-logo" src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : html`<div class="channel-logo-placeholder">${ch.name.charAt(0)}</div>`}
      </div>
    `;
  }

  private async playRecentCatchup(item: Extract<RecentlyWatchedItem, { kind: 'catchup' }>): Promise<void> {
    const catchup = await RecentlyWatchedService.catchupInfo(item);
    if (!catchup) {
      showToast(t('channel.catchupUnavailable'));
      this.render();
      return;
    }
    this.setPlaying(item.channelIndex, item.progress.progStart);
    this.onChannelSelect(item.channelIndex, catchup);
  }

}

// Escape a value for use inside a `[attr="..."]` selector. Only `\` and `"`
// matter. Avoids relying on `CSS.escape` which jsdom does not implement.
function attrSelectorEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
