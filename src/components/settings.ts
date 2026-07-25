import type { Action, PlaylistEntry, TzMode } from '../types';
import { $, $$, html, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { SpatialNav } from '../navigation/spatial-nav';
import { StorageService } from '../services/storage-service';
import { clearCachedEpg } from '../services/idb-cache';
import { UploadClient, uploadIdFromUrl } from '../services/upload-client';
import { createXtreamClient } from '../services/xtream-client';
import { normalizeXtreamBaseUrl } from '../utils/xtream-url';
import { genPlaylistId } from '../utils/playlist-id';
import { CONFIG } from '../config';
import { THEMES, OVERLAY_STYLES, type ThemeMeta, type OverlayStyle } from '../config/themes';
import { previewTheme } from '../services/theme-service';
import { showToast } from './toast';
import { ConfirmationPrompt } from './confirmation-prompt';
import qrcode from 'qrcode-generator';
import { createLogger } from '../utils/logger';
import { localeOptions, t, tp, type LocalePreference } from '../i18n';

const log = createLogger('Settings');

/** Generate a PNG data URL containing a QR code for the given text. */
function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 4);
}

/** "UTC+08:00" / "UTC-05:00" / "UTC" for a feed offset in minutes. */
function formatOffset(min: number): string {
  if (!min) return 'UTC';
  const sign = min > 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** "MyList — 12 channels" when count is known, otherwise just the name. */
function uploadLabel(pl: PlaylistEntry): string {
  if (typeof pl.count === 'number') {
    return `${pl.name} — ${tp('channel.count', pl.count)}`;
  }
  return pl.name;
}

/** One theme swatch tile: a mini mock of the app (tab bar, a focused channel
 *  tile, list rows, status dots) plus the theme name. It carries its own
 *  `data-theme` so every `var(--…)` inside resolves to that theme's colors,
 *  independent of the app's active theme. The mock is decorative (aria-hidden);
 *  the button's aria-label names the theme. */
function themeSwatch(theme: ThemeMeta, activeId: string): Safe {
  return html`
    <button class="theme-swatch ${theme.id === activeId ? 'active' : ''}" data-focusable
            data-theme-id="${theme.id}" data-theme="${theme.id}" aria-label="${theme.name} theme">
      <span class="theme-swatch-preview" aria-hidden="true">
        <span class="tsp-tabs">
          <span class="tsp-tab active">${t('nav.live')}</span>
          <span class="tsp-tab">${t('nav.movies')}</span>
          <span class="tsp-tab">${t('nav.series')}</span>
        </span>
        <span class="tsp-tiles">
          <span class="tsp-tile focus">ch1</span>
          <span class="tsp-tile">ch2</span>
          <span class="tsp-tile">ch3</span>
        </span>
        <span class="tsp-rows">
          <span class="tsp-row">${t('settings.previewChannelOne')}</span>
          <span class="tsp-row muted">${t('settings.previewChannelTwo')}</span>
        </span>
        <span class="tsp-foot">
          <span class="tsp-epg">${t('settings.previewEpgNow')}</span>
          <span class="tsp-dots">
            <span class="tsp-dot dn"></span>
            <span class="tsp-dot su"></span>
            <span class="tsp-dot wa"></span>
          </span>
        </span>
      </span>
      <span class="theme-swatch-name">${theme.name}</span>
    </button>`;
}

/** A single-select toggle group: connected buttons, the active one filled.
 *  Shared by every toggle row (styled via .toggle-group in settings.css). */
function toggleGroup(id: string, options: { value: string; label: string }[], active: string) {
  return html`
    <div class="toggle-group" id="${id}">
      ${options.map(o => html`
        <button class="toggle-option ${o.value === active ? 'active' : ''}"
                data-focusable data-value="${o.value}">${o.label}</button>
      `)}
    </div>`;
}

/** Preferred-subtitle-language options for the online-subtitle search ranking.
 *  '' = no preference. Endonyms render on the TV's fonts (Latin/Cyrillic/CJK/Hangul). */
function subtitleLanguages(): { value: string; label: string }[] {
  return [
    { value: '', label: t('settings.any') },
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'pt', label: 'Português' },
    { value: 'ru', label: 'Русский' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
  ];
}

function languageOptions(): { value: LocalePreference; label: string }[] {
  return [
    { value: 'system', label: t('settings.languageSystem') },
    ...localeOptions(),
  ];
}

/** Custom single-select dropdown — remote/D-pad friendly and app-styled (the app
 *  uses no native `<select>`). The trigger toggles the menu; each option carries a
 *  `data-dropdown-value`; the chosen value lives on the root's `data-value`. Closed
 *  options carry `.hidden` so SpatialNav skips them (its candidate filter honors
 *  `.hidden` / inline `display:none`, not CSS-class display). */
function dropdown(id: string, options: { value: string; label: string }[], active: string) {
  const current = options.find(o => o.value === active) ?? options[0];
  return html`
    <div class="dropdown" id="${id}" data-value="${active}">
      <button class="dropdown-trigger" data-focusable data-dropdown-trigger>
        <span class="dropdown-current">${current.label}</span>
        <span class="dropdown-caret"></span>
      </button>
      <div class="dropdown-menu">
        ${options.map(o => html`
          <button class="dropdown-option hidden ${o.value === active ? 'active' : ''}"
                  data-focusable data-dropdown-value="${o.value}">${o.label}</button>
        `)}
      </div>
    </div>`;
}

/** One editable Xtream account: its four credential fields grouped in a card
 *  keyed by the entry's stable id. Untrusted values interpolate through `html`. */
function xtreamCard(pl: Partial<PlaylistEntry>) {
  return html`
    <div class="xtream-card" data-id="${pl.id || ''}">
      <div class="xtream-fields">
        <div class="settings-field">
          <label>${t('settings.label')}</label>
          <input type="text" class="settings-input xtream-name" data-focusable
                 aria-label="${t('settings.accountLabel')}" placeholder="${t('settings.myProvider')}" value="${pl.name || ''}">
        </div>
        <div class="settings-field wide">
          <label>${t('settings.serverUrl')}</label>
          <input type="text" class="settings-input xtream-url" data-focusable
                 aria-label="${t('settings.serverUrl')}" placeholder="http://host:port" value="${pl.url || ''}">
        </div>
        <div class="settings-field">
          <label>${t('settings.username')}</label>
          <input type="text" class="settings-input xtream-username" data-focusable
                 aria-label="${t('settings.username')}" placeholder="username" value="${pl.xtream?.username || ''}">
        </div>
        <div class="settings-field">
          <label>${t('settings.password')}</label>
          <input type="password" class="settings-input xtream-password" data-focusable
                 aria-label="${t('settings.password')}" placeholder="password" value="${pl.xtream?.password || ''}">
        </div>
      </div>
      <div class="xtream-card-foot">
        <button class="btn btn-secondary check-xtream" data-focusable>${t('settings.check')}</button>
        <button class="btn btn-danger remove-xtream" data-focusable>${t('common.remove')}</button>
        <div class="xtream-status"></div>
      </div>
    </div>`;
}

/** "expires 2026-08-01" (UTC) or "never expires" for a unix-seconds expiry. */
function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return t('settings.neverExpires');
  const d = new Date(expiresAt * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return t('settings.expires', {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
  });
}

/** What the app does after Settings closes: reload = re-fetch playlist/EPG;
 *  apply = re-render for display-only changes; cancel = discard. */
export type SaveAction = 'reload' | 'apply' | 'cancel';

export class Settings {
  private container: HTMLElement;
  private onSave: (action: SaveAction) => void;
  private nav: SpatialNav;
  // Pending theme selection (persisted on Save; live-previewed while browsing).
  private selectedTheme = '';
  private confirmationPrompt = new ConfirmationPrompt();
  private watchlistAccount: PlaylistEntry | null = null;

  constructor(container: HTMLElement, onSave: (action: SaveAction) => void) {
    this.container = container;
    this.onSave = onSave;
    this.nav = new SpatialNav(container, (el) => this.onNavFocus(el));

    // Mouse/pointer support: clicking a focusable element behaves like remote OK.
    // Attached once on the persistent container (render() replaces innerHTML).
    // Marked `data-self-activate` so the global click handler skips this subtree
    // (this local handler is the "OK" action).
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!el) return;
      this.nav.focus(el);
      this.activate(el);
    });

    // Enter on input: commit and move to next focusable element in DOM order.
    // Attached once on the persistent container (render() replaces innerHTML).
    this.container.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
        const all = Array.from(this.container.querySelectorAll<HTMLElement>('[data-focusable]'));
        const idx = all.indexOf(e.target as HTMLElement);
        const next = all[idx + 1];
        if (next) this.nav.focus(next);
      }
    });

    // Pointer theme preview: hovering a swatch previews that theme app-wide;
    // moving the pointer off the swatches restores the currently selected theme
    // immediately (no deferring until focus lands elsewhere).
    this.container.addEventListener('mouseover', (e: MouseEvent) => {
      const sw = (e.target as HTMLElement).closest<HTMLElement>('.theme-swatch');
      if (sw?.dataset.themeId) previewTheme(sw.dataset.themeId);
    });
    this.container.addEventListener('mouseout', (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.theme-swatch')) return;
      const rel = e.relatedTarget as HTMLElement | null;
      if (!rel || !rel.closest('.theme-swatch')) previewTheme(this.selectedTheme);
    });
  }

  render(): void {
    const allPlaylists = StorageService.getPlaylists();
    const playlists = allPlaylists.filter(pl => pl.source !== 'upload' && pl.source !== 'xtream');
    const accounts = allPlaylists.filter(pl => pl.source === 'xtream');
    const selectedAccountId = StorageService.getSelectedXtreamAccountId();
    this.watchlistAccount = accounts.find((account) => account.id === selectedAccountId) ?? accounts[0] ?? null;
    const uploads = allPlaylists.filter(pl => pl.source === 'upload');
    const epgUrl = StorageService.getEpgUrl();
    const autoPlay = StorageService.getAutoPlay();
    const feedTime = StorageService.getTzMode() === 'feed';
    const tzOffset = StorageService.getEpgTzOffset();
    const os = StorageService.getOnlineSubtitleConfig();
    const theme = StorageService.getTheme();
    this.selectedTheme = theme;
    const overlayStyle = StorageService.getOverlayStyle();
    const localePreference = StorageService.getLocalePreference();
    const overlayStyles = OVERLAY_STYLES.map(option => ({
      value: option.value,
      label: t(option.value === 'dark' ? 'settings.overlayDark' : 'settings.overlayFrosted'),
    }));

    this.container.innerHTML = String(html`
      <div class="settings-view">
        <h2 class="settings-title">${t('common.settings')}</h2>

        <div class="settings-section">
          <h3>${t('settings.xtreamAccount')}</h3>
          <div class="xtream-entries" id="xtream-entries">
            ${accounts.length
              ? html`${accounts.map((pl) => xtreamCard(pl))}`
              : html`<div class="empty-hint">${t('settings.noXtream')}</div>`}
          </div>
          <button class="btn btn-primary" data-focusable id="add-xtream">${t('settings.addXtream')}</button>
        </div>

        <div class="settings-section">
          <h3>${t('settings.language')}</h3>
          <div class="settings-row">
            <div class="settings-field">
              ${dropdown('app-language', languageOptions(), localePreference)}
            </div>
          </div>
          <div class="empty-hint">${t('settings.languageHint')}</div>
        </div>

        <div class="settings-section">
          <h3>${t('settings.playlists')}</h3>
          <div class="playlist-entries" id="playlist-entries">
            ${playlists.length
              ? html`
                <div class="settings-row playlist-header-row">
                  <div class="settings-field"><label>${t('settings.name')}</label></div>
                  <div class="settings-field"><label>${t('settings.url')}</label></div>
                  <div class="playlist-header-spacer"></div>
                </div>
                ${playlists.map((pl) => html`
                <div class="settings-row" data-id="${pl.id}">
                  <div class="settings-field">
                    <input type="text" class="settings-input playlist-name"
                           aria-label="${t('settings.playlistName')}" placeholder="${t('settings.myPlaylist')}"
                           data-focusable value="${pl.name || ''}">
                  </div>
                  <div class="settings-field">
                    <input type="text" class="settings-input playlist-url"
                           aria-label="${t('settings.playlistUrl')}" placeholder="https://...m3u"
                           data-focusable value="${pl.url || ''}">
                  </div>
                  <button class="btn btn-danger remove-playlist" data-focusable>${t('common.remove')}</button>
                </div>
              `)}`
              : html`<div class="empty-hint">${t('settings.noPlaylists')}</div>`}
          </div>
          <button class="btn btn-primary" data-focusable id="add-playlist">${t('settings.addPlaylist')}</button>
        </div>

        <div class="settings-section">
          <h3>${t('settings.uploadPlaylist')}</h3>
          <div class="upload-section">
            <div class="upload-box upload-box-info" id="upload-info">${t('settings.checkingUpload')}</div>
            <div class="upload-box upload-box-list">
              <div class="upload-entries" id="upload-entries">
                ${uploads.length
                  ? uploads.map((pl) => html`
                    <div class="settings-row" data-key="${pl.url}">
                      <div class="settings-field wide">
                        <label>${uploadLabel(pl)}</label>
                      </div>
                      <button class="btn btn-danger remove-upload" data-focusable
                              data-url="${pl.url}">${t('common.remove')}</button>
                    </div>
                  `)
                  : html`<div class="empty-hint">${t('settings.noUploads')}</div>`}
              </div>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>${t('settings.epg')}</h3>
          <div class="settings-row">
            <div class="settings-field wide">
              <label>${t('settings.xmltvUrl')}</label>
              <input type="text" class="settings-input" data-focusable id="epg-url"
                     value="${epgUrl}" placeholder="https://example.com/epg.xml">
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>${t('settings.appearance')}</h3>
          <div class="theme-swatch-grid">
            ${THEMES.map(t => themeSwatch(t, theme))}
          </div>
          <div class="settings-row settings-toggle-row">
            <label>${t('settings.overlayGlass')}</label>
            ${toggleGroup('overlay-style', overlayStyles, overlayStyle)}
          </div>
          <div class="empty-hint">${t('settings.overlayHint')}</div>
        </div>

        <div class="settings-section">
          <h3>${t('settings.display')}</h3>
          <div class="settings-row settings-toggle-row">
            <label>${t('settings.timeZone')}</label>
            ${toggleGroup('tz-mode', [{ value: 'device', label: t('settings.device') }, { value: 'feed', label: t('settings.feed') }], feedTime ? 'feed' : 'device')}
          </div>
          <div class="empty-hint">
            ${tzOffset === null
              ? t('settings.timeZoneUnknown')
              : t('settings.timeZoneKnown', { offset: formatOffset(tzOffset) })}
          </div>
        </div>

        <div class="settings-section">
          <h3>${t('settings.playback')}</h3>
          <div class="settings-row settings-toggle-row">
            <label>${t('settings.autoPlay')}</label>
            ${toggleGroup('auto-play', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], autoPlay ? 'on' : 'off')}
          </div>
          <div class="settings-history-action">
            <div class="settings-history-copy">
              <div class="settings-history-title">${t('channel.recentlyWatched')}</div>
              <div class="settings-history-description">
                ${t('settings.clearRecentDescription')}
              </div>
            </div>
            <button class="btn btn-danger" data-focusable id="clear-recently-watched"
                    aria-label="${t('settings.clearRecentlyWatched')}">${t('settings.clearRecentlyWatched')}</button>
          </div>
          ${this.watchlistAccount ? html`
            <div class="settings-history-action">
              <div class="settings-history-copy">
                <div class="settings-history-title">${t('common.watchlist')}</div>
                <div class="settings-history-description">
                  ${t('settings.clearWatchlistDescription', { account: this.watchlistAccount.name })}
                </div>
              </div>
              <button class="btn btn-danger" data-focusable id="clear-watchlist"
                      aria-label="${t('settings.clearWatchlist')}">${t('settings.clearWatchlist')}</button>
            </div>
          ` : ''}
        </div>

        <div class="settings-section">
          <h3>${t('settings.onlineSubtitles')}</h3>
          <div class="settings-row">
            <div class="settings-field">
              <label>${t('settings.preferredSubtitle')}</label>
              ${dropdown('os-pref-lang', subtitleLanguages(), os.preferredLanguage)}
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-field wide">
              <label><span class="settings-domain">SubDL.com</span> ${t('settings.apiKey')}</label>
              <input type="text" class="settings-input" data-focusable id="subdl-key"
                     value="${os.subdl.apiKey}" placeholder="api_key">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-field wide">
              <label><span class="settings-domain">Assrt.net</span> ${t('settings.assrtToken')}</label>
              <input type="text" class="settings-input" data-focusable id="assrt-key"
                     value="${os.assrt.apiKey}" placeholder="token">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-field">
              <label><span class="settings-domain">OpenSubtitles.com</span> ${t('settings.apiKey')}</label>
              <input type="text" class="settings-input" data-focusable id="os-key"
                     value="${os.opensubtitles.apiKey}" placeholder="api_key">
            </div>
            <div class="settings-field">
              <label>${t('settings.username')}</label>
              <input type="text" class="settings-input" data-focusable id="os-user"
                     value="${os.opensubtitles.username}" placeholder="username">
            </div>
            <div class="settings-field">
              <label>${t('settings.password')}</label>
              <input type="password" class="settings-input" data-focusable id="os-pass"
                     value="${os.opensubtitles.password}" placeholder="password">
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>${t('settings.dataManagement')}</h3>
          <div class="settings-row">
            <button class="btn btn-secondary" data-focusable id="refresh-data">${t('settings.refreshAll')}</button>
            <button class="btn btn-danger" data-focusable id="clear-cache">${t('settings.clearCache')}</button>
          </div>
        </div>

        <div class="settings-actions">
          <button class="btn btn-primary btn-large" data-focusable id="save-settings">${t('settings.saveApply')}</button>
          <button class="btn btn-secondary btn-large" data-focusable id="cancel-settings">${t('common.cancel')}</button>
        </div>

        <div class="settings-about">
          ${CONFIG.APP_NAME} v${CONFIG.VERSION}
        </div>
      </div>
    `);

    this.nav.focusFirst();
    void this.loadUploadInfo();
    // Sync uploads from the local service on every Settings open. Subsequent
    // updates arrive via the Luna `uploadEvents` push channel (wired in
    // app.ts → subscribeToUploadEvents) and call refreshUploads() directly.
    void this.refreshUploads();
  }

  handleAction(action: Action): void {
    if (this.confirmationPrompt.visible) {
      this.confirmationPrompt.handleAction(action);
      return;
    }
    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        break;

      case 'select': {
        const focused = this.nav.focused;
        if (!focused) break;
        this.activate(focused);
        break;
      }
    }
  }

  private activate(el: HTMLElement): void {
    if (el.id === 'add-playlist') {
      this.addPlaylistEntry();
    } else if (el.classList.contains('remove-playlist')) {
      this.removePlaylistEntry(el);
    } else if (el.id === 'add-xtream') {
      this.addXtreamEntry();
    } else if (el.classList.contains('remove-xtream')) {
      this.removeXtreamEntry(el);
    } else if (el.classList.contains('check-xtream')) {
      void this.checkXtreamAccount(el);
    } else if (el.classList.contains('remove-upload')) {
      void this.removeUpload(el.dataset.url!);
    } else if (el.hasAttribute('data-dropdown-trigger')) {
      this.toggleDropdown(el.closest<HTMLElement>('.dropdown'));
    } else if (el.classList.contains('dropdown-option')) {
      this.selectDropdownOption(el);
    } else if (el.classList.contains('toggle-option')) {
      // Single-select toggle group: clear the siblings, activate the chosen option.
      el.parentElement?.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    } else if (el.classList.contains('theme-swatch')) {
      this.selectThemeSwatch(el);
    } else if (el.id === 'save-settings') {
      this.save();
    } else if (el.id === 'cancel-settings') {
      this.onSave('cancel');
    } else if (el.id === 'refresh-data') {
      this.onSave('reload');
    } else if (el.id === 'clear-cache') {
      StorageService.remove('cached_playlist');
      void clearCachedEpg();
      showToast(t('settings.cacheCleared'));
    } else if (el.id === 'clear-recently-watched') {
      this.confirmationPrompt.show({
        title: t('settings.clearRecentTitle'),
        message: t('settings.clearRecentMessage'),
        confirmLabel: t('common.clear'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => {
          StorageService.clearRecentlyWatched();
          showToast(t('settings.recentCleared'));
        },
        onCancel: () => {},
      });
    } else if (el.id === 'clear-watchlist' && this.watchlistAccount) {
      const account = this.watchlistAccount;
      this.confirmationPrompt.show({
        title: t('settings.clearWatchlistTitle'),
        message: t('settings.clearWatchlistMessage', { account: account.name }),
        confirmLabel: t('common.clear'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => {
          StorageService.clearWatchlist(account.id);
          showToast(t('settings.watchlistCleared', { account: account.name }));
        },
        onCancel: () => {},
      });
    } else if (el.tagName === 'INPUT') {
      (el as HTMLInputElement).focus();
    }
  }

  get isPromptVisible(): boolean {
    return this.confirmationPrompt.visible;
  }

  dismissPrompt(): void {
    this.confirmationPrompt.hide();
  }

  // Live theme preview: focusing (D-pad) or hovering (pointer) a swatch previews
  // that theme app-wide; anything else falls back to the currently selected theme.
  private onNavFocus(el: HTMLElement | null): void {
    if (el?.dataset.themeId) previewTheme(el.dataset.themeId);
    else previewTheme(this.selectedTheme);
  }

  // OK on a swatch: mark it the pending selection (persisted on Save & Apply;
  // reverted to savedTheme if Settings closes without saving — see App.showView).
  private selectThemeSwatch(el: HTMLElement): void {
    const id = el.dataset.themeId;
    if (!id) return;
    this.container.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    this.selectedTheme = id;
    previewTheme(id);
  }

  // Open/close a custom dropdown. Closed options carry `.hidden` so SpatialNav
  // skips them; opening reveals them and moves focus to the active/first option.
  private toggleDropdown(dd: HTMLElement | null): void {
    if (!dd) return;
    const open = !dd.classList.contains('open');
    dd.classList.toggle('open', open);
    dd.querySelectorAll('.dropdown-option').forEach(o => o.classList.toggle('hidden', !open));
    if (open) {
      const opt = dd.querySelector<HTMLElement>('.dropdown-option.active') ?? dd.querySelector<HTMLElement>('.dropdown-option');
      if (opt) this.nav.focus(opt);
    }
  }

  // Commit a dropdown option: record it on the root's data-value, update the
  // trigger label, re-hide the options, and return focus to the trigger.
  private selectDropdownOption(el: HTMLElement): void {
    const dd = el.closest<HTMLElement>('.dropdown');
    if (!dd) return;
    dd.dataset.value = el.dataset.dropdownValue ?? '';
    dd.querySelectorAll('.dropdown-option').forEach(o => { o.classList.remove('active'); o.classList.add('hidden'); });
    el.classList.add('active');
    const cur = dd.querySelector('.dropdown-current');
    if (cur) cur.textContent = el.textContent;
    dd.classList.remove('open');
    const trigger = dd.querySelector<HTMLElement>('.dropdown-trigger');
    if (trigger) this.nav.focus(trigger);
  }

  private addPlaylistEntry(): void {
    const entries = $('#playlist-entries', this.container);
    if (!entries) return;

    // First add: replace the empty-hint with the column header row.
    const emptyHint = entries.querySelector('.empty-hint');
    if (emptyHint) {
      emptyHint.remove();
      const header = document.createElement('div');
      header.className = 'settings-row playlist-header-row';
      header.innerHTML = `
        <div class="settings-field"><label>${t('settings.name')}</label></div>
        <div class="settings-field"><label>${t('settings.url')}</label></div>
        <div class="playlist-header-spacer"></div>
      `;
      entries.appendChild(header);
    }

    // Seed a concrete default name so it persists as a real value (a blank name
    // makes save() fall back to position-based numbering). Use one past the
    // highest existing "Playlist N" (and the row count) so adding after deleting
    // a middle row never reuses a surviving label.
    const nameInputs = entries.querySelectorAll<HTMLInputElement>('.playlist-name');
    const nextNum = Array.from(nameInputs).reduce((max, inp) => {
      const m = /^Playlist (\d+)$/.exec(inp.value.trim());
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, nameInputs.length) + 1;
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.dataset.id = genPlaylistId();
    row.innerHTML = `
      <div class="settings-field">
        <input type="text" class="settings-input playlist-name"
               aria-label="${t('settings.playlistName')}" placeholder="${t('settings.myPlaylist')}"
               data-focusable value="${t('settings.playlistDefault', { number: nextNum })}">
      </div>
      <div class="settings-field">
        <input type="text" class="settings-input playlist-url"
               aria-label="${t('settings.playlistUrl')}" placeholder="https://...m3u"
               data-focusable value="">
      </div>
      <button class="btn btn-danger remove-playlist" data-focusable>${t('common.remove')}</button>
    `;
    entries.appendChild(row);

    const newInput = row.querySelector<HTMLElement>('input');
    if (newInput) {
      this.nav.focus(newInput);
      (newInput as HTMLInputElement).focus();
    }
  }

  private removePlaylistEntry(removeBtn: HTMLElement): void {
    const entries = $('#playlist-entries', this.container);
    if (!entries) return;
    // Remove the row the clicked button sits in — no positional index, so it
    // can't be thrown off by stale/duplicate row ordering.
    removeBtn.closest('.settings-row')?.remove();
    // Drop the header row too if no data rows remain (lone header would look orphaned).
    if (entries.querySelectorAll('.settings-row:not(.playlist-header-row)').length === 0) {
      const header = entries.querySelector('.playlist-header-row');
      if (header) header.remove();
      const e = document.createElement('div');
      e.className = 'empty-hint';
      e.textContent = t('settings.noPlaylists');
      entries.appendChild(e);
    }
    this.nav.focusFirst();
  }

  private addXtreamEntry(): void {
    const entries = $('#xtream-entries', this.container);
    if (!entries) return;
    entries.querySelector('.empty-hint')?.remove();

    // Build the card off-DOM from the trusted template, then attach it. The
    // seeded id gives morph/save a stable key from the moment it's created.
    const tmp = document.createElement('div');
    tmp.innerHTML = String(xtreamCard({ id: genPlaylistId() }));
    const card = tmp.firstElementChild as HTMLElement | null;
    if (!card) return;
    entries.appendChild(card);

    const firstInput = card.querySelector<HTMLInputElement>('input');
    if (firstInput) {
      this.nav.focus(firstInput);
      firstInput.focus();
    }
  }

  private removeXtreamEntry(removeBtn: HTMLElement): void {
    const entries = $('#xtream-entries', this.container);
    if (!entries) return;
    // Remove the card the clicked button sits in (closest), independent of order.
    removeBtn.closest('.xtream-card')?.remove();
    if (entries.querySelectorAll('.xtream-card').length === 0) {
      const e = document.createElement('div');
      e.className = 'empty-hint';
      e.textContent = t('settings.noXtream');
      entries.appendChild(e);
    }
    this.nav.focusFirst();
  }

  /**
   * Verify a card's current (unsaved) credentials via get_account_info and show
   * the result inline, so the user can confirm before saving. Re-resolves the
   * status node after the await in case the view re-rendered, and never blocks
   * the rest of the form.
   */
  private async checkXtreamAccount(btn: HTMLElement): Promise<void> {
    const card = btn.closest<HTMLElement>('.xtream-card');
    if (!card) return;
    const id = card.dataset.id || '';
    const url = card.querySelector<HTMLInputElement>('.xtream-url')!.value.trim();
    const username = card.querySelector<HTMLInputElement>('.xtream-username')!.value.trim();
    const password = card.querySelector<HTMLInputElement>('.xtream-password')!.value;
    if (!url || !username || !password) {
      this.setXtreamStatus(id, html`${t('settings.enterCredentials')}`, 'err');
      return;
    }

    this.setXtreamStatus(id, html`${t('settings.checking')}`, '');
    const info = await createXtreamClient({ baseUrl: url, username, password }).getAccountInfo();
    if (!info) {
      log.warn('Xtream verify failed — server unreachable or non-JSON');
      this.setXtreamStatus(id, html`${t('settings.verifyFailed')}`, 'err');
      return;
    }
    if (!info.auth) {
      log.warn('Xtream verify rejected — credentials not accepted (auth 0)');
      this.setXtreamStatus(id, html`${t('settings.loginFailed')}`, 'err');
      return;
    }
    const status = info.status || t('settings.active');
    log.info('Xtream verify OK —', status, '| expires', formatExpiry(info.expiresAt),
      '|', info.activeConnections + '/' + info.maxConnections, 'connections');
    this.setXtreamStatus(
      id,
      html`${status} \u00b7 ${formatExpiry(info.expiresAt)} \u00b7 ${t('settings.connections', {
        active: info.activeConnections,
        max: info.maxConnections,
      })}`,
      'ok',
    );
  }

  private setXtreamStatus(id: string, content: Safe, cls: '' | 'ok' | 'err'): void {
    const el = $(`#xtream-entries .xtream-card[data-id="${id}"] .xtream-status`, this.container);
    if (!el) return;
    el.className = 'xtream-status' + (cls ? ` ${cls}` : '');
    morph(el, content);
  }

  private save(): void {
    // Read row-by-row so each row's stable id (data-id) is preserved; a row
    // added before this build has none, so mint one.
    const rows = $$('#playlist-entries .settings-row:not(.playlist-header-row)', this.container) as HTMLElement[];
    const playlists: PlaylistEntry[] = [];

    for (const row of rows) {
      const url = row.querySelector<HTMLInputElement>('.playlist-url')!.value.trim();
      if (!url) continue;
      const name = row.querySelector<HTMLInputElement>('.playlist-name')!.value.trim();
      playlists.push({
        id: row.dataset.id || genPlaylistId(),
        name: name || t('settings.playlistDefault', { number: playlists.length + 1 }),
        url,
        source: 'url',
      });
    }

    // Xtream accounts derive their get.php/xmltv.php URLs from these credentials
    // at load time; the base URL is normalized so a bare host still resolves.
    const accounts: PlaylistEntry[] = [];
    const cards = $$('#xtream-entries .xtream-card', this.container) as HTMLElement[];
    for (const card of cards) {
      const rawUrl = card.querySelector<HTMLInputElement>('.xtream-url')!.value.trim();
      const username = card.querySelector<HTMLInputElement>('.xtream-username')!.value.trim();
      const password = card.querySelector<HTMLInputElement>('.xtream-password')!.value;
      if (!rawUrl || !username || !password) continue;
      const base = normalizeXtreamBaseUrl(rawUrl);
      const name = card.querySelector<HTMLInputElement>('.xtream-name')!.value.trim();
      accounts.push({
        id: card.dataset.id || genPlaylistId(),
        name: name || base.replace(/^https?:\/\//i, ''),
        url: base,
        source: 'xtream',
        xtream: { username, password },
      });
    }

    const nonUpload = [...playlists, ...accounts];

    // Preserve auto-managed uploaded playlists (not shown in the editors above).
    const stored = StorageService.getPlaylists();
    const prevNonUpload = stored.filter(pl => pl.source !== 'upload');
    const uploads = stored.filter(pl => pl.source === 'upload');
    StorageService.setPlaylists([...nonUpload, ...uploads]);

    const epgInput = $('#epg-url', this.container) as HTMLInputElement | null;
    const prevEpg = StorageService.getEpgUrl();
    const epgUrl = epgInput ? epgInput.value.trim() : prevEpg;
    if (epgInput) StorageService.setEpgUrl(epgUrl);

    const autoPlayBtn = $('#auto-play .toggle-option.active', this.container);
    if (autoPlayBtn) StorageService.setAutoPlay(autoPlayBtn.dataset.value === 'on');

    const tzModeBtn = $('#tz-mode .toggle-option.active', this.container);
    if (tzModeBtn?.dataset.value) StorageService.setTzMode(tzModeBtn.dataset.value as TzMode);

    StorageService.setTheme(this.selectedTheme);

    const overlayBtn = $('#overlay-style .toggle-option.active', this.container);
    if (overlayBtn?.dataset.value) StorageService.setOverlayStyle(overlayBtn.dataset.value as OverlayStyle);

    const locale = ($('#app-language', this.container) as HTMLElement | null)?.dataset.value as LocalePreference | undefined;
    if (locale) StorageService.setLocalePreference(locale);

    const prevOs = StorageService.getOnlineSubtitleConfig();
    const osVal = (id: string) => ($(`#${id}`, this.container) as HTMLInputElement | null)?.value.trim() ?? '';
    const sameCreds = osVal('os-key') === prevOs.opensubtitles.apiKey
      && osVal('os-user') === prevOs.opensubtitles.username
      && osVal('os-pass') === prevOs.opensubtitles.password;
    StorageService.setOnlineSubtitleConfig({
      preferredLanguage: ($('#os-pref-lang', this.container) as HTMLElement | null)?.dataset.value ?? '',
      subdl: { apiKey: osVal('subdl-key') },
      assrt: { apiKey: osVal('assrt-key') },
      opensubtitles: {
        apiKey: osVal('os-key'), username: osVal('os-user'), password: osVal('os-pass'),
        token: sameCreds ? prevOs.opensubtitles.token : '',
        tokenTs: sameCreds ? prevOs.opensubtitles.tokenTs : 0,
      },
    });

    // Only a playlist/account or EPG-URL change needs a re-fetch; display-only
    // settings (time zone, auto-play) just re-render in place. Xtream credentials
    // are part of the signature so editing a username/password reloads too.
    const sig = (l: PlaylistEntry[]) =>
      JSON.stringify(l.map(pl => [pl.id, pl.name, pl.url, pl.xtream?.username, pl.xtream?.password]));
    const dataChanged = epgUrl !== prevEpg || sig(prevNonUpload) !== sig(nonUpload);
    this.onSave(dataChanged ? 'reload' : 'apply');
  }

  /**
   * Replace the placeholder text in #upload-info with QR + instructions (or
   * an error when the service is unreachable). Built through `html` so the
   * upload URL — which originates off-device — is escaped, then handed to
   * `morph()` so the surrounding rendered content stays unaffected and we
   * never touch innerHTML directly with an interpolated string.
   */
  private async loadUploadInfo(): Promise<void> {
    const el = $('#upload-info', this.container);
    if (!el) return;
    const info = await UploadClient.getInfo();
    // Re-resolve in case the user navigated away or settings re-rendered.
    const target = $('#upload-info', this.container);
    if (!target) return;
    if (info) {
      const url = info.uploadUrl;
      morph(target, html`
        <img class="upload-qr" alt="${t('settings.qrAlt', { url })}" src="${qrDataUrl(url)}">
        <div class="upload-instructions">
          ${t('settings.uploadInstructionsBefore')}
          <span class="upload-url">${url}</span>
          ${t('settings.uploadInstructionsAfter')}
        </div>
      `);
    } else {
      morph(target, html`<span>${t('settings.uploadUnavailable')}</span>`);
    }
  }

  private async removeUpload(url: string): Promise<void> {
    const id = uploadIdFromUrl(url);
    if (id) await UploadClient.remove(id);

    const remaining = StorageService.getPlaylists().filter(pl => pl.url !== url);
    StorageService.setPlaylists(remaining);
    StorageService.remove('cached_playlist');
    showToast(t('settings.uploadRemoved'));

    await this.refreshUploads();
  }

  /**
   * Pull the latest uploads from the local service into storage, then patch
   * just the #upload-entries section via morph() so the rest of the form
   * keeps its focus and unsaved input.
   *
   * Called on render() (covers uploads that arrived before the user opened
   * Settings) and on every Luna `uploadEvents` push from the upload service
   * (covers uploads that arrive while Settings is open — see app.ts).
   *
   * Safe to call when the settings view is hidden: reconcile still updates
   * storage, but the morph is a no-op against the off-screen container so
   * there's no visible side effect.
   */
  async refreshUploads(): Promise<void> {
    await UploadClient.reconcile();
    const target = $('#upload-entries', this.container);
    if (!target) return;

    const uploads = StorageService.getPlaylists().filter(pl => pl.source === 'upload');
    morph(target, uploads.length
      ? html`${uploads.map((pl) => html`
        <div class="settings-row" data-key="${pl.url}">
          <div class="settings-field wide">
            <label>${uploadLabel(pl)}</label>
          </div>
          <button class="btn btn-danger remove-upload" data-focusable
                  data-url="${pl.url}">${t('common.remove')}</button>
        </div>
      `)}`
      : html`<div class="empty-hint">${t('settings.noUploads')}</div>`);
  }
}
