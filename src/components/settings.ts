import type { Action, ChannelCycleMode, EpgSource, ManualEpgSource, NavDirection, PlaylistEntry, TzMode, XtreamLiveCategoryFilter, XtreamLiveCategorySnapshot } from '../types';
import { $, $$, html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import {
  NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS,
  LIVE_RECONNECT_ATTEMPT_OPTIONS,
  PLAYER_OSD_TIMEOUT_MS_OPTIONS,
  REFRESH_INTERVAL_HOUR_OPTIONS,
  StorageService,
  XTREAM_CATALOG_REFRESH_HOUR_OPTIONS,
} from '../services/storage-service';
import { EpgService } from '../services/epg-service';
import { ChannelCustomizationService } from '../services/channel-customization';
import { PlaylistService } from '../services/playlist-service';
import {
  clearAllCachedData,
  getCacheUsage,
  type CacheUsageSummary,
} from '../services/idb-cache';
import { UploadClient, uploadIdFromUrl } from '../services/upload-client';
import { SetupClient } from '../services/setup-client';
import { ReminderService } from '../services/reminder-service';
import {
  ChannelHealthService,
  type ChannelHealthProgress,
} from '../services/channel-health';
import { createXtreamClient } from '../services/xtream-client';
import { newLiveCategoryIds, normalizeLiveCategoryFilter } from '../utils/xtream-category-filter';
import { LiveCategoryPicker } from './live-category-picker';
import { normalizeXtreamBaseUrl, normalizeXtreamLiveOutputPreference } from '../utils/xtream-url';
import { genPlaylistId, isSourceEnabled } from '../utils/playlist';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { formatEpgOffset } from '../utils/epg-offset';
import { CONFIG } from '../config';
import { THEMES, OVERLAY_STYLES, TEXT_SIZES, DEFAULT_TEXT_SIZE, type ThemeMeta, type OverlayStyle, type TextSize } from '../config/themes';
import { previewTheme, applyTextSize } from '../services/theme-service';
import { showToast } from './toast';
import { ConfirmationPrompt } from './confirmation-prompt';
import { sourceToggle, toggleGroup } from './toggle-controls';
import {
  closeDropdown,
  commitDropdownOption,
  dropdown,
  toggleDropdown,
} from './dropdown';
import qrcode from 'qrcode-generator';
import { createLogger } from '../utils/logger';
import { ParentalControlService, isResumeConcealed, isWatchlistConcealed } from '../services/parental-control';
import { parentalPinSupported } from '../services/parental-pin';
import {
  formatNumber,
  localeOptions,
  t,
  tp,
  type LocalePreference,
  type TextMessageKey,
} from '../i18n';
import {
  ANIMATION_MODES,
  applyAnimationMode,
  type AnimationMode,
} from '../services/motion-service';
import {
  ADVANCED_ICON,
  APPEARANCE_ICON,
  CHEVRON_DOWN,
  CHEVRON_UP,
  CAPTIONS_ICON,
  DATABASE_ICON,
  GLOBE_ICON,
  GUIDE_ICON,
  LOCK_ICON,
  NAV_HORIZONTAL_ICON,
  NAV_VERTICAL_ICON,
  PLAYBACK_ICON,
  SOURCES_ICON,
} from './icons';

const log = createLogger('Settings');
// Frames the pane must hold still before a scroll counts as done.
const CATEGORY_SCROLL_STABLE_FRAMES = 4;
const CATEGORY_SCROLL_IDLE_FRAMES = 8;
const CATEGORY_SCROLL_MAX_FRAMES = 120;

type EpgScopePlaylist = Pick<PlaylistEntry, 'id' | 'name' | 'url'>;

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

function correctedTime(min: number): string {
  const total = 20 * 60 + min;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function correctionPreview(min: number): Safe {
  return html`${t('settings.timeCorrectionExample')}: 20:00 -> ${correctedTime(min)}`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
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

function languageHeading(): string {
  const localized = t('settings.language');
  return localized === 'Language' ? localized : `${localized} / Language`;
}

function refreshIntervalOptions(): { value: string; label: string }[] {
  return REFRESH_INTERVAL_HOUR_OPTIONS.map(hours => ({
    value: String(hours),
    label: hours === 0
      ? t('common.off')
      : tp('settings.refreshHours', hours),
  }));
}

function xtreamCatalogRefreshIntervalOptions(): { value: string; label: string }[] {
  return XTREAM_CATALOG_REFRESH_HOUR_OPTIONS.map(hours => ({
    value: String(hours),
    label: tp('settings.refreshHours', hours),
  }));
}

const ANIMATION_MODE_LABELS: Record<AnimationMode, TextMessageKey> = {
  essential: 'settings.animationEssential',
  reduced: 'settings.animationReduced',
  full: 'settings.animationFull',
};

function animationModeOptions(): { value: AnimationMode; label: string }[] {
  return ANIMATION_MODES.map(value => ({
    value,
    label: t(ANIMATION_MODE_LABELS[value]),
  }));
}

function timeoutOptions(values: readonly number[]): { value: string; label: string }[] {
  return values.map(value => {
    const seconds = value / 1000;
    return {
      value: String(value),
      label: tp('settings.durationSeconds', seconds, {
        seconds: formatNumber(seconds, { maximumFractionDigits: 1 }),
      }),
    };
  });
}

type SettingsCategory = 'general' | 'sources' | 'guide' | 'appearance'
  | 'playback' | 'subtitles' | 'data' | 'advanced';

const SETTINGS_CATEGORIES: readonly {
  id: SettingsCategory;
  label: TextMessageKey;
  icon: Safe;
}[] = [
  {
    id: 'general',
    label: 'settings.general',
    icon: raw(GLOBE_ICON),
  },
  {
    id: 'sources',
    label: 'settings.sources',
    icon: raw(SOURCES_ICON),
  },
  {
    id: 'guide',
    label: 'settings.guide',
    icon: raw(GUIDE_ICON),
  },
  {
    id: 'appearance',
    label: 'settings.appearance',
    icon: raw(APPEARANCE_ICON),
  },
  {
    id: 'playback',
    label: 'settings.playback',
    icon: raw(PLAYBACK_ICON),
  },
  {
    id: 'subtitles',
    label: 'settings.onlineSubtitles',
    icon: raw(CAPTIONS_ICON),
  },
  {
    id: 'advanced',
    label: 'settings.advanced',
    icon: raw(ADVANCED_ICON),
  },
  {
    id: 'data',
    label: 'settings.dataManagement',
    icon: raw(DATABASE_ICON),
  },
];

function settingsNavItem(category: typeof SETTINGS_CATEGORIES[number], active: boolean): Safe {
  return html`
    <button class="settings-nav-item ${active ? 'active' : ''}" data-focusable
            data-settings-target="${category.id}">
      <span class="settings-nav-icon">${category.icon}</span>
      <span>${t(category.label)}</span>
    </button>
  `;
}

function disabledDropdown(id: string, label: string): Safe {
  return html`
    <div class="dropdown epg-offset-unavailable" id="${id}" data-value="">
      <span class="dropdown-sizer" aria-hidden="true"><span>${label}</span></span>
      <button class="dropdown-trigger" disabled>
        <span class="dropdown-current">${label}</span>
        <span class="dropdown-caret"></span>
      </button>
    </div>`;
}

function uploadRow(pl: PlaylistEntry, enabled = isSourceEnabled(pl)): Safe {
    return html`
      <div class="settings-row ${enabled ? '' : 'source-disabled'}"
           data-key="${pl.url}" data-id="${pl.id}" data-source-entry>
        <div class="settings-field wide">
          <label>${uploadLabel(pl)}</label>
        </div>
        ${sourceToggle(enabled)}
        <button class="btn btn-danger remove-upload" data-focusable
                data-url="${pl.url}">${t('common.remove')}</button>
      </div>
    `;
}

function withEnabledState(entry: PlaylistEntry, enabled: boolean): PlaylistEntry {
  if (!enabled) return { ...entry, enabled: false };
  const copy = { ...entry };
  delete copy.enabled;
  return copy;
}

/** The card button's summary: "All", "{kept} of {total}" when the catalog
 *  size is known, and a badge for categories the user has not reviewed. */
export function liveCategoriesButtonContent(
  filter: XtreamLiveCategoryFilter | undefined,
  snapshot: XtreamLiveCategorySnapshot | null,
  catalogIds?: readonly string[],
): Safe {
  const ids = catalogIds ?? (snapshot ? Object.keys(snapshot.counts) : []);
  let value = '';
  if (!filter) {
    value = t('liveCategories.all');
  } else if (ids.length) {
    const listed = new Set(filter.ids);
    const matched = ids.filter(id => listed.has(id)).length;
    value = t('liveCategories.summary', {
      count: filter.mode === 'include' ? matched : ids.length - matched,
      total: ids.length,
    });
  }
  const fresh = newLiveCategoryIds(filter, snapshot, snapshot ? Object.keys(snapshot.counts) : []).length;
  return html`<span>${t('liveCategories.title')}</span>${value
    ? html`<span class="xtream-live-categories-value">${value}</span>` : ''}${fresh
    ? html`<em class="xtream-live-categories-new">${tp('liveCategories.newBadge', fresh)}</em>` : ''}`;
}

/** One editable Xtream account: its fields grouped in a card
 *  keyed by the entry's stable id. Untrusted values interpolate through `html`. */
function xtreamCard(pl: Partial<PlaylistEntry>) {
  const liveOutput = normalizeXtreamLiveOutputPreference(pl.xtream?.liveOutput);
  const enabled = pl.enabled !== false;
  const guide = !pl.id || StorageService.getGuideOffSources().indexOf(pl.id) < 0;
  return html`
    <div class="xtream-card ${enabled ? '' : 'source-disabled'}"
         data-id="${pl.id || ''}" data-source-entry>
      <div class="xtream-fields">
        <div class="settings-field">
          <label>${t('settings.label')}</label>
          <input type="text" class="settings-input xtream-name" data-focusable
                 aria-label="${t('settings.accountLabel')}" placeholder="${t('settings.myProvider')}" value="${pl.name || ''}">
        </div>
        <div class="settings-field wide">
          <label>${t('settings.serverUrl')}</label>
          <input type="url" class="settings-input xtream-url" data-focusable
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
        <div class="settings-field xtream-output">
          <label>${t('settings.streamFormat')}</label>
          ${dropdown(`xtream-output-${pl.id || ''}`, [
            { value: 'ts', label: t('settings.streamFormatTs') },
            { value: 'm3u8', label: t('settings.streamFormatHls') },
            { value: 'auto', label: t('settings.streamFormatAuto') },
          ], liveOutput)}
        </div>
        <div class="settings-field xtream-guide">
          <label>${t('settings.guide')}</label>
          ${toggleGroup(`xtream-guide-${pl.id || ''}`, [
            { value: 'on', label: t('settings.on') },
            { value: 'off', label: t('settings.off') },
          ], guide ? 'on' : 'off')}
        </div>
      </div>
      <div class="xtream-card-foot">
        ${sourceToggle(enabled)}
        <button class="btn btn-secondary check-xtream" data-focusable>${t('settings.check')}</button>
        <button class="btn btn-secondary xtream-live-categories" data-focusable>${liveCategoriesButtonContent(
          normalizeLiveCategoryFilter(pl.xtream?.liveCategories),
          pl.id ? StorageService.getLiveCategorySnapshot(pl.id) : null,
        )}</button>
        <button class="btn btn-danger remove-xtream" data-focusable>${t('common.remove')}</button>
        <div class="xtream-status"></div>
      </div>
    </div>`;
}

function manualEpgSourceRow(
  source: ManualEpgSource,
  playlists: EpgScopePlaylist[],
  index: number,
  sourceCount: number,
): Safe {
  const canMoveEarlier = index > 0;
  const canMoveLater = index < sourceCount - 1;
  const key = manualEpgKey(index);
  return html`
    <div class="manual-epg-source" data-manual-epg-source data-key="${key}">
      <div class="manual-epg-source-head">
        <span class="manual-epg-priority">${index + 1}</span>
        <input type="url" class="settings-input manual-epg-url" data-focusable
               aria-label="${t('settings.xmltvUrl')}" value="${source.url}"
               placeholder="http://host/guide.xml">
        <button class="btn btn-secondary move-epg-earlier" data-key="${key}:earlier"
                ${raw(canMoveEarlier ? 'data-focusable' : 'disabled')}
                aria-label="${t('settings.moveEarlier')}">${raw(CHEVRON_UP)}</button>
        <button class="btn btn-secondary move-epg-later" data-key="${key}:later"
                ${raw(canMoveLater ? 'data-focusable' : 'disabled')}
                aria-label="${t('settings.moveLater')}">${raw(CHEVRON_DOWN)}</button>
        <button class="btn btn-danger remove-epg-source" data-focusable data-key="${key}:remove">
          ${t('common.remove')}
        </button>
      </div>
      <div class="manual-epg-scope">
        <span class="manual-epg-scope-label">${t('settings.epgAppliesTo')}</span>
        ${manualEpgScopeOptions(source, playlists, key)}
      </div>
    </div>`;
}

function manualEpgKey(index: number): string {
  return `manual-epg-${index}`;
}

function manualEpgScopeOptions(
  source: ManualEpgSource,
  playlists: EpgScopePlaylist[],
  rowKey: string,
): Safe {
  const allPlaylists = source.playlistIds.length === 0;
  return html`
    <div class="manual-epg-scope-options">
      <button class="epg-scope-option ${allPlaylists ? 'active' : ''}"
              data-focusable data-scope-all data-key="${rowKey}:all">
        ${t('settings.allPlaylists')}
      </button>
      ${playlists.map(playlist => html`
        <button class="epg-scope-option ${
          source.playlistIds.includes(playlist.id) ? 'active' : ''
        }" data-focusable data-playlist-id="${playlist.id}"
                data-key="${rowKey}:playlist:${playlist.id}">
          ${playlist.name || playlist.url}
        </button>
      `)}
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
 *  apply = re-render for display-only changes; reset = erase local app data;
 *  edit-channels = open the channel list in edit mode; cancel = discard. */
// 'guide': only which sources load their program guide changed.
export type SaveAction = 'reload' | 'guide' | 'apply' | 'reset' | 'cancel' | 'edit-channels';

export class Settings {
  private container: HTMLElement;
  private onSave: (action: SaveAction) => void | Promise<void>;
  private onChannelsChanged: () => void;
  private nav: SpatialNav;
  // The nav only picks elements geometrically; the scope holds the focused
  // control's key and owns its ring and its reveal.
  readonly focusScope: FocusScope;
  // How the nav's next pick was asked for.
  private via: Via = 'key';
  // The pointer left the focused control: the next key only shows it.
  private concealed = false;
  // A control hovered while a text field has the caret, which takes the
  // ring once the caret leaves.
  private notedKey: string | null = null;
  // The control Settings came back to, until its first reveal.
  private landedKey: string | null = null;
  private currentRow: Element | null = null;
  // Pending theme selection (persisted on Save; live-previewed while browsing).
  private selectedTheme = '';
  private themeHoverToken = 0;
  private epgOffsets: Record<string, number> = {};
  private storedEpgOffsets: Record<string, number> = {};
  private confirmationPrompt = new ConfirmationPrompt('prompt.settings');
  private liveCategoryPicker = new LiveCategoryPicker();
  // Picker results waiting for Save, per card id; `account` ties each to the
  // server and username it was chosen for.
  private pendingLiveCategories = new Map<string, {
    filter: XtreamLiveCategoryFilter | undefined;
    account: string;
    catalogIds: string[];
    reviewed: XtreamLiveCategorySnapshot;
  }>();
  private watchlistAccount: PlaylistEntry | null = null;
  private ignoreCategoryScroll = false;
  private categoryScrollFrame: number | null = null;
  private categorySyncFrame: number | null = null;
  private categoryFocusFrame: number | null = null;
  // The scroll hold keeps the focused control's category, not the pane's.
  private categoryAimed = false;
  private onManageReminders: () => void;
  private onManageParentalControls: () => void;
  private healthController: AbortController | null = null;
  private healthCheckPromise: Promise<void> | null = null;
  private healthProgress: ChannelHealthProgress | null = null;
  private healthPaused = false;
  private healthResume: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    onSave: (action: SaveAction) => void | Promise<void>,
    onChannelsChanged: () => void = () => {},
    onManageReminders: () => void = () => {},
    onManageParentalControls: () => void = () => {},
    private authorizeLiveEditing: (name: string, proceed: () => void) => void =
      (_name, proceed) => proceed(),
    private authorizeSourceRemoval:
      (id: string, proceed: () => void, turnOff?: boolean) => void =
      (_id, proceed) => proceed(),
  ) {
    this.container = container;
    this.onSave = onSave;
    this.onChannelsChanged = onChannelsChanged;
    this.onManageReminders = onManageReminders;
    this.onManageParentalControls = onManageParentalControls;
    this.nav = new SpatialNav(container, (el) => this.onNavFocus(el), { follow: false });
    this.focusScope = Focus.register({
      id: 'view.settings',
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.defaultKey(),
      resolve: (key) => this.resolveKey(key),
      reveal: (key) => this.revealLanded(key),
      // A caret left in a text field keeps the arrow keys from whatever owns
      // them. The control the pointer rests on is no longer picked as it goes:
      // Settings no longer owns the keys, and a swatch would preview its theme.
      onRelease: () => {
        this.notedKey = null;
        this.caretInput()?.blur();
      },
    });

    // Mouse/pointer support: clicking a focusable element behaves like remote OK.
    // Attached once on the persistent container (render() replaces innerHTML).
    // Marked `data-self-activate` so the global click handler skips this subtree
    // (this local handler is the "OK" action).
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const openDropdown = this.container.querySelector<HTMLElement>('.dropdown.open');
      if (openDropdown && target.closest('.dropdown') !== openDropdown) {
        this.closeDropdown(openDropdown);
      }
      const el = target.closest<HTMLElement>('[data-focusable]');
      if (!el) return;
      this.notedKey = null;
      this.pick(el, 'pointer');
      this.activate(el);
    });

    // The global key handler ignores most keys in a text field, so the field
    // owns its ways out. Each sets where the ring lands before the caret goes.
    // Attached once on the persistent container (render() replaces innerHTML).
    this.container.addEventListener('keydown', (e: KeyboardEvent) => {
      const input = e.target as HTMLInputElement;
      if (input.tagName !== 'INPUT') return;
      const back = e.key === 'Escape' || e.keyCode === CONFIG.KEYS.BACK;
      const up = e.key === 'ArrowUp' || e.keyCode === CONFIG.KEYS.UP;
      const down = e.key === 'ArrowDown' || e.keyCode === CONFIG.KEYS.DOWN;
      if (e.key !== 'Enter' && !up && !down && !back) return;
      e.preventDefault();
      e.stopPropagation();
      this.notedKey = null;
      this.via = 'key';
      if (e.key === 'Enter') {
        // Commit and move to the next focusable element in DOM order.
        const all = Array.from(this.container.querySelectorAll<HTMLElement>('[data-focusable]'));
        this.pick(all[all.indexOf(input) + 1] ?? input, 'key');
      } else if (back) {
        this.pick(input, 'key');
      } else {
        this.nav.focused = input;
        if (!this.moveFocus(up ? 'up' : 'down')) this.pick(input, 'key');
      }
      input.blur();
    });

    // However the pointer took the caret away, the ring lands on the control
    // it rests on, or stays on the field.
    this.container.addEventListener('focusout', (e: FocusEvent) => {
      const input = e.target as HTMLElement;
      if (input.tagName !== 'INPUT') return;
      const noted = this.notedKey;
      this.notedKey = null;
      const el = noted !== null ? this.resolveKey(noted) : null;
      if (el) this.pick(el, 'pointer');
    });

    this.container.addEventListener('input', (e: Event) => {
      const input = e.target as HTMLInputElement;
      if (input.classList.contains('manual-epg-url')) {
        this.refreshEpgOffsetEditor(this.manualEpgSourcesFromEditor(), input.value.trim());
      } else if (
        input.classList.contains('playlist-name')
        || input.classList.contains('playlist-url')
        || input.classList.contains('xtream-name')
        || input.classList.contains('xtream-url')
      ) {
        this.refreshManualEpgScopes();
      }
    });

    // Hover moves focus, except that while a text field has the caret the
    // hovered control is only noted. Hovering a swatch previews its theme
    // app-wide; leaving it restores the selected theme at once.
    this.container.addEventListener('nav:hover', (e: Event) => {
      const el = e.target as HTMLElement;
      if (!el.hasAttribute('data-focusable')) return;
      const caret = this.caretInput();
      if (caret && caret !== el) {
        this.notedKey = this.keyOf(el);
        if (el.dataset.themeId) {
          this.themeHoverToken++;
          previewTheme(el.dataset.themeId);
        }
        return;
      }
      this.notedKey = null;
      this.pick(el, 'pointer');
    });
    this.container.addEventListener('nav:unhover', (e: Event) => {
      const el = e.target as HTMLElement;
      if (el.dataset.themeId) this.restoreThemeAfterHover();
      if (this.notedKey !== null && this.notedKey === this.keyOf(el)) this.notedKey = null;
      // A field with the caret keeps its ring.
      if (this.caretInput() || el !== this.resolveFocused()) return;
      this.concealed = true;
      this.markRow(null);
      this.focusScope.conceal();
      Focus.flush();
    });

    this.container.addEventListener('scroll', (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('settings-scroll') || this.ignoreCategoryScroll) return;
      if (this.categorySyncFrame !== null) return;
      this.categorySyncFrame = window.requestAnimationFrame(() => {
        this.categorySyncFrame = null;
        this.syncCategoryFromScroll(target);
      });
    }, true);
    // A wheel takes the pane over, so its scroll position picks the category.
    this.container.addEventListener('nav:wheel', (e: Event) => {
      const main = e.target instanceof Element ? e.target.closest<HTMLElement>('.settings-scroll') : null;
      if (!main || !this.ignoreCategoryScroll) return;
      this.endCategoryHold();
      if (this.categorySyncFrame !== null) return;
      this.categorySyncFrame = window.requestAnimationFrame(() => {
        this.categorySyncFrame = null;
        this.syncCategoryFromScroll(main);
      });
    });
  }

  private collectionDescription(kind: 'continue' | 'watchlist'): string {
    const account = this.watchlistAccount;
    if (!account) return '';
    let count: number;
    let concealed: boolean;
    if (kind === 'continue') {
      const entries = StorageService.getResumeList(account.id);
      count = entries.length;
      concealed = entries.some(isResumeConcealed);
    } else {
      const entries = [
        ...StorageService.getWatchlist(account.id, 'vod'),
        ...StorageService.getWatchlist(account.id, 'series'),
      ];
      count = entries.length;
      concealed = entries.some(isWatchlistConcealed);
    }
    return t(kind === 'continue'
      ? concealed ? 'settings.clearContinueWatchingDescriptionUncounted' : 'settings.clearContinueWatchingDescription'
      : concealed ? 'settings.clearWatchlistDescriptionUncounted' : 'settings.clearWatchlistDescription', {
      account: account.name, count,
    });
  }

  refreshCollectionCounts(): void {
    const resumeHint = this.container.querySelector<HTMLElement>('#continue-watching-count-hint');
    const watchlistHint = this.container.querySelector<HTMLElement>('#watchlist-count-hint');
    if (resumeHint) morph(resumeHint, html`${this.collectionDescription('continue')}`);
    if (watchlistHint) morph(watchlistHint, html`${this.collectionDescription('watchlist')}`);
  }

  render(): void {
    this.pendingLiveCategories.clear();
    const allPlaylists = StorageService.getPlaylists();
    const playlists = allPlaylists.filter(pl => pl.source !== 'upload' && pl.source !== 'xtream');
    const accounts = allPlaylists.filter(pl => pl.source === 'xtream');
    const enabledAccounts = accounts.filter(isSourceEnabled);
    const selectedAccountId = StorageService.getSelectedXtreamAccountId();
    this.watchlistAccount = enabledAccounts.find((account) => account.id === selectedAccountId)
      ?? enabledAccounts[0] ?? null;
    const uploads = allPlaylists.filter(pl => pl.source === 'upload');
    const manualEpgSources = StorageService.getManualEpgSources();
    this.storedEpgOffsets = StorageService.getEpgOffsets();
    this.epgOffsets = { ...this.storedEpgOffsets };
    const epgSources = this.epgSources(manualEpgSources, allPlaylists);
    const autoPlay = StorageService.getAutoPlay();
    const livePreview = StorageService.getLivePreview();
    const channelCycleMode = StorageService.getChannelCycleMode();
    const showHidden = StorageService.getShowHiddenChannels();
    const hideArabic = StorageService.getHideArabic();
    const feedTime = StorageService.getTzMode() === 'feed';
    const tzOffset = StorageService.getEpgTzOffset();
    const os = StorageService.getOnlineSubtitleConfig();
    const theme = StorageService.getTheme();
    this.selectedTheme = theme;
    const overlayStyle = StorageService.getOverlayStyle();
    const textSize = StorageService.getTextSize();
    const localePreference = StorageService.getLocalePreference();
    const liveReconnectAttempts = StorageService.getLiveReconnectAttempts();
    const numberEntryOsdTimeoutMs = StorageService.getNumberEntryOsdTimeoutMs();
    const playerOsdTimeoutMs = StorageService.getPlayerOsdTimeoutMs();
    const animationMode = StorageService.getAnimationMode();
    const playlistRefreshHours = StorageService.getPlaylistRefreshIntervalHours();
    const epgRefreshHours = StorageService.getEpgRefreshIntervalHours();
    const xtreamCatalogRefreshHours = StorageService.getXtreamCatalogRefreshIntervalHours();
    const overlayStyles = OVERLAY_STYLES.map(option => ({
      value: option.value,
      label: t(option.value === 'dark' ? 'settings.overlayDark' : 'settings.overlayFrosted'),
    }));
    const textSizes = TEXT_SIZES.map(size => ({
      value: size,
      label: size === DEFAULT_TEXT_SIZE ? t('settings.textSizeDefault', { percent: size }) : `${size}%`,
    }));
    const parentalSupported = parentalPinSupported();
    const parentalStatus = t(ParentalControlService.enabled
      ? 'parental.statusOn'
      : 'parental.statusOff');

    this.container.innerHTML = String(html`
      <div class="settings-view">
        <nav class="settings-sidebar" data-nav-container aria-label="${t('common.settings')}">
          <h2 class="settings-title">${t('common.settings')}</h2>
          <div class="settings-nav-list">
            ${SETTINGS_CATEGORIES.map((category, index) => settingsNavItem(category, index === 0))}
          </div>
          <div class="settings-nav-help">
            <div class="settings-nav-help-row">
              <span class="settings-nav-key">${raw(NAV_VERTICAL_ICON)}</span>
              <span>${t('settings.navChooseCategory')}</span>
            </div>
            <div class="settings-nav-help-row">
              <span class="settings-nav-key">${raw(NAV_HORIZONTAL_ICON)}</span>
              <span>${t('settings.navEnterReturn')}</span>
            </div>
          </div>
        </nav>

        <div class="settings-main">
          <div class="settings-scroll">
            <div class="settings-category" id="settings-general" data-settings-category="general">
              <div class="settings-general-row">
                <div class="settings-section settings-general-language">
                  <h3 class="settings-section-title">${languageHeading()}</h3>
                  <div class="settings-item">
                    ${dropdown('app-language', languageOptions(), localePreference)}
                    <div class="settings-item-hint">${t('settings.languageHint')}</div>
                  </div>
                </div>

                <div class="settings-section settings-general-device">
                  <h3 class="settings-section-title">${t('settings.deviceSetup')}</h3>
                  <div class="source-box setup-box-info device-setup-card"
                       id="setup-info">${t('settings.checkingSetup')}</div>
                </div>
              </div>
              <div class="settings-section">
                <h3 class="settings-section-title parental-entry-title">${t('settings.parentalControls')}<span
                    class="parental-entry-status ${ParentalControlService.enabled ? 'is-on' : ''}">${
                    raw(LOCK_ICON)}${parentalStatus}</span></h3>
                <div class="settings-item settings-item--action">
                  <button class="btn ${ParentalControlService.configured
                    ? 'btn-secondary'
                    : 'btn-primary'}" ${parentalSupported ? raw('data-focusable') : raw('disabled')}
                    id="manage-parental-controls">
                    ${t(ParentalControlService.configured ? 'parental.manage' : 'parental.turnOn')}
                  </button>
                  <div class="settings-item-hint">${t(parentalSupported
                    ? 'parental.settingsHint'
                    : 'parental.unavailable')}</div>
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-sources" data-settings-category="sources">
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.xtreamAccount')}</h3>
                <div class="xtream-entries" id="xtream-entries">
                  ${accounts.length
                    ? html`${accounts.map((pl) => xtreamCard(pl))}`
                    : html`<div class="empty-hint">${t('settings.noXtream')}</div>`}
                </div>
                <button class="btn btn-primary" data-focusable id="add-xtream">${t('settings.addXtream')}</button>
                <div class="settings-item-hint">
                  <strong>${t('settings.streamFormat')}:</strong> ${t('settings.streamFormatHint')}
                </div>
                <div class="settings-item-hint">
                  <strong>${t('liveCategories.title')}:</strong> ${t('liveCategories.settingsHint')}
                </div>
              </div>

              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.playlists')}</h3>
                <div class="playlist-entries" id="playlist-entries">
                  ${playlists.length
                    ? html`
                      <div class="settings-row playlist-header-row">
                        <div class="settings-field"><label>${t('settings.name')}</label></div>
                        <div class="settings-field"><label>${t('settings.url')}</label></div>
                        <div class="playlist-header-spacer"></div>
                      </div>
                      ${playlists.map((pl) => html`
                      <div class="settings-row ${isSourceEnabled(pl) ? '' : 'source-disabled'}"
                           data-id="${pl.id}" data-source-entry>
                        <div class="settings-field">
                          <input type="text" class="settings-input playlist-name"
                                 aria-label="${t('settings.playlistName')}" placeholder="${t('settings.myPlaylist')}"
                                 data-focusable value="${pl.name || ''}">
                        </div>
                        <div class="settings-field">
                          <input type="url" class="settings-input playlist-url"
                                 aria-label="${t('settings.playlistUrl')}" placeholder="https://...m3u"
                                 data-focusable value="${pl.url || ''}">
                        </div>
                        ${sourceToggle(isSourceEnabled(pl))}
                        <button class="btn btn-danger remove-playlist" data-focusable>${t('common.remove')}</button>
                      </div>
                    `)}`
                    : html`<div class="empty-hint">${t('settings.noPlaylists')}</div>`}
                </div>
                <button class="btn btn-primary" data-focusable id="add-playlist">${t('settings.addPlaylist')}</button>
              </div>

              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.uploadPlaylist')}</h3>
                <div class="source-box upload-box-list">
                  <div class="upload-entries" id="upload-entries">
                    ${uploads.length
                      ? uploads.map((pl) => uploadRow(pl))
                      : html`<div class="empty-hint">${t('settings.noUploads')}</div>`}
                  </div>
                </div>
              </div>

              <div class="settings-section" id="channel-customization-settings">
                <h3 class="settings-section-title">${t('settings.channels')}</h3>
                ${this.channelHealthPanel()}
                <div class="settings-item settings-item--action">
                  <div class="settings-item-title">${t('settings.editChannelList')}</div>
                  <button class="btn btn-secondary" data-focusable id="edit-channel-list"
                          aria-label="${t('settings.editChannelList')}">${t('settings.editChannelList')}</button>
                  <div class="settings-item-hint">${t('settings.editChannelListHint')}</div>
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.showHidden')}</div>
                  ${toggleGroup('show-hidden', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], showHidden ? 'on' : 'off')}
                  <div class="settings-item-hint">${t('settings.showHiddenHint')}</div>
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.hideArabic')}</div>
                  ${toggleGroup('hide-arabic', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], hideArabic ? 'on' : 'off')}
                  <div class="settings-item-hint">${t('settings.hideArabicHint')}</div>
                </div>
                <div class="settings-item settings-item--action">
                  <div class="settings-item-title">${t('settings.resetCustomization')}</div>
                  <button class="btn btn-danger" data-focusable id="reset-customization"
                          aria-label="${t('settings.resetCustomization')}">${t('settings.resetCustomization')}</button>
                  <div class="settings-item-hint">${t('settings.resetCustomizationHint')}</div>
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-guide" data-settings-category="guide">
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.epg')}</h3>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.manualEpgSources')}</div>
                  <div class="manual-epg-sources">
                    ${manualEpgSources.length
                      ? manualEpgSources.map((source, index) =>
                        manualEpgSourceRow(
                          source,
                          allPlaylists,
                          index,
                          manualEpgSources.length,
                        ))
                      : html`<div class="empty-hint">${t('settings.noEpgSources')}</div>`}
                  </div>
                  <button class="btn btn-primary" data-focusable id="add-epg-source">
                    <span class="btn-add-icon" aria-hidden="true">+</span>${t('settings.addEpgSource')}
                  </button>
                  <div class="settings-item-hint">${t('settings.xmltvUrlsHint')}</div>
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.timeZone')}</div>
                  ${toggleGroup('tz-mode', [{ value: 'device', label: t('settings.device') }, { value: 'feed', label: t('settings.feed') }], feedTime ? 'feed' : 'device')}
                  <div class="settings-item-hint">
                    ${tzOffset === null
                      ? t('settings.timeZoneUnknown')
                      : t('settings.timeZoneKnown', { offset: formatOffset(tzOffset) })}
                  </div>
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.timeCorrection')}</div>
                  <div class="epg-offset-editor">
                    ${this.epgOffsetEditor(epgSources, allPlaylists, epgSources[0]?.url)}
                  </div>
                  <div class="settings-item-hint">${t('settings.timeCorrectionHint')}</div>
                </div>
                <div class="settings-item settings-item--action">
                  <div class="settings-item-title">${t('reminderManager.title')}</div>
                  <button class="btn btn-secondary" data-focusable id="manage-reminders">
                    ${t('settings.manageReminders', {
                      count: ReminderService.listManageable().length,
                    })}
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-appearance" data-settings-category="appearance">
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.appearance')}</h3>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.theme')}</div>
                  <div class="theme-swatch-grid">
                    ${THEMES.map(t => themeSwatch(t, theme))}
                  </div>
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.overlayGlass')}</div>
                  ${toggleGroup('overlay-style', overlayStyles, overlayStyle)}
                  <div class="settings-item-hint">${t('settings.overlayHint')}</div>
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.textSize')}</div>
                  ${dropdown('text-size', textSizes, textSize)}
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-playback" data-settings-category="playback">
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.playback')}</h3>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.autoPlay')}</div>
                  ${toggleGroup('auto-play', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], autoPlay ? 'on' : 'off')}
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.livePreview')}</div>
                  ${toggleGroup('live-preview-setting', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], livePreview ? 'on' : 'off')}
                  <div class="settings-item-hint">${t('settings.livePreviewHint')}</div>
                </div>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.channelCycleMode')}</div>
                  ${toggleGroup('channel-cycle-mode', [
                    { value: 'global', label: t('settings.channelCycleGlobal') },
                    { value: 'active', label: t('settings.channelCycleActive') },
                  ], channelCycleMode)}
                  <div class="settings-item-hint">${t('settings.channelCycleModeHint')}</div>
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-subtitles" data-settings-category="subtitles">
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.onlineSubtitles')}</h3>
                <div class="settings-item">
                  <div class="settings-item-title">${t('settings.preferredSubtitle')}</div>
                  ${dropdown('os-pref-lang', subtitleLanguages(), os.preferredLanguage)}
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
                    <div class="settings-item-hint">${t('settings.assrtDescription')}</div>
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
            </div>

            <div class="settings-category" id="settings-advanced"
                 data-settings-category="advanced">
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.advanced')}</h3>
                <div class="settings-advanced-matrix">
                  <div class="settings-advanced-row">
                    <div class="settings-advanced-group">
                      ${t('settings.advancedGroupInterface')}
                    </div>
                    <div class="settings-advanced-description">
                      <div class="settings-item-title">${t('settings.animationMode')}</div>
                      <div class="settings-item-hint">${t('settings.animationHint')}</div>
                    </div>
                    <div class="settings-advanced-control">
                    ${toggleGroup(
                      'animation-mode',
                      animationModeOptions(),
                      animationMode,
                    )}
                    </div>
                  </div>
                  <div class="settings-advanced-row">
                    <div class="settings-advanced-group">
                      ${t('settings.advancedGroupPlayback')}
                    </div>
                    <div class="settings-advanced-description">
                      <div class="settings-item-title">${t('settings.liveReconnectAttempts')}</div>
                      <div class="settings-item-hint">${t('settings.liveReconnectHint')}</div>
                    </div>
                    <div class="settings-advanced-control">
                    ${dropdown(
                      'live-reconnect-attempts',
                      LIVE_RECONNECT_ATTEMPT_OPTIONS.map(value => ({
                        value: String(value), label: String(value),
                      })),
                      String(liveReconnectAttempts),
                    )}
                    </div>
                  </div>
                  <div class="settings-advanced-row">
                    <div class="settings-advanced-group">
                      ${t('settings.advancedGroupOnScreenDisplay')}
                    </div>
                    <div class="settings-advanced-description">
                      <div class="settings-item-title">${t('settings.numberEntryOsdTimeout')}</div>
                      <div class="settings-item-hint">${t('settings.numberEntryOsdTimeoutHint')}</div>
                    </div>
                    <div class="settings-advanced-control">
                    ${dropdown(
                      'number-entry-osd-timeout',
                      timeoutOptions(NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS),
                      String(numberEntryOsdTimeoutMs),
                    )}
                    </div>
                  </div>
                  <div class="settings-advanced-row">
                    <div class="settings-advanced-group" aria-hidden="true"></div>
                    <div class="settings-advanced-description">
                      <div class="settings-item-title">${t('settings.playerOsdTimeout')}</div>
                      <div class="settings-item-hint">${t('settings.playerOsdTimeoutHint')}</div>
                    </div>
                    <div class="settings-advanced-control">
                    ${dropdown(
                      'player-osd-timeout',
                      timeoutOptions(PLAYER_OSD_TIMEOUT_MS_OPTIONS),
                      String(playerOsdTimeoutMs),
                    )}
                    </div>
                  </div>
                  <div class="settings-advanced-row">
                    <div class="settings-advanced-group">
                      ${t('settings.advancedGroupBackgroundRefresh')}
                    </div>
                    <div class="settings-advanced-description">
                      <div class="settings-item-title">${t('settings.playlistRefreshInterval')}</div>
                      <div class="settings-item-hint">${t('settings.playlistRefreshHint', {
                        action: t('settings.refreshAll'),
                      })}</div>
                    </div>
                    <div class="settings-advanced-control">
                    ${dropdown(
                      'playlist-refresh-interval',
                      refreshIntervalOptions(),
                      String(playlistRefreshHours),
                    )}
                    </div>
                  </div>
                  <div class="settings-advanced-row">
                    <div class="settings-advanced-group" aria-hidden="true"></div>
                    <div class="settings-advanced-description">
                      <div class="settings-item-title">${t('settings.epgRefreshInterval')}</div>
                      <div class="settings-item-hint">${t('settings.epgRefreshHint', {
                        action: t('settings.refreshAll'),
                      })}</div>
                    </div>
                    <div class="settings-advanced-control">
                    ${dropdown(
                      'epg-refresh-interval',
                      refreshIntervalOptions(),
                      String(epgRefreshHours),
                    )}
                    </div>
                  </div>
                  ${enabledAccounts.length ? html`
                    <div class="settings-advanced-row">
                      <div class="settings-advanced-group" aria-hidden="true"></div>
                      <div class="settings-advanced-description">
                        <div class="settings-item-title">${t('settings.xtreamCatalogRefreshInterval')}</div>
                        <div class="settings-item-hint">${t('settings.xtreamCatalogRefreshHint', {
                          action: t('settings.refreshAll'),
                        })}</div>
                      </div>
                      <div class="settings-advanced-control">
                      ${dropdown(
                        'xtream-catalog-refresh-interval',
                        xtreamCatalogRefreshIntervalOptions(),
                        String(xtreamCatalogRefreshHours),
                      )}
                      </div>
                    </div>
                  ` : ''}
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-data" data-settings-category="data">
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.dataManagement')}</h3>
                <div class="settings-item settings-item--action">
                  <div class="settings-item-title">${t('channel.recentlyWatched')}</div>
                  <button class="btn btn-danger" data-focusable id="clear-recently-watched"
                          aria-label="${t('settings.clearRecentlyWatched')}">${t('settings.clearRecentlyWatched')}</button>
                  <div class="settings-item-hint">
                    ${t('settings.clearRecentDescription')}
                  </div>
                </div>
                ${this.watchlistAccount ? html`
                  <div class="settings-item settings-item--action">
                    <div class="settings-item-title">${t('catalog.continueWatching')}</div>
                    <button class="btn btn-danger" data-focusable id="clear-continue-watching"
                            aria-label="${t('settings.clearContinueWatching')}">${t('settings.clearContinueWatching')}</button>
                    <div class="settings-item-hint" id="continue-watching-count-hint" aria-live="polite">
                      ${this.collectionDescription('continue')}
                    </div>
                  </div>
                  <div class="settings-item settings-item--action">
                    <div class="settings-item-title">${t('common.watchlist')}</div>
                    <button class="btn btn-danger" data-focusable id="clear-watchlist"
                            aria-label="${t('settings.clearWatchlist')}">${t('settings.clearWatchlist')}</button>
                    <div class="settings-item-hint" id="watchlist-count-hint" aria-live="polite">
                      ${this.collectionDescription('watchlist')}
                    </div>
                  </div>
                ` : ''}
                <div class="cache-usage" id="cache-usage" aria-live="polite">
                  <div class="cache-usage-loading">${t('common.loading')}</div>
                </div>
                <div class="settings-maintenance">
                  <button class="btn btn-secondary" data-focusable id="refresh-data">${t('settings.refreshAll')}</button>
                  <button class="btn btn-danger" data-focusable id="clear-cache">${t('settings.clearCache')}</button>
                </div>
                <div class="settings-item settings-item--action settings-reset">
                  <div class="settings-item-title">${t('settings.resetApp')}</div>
                  <button class="btn btn-danger" data-focusable id="reset-app"
                          aria-label="${t('settings.resetApp')}">${t('settings.resetApp')}</button>
                  <div class="settings-item-hint">${t('settings.resetAppDescription')}</div>
                </div>
              </div>
            </div>

            <div class="settings-about">
              ${CONFIG.APP_NAME} v${CONFIG.VERSION}
            </div>
          </div>

          <div class="settings-actions" data-nav-container>
            <button class="btn btn-secondary btn-large" data-focusable id="cancel-settings">${t('common.cancel')}</button>
            <button class="btn btn-primary btn-large" data-focusable id="save-settings">${t('settings.saveApply')}</button>
          </div>
        </div>
      </div>
    `);

    this.enter();
    void this.refreshSetupInfo();
    // Sync uploads from the local service on every Settings open. Subsequent
    // updates arrive via the Luna `serviceEvents` push channel (wired in
    // app.ts → subscribeToServiceEvents) and call refreshUploads() directly.
    void this.refreshUploads();
    void this.loadCacheUsage();
  }

  private epgSources(manualSources: ManualEpgSource[], playlists: PlaylistEntry[]): EpgSource[] {
    const enabledIds = new Set(playlists.filter(isSourceEnabled).map(source => source.id));
    const discovered = PlaylistService.epgSources
      .map(source => ({
        ...source,
        playlistIds: source.playlistIds.filter(id => enabledIds.has(id)),
      }))
      .filter(source => source.playlistIds.length > 0);
    const sources: EpgSource[] = manualSources.map(source => ({
      ...source,
      kind: 'manual',
    }));
    for (const source of discovered) {
      const existing = sources.find(candidate => candidate.url === source.url);
      if (!existing) {
        sources.push(source);
      } else if (existing.playlistIds.length) {
        for (const id of source.playlistIds) {
          if (!existing.playlistIds.includes(id)) existing.playlistIds.push(id);
        }
      }
    }
    return sources;
  }

  private epgSourceOptions(
    sources: EpgSource[],
    playlists: PlaylistEntry[],
  ): { value: string; label: string }[] {
    const names = new Map(playlists.map(source => [source.id, source.name || source.url]));
    const fallbackLabels = sources.map(source => {
      const labels = source.playlistIds
        .map(id => names.get(id))
        .filter((name): name is string => Boolean(name));
      return source.kind === 'manual'
        ? t('settings.manualXmltv')
        : labels.join(', ') || t('settings.discoveredEpg');
    });
    const sourceNames = sources.map(source => EpgService.getSourceName(source.url));
    const baseLabels = sources.map((_source, index) =>
      sourceNames[index] || fallbackLabels[index]);
    return sources.map((source, index) => {
      const base = baseLabels[index];
      const duplicateIndexes = baseLabels
        .map((label, candidate) => label === base ? candidate : -1)
        .filter(candidate => candidate >= 0);
      if (duplicateIndexes.length === 1) return { value: source.url, label: base };
      const qualified = sourceNames[index] ? `${base} — ${fallbackLabels[index]}` : base;
      const qualifiedLabels = duplicateIndexes.map(candidate =>
        sourceNames[candidate]
          ? `${baseLabels[candidate]} — ${fallbackLabels[candidate]}`
          : baseLabels[candidate]);
      const duplicateIndex = duplicateIndexes.indexOf(index) + 1;
      return {
        value: source.url,
        label: qualifiedLabels.filter(label => label === qualified).length === 1
          ? qualified
          : `${qualified} — EPG ${duplicateIndex}`,
      };
    });
  }

  private epgOffsetEditor(
    sources: EpgSource[],
    playlists: PlaylistEntry[],
    selectedUrl?: string,
  ): Safe {
    const selected = sources.some(source => source.url === selectedUrl)
      ? selectedUrl as string
      : sources[0]?.url;
    const offset = selected ? this.epgOffsets[selected] ?? 0 : 0;
    return html`
      <div class="epg-offset-controls">
        ${selected
          ? dropdown('epg-offset-source', this.epgSourceOptions(sources, playlists), selected)
          : disabledDropdown('epg-offset-source', t('settings.manualXmltv'))}
        <div class="epg-offset-stepper ${selected ? '' : 'epg-offset-unavailable'}">
          ${selected
            ? html`
              <button class="btn btn-secondary epg-offset-step" data-focusable
                      data-offset-delta="-${CONFIG.EPG.OFFSET_STEP_MINUTES}"
                      aria-label="${t('settings.offsetEarlier')}">-</button>
              <button class="btn btn-secondary epg-offset-value" data-focusable
                      aria-label="${t('settings.offsetReset')}">
                ${formatEpgOffset(offset)}
              </button>
              <button class="btn btn-secondary epg-offset-step" data-focusable
                      data-offset-delta="${CONFIG.EPG.OFFSET_STEP_MINUTES}"
                      aria-label="${t('settings.offsetLater')}">+</button>
            `
            : html`
              <button class="btn btn-secondary epg-offset-step" disabled>-</button>
              <button class="btn btn-secondary epg-offset-value" disabled>
                ${formatEpgOffset(0)}
              </button>
              <button class="btn btn-secondary epg-offset-step" disabled>+</button>
            `}
        </div>
      </div>
      <div class="settings-item-hint epg-offset-preview">
        ${correctionPreview(offset)}
      </div>`;
  }

  private refreshEpgOffsetEditor(
    manualSources: ManualEpgSource[],
    selectedUrl?: string,
  ): void {
    const editor = $('.epg-offset-editor', this.container);
    if (!editor) return;
    const playlists = StorageService.getPlaylists();
    const sources = this.epgSources(manualSources, playlists);
    morph(editor, this.epgOffsetEditor(sources, playlists, selectedUrl));
  }

  private adjustEpgOffset(delta: number): void {
    if (!Number.isFinite(delta)) return;
    const source = $('#epg-offset-source', this.container)?.dataset.value;
    if (!source) return;
    this.setEpgOffset((this.epgOffsets[source] ?? 0) + delta);
  }

  private setEpgOffset(value: number): void {
    const source = $('#epg-offset-source', this.container)?.dataset.value;
    if (!source) return;
    const bounded = Math.max(
      -CONFIG.EPG.OFFSET_MAX_MINUTES,
      Math.min(CONFIG.EPG.OFFSET_MAX_MINUTES, value),
    );
    if (bounded === 0) delete this.epgOffsets[source];
    else this.epgOffsets[source] = bounded;
    this.updateEpgOffsetControl();
  }

  private updateEpgOffsetControl(): void {
    const source = $('#epg-offset-source', this.container)?.dataset.value;
    if (!source) return;
    const offset = this.epgOffsets[source] ?? 0;
    const value = $('.epg-offset-value', this.container);
    if (value) value.textContent = formatEpgOffset(offset);
    const preview = $('.epg-offset-preview', this.container);
    if (preview) morph(preview, correctionPreview(offset));
  }

  // An open dropdown menu is absolutely positioned over the settings pane, so an
  // untrapped move scores items behind it. The restriction is released straight
  // after: the pane is re-morphed on every render, so a held element goes stale.
  // Up walks the category column on its own, so Up from the first
  // category leaves for the tab bar rather than the pane beside it.
  private moveFocus(action: NavDirection): boolean {
    const open = this.container.querySelector<HTMLElement>('.dropdown.open');
    const column = action === 'up'
      && this.nav.focused?.classList.contains('settings-nav-item')
      ? this.container.querySelector<HTMLElement>('.settings-sidebar') : null;
    this.nav.setRestrict(open?.querySelector<HTMLElement>('.dropdown-menu') ?? column);
    this.via = 'key';
    const moved = this.nav.move(action);
    this.nav.setRestrict(null);
    return moved || !!open;
  }

  private restoreOpenDropdownFocus(open: HTMLElement): void {
    const option = open.querySelector<HTMLElement>('.dropdown-option.active')
      ?? open.querySelector<HTMLElement>('.dropdown-option');
    if (option) this.nav.focus(option);
  }

  // False when Up or Down found nothing to move to, so the host can hand Up
  // to the tab bar.
  handleAction(action: Action): boolean {
    if (this.confirmationPrompt.visible) {
      this.confirmationPrompt.handleAction(action);
      return true;
    }
    this.via = 'key';
    this.syncNav();
    // After the pointer left, the first key only shows where focus is, so
    // nothing acts on a control nobody could see.
    if (this.concealed && (isFocusMove(action) || action === 'select')) {
      const shown = this.resolveFocused();
      if (shown) {
        this.pick(shown, 'key');
        return true;
      }
    }

    switch (action) {
      case 'up':
      case 'down':
        return this.moveFocus(action);

      case 'right':
        if (this.nav.focused?.classList.contains('settings-nav-item')) {
          this.focusCategoryFirst(this.nav.focused.dataset.settingsTarget as SettingsCategory);
          break;
        }
        this.moveFocus(action);
        break;

      case 'left':
        if (this.nav.focused?.classList.contains('settings-nav-item')) {
          this.nav.move(action);
          break;
        }
        {
          const openDropdown = this.container.querySelector<HTMLElement>('.dropdown.open');
          if (openDropdown) this.closeDropdown(openDropdown);
          const peer = this.leftPeer(this.nav.focused);
          if (peer) this.nav.focus(peer);
          else this.focusActiveCategory();
        }
        break;

      case 'select': {
        const focused = this.nav.focused;
        if (!focused) break;
        const openDropdown = this.container.querySelector<HTMLElement>('.dropdown.open');
        if (openDropdown && !openDropdown.contains(focused)) {
          this.restoreOpenDropdownFocus(openDropdown);
          break;
        }
        this.activate(focused);
        break;
      }
    }
    return true;
  }

  focusReminderEntry(): void {
    const entry = $('#manage-reminders', this.container);
    if (!entry) return;
    entry.textContent = t('settings.manageReminders', {
      count: ReminderService.listManageable().length,
    });
    this.nav.focus(entry);
  }

  private activate(el: HTMLElement): void {
    if (el.classList.contains('settings-nav-item')) {
      this.scrollToCategory(el.dataset.settingsTarget as SettingsCategory);
    } else if (el.id === 'add-playlist') {
      this.addPlaylistEntry();
    } else if (el.classList.contains('remove-playlist')) {
      this.authorizeSourceRemoval(this.sourceId(el), () => this.removePlaylistEntry(el));
    } else if (el.id === 'add-epg-source') {
      this.addManualEpgSource();
    } else if (el.classList.contains('remove-epg-source')) {
      this.removeManualEpgSource(el);
    } else if (el.classList.contains('move-epg-earlier')) {
      this.moveManualEpgSource(el, -1);
    } else if (el.classList.contains('move-epg-later')) {
      this.moveManualEpgSource(el, 1);
    } else if (el.classList.contains('epg-scope-option')) {
      this.toggleManualEpgScope(el);
    } else if (el.id === 'add-xtream') {
      this.addXtreamEntry();
    } else if (el.classList.contains('remove-xtream')) {
      this.authorizeSourceRemoval(this.sourceId(el), () => this.removeXtreamEntry(el));
    } else if (el.classList.contains('check-xtream')) {
      void this.checkXtreamAccount(el);
    } else if (el.classList.contains('xtream-live-categories')) {
      this.openLiveCategories(el);
    } else if (el.classList.contains('source-toggle')) {
      if (el.dataset.enabled === 'true') {
        this.authorizeSourceRemoval(this.sourceId(el), () => this.toggleSource(el), true);
      } else {
        this.toggleSource(el);
      }
    } else if (el.classList.contains('remove-upload')) {
      this.authorizeSourceRemoval(this.sourceId(el), () => void this.removeUpload(el.dataset.url!));
    } else if (el.hasAttribute('data-dropdown-trigger')) {
      this.toggleDropdown(el.closest<HTMLElement>('.dropdown'));
    } else if (el.classList.contains('dropdown-option')) {
      this.selectDropdownOption(el);
    } else if (el.classList.contains('toggle-option')) {
      // Single-select toggle group: clear the siblings, activate the chosen option.
      el.parentElement?.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    } else if (el.classList.contains('epg-offset-step')) {
      this.adjustEpgOffset(Number(el.dataset.offsetDelta));
    } else if (el.classList.contains('epg-offset-value')) {
      this.setEpgOffset(0);
    } else if (el.classList.contains('theme-swatch')) {
      this.selectThemeSwatch(el);
    } else if (el.id === 'save-settings') {
      this.save();
    } else if (el.id === 'cancel-settings') {
      this.onSave('cancel');
    } else if (el.id === 'refresh-data') {
      this.onSave('reload');
    } else if (el.id === 'clear-cache') {
      this.confirmationPrompt.show({
        title: t('settings.clearCacheTitle'),
        message: t('settings.clearCacheMessage'),
        confirmLabel: t('common.clear'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => { void this.clearCache(); },
        onCancel: () => {},
      });
    } else if (el.id === 'reset-app') {
      this.confirmationPrompt.show({
        title: t('settings.resetAppTitle'),
        message: t('settings.resetAppMessage'),
        confirmLabel: t('common.reset'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => { void this.resetApp(); },
        onCancel: () => {},
      });
    } else if (el.id === 'edit-channel-list') {
      this.saveShowHidden();
      this.onSave('edit-channels');
    } else if (el.id === 'check-channel-health') {
      if (!this.healthController) {
        const check = this.startChannelHealthCheck();
        this.healthCheckPromise = check;
        const clearHealthCheckPromise = () => {
          if (this.healthCheckPromise === check) this.healthCheckPromise = null;
        };
        void check.then(clearHealthCheckPromise, clearHealthCheckPromise);
      }
    } else if (el.id === 'pause-channel-health') {
      this.toggleChannelHealthPause();
    } else if (el.id === 'cancel-channel-health') {
      this.cancelChannelHealthCheck();
    } else if (el.id === 'manage-reminders') {
      this.onManageReminders();
    } else if (el.id === 'manage-parental-controls') {
      this.onManageParentalControls();
    } else if (el.id === 'reset-customization') {
      this.authorizeLiveEditing(t('settings.resetCustomization'), () => this.confirmResetCustomization());
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
    } else if (el.id === 'clear-continue-watching' && this.watchlistAccount) {
      const account = this.watchlistAccount;
      this.confirmationPrompt.show({
        title: t('catalog.clearContinueWatchingTitle'),
        message: t('settings.clearContinueWatchingMessage', { account: account.name }),
        confirmLabel: t('common.clearAll'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => {
          StorageService.clearResumeList(account.id);
          this.refreshCollectionCounts();
          showToast(t('settings.continueWatchingCleared', { account: account.name }));
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
          this.refreshCollectionCounts();
          showToast(t('settings.watchlistCleared', { account: account.name }));
        },
        onCancel: () => {},
      });
    } else if (el.tagName === 'INPUT') {
      (el as HTMLInputElement).focus();
    }
  }

  private channelHealthPanel(): Safe {
    const channels = PlaylistService.allChannels;
    const summary = ChannelHealthService.getSummary(channels);
    return html`
      <div class="settings-item settings-item--action channel-health-panel">
        <div class="settings-item-title">${t('settings.channelHealth')}</div>
        ${this.healthController
          ? html`
            <div class="channel-health-actions">
              <button class="btn btn-secondary" data-key="pause-channel-health"
                      data-focusable id="pause-channel-health">
                ${this.healthPaused
                  ? t('common.continue')
                  : t('common.pause')}
              </button>
              <button class="btn btn-danger" data-key="cancel-channel-health"
                      data-focusable id="cancel-channel-health">${t('common.cancel')}</button>
            </div>
          `
          : html`
            <button class="btn btn-secondary" data-key="check-channel-health"
                    data-focusable id="check-channel-health">
              ${t('settings.checkChannelHealth')}
            </button>
          `}
        ${this.healthProgress ? html`
          <div class="channel-health-progress" aria-live="polite">
            <div class="channel-health-progress-track">
              <div class="channel-health-progress-fill"
                   style="width:${this.healthProgress.total
                     ? Math.round(this.healthProgress.completed / this.healthProgress.total * 100)
                     : 0}%"></div>
            </div>
            <span>${t('settings.channelHealthProgress', {
              completed: this.healthProgress.completed,
              total: this.healthProgress.total,
            })}</span>
          </div>
        ` : ''}
        <div class="channel-health-summary">
          <span class="channel-health-status healthy">${t('channel.healthHealthy')}: ${summary.healthy}</span>
          <span class="channel-health-status suspect">${t('channel.healthSuspect')}: ${summary.suspect}</span>
          <span class="channel-health-status unavailable">${t('channel.healthUnavailable')}: ${summary.unavailable}</span>
          <span>${t('settings.channelHealthUnknown')}: ${summary.unknown}</span>
        </div>
        <div class="settings-item-hint">${t('settings.channelHealthHint')}</div>
      </div>
    `;
  }

  private updateChannelHealthPanel(): void {
    const panel = $('.channel-health-panel', this.container);
    if (panel) morph(panel, this.channelHealthPanel());
  }

  private toggleChannelHealthPause(): void {
    if (!this.healthController) return;
    this.healthPaused = !this.healthPaused;
    if (!this.healthPaused) {
      this.healthResume?.();
      this.healthResume = null;
    }
    this.updateChannelHealthPanel();
  }

  private cancelChannelHealthCheck(): void {
    this.healthController?.abort();
    this.healthPaused = false;
    this.healthResume?.();
    this.healthResume = null;
  }

  private waitWhileChannelHealthPaused(): Promise<void> {
    if (!this.healthPaused) return Promise.resolve();
    return new Promise(resolve => {
      this.healthResume = resolve;
    });
  }

  private async startChannelHealthCheck(): Promise<void> {
    const channels = PlaylistService.allChannels;
    if (!channels.length) {
      showToast(t('settings.channelHealthEmpty'));
      return;
    }
    const controller = new AbortController();
    this.healthController = controller;
    this.healthPaused = false;
    this.healthProgress = {
      ...ChannelHealthService.getSummary(channels),
      completed: 0,
    };
    this.updateChannelHealthPanel();
    try {
      await ChannelHealthService.checkAll(channels, {
        signal: controller.signal,
        waitWhilePaused: () => this.waitWhileChannelHealthPaused(),
        onProgress: progress => {
          if (this.healthController !== controller) return;
          this.healthProgress = progress;
          this.updateChannelHealthPanel();
        },
      });
      if (!controller.signal.aborted) showToast(t('settings.channelHealthComplete'));
    } catch (err) {
      log.error(
        'Channel health check failed',
        'event=channel.health.check.failed',
        err,
      );
      showToast(t('settings.channelHealthFailed'));
    } finally {
      if (this.healthController === controller) {
        this.healthController = null;
        this.healthPaused = false;
        this.healthResume = null;
        this.healthProgress = null;
        this.updateChannelHealthPanel();
        this.onChannelsChanged();
      }
    }
  }

  private async resetApp(): Promise<void> {
    try {
      await this.onSave('reset');
    } catch (err) {
      log.error(
        'App reset failed',
        'event=persistence.reset.failed',
        'operation=clear',
        err,
      );
      showToast(t('settings.resetFailed'));
    }
  }

  private async loadCacheUsage(): Promise<void> {
    try {
      const usage = await getCacheUsage();
      this.renderCacheUsage(usage);
    } catch (err) {
      log.warn(
        'Cache usage read failed',
        'event=persistence.cache.accounting.read.failed',
        'operation=read',
        'surface=settings',
        err,
      );
      const target = $('#cache-usage', this.container);
      if (target) morph(target, html`<div class="cache-usage-loading">-</div>`);
    }
  }

  private renderCacheUsage(usage: CacheUsageSummary): void {
    const target = $('#cache-usage', this.container);
    if (!target) return;
    const usedPercent = usage.budgetBytes > 0
      ? Math.max(0, Math.min(100, usage.total.bytes / usage.budgetBytes * 100))
      : 0;
    const used = formatBytes(usage.total.bytes);
    const budget = formatBytes(usage.budgetBytes);
    morph(target, html`
      <div class="cache-usage-total" role="img" aria-label="${used} / ${budget}">
        <svg class="cache-usage-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="cache-usage-ring-track" cx="60" cy="60" r="50"></circle>
          <circle class="cache-usage-ring-used" cx="60" cy="60" r="50"
                  pathLength="100" stroke-dasharray="${usedPercent.toFixed(1)} 100"
                  stroke-dashoffset="0"
                  transform="rotate(-90 60 60)"></circle>
        </svg>
        <div class="cache-usage-value">
          <strong>${used}</strong>
          <span>/ ${budget}</span>
        </div>
      </div>
      <div class="cache-usage-breakdown">
        <span>${t('settings.playlists')} <strong>${formatBytes(usage.categories.playlist.bytes)}</strong></span>
        <span>${t('settings.epg')} <strong>${formatBytes(usage.categories.epg.bytes)}</strong></span>
        <span>${t('settings.moviesSeriesMediaData')} <strong>${formatBytes(usage.categories.catalog.bytes)}</strong></span>
        <span>${t('settings.onlineSubtitles')} <strong>${formatBytes(usage.categories.subtitle.bytes)}</strong></span>
        <span>${t('settings.channelHealth')} <strong>${formatBytes(usage.categories.health.bytes)}</strong></span>
        <span>${t('settings.searchIndex')} <strong>${formatBytes(usage.categories.search.bytes)}</strong></span>
      </div>
    `);
  }

  private async clearCache(): Promise<void> {
    try {
      const activeCheck = this.healthCheckPromise;
      if (activeCheck) {
        this.cancelChannelHealthCheck();
        await activeCheck;
      }
      await clearAllCachedData();
      ChannelHealthService.reset();
      this.updateChannelHealthPanel();
      this.onChannelsChanged();
      await this.loadCacheUsage();
      showToast(t('settings.cacheCleared'));
    } catch (err) {
      log.error(
        'Cache clear failed',
        'event=persistence.cache.clear.failed',
        'operation=clear',
        'scope=all',
        'surface=settings',
        err,
      );
      showToast(t('settings.cacheClearFailed'));
    }
  }

  // Applied on its own (not only on Save) so leaving through "Edit channel list"
  // still honors the toggle.
  private saveShowHidden(): void {
    const btn = $('#show-hidden .toggle-option.active', this.container);
    if (!btn) return;
    const show = btn.dataset.value === 'on';
    if (show === StorageService.getShowHiddenChannels()) return;
    StorageService.setShowHiddenChannels(show);
    PlaylistService.applyCustomization();
    this.onChannelsChanged();
  }

  get isPromptVisible(): boolean {
    return this.confirmationPrompt.visible || this.liveCategoryPicker.visible;
  }

  dismissPrompt(): void {
    this.confirmationPrompt.hide();
    this.liveCategoryPicker.hide();
  }

  // Live theme preview: focusing (D-pad) or hovering (pointer) a swatch previews
  // that theme app-wide; anything else falls back to the currently selected theme.
  private confirmResetCustomization(): void {
    this.confirmationPrompt.show({
      title: t('settings.resetCustomizationTitle'),
      message: t('settings.resetCustomizationMessage'),
      confirmLabel: t('common.reset'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        ChannelCustomizationService.reset();
        PlaylistService.applyCustomization();
        this.onChannelsChanged();
        showToast(t('settings.customizationReset'));
      },
      onCancel: () => {},
    });
  }

  // The pointer leaving a swatch for another hovers the next one in the same
  // task; restoring the selected theme in between would restyle the whole
  // document twice per move, so the restore waits until that hover is done.
  private restoreThemeAfterHover(): void {
    const token = ++this.themeHoverToken;
    void Promise.resolve().then(() => {
      if (token === this.themeHoverToken) previewTheme(this.selectedTheme);
    });
  }

  private onNavFocus(el: HTMLElement | null): void {
    this.themeHoverToken++;
    if (el?.dataset.themeId) previewTheme(el.dataset.themeId);
    else previewTheme(this.selectedTheme);
    if (!el) return;
    const key = this.keyOf(el);
    if (key !== this.landedKey) this.landedKey = null;
    // Only the owner of the keys shows or reveals a key's focus; otherwise
    // the pick is noted for when the keys come back. The pointer's pick
    // lights where it rests either way.
    const owner = Focus.owner() === this.focusScope;
    if (!owner && this.via !== 'pointer') {
      this.focusScope.track(key);
      return;
    }
    this.concealed = false;
    this.focusScope.focus(key, this.via);
    this.markRow(el);
    if (!owner) return;
    Focus.flush();
    // A key moving focus on while the pane settles takes the category along;
    // the pointer takes the pane over, so its scroll position picks it.
    if (this.categoryAimed && key !== this.landedKey) {
      if (this.via === 'key' && el.closest('.settings-category')) this.markCategoryOf(el);
      else this.endCategoryHold();
    }
  }

  private pick(el: HTMLElement, via: Via): void {
    this.via = via;
    this.nav.focus(el);
    this.via = 'key';
  }

  // Opening Settings returns to the control it was left on, brought into
  // view, or starts at the current category.
  private enter(): void {
    this.notedKey = null;
    this.land();
    if (Focus.owner() === this.focusScope) Focus.flush();
  }

  /** Back onto Settings from the tab bar: the last control, brought into view. */
  resumeFocus(): void {
    this.land();
    Focus.flush();
  }

  // The remembered control, under the key of what stands in for it now, with
  // the category list showing where it is.
  private land(): void {
    const last = this.focusScope.focusKey;
    const el = (last !== null ? this.resolveKey(last) : null)
      ?? this.resolveKey(this.defaultKey() ?? '');
    this.concealed = false;
    this.nav.focused = el;
    const key = el ? this.keyOf(el) : this.defaultKey();
    this.landedKey = key;
    this.focusScope.focus(key, 'resume');
    this.markRow(el);
    this.markCategoryOf(el);
  }

  // Scrolling the control Settings came back to into view must not let the
  // pane's scroll position pick another category.
  private revealLanded(key: string): false {
    if (key !== this.landedKey) return false;
    this.landedKey = null;
    this.markCategoryOf(this.resolveKey(key));
    return false;
  }

  // A smooth reveal scroll runs over many frames, so the category stays put
  // until the pane holds still.
  private markCategoryOf(el: HTMLElement | null): void {
    const category = el?.closest<HTMLElement>('.settings-category')?.dataset.settingsCategory as
      SettingsCategory | undefined;
    if (!el || !category) return;
    this.setActiveCategory(category);
    const main = el.closest<HTMLElement>('.settings-scroll');
    if (!main) {
      this.holdCategoryScroll();
      return;
    }
    if (this.categorySyncFrame !== null) {
      window.cancelAnimationFrame(this.categorySyncFrame);
      this.categorySyncFrame = null;
    }
    if (this.categoryScrollFrame !== null) window.cancelAnimationFrame(this.categoryScrollFrame);
    this.ignoreCategoryScroll = true;
    this.watchCategoryScroll(main, category, null);
    this.categoryAimed = true;
  }

  // The user took the pane over: the scroll position picks the category again.
  private endCategoryHold(): void {
    if (this.categoryScrollFrame !== null) {
      window.cancelAnimationFrame(this.categoryScrollFrame);
      this.categoryScrollFrame = null;
    }
    if (this.categoryFocusFrame !== null) {
      window.cancelAnimationFrame(this.categoryFocusFrame);
      this.categoryFocusFrame = null;
    }
    this.ignoreCategoryScroll = false;
    this.categoryAimed = false;
  }

  private syncNav(): void {
    const el = this.resolveFocused();
    if (el) this.nav.focused = el;
  }

  private resolveFocused(): HTMLElement | null {
    const key = this.focusScope.focusKey;
    return key !== null ? this.resolveKey(key) : null;
  }

  private caretInput(): HTMLInputElement | null {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.container.contains(active) ? active : null;
  }

  // An Advanced row is tinted while one of its controls has the focus.
  private markRow(el: HTMLElement | null): void {
    const row = el?.closest('.settings-advanced-row') ?? null;
    if (row === this.currentRow) return;
    this.currentRow?.classList.remove('is-current');
    row?.classList.add('is-current');
    this.currentRow = row;
  }

  private defaultKey(): string | null {
    const item = this.container.querySelector<HTMLElement>('.settings-nav-item.active')
      ?? this.container.querySelector<HTMLElement>('.settings-nav-item');
    return item ? this.keyOf(item) : null;
  }

  // A key names the control by its data-key or id, or else by its place
  // among its kind under the nearest ancestor with an id. Most of Settings
  // is rebuilt on every open, and the key finds the new node.
  private keyOf(el: HTMLElement): string {
    if (el.dataset.key) return `=${el.dataset.key}`;
    if (el.id) return `#${el.id}`;
    const anchor = this.anchorOf(el);
    const kind = this.kindOf(el);
    const peers = this.peersOf(anchor, kind);
    const attr = anchor === this.container ? '' : anchor.id ? `#${anchor.id}` : `@${anchor.dataset.id ?? ''}`;
    return `${attr}|${kind}|${String(peers.indexOf(el))}`;
  }

  private resolveKey(key: string): HTMLElement | null {
    const el = this.findKey(key);
    if (!el || !el.hasAttribute('data-focusable')) return null;
    // An option of a closed menu can't be seen, so its trigger stands in.
    const menu = el.classList.contains('dropdown-option') ? el.closest('.dropdown') : null;
    if (menu && !menu.classList.contains('open')) {
      return menu.querySelector<HTMLElement>('.dropdown-trigger[data-focusable]');
    }
    return el;
  }

  private findKey(key: string): HTMLElement | null {
    if (key.charAt(0) === '=') {
      const value = key.slice(1);
      return Array.from(this.container.querySelectorAll<HTMLElement>('[data-key]'))
        .find(el => el.dataset.key === value) ?? null;
    }
    let el: HTMLElement | null = null;
    const last = key.lastIndexOf('|');
    if (key.charAt(0) === '#' && last < 0) {
      el = this.byAttr('id', key.slice(1));
    } else if (last > 0) {
      const kindAt = key.lastIndexOf('|', last - 1);
      if (kindAt < 0) return null;
      const attr = key.slice(0, kindAt);
      const anchor = attr === '' ? this.container
        : attr.charAt(0) === '#' ? this.byAttr('id', attr.slice(1))
          : this.byAttr('data-id', attr.slice(1));
      if (anchor) el = this.peersOf(anchor, key.slice(kindAt + 1, last))[Number(key.slice(last + 1))] ?? null;
    }
    return el;
  }

  private byAttr(name: string, value: string): HTMLElement | null {
    if (!value) return null;
    return this.container.querySelector<HTMLElement>(
      `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`);
  }

  private anchorOf(el: HTMLElement): HTMLElement {
    const anchor = el.parentElement?.closest<HTMLElement>('[id]:not([id=""]), [data-id]:not([data-id=""])');
    return anchor && this.container.contains(anchor) && anchor !== this.container ? anchor : this.container;
  }

  private kindOf(el: HTMLElement): string {
    return `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''}`;
  }

  private peersOf(anchor: HTMLElement, kind: string): HTMLElement[] {
    return Array.from(anchor.querySelectorAll<HTMLElement>('[data-focusable]'))
      .filter(el => !el.id && !el.dataset.key && this.kindOf(el) === kind && this.anchorOf(el) === anchor);
  }

  private setActiveCategory(category: SettingsCategory): void {
    this.container.querySelectorAll('.settings-nav-item').forEach((item) => {
      item.classList.toggle(
        'active',
        (item as HTMLElement).dataset.settingsTarget === category,
      );
    });
  }

  private scrollToCategory(category: SettingsCategory): void {
    const target = this.container.querySelector<HTMLElement>(`#settings-${category}`);
    if (!target) return;
    const main = target.closest<HTMLElement>('.settings-scroll');
    if (!main) return;
    this.setActiveCategory(category);
    this.ignoreCategoryScroll = true;
    this.categoryAimed = false;
    if (this.categoryScrollFrame !== null) {
      window.cancelAnimationFrame(this.categoryScrollFrame);
    }
    const maxScrollTop = Math.max(0, main.scrollHeight - main.clientHeight);
    const targetScrollTop = Math.max(
      0,
      Math.min(
        main.scrollTop + target.getBoundingClientRect().top - main.getBoundingClientRect().top,
        maxScrollTop,
      ),
    );
    // The pane's scroll-behavior decides whether the jump animates.
    main.scrollTop = targetScrollTop;
    this.watchCategoryScroll(main, category, targetScrollTop);
  }

  // Without a target, the scroll may not have started yet, so the pane must
  // hold still longer before the category is settled; a frame cap keeps
  // the scroll-picked category from staying off for good.
  private watchCategoryScroll(
    main: HTMLElement,
    category: SettingsCategory,
    targetScrollTop: number | null,
  ): void {
    let lastScrollTop = main.scrollTop;
    let moving = false;
    let stableFrames = 0;
    let frames = 0;
    const settled = targetScrollTop === null ? CATEGORY_SCROLL_IDLE_FRAMES : CATEGORY_SCROLL_STABLE_FRAMES;
    const watch = () => {
      const current = main.scrollTop;
      const delta = Math.abs(current - lastScrollTop);
      const reachedTarget = targetScrollTop !== null && Math.abs(current - targetScrollTop) <= 1;
      if (delta > 0.5) {
        moving = true;
        stableFrames = 0;
      } else if (moving || targetScrollTop === null) {
        stableFrames++;
      }
      lastScrollTop = current;

      if (reachedTarget || stableFrames >= settled || ++frames >= CATEGORY_SCROLL_MAX_FRAMES) {
        this.ignoreCategoryScroll = false;
        this.categoryScrollFrame = null;
        this.categoryAimed = false;
        if (reachedTarget || targetScrollTop === null) this.setActiveCategory(category);
        else this.syncCategoryFromScroll(main);
        return;
      }
      this.categoryScrollFrame = window.requestAnimationFrame(watch);
    };
    this.categoryScrollFrame = window.requestAnimationFrame(watch);
  }

  private leftPeer(el: HTMLElement | null): HTMLElement | null {
    if (!el) return null;
    const group = el.closest<HTMLElement>(
      '.toggle-group, .theme-swatch-grid, .settings-row, .xtream-fields, .xtream-card-foot, .settings-actions, .epg-offset-controls',
    );
    if (!group) return null;
    const rect = el.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const candidate of group.querySelectorAll<HTMLElement>('[data-focusable]')) {
      if (candidate === el) continue;
      const other = candidate.getBoundingClientRect();
      const overlap = Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
      if (other.left >= rect.left - 5 || overlap <= 5) continue;
      const score = rect.left - other.right
        + Math.abs((rect.top + rect.bottom) - (other.top + other.bottom));
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  private focusActiveCategory(): void {
    const active = this.container.querySelector<HTMLElement>('.settings-nav-item.active')
      ?? this.container.querySelector<HTMLElement>('.settings-nav-item');
    if (active) this.nav.focus(active);
  }

  // Entry takes the pane's first focusable in DOM order, with no geometry to
  // fall back on, so measurement is what keeps focus off an invisible control —
  // a closed menu's options stay focusable.
  private focusCategoryFirst(category: SettingsCategory): void {
    const pane = this.container.querySelector<HTMLElement>(`#settings-${category}`);
    if (!pane) return;
    this.nav.setRestrict(pane);
    const focused = this.nav.focusFirst();
    this.nav.setRestrict(null);
    if (focused) this.markCategoryOf(this.nav.focused);
  }

  // The scroll that brings focus into view must not re-pick the category.
  private holdCategoryScroll(): void {
    if (this.categorySyncFrame !== null) {
      window.cancelAnimationFrame(this.categorySyncFrame);
      this.categorySyncFrame = null;
    }
    if (this.categoryFocusFrame !== null) {
      window.cancelAnimationFrame(this.categoryFocusFrame);
    }
    this.ignoreCategoryScroll = true;
    this.categoryFocusFrame = window.requestAnimationFrame(() => {
      this.categoryFocusFrame = null;
      if (this.categoryScrollFrame === null) this.ignoreCategoryScroll = false;
    });
  }

  private syncCategoryFromScroll(main: HTMLElement): void {
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 2) {
      this.setActiveCategory(SETTINGS_CATEGORIES[SETTINGS_CATEGORIES.length - 1].id);
      return;
    }
    const threshold = main.getBoundingClientRect().top + 48;
    let active: SettingsCategory = 'general';
    for (const category of SETTINGS_CATEGORIES) {
      const section = this.container.querySelector<HTMLElement>(`#settings-${category.id}`);
      if (!section || section.getBoundingClientRect().top > threshold) break;
      active = category.id;
    }
    this.setActiveCategory(active);
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

  // Opening moves focus to the active option, or the first one when the stored
  // value is no longer offered.
  private toggleDropdown(dd: HTMLElement | null): void {
    toggleDropdown(this.container, this.nav, dd);
  }

  private closeDropdown(dd: HTMLElement): void {
    closeDropdown(this.nav, dd);
  }

  dismissDropdown(): boolean {
    const open = this.container.querySelector<HTMLElement>('.dropdown.open');
    if (!open) return false;
    this.closeDropdown(open);
    return true;
  }

  // Commit a dropdown option: record it on the root's data-value, update the
  // trigger label, close the menu, and return focus to the trigger.
  private selectDropdownOption(el: HTMLElement): void {
    const dd = commitDropdownOption(el);
    if (!dd) return;
    // Text size previews live so the choice can be judged at its own scale;
    // showView() reverts it if Settings closes without saving.
    if (dd.id === 'text-size') applyTextSize(dd.dataset.value ?? '');
    if (dd.id === 'epg-offset-source') this.updateEpgOffsetControl();
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
    row.setAttribute('data-source-entry', '');
    row.innerHTML = `
      <div class="settings-field">
        <input type="text" class="settings-input playlist-name"
               aria-label="${t('settings.playlistName')}" placeholder="${t('settings.myPlaylist')}"
               data-focusable value="${t('settings.playlistDefault', { number: nextNum })}">
      </div>
      <div class="settings-field">
        <input type="url" class="settings-input playlist-url"
               aria-label="${t('settings.playlistUrl')}" placeholder="https://...m3u"
               data-focusable value="">
      </div>
      ${String(sourceToggle(true))}
      <button class="btn btn-danger remove-playlist" data-focusable>${t('common.remove')}</button>
    `;
    entries.appendChild(row);
    this.refreshManualEpgScopes();

    const newInput = row.querySelector<HTMLElement>('input');
    if (newInput) {
      this.nav.focus(newInput);
      (newInput as HTMLInputElement).focus();
    }
  }

  private manualEpgSourcesFromEditor(
    allowedPlaylistIds?: ReadonlySet<string>,
  ): ManualEpgSource[] {
    return Array.from(
      this.container.querySelectorAll<HTMLElement>('[data-manual-epg-source]'),
    ).map(row => {
      const source = this.manualEpgSourceFromRow(row);
      return {
        url: source.url.trim(),
        playlistIds: allowedPlaylistIds && source.playlistIds.length
          ? source.playlistIds.filter(id => allowedPlaylistIds.has(id))
          : source.playlistIds,
      };
    })
      .filter(source => source.url !== '');
  }

  private manualEpgSourceFromRow(row: HTMLElement): ManualEpgSource {
    const url = row.querySelector<HTMLInputElement>('.manual-epg-url')?.value ?? '';
    const all = row.querySelector('.epg-scope-option[data-scope-all].active');
    const playlistIds = all
      ? []
      : Array.from(row.querySelectorAll<HTMLElement>(
          '.epg-scope-option[data-playlist-id].active',
        )).map(option => option.dataset.playlistId ?? '').filter(Boolean);
    return { url, playlistIds };
  }

  private applyManualEpgSourceToRow(
    row: HTMLElement,
    source: ManualEpgSource,
  ): void {
    const input = row.querySelector<HTMLInputElement>('.manual-epg-url');
    if (input) input.value = source.url;
    row.querySelector<HTMLElement>('[data-scope-all]')?.classList.toggle(
      'active',
      source.playlistIds.length === 0,
    );
    row.querySelectorAll<HTMLElement>('[data-playlist-id]').forEach(option => {
      option.classList.toggle(
        'active',
        source.playlistIds.includes(option.dataset.playlistId ?? ''),
      );
    });
  }

  private currentEpgOffsetSource(): string | undefined {
    return $('#epg-offset-source', this.container)?.dataset.value;
  }

  private epgScopePlaylistsFromEditor(): EpgScopePlaylist[] {
    const playlists = $$('#playlist-entries [data-source-entry]', this.container)
      .map(row => ({
        id: row.dataset.id ?? '',
        name: row.querySelector<HTMLInputElement>('.playlist-name')?.value.trim() ?? '',
        url: row.querySelector<HTMLInputElement>('.playlist-url')?.value.trim() ?? '',
      }))
      .filter(playlist => playlist.id !== '');
    const accounts = $$('#xtream-entries .xtream-card', this.container)
      .map(card => ({
        id: card.dataset.id ?? '',
        name: card.querySelector<HTMLInputElement>('.xtream-name')?.value.trim() ?? '',
        url: card.querySelector<HTMLInputElement>('.xtream-url')?.value.trim() ?? '',
      }))
      .filter(account => account.id !== '');
    const uploads = StorageService.getPlaylists()
      .filter(playlist => playlist.source === 'upload')
      .map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        url: playlist.url,
      }));
    return [...playlists, ...accounts, ...uploads];
  }

  private refreshManualEpgScopes(): void {
    const playlists = this.epgScopePlaylistsFromEditor();
    const playlistIds = new Set(playlists.map(playlist => playlist.id));
    this.container.querySelectorAll<HTMLElement>('[data-manual-epg-source]')
      .forEach(row => {
        const source = this.manualEpgSourceFromRow(row);
        if (source.playlistIds.length) {
          source.playlistIds = source.playlistIds.filter(id => playlistIds.has(id));
        }
        const options = row.querySelector<HTMLElement>('.manual-epg-scope-options');
        if (options) morph(options, manualEpgScopeOptions(source, playlists, row.dataset.key ?? ''));
      });
  }

  private addManualEpgSource(): void {
    const entries = $('.manual-epg-sources', this.container);
    if (!entries) return;
    entries.querySelector('.empty-hint')?.remove();
    const playlists = this.epgScopePlaylistsFromEditor();
    const index = entries.querySelectorAll('[data-manual-epg-source]').length;
    const wrap = document.createElement('div');
    wrap.innerHTML = String(manualEpgSourceRow(
      { url: '', playlistIds: [] },
      playlists,
      index,
      index + 1,
    ));
    const row = wrap.firstElementChild;
    if (!row) return;
    entries.appendChild(row);
    this.renumberManualEpgSources();
    const input = row.querySelector<HTMLInputElement>('.manual-epg-url');
    if (input) {
      this.nav.focus(input);
      input.focus();
    }
  }

  private removeManualEpgSource(button: HTMLElement): void {
    const entries = $('.manual-epg-sources', this.container);
    button.closest('[data-manual-epg-source]')?.remove();
    if (entries && !entries.querySelector('[data-manual-epg-source]')) {
      const emptyHint = document.createElement('div');
      emptyHint.className = 'empty-hint';
      emptyHint.textContent = t('settings.noEpgSources');
      entries.appendChild(emptyHint);
    }
    this.renumberManualEpgSources();
    this.refreshEpgOffsetEditor(
      this.manualEpgSourcesFromEditor(),
      this.currentEpgOffsetSource(),
    );
    this.nav.focus($('#add-epg-source', this.container));
  }

  private moveManualEpgSource(button: HTMLElement, direction: -1 | 1): void {
    const row = button.closest<HTMLElement>('[data-manual-epg-source]');
    if (!row) return;
    const target = direction < 0
      ? row.previousElementSibling
      : row.nextElementSibling;
    if (!(target instanceof HTMLElement)) return;
    const source = this.manualEpgSourceFromRow(row);
    const targetSource = this.manualEpgSourceFromRow(target);
    this.applyManualEpgSourceToRow(target, source);
    this.applyManualEpgSourceToRow(row, targetSource);
    this.refreshEpgOffsetEditor(
      this.manualEpgSourcesFromEditor(),
      this.currentEpgOffsetSource(),
    );
    this.nav.focus(target.querySelector<HTMLElement>('.manual-epg-url'));
  }

  private renumberManualEpgSources(): void {
    const rows = Array.from(
      this.container.querySelectorAll<HTMLElement>('[data-manual-epg-source]'),
    );
    rows.forEach((row, index) => {
        // Keys follow the row's place, so a row and its buttons never share
        // a key with another row after one is removed.
        const key = manualEpgKey(index);
        const previous = row.dataset.key ?? '';
        row.dataset.key = key;
        row.querySelectorAll<HTMLElement>('[data-key]').forEach(el => {
          const own = el.dataset.key ?? '';
          if (own.startsWith(`${previous}:`)) el.dataset.key = key + own.slice(previous.length);
        });
        const priority = row.querySelector('.manual-epg-priority');
        if (priority) priority.textContent = String(index + 1);
        const earlier = row.querySelector<HTMLButtonElement>('.move-epg-earlier');
        const later = row.querySelector<HTMLButtonElement>('.move-epg-later');
        this.setManualEpgMoveState(earlier, index > 0);
        this.setManualEpgMoveState(later, index < rows.length - 1);
      });
  }

  private setManualEpgMoveState(
    button: HTMLButtonElement | null,
    enabled: boolean,
  ): void {
    if (!button) return;
    button.disabled = !enabled;
    if (enabled) button.setAttribute('data-focusable', '');
    else button.removeAttribute('data-focusable');
  }

  private toggleManualEpgScope(option: HTMLElement): void {
    const row = option.closest<HTMLElement>('[data-manual-epg-source]');
    if (!row) return;
    const all = row.querySelector<HTMLElement>('[data-scope-all]');
    const scoped = Array.from(
      row.querySelectorAll<HTMLElement>('[data-playlist-id]'),
    );
    if (option.hasAttribute('data-scope-all')) {
      all?.classList.add('active');
      scoped.forEach(item => item.classList.remove('active'));
    } else {
      option.classList.toggle('active');
      all?.classList.remove('active');
      if (!scoped.some(item => item.classList.contains('active'))) {
        all?.classList.add('active');
      }
    }
    this.refreshEpgOffsetEditor(
      this.manualEpgSourcesFromEditor(),
      this.currentEpgOffsetSource(),
    );
  }

  private sourceId(el: HTMLElement): string {
    return el.closest<HTMLElement>('[data-source-entry]')?.dataset.id ?? '';
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
    this.refreshManualEpgScopes();
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
    this.refreshManualEpgScopes();

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
    this.refreshManualEpgScopes();
    this.nav.focusFirst();
  }

  private toggleSource(button: HTMLElement): void {
    const enabled = button.dataset.enabled !== 'true';
    button.dataset.enabled = enabled ? 'true' : 'false';
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.classList.toggle('active', enabled);
    const label = button.querySelector('.source-toggle-label');
    if (label) label.textContent = t(enabled ? 'settings.on' : 'settings.off');
    button.closest<HTMLElement>('[data-source-entry]')
      ?.classList.toggle('source-disabled', !enabled);
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
      log.warn(
        'Xtream verify failed — server unreachable or non-JSON',
        'event=xtream.verify.failed',
        'reason=request_failed',
      );
      this.setXtreamStatus(id, html`${t('settings.verifyFailed')}`, 'err');
      return;
    }
    if (!info.auth) {
      log.warn(
        'Xtream verify rejected — credentials not accepted (auth 0)',
        'event=xtream.verify.rejected',
        'reason=credentials',
      );
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

  private cardAccount(card: HTMLElement): { url: string; username: string; password: string; key: string } {
    const url = normalizeXtreamBaseUrl(card.querySelector<HTMLInputElement>('.xtream-url')!.value.trim());
    const username = card.querySelector<HTMLInputElement>('.xtream-username')!.value.trim();
    const password = card.querySelector<HTMLInputElement>('.xtream-password')!.value;
    return { url, username, password, key: `${url}|${username}` };
  }

  private storedAccountMatches(id: string, key: string): PlaylistEntry | undefined {
    return StorageService.getPlaylists().find(pl => pl.id === id && pl.source === 'xtream'
      && `${normalizeXtreamBaseUrl(pl.url)}|${pl.xtream?.username ?? ''}` === key);
  }

  /** The card's filter as it stands: a picker result for the same account,
   *  else the saved one while the server and username are unchanged. */
  private cardLiveCategories(id: string, key: string): XtreamLiveCategoryFilter | undefined {
    const pending = this.pendingLiveCategories.get(id);
    if (pending && pending.account === key) return pending.filter;
    return normalizeLiveCategoryFilter(this.storedAccountMatches(id, key)?.xtream?.liveCategories);
  }

  private openLiveCategories(btn: HTMLElement): void {
    const card = btn.closest<HTMLElement>('.xtream-card');
    if (!card) return;
    const id = card.dataset.id || '';
    const account = this.cardAccount(card);
    if (!account.url || !account.username || !account.password) {
      this.setXtreamStatus(id, html`${t('settings.enterCredentials')}`, 'err');
      return;
    }
    const stored = this.storedAccountMatches(id, account.key);
    const snapshot = stored ? StorageService.getLiveCategorySnapshot(id) : null;
    const name = card.querySelector<HTMLInputElement>('.xtream-name')!.value.trim()
      || account.url.replace(/^https?:\/\//i, '');
    const client = createXtreamClient({
      baseUrl: account.url,
      username: account.username,
      password: account.password,
    });
    const restoreFocus = (): void => {
      const target = this.container.querySelector<HTMLElement>(
        `#xtream-entries .xtream-card[data-id="${id}"] .xtream-live-categories`,
      );
      if (target) this.nav.focus(target);
    };
    this.liveCategoryPicker.open({
      accountId: id,
      accountName: name,
      accounts: this.liveCategoryAccounts(),
      onSwitch: nextId => {
        const next = this.container.querySelector<HTMLElement>(
          `#xtream-entries .xtream-card[data-id="${nextId}"] .xtream-live-categories`,
        );
        if (next) this.openLiveCategories(next);
      },
      filter: this.cardLiveCategories(id, account.key),
      snapshot,
      loadCategories: signal => client.getLiveCategories(signal),
      onDone: (filter, categories) => {
        const catalogIds = categories.map(category => category.id);
        const counts: Record<string, number> = {};
        for (const catalogId of catalogIds) {
          if (snapshot && snapshot.counts[catalogId] !== undefined) counts[catalogId] = snapshot.counts[catalogId];
        }
        const reviewed: XtreamLiveCategorySnapshot = {
          knownIds: Array.from(new Set(catalogIds)),
          announcedIds: [],
          counts,
        };
        this.pendingLiveCategories.set(id, { filter, account: account.key, catalogIds, reviewed });
        // A re-pointed or unsaved account gets its snapshot only once Save succeeds.
        if (stored) StorageService.setLiveCategorySnapshot(id, reviewed);
        log.info('Live categories chosen', 'event=xtream.category_filter.picked',
          `mode=${filter ? filter.mode : 'all'}`, `categories=${String(filter ? filter.ids.length : 0)}`,
          `total=${String(catalogIds.length)}`);
        const target = this.container.querySelector<HTMLElement>(
          `#xtream-entries .xtream-card[data-id="${id}"] .xtream-live-categories`,
        );
        if (target) morph(target, liveCategoriesButtonContent(filter, reviewed, catalogIds));
        restoreFocus();
      },
      onCancel: restoreFocus,
    });
  }

  /** Saved or unsaved account cards whose credentials are filled in. */
  private liveCategoryAccounts(): PlaylistEntry[] {
    return ($$('#xtream-entries .xtream-card', this.container) as HTMLElement[])
      .filter(card => !!card.dataset.id)
      .map(card => ({ card, account: this.cardAccount(card) }))
      .filter(({ account }) => account.url && account.username && account.password)
      .map(({ card, account }) => ({
        id: card.dataset.id!,
        name: card.querySelector<HTMLInputElement>('.xtream-name')!.value.trim()
          || account.url.replace(/^https?:\/\//i, ''),
        url: account.url,
        source: 'xtream' as const,
      }));
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
      const entry: PlaylistEntry = {
        id: row.dataset.id || genPlaylistId(),
        name: name || t('settings.playlistDefault', { number: playlists.length + 1 }),
        url,
        source: 'url',
      };
      playlists.push(withEnabledState(
        entry,
        row.querySelector<HTMLElement>('.source-toggle')?.dataset.enabled !== 'false',
      ));
    }

    // Xtream accounts derive their get.php/xmltv.php URLs from these credentials
    // at load time; the base URL is normalized so a bare host still resolves.
    const accounts: PlaylistEntry[] = [];
    const guideOff: string[] = [];
    const reviewedSnapshots: [string, XtreamLiveCategorySnapshot][] = [];
    const cards = $$('#xtream-entries .xtream-card', this.container) as HTMLElement[];
    for (const card of cards) {
      const rawUrl = card.querySelector<HTMLInputElement>('.xtream-url')!.value.trim();
      const username = card.querySelector<HTMLInputElement>('.xtream-username')!.value.trim();
      const password = card.querySelector<HTMLInputElement>('.xtream-password')!.value;
      if (!rawUrl || !username || !password) continue;
      const base = normalizeXtreamBaseUrl(rawUrl);
      const name = card.querySelector<HTMLInputElement>('.xtream-name')!.value.trim();
      const liveOutput = normalizeXtreamLiveOutputPreference(
        card.querySelector<HTMLElement>('.xtream-output .dropdown')!.dataset.value,
      );
      const id = card.dataset.id || genPlaylistId();
      if (card.querySelector<HTMLElement>('.xtream-guide .toggle-option.active')?.dataset.value === 'off') {
        guideOff.push(id);
      }
      const xtream: NonNullable<PlaylistEntry['xtream']> = { username, password, liveOutput };
      const accountKey = `${base}|${username}`;
      const liveCategories = this.cardLiveCategories(id, accountKey);
      if (liveCategories) xtream.liveCategories = liveCategories;
      const pendingReview = this.pendingLiveCategories.get(id);
      if (pendingReview && pendingReview.account === accountKey) reviewedSnapshots.push([id, pendingReview.reviewed]);
      const entry: PlaylistEntry = {
        id,
        name: name || base.replace(/^https?:\/\//i, ''),
        url: base,
        source: 'xtream',
        xtream,
      };
      accounts.push(withEnabledState(
        entry,
        card.querySelector<HTMLElement>('.source-toggle')?.dataset.enabled !== 'false',
      ));
    }

    const nonUpload = [...playlists, ...accounts];

    // Preserve auto-managed uploaded playlists (not shown in the editors above).
    const stored = StorageService.getPlaylists();
    const uploads = stored.filter(pl => pl.source === 'upload').map((playlist) => {
      const toggle = this.container.querySelector<HTMLElement>(
        `#upload-entries [data-id="${playlist.id}"] .source-toggle`,
      );
      return withEnabledState(playlist, toggle?.dataset.enabled !== 'false');
    });
    const nextSources = [...nonUpload, ...uploads];
    const manualEpgSources = this.manualEpgSourcesFromEditor(
      new Set(nextSources.map(source => source.id)),
    );
    const seenEpgUrls = new Set<string>();
    const duplicateEpgUrl = manualEpgSources.find(source => {
      if (seenEpgUrls.has(source.url)) return true;
      seenEpgUrls.add(source.url);
      return false;
    })?.url;
    if (duplicateEpgUrl) {
      const duplicateInput = Array.from(
        this.container.querySelectorAll<HTMLInputElement>('.manual-epg-url'),
      ).filter(input => input.value.trim() === duplicateEpgUrl)[1];
      if (duplicateInput) {
        this.nav.focus(duplicateInput);
        duplicateInput.focus();
      }
      showToast(t('settings.duplicateEpgSource'));
      return;
    }

    ReminderService.backfillSourceIds();
    // A re-pointed account loses its old snapshot on save; keep the one its picker just reviewed.
    if (StorageService.setPlaylists(nextSources)) {
      for (const [reviewedId, reviewed] of reviewedSnapshots) {
        StorageService.setLiveCategorySnapshot(reviewedId, reviewed);
      }
    }

    const previousManualEpgSources = StorageService.getManualEpgSources();
    StorageService.setManualEpgSources(manualEpgSources);
    const previousGuideOff = StorageService.getGuideOffSources();
    StorageService.setGuideOffSources(guideOff);

    const autoPlayBtn = $('#auto-play .toggle-option.active', this.container);
    if (autoPlayBtn) StorageService.setAutoPlay(autoPlayBtn.dataset.value === 'on');

    const livePreviewBtn = $('#live-preview-setting .toggle-option.active', this.container);
    if (livePreviewBtn) StorageService.setLivePreview(livePreviewBtn.dataset.value === 'on');

    const channelCycleBtn = $('#channel-cycle-mode .toggle-option.active', this.container);
    if (channelCycleBtn?.dataset.value) {
      StorageService.setChannelCycleMode(channelCycleBtn.dataset.value as ChannelCycleMode);
    }

    this.saveShowHidden();
    const hideArabicBtn = $('#hide-arabic .toggle-option.active', this.container);
    if (hideArabicBtn) StorageService.setHideArabic(hideArabicBtn.dataset.value === 'on');

    const tzModeBtn = $('#tz-mode .toggle-option.active', this.container);
    if (tzModeBtn?.dataset.value) StorageService.setTzMode(tzModeBtn.dataset.value as TzMode);
    const sourceByChannel: Record<string, string> = {};
    const legacySources = new Map<string, string>();
    const ambiguousLegacyKeys = new Set<string>();
    for (const channel of PlaylistService.channels) {
      const sourceUrl = EpgService.getSourceUrl(channel);
      if (!sourceUrl) continue;
      sourceByChannel[channelKey(channel)] = sourceUrl;
      const legacyKey = legacyChannelKey(channel);
      if (legacySources.has(legacyKey)) {
        ambiguousLegacyKeys.add(legacyKey);
      } else {
        legacySources.set(legacyKey, sourceUrl);
      }
    }
    for (const [legacyKey, sourceUrl] of legacySources) {
      if (!ambiguousLegacyKeys.has(legacyKey)) sourceByChannel[legacyKey] = sourceUrl;
    }
    ReminderService.migrateEpgOffsets(
      this.storedEpgOffsets,
      this.epgOffsets,
      sourceByChannel,
    );
    StorageService.migrateCatchupEpgOffsets(
      this.storedEpgOffsets,
      this.epgOffsets,
      sourceByChannel,
    );
    const nextEpgOffsets = { ...this.epgOffsets };
    for (const source of previousManualEpgSources) {
      if (!manualEpgSources.some(candidate => candidate.url === source.url)
          && !PlaylistService.epgSources.some(candidate => candidate.url === source.url)) {
        delete nextEpgOffsets[source.url];
      }
    }
    this.epgOffsets = nextEpgOffsets;
    StorageService.setEpgOffsets(nextEpgOffsets);

    StorageService.setTheme(this.selectedTheme);

    const overlayBtn = $('#overlay-style .toggle-option.active', this.container);
    if (overlayBtn?.dataset.value) StorageService.setOverlayStyle(overlayBtn.dataset.value as OverlayStyle);

    const textSize = ($('#text-size', this.container) as HTMLElement | null)?.dataset.value;
    if (textSize) StorageService.setTextSize(textSize as TextSize);

    const locale = ($('#app-language', this.container) as HTMLElement | null)?.dataset.value as LocalePreference | undefined;
    if (locale) StorageService.setLocalePreference(locale);

    const liveReconnectAttempts = Number(
      ($('#live-reconnect-attempts', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setLiveReconnectAttempts(liveReconnectAttempts);

    const numberEntryOsdTimeoutMs = Number(
      ($('#number-entry-osd-timeout', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setNumberEntryOsdTimeoutMs(numberEntryOsdTimeoutMs);

    const playerOsdTimeoutMs = Number(
      ($('#player-osd-timeout', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setPlayerOsdTimeoutMs(playerOsdTimeoutMs);

    const animationMode = $('#animation-mode .toggle-option.active', this.container)
      ?.dataset.value as AnimationMode | undefined;
    if (animationMode) {
      StorageService.setAnimationMode(animationMode);
      applyAnimationMode(animationMode);
    }

    const playlistRefreshHours = Number(
      ($('#playlist-refresh-interval', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setPlaylistRefreshIntervalHours(playlistRefreshHours);

    const epgRefreshHours = Number(
      ($('#epg-refresh-interval', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setEpgRefreshIntervalHours(epgRefreshHours);

    const xtreamCatalogRefresh = $(
      '#xtream-catalog-refresh-interval',
      this.container,
    ) as HTMLElement | null;
    if (xtreamCatalogRefresh) {
      StorageService.setXtreamCatalogRefreshIntervalHours(
        Number(xtreamCatalogRefresh.dataset.value),
      );
    }

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

    // Source, EPG URL, and time correction changes rebuild loaded data. Display-only
    // settings (time zone, auto-play) just re-render in place.
    const sig = (l: PlaylistEntry[]) =>
      JSON.stringify(l.map(pl => [
        pl.id,
        pl.name,
        pl.url,
        isSourceEnabled(pl),
        pl.xtream?.username,
        pl.xtream?.password,
        pl.xtream ? normalizeXtreamLiveOutputPreference(pl.xtream.liveOutput) : '',
        pl.xtream ? normalizeLiveCategoryFilter(pl.xtream.liveCategories) ?? null : null,
      ]));
    const offsetSig = (offsets: Record<string, number>) =>
      JSON.stringify(Object.keys(offsets).sort().map(url => [url, offsets[url]]));
    const dataChanged = JSON.stringify(manualEpgSources)
        !== JSON.stringify(previousManualEpgSources)
      || sig(stored) !== sig(nextSources)
      || offsetSig(this.storedEpgOffsets) !== offsetSig(this.epgOffsets);
    // A guide switch alone keeps the channel and catalog caches, which a
    // reload would download again.
    const guideChanged = JSON.stringify(previousGuideOff.slice().sort())
      !== JSON.stringify(guideOff.slice().sort());
    this.onSave(dataChanged ? 'reload' : guideChanged ? 'guide' : 'apply');
  }

  /**
   * Replace the placeholder text in #setup-info with QR + instructions (or
   * an error when the service is unreachable). Built through `html` so the
   * setup URL — which originates off-device — is escaped, then handed to
   * `morph()` so the surrounding rendered content stays unaffected and we
   * never touch innerHTML directly with an interpolated string.
   */
  async refreshSetupInfo(): Promise<void> {
    const el = $('#setup-info', this.container);
    if (!el) return;
    const info = await SetupClient.getInfo();
    // Re-resolve in case the user navigated away or settings re-rendered.
    const target = $('#setup-info', this.container);
    if (!target) return;
    if (info) {
      const qrUrl = info.setupUrl;
      morph(target, html`
        <img class="setup-qr" alt="${t('settings.qrAlt', { url: qrUrl })}" src="${qrDataUrl(qrUrl)}">
        <div class="setup-instructions">
          <div class="setup-scan-instruction">${t('settings.setupScanQr')}</div>
          <div class="setup-browser-instruction">${t('settings.setupOpenInBrowser')}</div>
          <span class="setup-url">${info.manualUrl}</span>
          <div class="setup-pairing-instruction">${t('settings.setupPairingPrompt')}</div>
          <span class="setup-pairing-code">${info.pairingCode}</span>
        </div>
      `);
    } else {
      morph(target, html`<span>${t('settings.setupUnavailable')}</span>`);
    }
  }

  private async removeUpload(url: string): Promise<void> {
    const id = uploadIdFromUrl(url);
    if (id) await UploadClient.remove(id);

    const remaining = StorageService.getPlaylists().filter(pl => pl.url !== url);
    StorageService.setPlaylists(remaining);
    showToast(t('settings.uploadRemoved'));

    await this.refreshUploads();
  }

  /**
   * Pull the latest uploads from the local service into storage, then patch
   * just the #upload-entries section via morph() so the rest of the form
   * keeps its focus and unsaved input.
   *
   * Called on render() (covers uploads that arrived before the user opened
   * Settings) and on every Luna `serviceEvents` upload push from the LAN service
   * (covers uploads that arrive while Settings is open — see app.ts).
   *
   * Safe to call when the settings view is hidden: reconcile still updates
   * storage, but the morph is a no-op against the off-screen container so
   * there's no visible side effect.
   */
  async refreshUploads(): Promise<void> {
    const pending = new Map<string, boolean>();
    $$('#upload-entries [data-source-entry]', this.container).forEach((row) => {
      const key = row.dataset.id || row.getAttribute('data-key');
      const toggle = row.querySelector<HTMLElement>('.source-toggle');
      if (key && toggle) pending.set(key, toggle.dataset.enabled !== 'false');
    });
    await UploadClient.reconcile();
    const target = $('#upload-entries', this.container);
    if (!target) return;

    const uploads = StorageService.getPlaylists().filter(pl => pl.source === 'upload');
    morph(target, uploads.length
      ? html`${uploads.map((pl) =>
          uploadRow(pl, pending.get(pl.id || pl.url) ?? isSourceEnabled(pl)))}`
      : html`<div class="empty-hint">${t('settings.noUploads')}</div>`);
    this.refreshManualEpgScopes();
  }
}
