import './polyfills';
import { CONFIG } from './config';
import { KeyHandler } from './navigation/key-handler';
import { PlaylistService } from './services/playlist-service';
import { EpgService } from './services/epg-service';
import { StorageService } from './services/storage-service';
import { clearAllCachedData } from './services/idb-cache';
import { setServicePort } from './services/upload-client';
import { ChannelList } from './components/channel-list';
import { Player } from './components/player';
import { EpgGrid } from './components/epg-grid';
import { Settings, type SaveAction } from './components/settings';
import { Sidebar } from './components/sidebar';
import { PlayerMenu } from './components/player-menu';
import { TabBar, type Section, sectionForView } from './components/tab-bar';
import { Movies } from './components/movies';
import { Series } from './components/series';
import { Search } from './components/search';
import { showToast } from './components/toast';
import { ReminderService } from './services/reminder-service';
import { ReminderPrompt } from './components/reminder-prompt';
import { setDisplayTz } from './utils/time';
import { initTheme, applyTheme, applyOverlayStyle, applyTextSize } from './services/theme-service';
import { channelKey } from './utils/channel';
import { truncate } from './utils/text';
import { $, show, hide } from './utils/dom';
import { createLogger, installGlobalErrorHandlers, logEnvironment } from './utils/logger';
import type { Action, NumberEvent, CatchupInfo, EpgSource, PlaylistEntry } from './types';
import { getLocale, initLocale, resolveLocale, setLocale, t, tp } from './i18n';

const log = createLogger('App');

type ViewName = 'channels' | 'player' | 'epg' | 'settings' | 'loading' | 'movies' | 'series' | 'search';

class App {
  private views!: Record<ViewName, HTMLElement>;
  private viewStack: ViewName[] = ['channels'];
  private backPressTime = 0;
  private viewBeforeSearch: ViewName | null = null;
  private channelList!: ChannelList;
  private player!: Player;
  private epgGrid!: EpgGrid;
  private settings!: Settings;
  private sidebar!: Sidebar;
  private menu!: PlayerMenu;
  private reminderPrompt = new ReminderPrompt();
  private tabBar!: TabBar;
  private search!: Search;
  private movies!: Movies;
  private series!: Series;
  private lastSearchQuery = '';
  private enterChannelsAfterUploadSync = false;
  private remindersInitialized = false;
  private bundledServiceStarting = false;

  async init(): Promise<void> {
    const done = log.time('init');
    log.info('Initializing app');
    initLocale(StorageService.getLocalePreference());
    const initialLoadingText = $('#loading-text');
    if (initialLoadingText) initialLoadingText.textContent = t('common.loading');
    initTheme();
    this.views = {
      channels: $('#view-channels')!,
      player: $('#view-player')!,
      epg: $('#view-epg')!,
      settings: $('#view-settings')!,
      movies: $('#view-movies')!,
      series: $('#view-series')!,
      search: $('#view-search')!,
      loading: $('#view-loading')!,
    };

    this.channelList = new ChannelList(
      this.views.channels,
      (idx, catchup) => this.playChannel(idx, catchup),
      () => this.player.syncCurrentIndex(),
    );
    this.player = new Player(this.views.player, () => {
      this.channelList.render();
      this.showView('channels');
    }, (idx, catchupStart) => this.channelList.setPlaying(idx, catchupStart),
    () => !this.sidebar.visible && !this.menu.visible);
    this.epgGrid = new EpgGrid(this.views.epg, (idx, catchup) => this.playChannel(idx, catchup));
    this.settings = new Settings(
      this.views.settings,
      (action) => this.onSettingsSaved(action),
      () => this.player.syncCurrentIndex(),
    );

    this.player.init($('#video-player') as HTMLVideoElement);

    this.sidebar = new Sidebar(
      this.views.player,
      () => this.player.getCurrentIndex(),
      (idx, catchup) => this.playChannel(idx, catchup),
    );
    this.menu = new PlayerMenu(
      this.views.player,
      () => this.player.getCurrentChannel(),
      (action) => this.onMenuAction(action),
      () => this.player.getAudioTracks(),
      (index) => this.player.selectAudioTrack(index),
      () => this.player.getSubtitleTracks(),
      (index) => this.player.selectSubtitleTrack(index),
      () => this.player.subtitleOffsetState(),
      () => this.player.openSubtitleOffset(),
    );

    this.movies = new Movies(this.views.movies, {
      onRevealTabBar: () => this.tabBar.focus(),
      onBack: () => this.goLive(),
      onPlayVod: (req) => {
        this.showView('player');
        this.player.playVod({
          ...req,
          onBack: () => {
            this.showView('movies');
            this.movies.refreshPlaybackState();
          },
        });
      },
    });
    this.series = new Series(this.views.series, {
      onRevealTabBar: () => this.tabBar.focus(),
      onBack: () => this.goLive(),
      onPlayVod: (req) => {
        this.showView('player');
        this.player.playVod({
          ...req,
          onBack: () => {
            this.showView('series');
            this.series.refreshPlaybackState();
          },
        });
      },
    });
    this.search = new Search(this.views.search, {
      onRevealTabBar: () => this.tabBar.focus(),
      onBack: () => this.goLive(),
      onPlayChannel: (idx, catchup) => { this.tabBar.blur(); this.playChannel(idx, catchup); },
      onOpenMovie: (account, vod) => {
        this.tabBar.blur();
        this.showView('movies');
        this.movies.openItem(account, vod, () => this.showView('search')).catch((err) => log.error('Open movie failed:', err));
      },
      onOpenSeries: (account, series) => {
        this.tabBar.blur();
        this.showView('series');
        this.series.openItem(account, series, () => this.showView('search')).catch((err) => log.error('Open series failed:', err));
      },
    });
    this.tabBar = new TabBar({
      onSwitch: (section) => this.switchSection(section),
      onEnter: (section) => this.enterSection(section),
      onSearchQuery: (query) => this.handleSearchQuery(query),
      onSearchLeave: () => this.search.focusFirstResult(),
      onSearchClose: () => this.handleSearchClose(),
      onSelectAccount: (id) => this.selectXtreamAccount(id),
    });
    this.tabBar.init();

    KeyHandler.init();
    KeyHandler.setHandler((action, event) => this.handleKey(action, event));

    this.initSidebarTrigger();

    done();
    this.enterChannelsAfterUploadSync = StorageService.getPlaylists().length === 0;
    const bundledServiceReady = this.startBundledService();
    this.bindBundledServiceLifecycle();
    this.bindReminderLifecycle();
    // Register a retail-safe callback immediately. If Developer Mode is
    // detected below, the same named activities are replaced with alerts.
    ReminderService.reschedulePending();
    await this.loadData();
    // Cold launch from a "Watch now" alert: channels are loaded now, so tune.
    this.handleLaunchParams(this.coldLaunchParams());
    void bundledServiceReady
      .then((started) => started ? this.finishBundledServiceInit() : undefined)
      .catch(err => log.error('Bundled service initialization failed:', err));
  }

  /**
   * Tie the bundled service's lifetime to the app's foreground state. The
   * service holds an open LAN HTTP port and a Luna keepAlive activity, so we
   * stop it when the app is backgrounded (visibility → hidden) so neither
   * the port nor the service process lingers across the rest of webOS. On
   * visibility → visible we restart it and resubscribe.
   *
   * visibilitychange is reliable on this firmware (verified empirically; the
   * Player module's suspend/resume listens to the same event).
   */
  private bindBundledServiceLifecycle(): void {
    let lastVisibility = document.visibilityState;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === lastVisibility) return;
      lastVisibility = document.visibilityState;
      if (document.visibilityState === 'hidden') {
        log.info('App backgrounded — stopping bundled service');
        this.stopBundledService();
      } else if (document.visibilityState === 'visible') {
        if (this.bundledServiceStarting) {
          log.info('App foregrounded while bundled service start is pending');
          return;
        }
        log.info('App foregrounded — restarting bundled service');
        void this.startBundledService()
          .then((started) => started ? this.finishBundledServiceInit() : undefined)
          .catch(err => log.error('Bundled service restart failed:', err));
      }
    });
  }

  /**
   * Fire-and-forget Luna call to gracefully shut down the bundled service.
   * The service closes its HTTP listener, releases its keepAlive activity,
   * and lets the Node process exit so neither the port nor the process
   * persists in the background.
   */
  private stopBundledService(): void {
    type LunaService = { request: (uri: string, opts: unknown) => void };
    const w = window as unknown as { webOS?: { service?: LunaService } };
    const request = w.webOS?.service?.request;
    if (!request) return;
    try {
      request(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'stop',
        parameters: {},
        onSuccess: (resp: unknown) => log.info('Bundled service stop onSuccess:', JSON.stringify(resp)),
        onFailure: (err: unknown) => log.warn('Bundled service stop onFailure:', JSON.stringify(err)),
      });
    } catch (e) {
      log.warn('stopBundledService threw:', e);
    }
    // Forget the runtime port — next start will set it again via setServicePort.
    setServicePort(null);
  }

  /**
   * Ask the webOS Luna service bus to start the bundled webOS JS service
   * (see bundled-service/). On non-webOS environments (desktop preview, e2e)
   * this is a no-op — the bundled service is only available on device.
   *
   * We log onSuccess/onFailure explicitly so device logs (ares-inspect or
   * ares-monitor-log) show what happened, instead of guessing from silence.
   */
  private async startBundledService(): Promise<boolean> {
    if (this.bundledServiceStarting) return false;
    this.bundledServiceStarting = true;
    type LunaService = { request: (uri: string, opts: unknown) => void };
    const w = window as unknown as { webOS?: { service?: LunaService } };
    const request = w.webOS?.service?.request;
    if (!request) {
      this.bundledServiceStarting = false;
      log.debug('webOS Luna service bus not available — skipping bundled service start');
      return false;
    }
    log.info('Calling luna://' + CONFIG.SERVICE_ID + '/start ...');
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (started: boolean, why: string): void => {
        if (settled) return;
        settled = true;
        this.bundledServiceStarting = false;
        log.info('startBundledService settled:', why);
        resolve(started);
      };
      const timer = setTimeout(() => finish(false, 'timeout after 3s'), 3000);
      // NOTE: no trailing '/' on the URI — the shim appends '/' + method,
      // so a trailing slash here produces 'luna://.../service//start' (double
      // slash) which Luna treats as a missing method and returns onFailure.
      try {
        request(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'start',
          parameters: {},
          onSuccess: (resp: unknown) => {
            clearTimeout(timer);
            const lateSuccess = settled;
            if (document.visibilityState === 'hidden') {
              log.info('Bundled service started after app was hidden — stopping it');
              this.stopBundledService();
              finish(false, 'stopped after app hidden');
              return;
            }
            if (resp && typeof resp === 'object' && 'port' in resp) {
              const p = (resp as { port?: unknown }).port;
              if (typeof p === 'number') setServicePort(p);
            }
            log.info('Bundled service start onSuccess:', JSON.stringify(resp));
            finish(true, 'onSuccess');
            if (lateSuccess) {
              void this.finishBundledServiceInit()
                .catch(err => log.error('Late bundled service initialization failed:', err));
            }
          },
          onFailure: (err: unknown) => {
            clearTimeout(timer);
            log.error('Bundled service start onFailure:', JSON.stringify(err));
            finish(false, 'onFailure');
          },
        });
      } catch (e) {
        clearTimeout(timer);
        log.error('Bundled service start threw:', e);
        finish(false, 'threw');
      }
    });
  }

  private async finishBundledServiceInit(): Promise<void> {
    if (document.visibilityState === 'hidden') return;
    this.subscribeToUploadEvents();
    if (!this.remindersInitialized) {
      const initialized = await this.queryDevMode();
      ReminderService.reschedulePending();
      this.remindersInitialized = initialized;
    }
    await this.settings.refreshUploads();
    await this.loadChannelsAfterFirstUpload();
  }

  private async loadChannelsAfterFirstUpload(): Promise<void> {
    if (this.enterChannelsAfterUploadSync &&
        StorageService.getPlaylists().length > 0) {
      this.enterChannelsAfterUploadSync = false;
      await this.loadData();
    }
  }

  /**
   * Ask the bundled service whether Developer Mode is on. In dev mode reminders
   * fire an interactive system alert instead of the passive toast + in-app
   * prompt. Guarded: with no Luna bus (desktop/e2e) dev-mode stays false and we
   * keep the retail in-app path.
   */
  private async queryDevMode(): Promise<boolean> {
    type LunaService = { request: (uri: string, opts: unknown) => void };
    const w = window as unknown as { webOS?: { service?: LunaService } };
    const request = w.webOS?.service?.request;
    ReminderService.setDevMode(false);
    if (!request) {
      log.debug('Luna unavailable — dev-mode alert disabled, using in-app prompt');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (initialized: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(initialized);
        }
      };
      const timer = setTimeout(() => finish(false), 3000);
      try {
        request(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'getDevMode',
          parameters: {},
          onSuccess: (resp: unknown) => {
            clearTimeout(timer);
            const lateSuccess = settled;
            if (document.visibilityState === 'hidden') {
              finish(false);
              return;
            }
            const dev = !!(resp && typeof resp === 'object' && (resp as { devmode?: unknown }).devmode);
            ReminderService.setDevMode(dev);
            log.info('getDevMode:', dev);
            finish(true);
            if (lateSuccess) {
              this.remindersInitialized = true;
              ReminderService.reschedulePending();
            }
          },
          onFailure: (err: unknown) => {
            clearTimeout(timer);
            log.warn('getDevMode onFailure:', JSON.stringify(err));
            finish(false);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        log.warn('getDevMode threw:', e);
        finish(false);
      }
    });
  }

  /**
   * Subscribe to the bundled service's `uploadEvents` push channel. Whenever
   * the service writes/deletes an uploaded playlist (via the LAN /upload page
   * or DELETE /uploads/:id), it pushes a notification on this subscription
   * and we call Settings.refreshUploads() to re-sync storage + the upload
   * list UI. No polling.
   *
   * Subscription is best-effort: if Luna isn't available (desktop/e2e) or
   * the subscribe call fails, we silently fall back to the explicit
   * refreshUploads() that Settings.render() already runs on open.
   */
  private subscribeToUploadEvents(): void {
    type LunaService = { request: (uri: string, opts: unknown) => void };
    const w = window as unknown as { webOS?: { service?: LunaService } };
    const request = w.webOS?.service?.request;
    if (!request) {
      log.debug('Luna unavailable — upload event subscription skipped');
      return;
    }
    log.info('Subscribing to luna://' + CONFIG.SERVICE_ID + '/uploadEvents ...');
    try {
      request(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'uploadEvents',
        subscribe: true,
        parameters: {},
        onSuccess: (resp: unknown) => {
          log.info('uploadEvents push:', JSON.stringify(resp));
          if (resp && typeof resp === 'object' &&
              (resp as { subscribed?: unknown }).subscribed === true) return;
          void this.settings.refreshUploads()
            .then(() => this.loadChannelsAfterFirstUpload())
            .catch(err => log.error('Upload event refresh failed:', err));
        },
        onFailure: (err: unknown) => {
          log.warn('uploadEvents subscription failed:', JSON.stringify(err));
        },
      });
    } catch (e) {
      log.warn('uploadEvents subscribe threw:', e);
    }
  }

  /**
   * Push the saved display-timezone mode + the EPG's source offset into the
   * time formatter. Display only; safe to re-run any time. Prefers the offset
   * from the freshly-loaded feed, persists it, and falls back to the last-known
   * value — so feed mode renders correctly before the EPG has reloaded. The
   * formatter degrades 'feed' to 'device' while the offset is still unknown.
   */
  private applyDisplayTz(): void {
    const offset = EpgService.tzOffsetMinutes ?? StorageService.getEpgTzOffset();
    if (EpgService.tzOffsetMinutes != null) StorageService.setEpgTzOffset(EpgService.tzOffsetMinutes);
    setDisplayTz(StorageService.getTzMode(), offset);
  }

  private epgSources(): EpgSource[] {
    const manualUrl = StorageService.getEpgUrl();
    const discovered = PlaylistService.epgSources;
    return manualUrl && !discovered.some((source) => source.url === manualUrl)
      ? [{ url: manualUrl, playlistIds: [], kind: 'manual' }, ...discovered]
      : discovered;
  }

  private async loadData(): Promise<void> {
    const done = log.time('loadData');
    show(this.views.loading);

    this.applyDisplayTz();
    this.epgGrid.resetDay(); // re-pick today; a tz change invalidates the remembered day index

    try {
      const playlists = StorageService.getPlaylists();
      log.info('Configured playlists:', playlists.length);
      if (!playlists.length) {
        log.info('No playlists configured — opening settings');
        // Clear in-memory state so the channel list does not show stale
        // channels if the user navigates back from settings (e.g. with BACK).
        PlaylistService.reset();
        EpgService.reset();
        // No account at all: drop Movies/Series (Xtream-only) and any stale
        // account avatars so the docked tab bar shows Live/Settings/Search only.
        this.tabBar.setSections(false);
        this.tabBar.setAccounts([], '');
        this.channelList.render();
        this.showView('settings');
        this.settings.render();
        showToast(t('app.welcome'));
        return;
      }

      const loadingText = $('#loading-text');
      if (loadingText) loadingText.textContent = t('app.loadingChannels');
      await PlaylistService.load();
      log.info('Channels loaded:', PlaylistService.channels.length,
        '| groups:', PlaylistService.groups.length,
        '| epgSources:', PlaylistService.epgSources);
      const epgSources = this.epgSources();
      if (epgSources.length) log.info('Using EPG sources:', epgSources);
      else log.warn('No EPG sources configured');

      const hasXtream = StorageService.getPlaylists().some((p) => p.source === 'xtream');
      this.tabBar.setSections(hasXtream);
      const xtreamAccounts = StorageService.getPlaylists().filter((p) => p.source === 'xtream' && p.xtream);
      this.tabBar.setAccounts(xtreamAccounts, this.activeXtreamAccount()?.id ?? '');

      this.showView('channels');
      this.channelList.render();

      showToast(tp('app.channelsLoaded', PlaylistService.channels.length));

      this.scanReminders();

      if (StorageService.getAutoPlay()) {
        // The per-stream key survives customization and provider reshuffles.
        const lastCh = PlaylistService.resolveLastChannelIndex(
          StorageService.getLastChannelKey(),
          StorageService.getLastChannel(),
        );
        if (lastCh >= 0 && lastCh < PlaylistService.channels.length) {
          log.info('Auto-play resuming last channel index', lastCh);
          this.playChannel(lastCh);
        }
      }

      if (epgSources.length) {
        EpgService.load(epgSources)
          .then(() => {
            this.applyDisplayTz();
            this.channelList.render();
            this.search.refreshPrograms();
          })
          .catch(err => log.error('EPG load failed:', err));
        setInterval(() => EpgService.refresh()
          .then(() => {
            this.applyDisplayTz();
            this.channelList.render();
            this.search.refreshPrograms();
          })
          .catch(err => log.error('EPG refresh failed:', err)),
        CONFIG.EPG_REFRESH_INTERVAL);
      }
    } catch (err) {
      log.error('loadData failed:', err);
      this.showView('settings');
      this.settings.render();
      showToast(t('app.loadFailed'));
    } finally {
      hide(this.views.loading);
      done();
    }
  }

  private showView(name: ViewName): void {
    if (name !== 'channels' && this.channelList.isEditing) this.channelList.exitEditMode();
    // Re-assert the persisted theme on every view transition. This reverts any
    // unsaved live preview when Settings closes (Back / section switch / Cancel)
    // while keeping a just-saved theme, since save() persists before this runs.
    applyTheme(StorageService.getTheme());
    applyOverlayStyle(StorageService.getOverlayStyle());
    applyTextSize(StorageService.getTextSize());
    this.player.closeSubtitleSearch(); // never let the subtitle overlay linger across a view change
    this.player.closeSubtitleOffset(); // never let the subtitle-sync overlay linger across a view change
    this.epgGrid.dismissPrompt(); // never let the catch-up prompt linger across a view change
    this.search.dismissPrompt();
    this.settings.dismissPrompt();
    for (const [key, el] of Object.entries(this.views)) {
      if (key === 'loading') continue;
      if (key === name) show(el);
      else hide(el);
    }

    if (name === 'player') {
      this.viewStack.push(name);
    } else if (name !== this.viewStack[this.viewStack.length - 1]) {
      this.viewStack = [name];
    }

    // The docked tab bar shows on the section views and hides on the full-screen
    // player / EPG (and the loading splash), which render edge-to-edge.
    const section = sectionForView(name);
    this.tabBar.setShown(section !== null);

    // Focus the channel entry point on entry — but not while the tab bar holds
    // focus (a live Left/Right preview updates the view beneath it without
    // stealing the focus ring). No-op on first load (render runs after).
    if (name === 'channels' && !this.tabBar.focused) this.channelList.highlightEntryPoint();

    // Keep the active tab bound to the shown section view (so returning from
    // Settings, EPG, the player, etc. updates the underline). Skipped while the
    // search box is open — it overlays other views but stays "Search".
    if (section && !this.tabBar.searchOpen) this.tabBar.setActive(section);
  }

  // Map a tab-bar section to its view and show it (Live = the channels view).
  private switchSection(section: Section): void {
    if (section !== 'live' && this.channelList.isEditing) this.channelList.exitEditMode();
    // Leaving the player via the tab bar (the pointer can reveal it over the
    // player) must tear down playback, like Back / red / blue do.
    this.player.stop();
    if (section === 'live') { this.showView('channels'); this.channelList.render(); return; }
    if (section === 'movies') {
      this.showView('movies');
      const account = this.activeXtreamAccount();
      if (account) this.movies.open(account).catch((err) => log.error('Movies open failed:', err));
      return;
    }
    if (section === 'series') {
      this.showView('series');
      const seriesAccount = this.activeXtreamAccount();
      if (seriesAccount) this.series.open(seriesAccount).catch((err) => log.error('Series open failed:', err));
      return;
    }
    if (section === 'settings') {
      this.settings.render();
      this.showView('settings');
      return;
    }
    // Search: keep the current view; the results view only covers it once a
    // query is typed (handleSearchQuery). Remember where to return to.
    if (this.viewStack[this.viewStack.length - 1] !== 'search') {
      this.viewBeforeSearch = this.viewStack[this.viewStack.length - 1];
    }
    // Prep the results (loads the catalog once) into the still-hidden search view.
    this.search.open(this.activeXtreamAccount()).catch((err) => log.error('Search open failed:', err));
  }

  // The tab bar's search box query changed: show the results view over the
  // current one while non-empty; restore the underlying view when cleared.
  private handleSearchQuery(query: string): void {
    this.lastSearchQuery = query;
    this.search.setQuery(query);
    const hasQuery = query.trim().length > 0;
    const onSearch = this.viewStack[this.viewStack.length - 1] === 'search';
    if (hasQuery && !onSearch) this.showView('search');
    else if (!hasQuery && onSearch) this.showView(this.viewBeforeSearch ?? 'channels');
  }

  // The search box was closed: clear it and return to the view it opened from
  // (showView re-syncs the active tab, since the box is already collapsed).
  private handleSearchClose(): void {
    this.search.setQuery('');
    const rv = this.viewBeforeSearch ?? 'channels';
    this.viewBeforeSearch = null;
    this.showView(rv);
  }

  // Down/Select from the bar: switch to the section and drop focus into content.
  private enterSection(section: Section): void {
    this.tabBar.setActive(section);
    this.switchSection(section);
  }

  private goLive(): void {
    this.player.stop();
    this.tabBar.setActive('live');
    this.showView('channels');
    this.channelList.render();
  }

  private activeXtreamAccount(): PlaylistEntry | null {
    const accounts = StorageService.getPlaylists().filter((p) => p.source === 'xtream' && p.xtream);
    const selId = StorageService.getSelectedXtreamAccountId();
    return accounts.find((a) => a.id === selId) ?? accounts[0] ?? null;
  }

  // A different Xtream account was picked in the avatar dropdown: persist it and
  // reload whichever account-scoped section is showing. Live/Settings just store.
  private selectXtreamAccount(id: string): void {
    StorageService.setSelectedXtreamAccountId(id);
    const account = this.activeXtreamAccount();
    if (!account) return;
    log.info('Xtream account switched to', account.name);
    this.tabBar.setAccounts(
      StorageService.getPlaylists().filter((p) => p.source === 'xtream' && p.xtream),
      account.id,
    );
    const current = this.viewStack[this.viewStack.length - 1];
    if (current === 'movies') {
      this.movies.open(account).catch((err) => log.error('Movies reopen failed:', err));
    } else if (current === 'series') {
      this.series.open(account).catch((err) => log.error('Series reopen failed:', err));
    } else if (current === 'search') {
      this.search.open(account)
        .then(() => this.search.setQuery(this.lastSearchQuery))
        .catch((err) => log.error('Search reopen failed:', err));
    }
  }

  private playChannel(index: number, catchup?: CatchupInfo): void {
    this.showView('player');
    this.player.play(index, catchup);
  }

  private bindReminderLifecycle(): void {
    setInterval(() => this.scanReminders(), CONFIG.REMINDER_SCAN_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scanReminders();
    });
    // "Watch now" on a dev-mode reminder alert relaunches us with a channel key.
    document.addEventListener('webOSRelaunch', (e) => {
      this.handleLaunchParams((e as CustomEvent).detail);
    });
  }

  private coldLaunchParams(): unknown {
    const w = window as unknown as { PalmSystem?: { launchParams?: string } };
    return w.PalmSystem?.launchParams;
  }

  private handleLaunchParams(raw: unknown): void {
    const idx = ReminderService.resolveLaunchChannel(raw);
    if (idx >= 0) {
      log.info('Reminder launch — tuning channel index', idx);
      this.playChannel(idx);
    }
  }

  private scanReminders(): void {
    ReminderService.prune();
    // Dev mode: the interactive system alert is the single notification path,
    // so skip the in-app prompt (prune still runs to clean up ended reminders).
    if (ReminderService.devMode) return;
    this.showNextReminder();
  }

  private showNextReminder(): void {
    if (this.reminderPrompt.visible) return;
    const due = ReminderService.dueNow();
    const r = due[0];
    if (!r) return;
    this.reminderPrompt.show(
      truncate(r.title, CONFIG.REMINDER.TITLE_MAX),
      truncate(r.channelName, CONFIG.REMINDER.CHANNEL_MAX),
      {
      onConfirm: () => {
        ReminderService.markAnswered(r.channelKey, r.startMs);
        const idx = ReminderService.resolveChannelIndex(r.channelKey);
        if (idx >= 0) this.playChannel(idx);
        this.showNextReminder();
      },
      onCancel: () => {
        ReminderService.markAnswered(r.channelKey, r.startMs);
        this.showNextReminder();
      },
    });
  }

  private handleKey(action: Action, event?: NumberEvent): void {
    const currentView = this.viewStack[this.viewStack.length - 1];

    // A reminder prompt overlays every view and consumes input first.
    if (this.reminderPrompt.visible) {
      this.reminderPrompt.handleAction(action);
      return;
    }

    // The catch-up resume prompt is body-mounted but logically inside the EPG;
    // consume all actions (including back/blue globals) while it is visible.
    if (this.epgGrid.isPromptVisible) {
      this.epgGrid.handleAction(action, event);
      return;
    }

    if (this.settings.isPromptVisible) {
      this.settings.handleAction(action);
      return;
    }

    // The docked tab bar consumes input while it holds focus.
    if (this.tabBar.focused) {
      this.tabBar.handleAction(action);
      return;
    }

    // The subtitle-sync adjuster is modal over the player: it consumes all input.
    if (currentView === 'player' && this.player.subtitleOffsetOpen()) {
      this.player.handleSubtitleOffsetAction(action);
      return;
    }

    // Global shortcuts
    // While the channel list is in edit mode the color keys belong to the editor.
    const editingChannels = currentView === 'channels' && this.channelList.isEditing;
    if (action === 'red' && currentView !== 'epg' && !editingChannels) {
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.showView('epg');
      this.epgGrid.render();
      // Refresh EPG data in background, then re-render
      EpgService.refresh().then(() => {
        this.applyDisplayTz();
        this.epgGrid.render();
        this.search.refreshPrograms();
      });
      return;
    }
    if (action === 'blue' && currentView !== 'settings' && !editingChannels) {
      if (currentView === 'epg') this.epgGrid.deactivateFilters();
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.settings.render();
      this.showView('settings');
      return;
    }
    if (action === 'green' && currentView === 'player' && (this.sidebar.visible || this.menu.visible)) {
      this.togglePlayingFavorite();
      return;
    }
    if (action === 'yellow' && currentView === 'player') {
      this.player.showOSD();
      return;
    }

    // Back handling
    if (action === 'back') {
      if (currentView === 'player') {
        if (this.sidebar.visible) {
          if (!this.sidebar.handleBack()) this.sidebar.hide();
        } else if (this.menu.visible) {
          // Let the menu step out of its audio sub-menu before closing.
          if (!this.menu.handleBack()) this.menu.hide();
        } else {
          this.player.handleAction('back');
        }
        return;
      }
      if (currentView === 'movies') { this.movies.handleAction('back'); return; }
      if (currentView === 'series') { this.series.handleAction('back'); return; }
      if (currentView === 'search') { this.search.handleAction('back'); return; }
      if (currentView === 'epg') {
        if (this.epgGrid.isFilterOpen) {
          this.epgGrid.handleAction('back');
          return;
        }
        this.epgGrid.deactivateFilters();
        this.tabBar.setActive('live');
        this.channelList.render();
        this.showView('channels');
        return;
      }
      if (currentView === 'settings') {
        if (this.settings.dismissDropdown()) return;
        this.tabBar.setActive('live');
        this.channelList.render();
        this.showView('channels');
        return;
      }
      if (currentView === 'channels') {
        if (this.channelList.handleBack()) return;
        const now = Date.now();
        if (now - this.backPressTime < 3000) {
          const webOS = (window as unknown as Record<string, { platformBack?: () => void }>).webOS;
          if (webOS?.platformBack) webOS.platformBack();
          else window.close();
        } else {
          this.backPressTime = now;
          showToast(t('app.exitHint'));
        }
        return;
      }
    }

    // Delegate to active view
    switch (currentView) {
      case 'channels': {
        const moved = this.channelList.handleAction(action, event);
        if (action === 'up' && !moved && this.tabBar.shown) this.tabBar.focus();
        break;
      }
      case 'movies':
        this.movies.handleAction(action);
        break;
      case 'series':
        this.series.handleAction(action);
        break;
      case 'search':
        this.search.handleAction(action);
        break;
      case 'player':
        if (this.player.isVod()) {
          // A VOD menu (opened by the pointer) captures D-pad nav; Left closes
          // it. Otherwise D-pad drives VOD playback (seek / pause / OSD).
          if (this.menu.visible) {
            if (action === 'up' || action === 'down' || action === 'select') this.menu.handleAction(action);
            else if (action === 'left') this.menu.hide();
          } else {
            this.player.handleAction(action);
          }
          break;
        }
        // While the OSD is up on seekable catch-up, Left/Right seek instead of
        // opening the sidebar/menu (which stay reachable once the OSD hides).
        if ((action === 'left' || action === 'right')
            && !this.sidebar.visible && !this.menu.visible && this.player.canSeek()) {
          this.player.handleAction(action);
          break;
        }
        if (action === 'left') {
          if (this.menu.visible) this.menu.hide();
          else if (this.sidebar.visible) this.sidebar.handleAction(action);
          else this.sidebar.show();
        } else if (action === 'right') {
          if (this.sidebar.visible) this.sidebar.handleAction(action);
          else if (this.menu.visible) this.menu.hide();
          else this.menu.show();
        } else if (this.sidebar.visible && (
          action === 'up' || action === 'down' ||
          action === 'channel_up' || action === 'channel_down' ||
          action === 'select'
        )) {
          this.sidebar.handleAction(action);
        } else if (this.menu.visible && (
          action === 'up' || action === 'down' || action === 'select'
        )) {
          this.menu.handleAction(action);
        } else {
          this.player.handleAction(action);
        }
        break;
      case 'epg':
        this.epgGrid.handleAction(action, event);
        break;
      case 'settings':
        if (action === 'back') {
          this.channelList.render();
          this.showView('channels');
        } else {
          this.settings.handleAction(action);
        }
        break;
    }
  }

  private initSidebarTrigger(): void {
    document.addEventListener('pointermove', (e: PointerEvent) => {
      const currentView = this.viewStack[this.viewStack.length - 1];
      if (currentView !== 'player') return;

      const osd = $('#player-osd', this.views.player);
      const osdRect = osd?.getBoundingClientRect();
      const overOsd = !!osd && !osd.classList.contains('hidden') && !!osdRect
        && e.clientY >= osdRect.top;

      // VOD (movies/series) has no channels and no live menu — only the OSD
      // (title + seek bar) is pointer-revealable; suppress the channel sidebar
      // and the live player menu.
      const vod = this.player.isVod();

      // Protect the full-width area beside and below the OSD too: its edge
      // controls sit next to margins where an imprecise cursor can open a panel.
      if (!overOsd && !vod && e.clientX < 80 && !this.menu.visible) {
        this.sidebar.show();
        this.sidebar.handlePointerMove(e.clientX, false);
      } else if (this.sidebar.visible) {
        const overSidebar = !!(e.target as HTMLElement).closest('.player-sidebar');
        const delayingDismiss = this.sidebar.handlePointerMove(e.clientX, overSidebar);
        if (!delayingDismiss && !overSidebar
            && e.clientX > this.sidebar.pointerDismissX && !this.sidebar.keyboardOn) {
          // Never dismiss while the keyboard is on — the pointer naturally
          // leaves the sidebar on its way to the on-screen keyboard.
          this.sidebar.hide();
        }
      }

      // Right menu. Live/catch-up and VOD alike; for VOD it shows the VOD action
      // set (Info, Settings) plus any audio/subtitle tracks — the channel rows
      // are hidden, so it's never empty.
      if (!overOsd && e.clientX > 1840 && !this.sidebar.visible) {
        this.menu.show();
      } else if (this.menu.visible) {
        const overMenu = !!(e.target as HTMLElement).closest('.player-menu');
        if (overMenu) {
          this.menu.resetTimer();
        } else if (e.clientX < 1540) {
          this.menu.hide();
        }
      }

      // Bottom OSD info bar
      if (e.clientY > 900 && !this.sidebar.visible && !this.menu.visible) {
        this.player.showOSD();
      }
    });
  }

  private onMenuAction(action: Action): void {
    if (action === 'green') {
      this.togglePlayingFavorite();
    } else if (action === 'yellow') {
      this.player.showOSD();
    } else {
      this.handleKey(action);
    }
  }

  private togglePlayingFavorite(): void {
    const ch = this.player.getCurrentChannel();
    if (!ch) return;
    const key = channelKey(ch);
    StorageService.toggleFavorite(key);
    showToast(StorageService.getFavorites().includes(key)
      ? t('channel.favoriteAdded', { name: ch.name })
      : t('channel.favoriteRemoved', { name: ch.name }));
    this.channelList.render();
    this.sidebar.refresh();
  }


  private async onSettingsSaved(action: SaveAction): Promise<void> {
    if (action === 'edit-channels') {
      this.tabBar.setActive('live');
      this.showView('channels');
      this.channelList.render();
      this.channelList.enterEditMode();
      return;
    }
    if (action === 'reset') {
      StorageService.clearAll();
      await clearAllCachedData();
      location.reload();
      return;
    }
    if (action !== 'cancel') {
      const locale = resolveLocale(StorageService.getLocalePreference());
      if (locale !== getLocale()) {
        setLocale(locale);
        this.tabBar.refresh();
        ReminderService.reschedulePending();
      }
    }
    if (action === 'reload') {
      StorageService.remove('cached_playlist');
      this.showView('channels');
      await this.loadData();
      return;
    }
    // 'apply': only display settings changed — re-apply + re-render, no re-fetch.
    if (action === 'apply') {
      this.applyDisplayTz();
      this.epgGrid.resetDay();
    }
    this.channelList.render();
    this.showView('channels');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  installGlobalErrorHandlers();
  logEnvironment(CONFIG.VERSION);
  const app = new App();
  app.init().catch(err => log.error('App init failed:', err));
});
