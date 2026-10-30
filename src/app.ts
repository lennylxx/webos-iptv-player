import './polyfills';
import './engine-quirks';
import { CONFIG } from './config';
import { KeyHandler } from './navigation/key-handler';
import { PlaylistService } from './services/playlist-service';
import { EpgService } from './services/epg-service';
import { ChannelHealthService } from './services/channel-health';
import { StorageService } from './services/storage-service';
import {
  clearAllCachedData,
  clearCachedCatalog,
  clearCachedPlaylist,
  flushCacheWrites,
} from './services/idb-cache';
import { SetupClient } from './services/setup-client';
import { SearchIndexPrewarmer } from './services/search-index-store';
import {
  CATALOG_STORE,
  EPG_STORE,
  SERIES_CATALOG_RESOURCE,
  VOD_CATALOG_RESOURCE,
} from './services/idb-schema';
import type { SearchPrewarmSource } from './workers/tasks';
import { setServicePort } from './services/service-http';
import { isLunaAvailable, lunaRequest, type LunaRequestHandle } from './services/luna';
import { ChannelList } from './components/channel-list';
import { Player } from './components/player';
import { LivePreview } from './components/live-preview';
import { EpgGrid } from './components/epg-grid';
import { Settings, type SaveAction } from './components/settings';
import { Sidebar } from './components/sidebar';
import { PlayerMenu } from './components/player-menu';
import { TabBar, type Section, sectionForView } from './components/tab-bar';
import { Movies } from './components/movies';
import { Series } from './components/series';
import { Search } from './components/search';
import { SearchHistoryDropdown } from './components/search-history-dropdown';
import { showToast } from './components/toast';
import { showNumberEntry, hideNumberEntry } from './components/number-entry';
import { ReminderService } from './services/reminder-service';
import { ReminderPrompt } from './components/reminder-prompt';
import { ReminderManager } from './components/reminder-manager';
import { ParentalControls } from './components/parental-controls';
import { ParentalPinPrompt } from './components/parental-pin-prompt';
import {
  liveParentalRequest,
  ParentalControlService,
  vodParentalRequest,
} from './services/parental-control';
import { setDisplayTz } from './utils/time';
import { initTheme, applyTheme, applyOverlayStyle, applyTextSize } from './services/theme-service';
import { applyAnimationMode } from './services/motion-service';
import { channelKey } from './utils/channel';
import { isSourceEnabled } from './utils/playlist';
import { truncate } from './utils/text';
import { $, show, hide } from './utils/dom';
import { createLogger, installGlobalErrorHandlers, logEnvironment } from './utils/logger';
import { withoutGuideOff } from './utils/guide-sources';
import { preloadSearchCatalog } from './services/xtream-catalog';
import { FocusRing } from './navigation/focus-ring';
import { Focus, type FocusScope } from './navigation/focus-scope';
import type {
  Action,
  NumberEvent,
  CatchupInfo,
  Channel,
  ChannelScope,
  EpgSource,
  PlaylistEntry,
} from './types';
import { getLocale, initLocale, resolveLocale, setLocale, t, tp } from './i18n';

const log = createLogger('App');

type ViewName = 'channels' | 'player' | 'epg' | 'settings' | 'parental-controls' | 'reminders'
  | 'loading' | 'movies' | 'series' | 'search';

class App {
  private views!: Record<ViewName, HTMLElement>;
  private viewStack: ViewName[] = ['channels'];
  private backPressTime = 0;
  private viewBeforeSearch: ViewName | null = null;
  // Catalog views a search result deep-linked into a detail; restored on the
  // way back to the view Search opened over.
  private readonly searchDetailViews = new Set<'movies' | 'series'>();
  private channelList!: ChannelList;
  private player!: Player;
  private livePreview!: LivePreview;
  private epgGrid!: EpgGrid;
  private settings!: Settings;
  private parentalControls!: ParentalControls;
  private parentalPinPrompt = new ParentalPinPrompt();
  private sidebar!: Sidebar;
  private menu!: PlayerMenu;
  private reminderPrompt = new ReminderPrompt();
  private reminderManager!: ReminderManager;
  private reminderManagerOrigin: 'settings' | 'epg' = 'settings';
  private tabBar!: TabBar;
  private search!: Search;
  private historyDropdown!: SearchHistoryDropdown;
  private movies!: Movies;
  private series!: Series;
  private lastSearchQuery = '';
  private enterChannelsAfterUploadSync = false;
  private remindersInitialized = false;
  private bundledServiceStarting = false;
  private serviceEventsSubscription: LunaRequestHandle | null = null;
  private deviceSetupSync = Promise.resolve();
  private playlistRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private playlistRefreshIntervalMs: number | null | undefined;
  private playlistRefreshPromise: Promise<void> | null = null;
  // The load confirmation toast owns the screen until loadData() settles.
  private loadingData = false;
  private epgRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private epgRefreshIntervalMs: number | null | undefined;
  private epgChannelReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private searchCatalogPreloadTimer: ReturnType<typeof setTimeout> | null = null;
  private hideArabic = StorageService.getHideArabic();
  private readonly searchPrewarm = new SearchIndexPrewarmer(() => this.searchPrewarmSources());

  async init(): Promise<void> {
    const done = log.time('init');
    log.info('Initializing app');
    await StorageService.init();
    ParentalControlService.reload();
    StorageService.setPlaylistsReplacedHandler((previous, next) =>
      ParentalControlService.reviewChangedSources(previous, next));
    ParentalControlService.setChallengeHandler(request =>
      this.parentalPinPrompt.showChallenge(request));
    StorageService.setWriteFailureHandler(() => showToast(t('app.saveFailed')));
    this.searchPrewarm.watchSourceWrites();
    initLocale(StorageService.getLocalePreference());
    applyAnimationMode(StorageService.getAnimationMode());
    const initialLoadingText = $('#loading-text');
    if (initialLoadingText) initialLoadingText.textContent = t('common.loading');
    initTheme();
    this.views = {
      channels: $('#view-channels')!,
      player: $('#view-player')!,
      epg: $('#view-epg')!,
      settings: $('#view-settings')!,
      'parental-controls': $('#view-parental-controls')!,
      reminders: $('#view-reminders')!,
      movies: $('#view-movies')!,
      series: $('#view-series')!,
      search: $('#view-search')!,
      loading: $('#view-loading')!,
    };

    this.channelList = new ChannelList(
      $('#channel-browser')!,
      {
        onChannelSelect: (idx, catchup, scope, mode) =>
          this.livePreview.selectChannel(idx, catchup, scope, mode),
        onChannelsChanged: () => {
          this.player.syncCurrentIndex();
          this.scheduleEpgReload();
        },
        onEpgMappingChanged: () => this.scheduleEpgReload(),
        onEpgOffsetChanged: () => {
          void this.search.refreshPrograms();
        },
        onEnterPreview: () => this.livePreview?.focusControls() ?? false,
        authorizeEdit: proceed =>
          this.authorizeLiveEditing(t('settings.editChannelList'), proceed),
        onListFocus: () => this.livePreview?.leaveControls(false),
        getPreviewHintState: () => this.livePreview?.hintState() ?? 'off',
        onEnterManagement: () => this.livePreview?.close(),
      },
    );
    this.player = new Player(this.views.player, () => {
      this.channelList.render();
      this.showView('channels');
    }, (idx, catchupStart) => {
      this.channelList.setPlaying(idx, catchupStart);
      if (this.livePreview?.isShowing) this.channelList.render(false);
    },
    () => !this.sidebar.visible && !this.menu.visible,
    () => {
      this.sidebar.refresh();
    }, () => {
      this.livePreview?.refresh();
      this.menu.refresh();
    },
    () => this.livePreview?.canResumePlayback() ?? true,
    (channel, action, preview, ask = true) => {
      const request = liveParentalRequest(channel, preview ? 'preview' : 'play');
      if (!ask && !ParentalControlService.decision(request).allowed) return false;
      return ParentalControlService.authorize(request, () => {
        if (!preview && !this.isCurrentView('player')) this.showView('player');
        action();
      });
    },
    (item, action) => ParentalControlService.authorize(
      vodParentalRequest(item, item.resumeSecs > 0 ? 'resume' : 'play'),
      () => {
        if (!this.isCurrentView('player')) this.showView('player');
        action();
      },
    ));
    this.epgGrid = new EpgGrid(
      this.views.epg,
      (idx, catchup, scope) => this.playChannel(idx, catchup, scope),
      () => this.leaveUp(),
      () => this.openReminderManager('epg'),
    );
    this.reminderManager = new ReminderManager(this.views.reminders, () => {
      if (this.reminderManagerOrigin === 'epg') {
        this.showView('epg');
        this.epgGrid.focusReminderEntry();
      } else {
        this.showView('settings');
        this.settings.focusReminderEntry();
      }
    });
    this.settings = new Settings(
      this.views.settings,
      (action) => this.onSettingsSaved(action),
      () => this.player.syncCurrentIndex(),
      () => this.openReminderManager('settings'),
      () => this.openParentalControls(),
      (name, proceed) => this.authorizeLiveEditing(name, proceed),
      (id, proceed, turnOff) => this.authorizeSourceRemoval(id, proceed, turnOff),
    );
    this.parentalControls = new ParentalControls(
      this.views['parental-controls'],
      () => this.leaveParentalControls(),
      done => this.parentalPinPrompt.showChange(done),
      done => this.parentalPinPrompt.showCreate(done),
    );

    this.player.init($('#video-player') as HTMLVideoElement);
    this.livePreview = new LivePreview($('#live-preview')!, {
      channelView: this.views.channels,
      player: this.player,
      channelList: this.channelList,
      getCurrentView: () => this.viewStack[this.viewStack.length - 1],
      showChannels: preserveFocus => this.showView('channels', preserveFocus),
      showPlayer: () => this.showView('player'),
      playFullscreen: (index, catchup, scope) => this.playChannel(index, catchup, scope),
      blurTabBar: () => this.tabBar.blur(),
      expansionBlocked: () => this.reminderPrompt.visible,
      isFavorite: channel => StorageService.getFavorites().includes(channelKey(channel)),
      toggleFavorite: channel => this.toggleChannelFavorite(channel),
    });
    window.addEventListener('resize', () => this.livePreview.refreshLayout());
    ParentalControlService.subscribe(concealmentChanged =>
      this.onParentalLocksChanged(concealmentChanged));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.parentalPinPrompt.dismiss();
        // Whoever comes back must not find the manager open without a PIN.
        if (this.isCurrentView('parental-controls')) this.leaveParentalControls();
        ParentalControlService.lock('backgrounded');
        this.livePreview.suspend();
      } else {
        this.livePreview.refresh();
        this.livePreview.refreshLayout();
      }
    });

    this.sidebar = new Sidebar(
      this.views.player,
      () => this.player.getCurrentIndex(),
      (idx, catchup, scope) => this.playChannel(idx, catchup, scope),
      () => this.player.getCurrentCatchupStart(),
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
      () => this.player.getPlaybackRateState(),
      (rate) => this.player.setPlaybackRate(rate),
      () => this.player.subtitleSearchAvailable(),
      () => this.player.openSubtitleSearch(),
    );

    this.movies = new Movies(this.views.movies, {
      onRevealTabBar: () => this.leaveUp(),
      onBack: () => this.goLive(),
      onPlayVod: (req) => {
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
      onRevealTabBar: () => this.leaveUp(),
      onBack: () => this.goLive(),
      onPlayVod: (req) => {
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
      onRevealTabBar: () => this.leaveUp(),
      onReleaseTabBar: () => this.tabBar.blur(),
      // Step back out to the search box, which a second Back closes.
      onBack: () => {
        if (this.tabBar.searchOpen) this.tabBar.focus();
        else this.goLive();
      },
      onPlayChannel: (idx, catchup) => { this.tabBar.blur(); this.playChannel(idx, catchup); },
      onOpenMovie: (account, vod) => {
        this.tabBar.blur();
        this.searchDetailViews.add('movies');
        this.showView('movies');
        this.movies.openItem(account, vod, () => this.showView('search'))
          .catch((err) => log.error(
            'Open movie failed',
            'event=xtream.view.open.failed',
            'operation=movie_detail',
            err,
          ));
      },
      onOpenSeries: (account, series) => {
        this.tabBar.blur();
        this.searchDetailViews.add('series');
        this.showView('series');
        this.series.openItem(account, series, () => this.showView('search'))
          .catch((err) => log.error(
            'Open series failed',
            'event=xtream.view.open.failed',
            'operation=series_detail',
            err,
          ));
      },
    });
    this.historyDropdown = new SearchHistoryDropdown({
      onPick: (query) => {
        this.tabBar.setSearchQuery(query);
        this.tabBar.blur();
        this.handleSearchQuery(query);
        this.search.focusFirstResult();
      },
      onCleared: () => this.tabBar.focus(),
      onReturnToInput: () => this.tabBar.focus(),
      onDismiss: () => this.tabBar.closeSearch(),
    });
    this.tabBar = new TabBar({
      onSwitch: (section) => this.switchSection(section),
      onEnter: (section, via) => this.enterSection(section, via),
      onSearchQuery: (query) => this.handleSearchQuery(query),
      onSearchLeave: () => {
        if (this.lastSearchQuery.trim()) {
          this.search.focusFirstResult();
          return true;
        }
        return this.openHistoryDropdown() && this.historyDropdown.focusFirst();
      },
      onSearchClose: () => this.handleSearchClose(),
      onSelectAccount: (id) => this.selectXtreamAccount(id),
      onAccountMenuOpen: () => this.historyDropdown.close('account-menu'),
      onAccountMenuClose: (reason, hit) => {
        // A click into the content dismissed the menu; that click's select
        // must reach the content, so don't pull focus back into the box.
        if (reason === 'outside' || !this.tabBar.searchOpen || !this.tabBar.shown) {
          this.historyDropdown.close('view-change');
          return;
        }
        this.tabBar.focus();
        // The scrim's own click handler dismisses search next.
        if (hit && this.historyDropdown.dismissedBy(hit)) return;
        // So does a tab's or the magnifier's: the switcher's capture-phase
        // listener closes the menu before the bar's handler acts on it.
        if (hit?.closest('.tab-bar-item')) return;
        if (!this.lastSearchQuery.trim()) this.openHistoryDropdown();
      },
      onLockNow: () => ParentalControlService.lock('lock-now'),
    });
    this.tabBar.init();

    KeyHandler.init();
    KeyHandler.setHandler((action, event) => {
      this.handleKey(action, event);
      // Any key ends a pointer entry's wait, even one that acted elsewhere.
      FocusRing.reveal('key', action);
      FocusRing.sync();
      Focus.input();
    });
    this.initFocusScopes();
    FocusRing.install(() => {
      const owner = Focus.owner();
      return { root: owner?.root() ?? null, modal: !!owner?.modal, id: owner?.id };
    });
    KeyHandler.setChannelCount(() => PlaylistService.channels.length);

    this.initSidebarTrigger();

    done();
    this.enterChannelsAfterUploadSync = StorageService.getPlaylists().length === 0;
    this.bindBundledServiceLifecycle();
    this.bindReminderLifecycle();
    // Register a retail-safe callback immediately. If Developer Mode is
    // detected below, the same named activities are replaced with alerts.
    ReminderService.reschedulePending();
    await this.loadData();
    // Cold launch from a "Watch now" alert: channels are loaded now, so tune.
    this.handleLaunchParams(this.coldLaunchParams());
    // Spawning the service process can synchronously stall Luna on a cold TV.
    // Keep LAN setup off the critical path so cached channels render first.
    const bundledServiceReady = this.startBundledService();
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
        void this.flushUserData('background');
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

  private async flushUserData(reason: 'background' | 'exit'): Promise<boolean> {
    try {
      await Promise.all([StorageService.flush(), flushCacheWrites()]);
      log.info(
        'User data flush completed',
        'event=persistence.user.flush.completed',
        'operation=flush',
        `reason=${reason}`,
      );
      return true;
    } catch (err) {
      log.error(
        'User data flush failed',
        'event=persistence.user.flush.failed',
        'operation=flush',
        `reason=${reason}`,
        err,
      );
      return false;
    }
  }

  private async exitApp(): Promise<void> {
    if (!await this.flushUserData('exit')) {
      this.backPressTime = 0;
      showToast(t('app.saveFailed'));
      return;
    }
    this.stopBundledService();
    window.close();
  }

  private cancelServiceEventsSubscription(): void {
    if (!this.serviceEventsSubscription) return;
    try {
      this.serviceEventsSubscription.cancel();
    } catch (e) {
      log.warn('serviceEvents cancellation threw:', e);
    }
    this.serviceEventsSubscription = null;
  }

  /**
   * Fire-and-forget Luna call to gracefully shut down the bundled service.
   * The service closes its HTTP listener, releases its keepAlive activity,
   * and lets the Node process exit so neither the port nor the process
   * persists in the background.
   */
  private stopBundledService(): void {
    this.cancelServiceEventsSubscription();
    if (!isLunaAvailable()) {
      setServicePort(null);
      return;
    }
    try {
      lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
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
    if (!isLunaAvailable()) {
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
      // NOTE: no trailing '/' on the URI — the Luna client appends '/' + method,
      // so a trailing slash here produces 'luna://.../service//start' (double
      // slash) which Luna treats as a missing method and returns onFailure.
      try {
        lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
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
    this.subscribeToServiceEvents();
    if (!this.remindersInitialized) {
      const initialized = await this.queryDevMode();
      ReminderService.reschedulePending();
      this.remindersInitialized = initialized;
    }
    await this.queueDeviceSetupSync();
    void SetupClient.publishState();
    await this.settings.refreshSetupInfo();
    await this.settings.refreshUploads();
    await this.loadChannelsAfterFirstUpload();
  }

  private queueDeviceSetupSync(): Promise<void> {
    this.deviceSetupSync = this.deviceSetupSync
      .then(async () => {
        if (await SetupClient.applyPendingActions()) {
          await this.onSettingsSaved('reload');
        }
      })
      .catch(err => log.error('Device setup sync failed:', err));
    return this.deviceSetupSync;
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
    ReminderService.setDevMode(false);
    if (!isLunaAvailable()) {
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
        lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
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
   * Subscribe to the bundled service's `serviceEvents` push channel. Upload
   * changes refresh the managed upload list; phone setup changes consume the
   * queued Playlist, Xtream, or EPG action and reload channel data. No polling.
   *
   * Subscription is best-effort: if Luna isn't available (desktop/e2e) or
   * the subscribe call fails, we silently fall back to the explicit
   * refresh calls that bundled-service initialization runs on open.
   */
  private subscribeToServiceEvents(): void {
    if (!isLunaAvailable()) {
      log.debug('Luna unavailable — service event subscription skipped');
      return;
    }
    this.cancelServiceEventsSubscription();
    log.info('Subscribing to luna://' + CONFIG.SERVICE_ID + '/serviceEvents ...');
    try {
      this.serviceEventsSubscription = lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'serviceEvents',
        subscribe: true,
        parameters: {},
        onSuccess: (resp: unknown) => {
          log.info('serviceEvents push:', JSON.stringify(resp));
          if (resp && typeof resp === 'object' &&
              (resp as { subscribed?: unknown }).subscribed === true) return;
          if (resp && typeof resp === 'object' &&
              (resp as { event?: unknown }).event === 'setup-changed') {
            void this.queueDeviceSetupSync();
            return;
          }
          void this.settings.refreshUploads()
            .then(() => this.loadChannelsAfterFirstUpload())
            .catch(err => log.error('Upload event refresh failed:', err));
        },
        onFailure: (err: unknown) => {
          log.warn('serviceEvents subscription failed:', JSON.stringify(err));
        },
      });
    } catch (e) {
      log.warn('serviceEvents subscribe threw:', e);
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
    if (!StorageService.getPlaylists().some(isSourceEnabled)) return [];
    const manual = StorageService.getManualEpgSources()
      .map(source => ({ ...source, kind: 'manual' as const }));
    const discovered = withoutGuideOff(PlaylistService.epgSources, StorageService.getGuideOffSources());
    const sources: EpgSource[] = [...manual, ...discovered];
    const offsets = StorageService.getEpgOffsets();
    return sources.map(source => ({ ...source, offsetMinutes: offsets[source.url] ?? 0 }));
  }

  /**
   * The guide covers the eligible channels, so a visibility edit and a
   * mapping edit both have to re-derive it. Narrowing the selection is served
   * from the cache; only a selection that grew refetches.
   */
  private scheduleEpgReload(): void {
    if (this.epgChannelReloadTimer !== null) clearTimeout(this.epgChannelReloadTimer);
    this.epgChannelReloadTimer = setTimeout(() => {
      this.epgChannelReloadTimer = null;
      const sources = this.epgSources();
      if (!sources.length) return;
      void EpgService.load(
        sources,
        PlaylistService.getEpgEligibleChannels(),
        () => this.refreshEpgDependentViews(),
      )
        .then(() => {
          this.refreshEpgDependentViews();
        })
        .catch(err => log.error('EPG reload after a channel change failed:', err));
    }, CONFIG.EPG.CHANNEL_CHANGE_RELOAD_DELAY);
  }

  private stopEpgRefresh(): void {
    if (this.epgChannelReloadTimer !== null) {
      clearTimeout(this.epgChannelReloadTimer);
      this.epgChannelReloadTimer = null;
    }
    this.epgRefreshIntervalMs = undefined;
    if (this.epgRefreshTimer !== null) {
      clearTimeout(this.epgRefreshTimer);
      this.epgRefreshTimer = null;
    }
  }

  private scheduleEpgRefresh(force = false, delayOverride?: number): void {
    const intervalMs = StorageService.getEpgRefreshIntervalMs();
    const shouldRun = intervalMs !== null && this.epgSources().length > 0;
    if (!force
      && this.epgRefreshIntervalMs === intervalMs
      && ((shouldRun && this.epgRefreshTimer !== null)
        || (!shouldRun && this.epgRefreshTimer === null))) {
      return;
    }
    if (this.epgRefreshTimer !== null) {
      clearTimeout(this.epgRefreshTimer);
      this.epgRefreshTimer = null;
    }
    this.epgRefreshIntervalMs = intervalMs;
    if (!shouldRun || intervalMs === null) return;
    const delayMs = delayOverride ?? EpgService.getNextRefreshDelayMs(intervalMs);
    this.epgRefreshTimer = setTimeout(() => {
      this.epgRefreshTimer = null;
      EpgService.refresh(() => this.refreshEpgDependentViews())
        .then((complete) => {
          this.refreshEpgDependentViews();
          this.scheduleEpgRefresh(
            true,
            complete ? undefined : StorageService.getEpgRefreshIntervalMs() ?? undefined,
          );
        }, (err) => {
          log.error('EPG refresh failed:', err);
          this.scheduleEpgRefresh(true, StorageService.getEpgRefreshIntervalMs() ?? undefined);
        });
    }, delayMs);
  }

  private stopPlaylistRefresh(): void {
    if (this.playlistRefreshTimer !== null) {
      clearTimeout(this.playlistRefreshTimer);
      this.playlistRefreshTimer = null;
    }
    this.playlistRefreshIntervalMs = undefined;
  }

  private schedulePlaylistRefresh(force = false, delayOverride?: number): void {
    const intervalMs = StorageService.getPlaylistRefreshIntervalMs();
    const shouldRun = intervalMs !== null
      && StorageService.getPlaylists().some(isSourceEnabled);
    if (!force
      && this.playlistRefreshIntervalMs === intervalMs
      && ((shouldRun && this.playlistRefreshTimer !== null)
        || (!shouldRun && this.playlistRefreshTimer === null))) {
      return;
    }
    if (this.playlistRefreshTimer !== null) {
      clearTimeout(this.playlistRefreshTimer);
      this.playlistRefreshTimer = null;
    }
    this.playlistRefreshIntervalMs = intervalMs;
    if (!shouldRun || intervalMs === null) return;
    const delayMs = delayOverride ?? PlaylistService.getNextRefreshDelayMs(intervalMs);
    this.playlistRefreshTimer = setTimeout(() => {
      this.playlistRefreshTimer = null;
      void this.queuePlaylistRefresh();
    }, delayMs);
  }

  private queuePlaylistRefresh(): Promise<void> {
    if (this.playlistRefreshPromise) return this.playlistRefreshPromise;
    const onSettled = () => {
      this.playlistRefreshPromise = null;
      this.schedulePlaylistRefresh(
        true,
        StorageService.getPlaylistRefreshIntervalMs() ?? undefined,
      );
    };
    this.playlistRefreshPromise = this.refreshPlaylistInBackground()
      .then(() => {
        onSettled();
      }, (err) => {
        onSettled();
        throw err;
      });
    return this.playlistRefreshPromise;
  }

  private async refreshPlaylistInBackground(): Promise<void> {
    try {
      if (!StorageService.getPlaylists().some(isSourceEnabled)) return;
      await PlaylistService.refresh(undefined, { preserveOnFailure: true });
      this.player.syncCurrentIndex();
      await ChannelHealthService.initialize();

      const epgSources = this.epgSources();
      if (epgSources.length) {
        await EpgService.load(
          epgSources,
          PlaylistService.getEpgEligibleChannels(),
          () => this.refreshEpgDependentViews(),
        );
        await EpgService.refresh(() => this.refreshEpgDependentViews());
        this.refreshEpgDependentViews();
      } else {
        EpgService.reset();
        this.refreshEpgDependentViews();
      }
      this.scheduleEpgRefresh(true);

      const playlists = StorageService.getPlaylists();
      const xtreamAccounts = playlists
        .filter((playlist) =>
          playlist.source === 'xtream' && playlist.xtream && isSourceEnabled(playlist));
      this.tabBar.setSections(xtreamAccounts.length > 0);
      this.tabBar.setAccounts(xtreamAccounts, this.activeXtreamAccount()?.id ?? '');
      this.channelList.render();
      this.sidebar.refresh();
      this.livePreview?.refresh();
      this.showLiveCategoryNotices();
    } catch (err) {
      log.error('Automatic playlist refresh failed:', err);
    }
  }

  private async loadData(forceEpgRefresh = false): Promise<void> {
    const done = log.time('loadData');
    this.loadingData = true;
    show(this.views.loading);
    this.stopEpgRefresh();
    this.stopPlaylistRefresh();
    if (this.playlistRefreshPromise) await this.playlistRefreshPromise;

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
      let lastProgressAt = 0;
      await PlaylistService.load(progress => {
        if (!loadingText) return;
        const now = Date.now();
        if (now - lastProgressAt < 250) return;
        lastProgressAt = now;
        loadingText.textContent = t('app.loadingChannelsProgress', {
          processed: progress.channelsProcessed,
          kept: progress.channelsKept,
        });
      });
      this.player.syncCurrentIndex();
      await ChannelHealthService.initialize();
      log.info('Channels loaded:', PlaylistService.channels.length,
        '| groups:', PlaylistService.groups.length,
        '| epgSources:', PlaylistService.epgSources);
      const epgSources = this.epgSources();
      if (epgSources.length) log.info('Using EPG sources:', epgSources);
      else {
        log.warn('No EPG sources configured');
        EpgService.reset();
      }
      const epgChannels = PlaylistService.getEpgEligibleChannels();
      if (epgSources.length) {
        await EpgService.restoreCached(epgSources, epgChannels);
      }

      const hasXtream = StorageService.getPlaylists()
        .some((p) => p.source === 'xtream' && isSourceEnabled(p));
      this.tabBar.setSections(hasXtream);
      const xtreamAccounts = StorageService.getPlaylists()
        .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p));
      this.tabBar.setAccounts(xtreamAccounts, this.activeXtreamAccount()?.id ?? '');

      this.showView('channels');
      this.channelList.render();

      showToast(tp('app.channelsLoaded', PlaylistService.channels.length));
      // Let the load confirmation finish before a new-category notice replaces it.
      setTimeout(() => this.showLiveCategoryNotices(), 3000);

      this.scanReminders();
      ReminderService.reschedulePending();

      if (StorageService.getAutoPlay()) {
        // The per-stream key survives customization and provider reshuffles.
        const lastCh = PlaylistService.resolveLastChannelIndex(
          StorageService.getLastChannelKey(),
          StorageService.getLastChannel(),
        );
        const last = PlaylistService.channels[lastCh];
        // A locked channel must not open a PIN prompt over a cold start.
        if (last && ParentalControlService.decision(liveParentalRequest(last)).allowed) {
          log.info('Auto-play resuming last channel index', lastCh);
          this.playChannel(lastCh);
        }
      }

      if (epgSources.length) {
        if (forceEpgRefresh) {
          EpgService.refresh(() => this.refreshEpgDependentViews(), true)
            .then(() => {
              this.refreshEpgDependentViews();
              this.scheduleEpgRefresh(
                true,
                StorageService.getEpgRefreshIntervalMs() ?? undefined,
              );
            }, (err) => {
              log.error('EPG load failed:', err);
              this.scheduleEpgRefresh(
                true,
                StorageService.getEpgRefreshIntervalMs() ?? undefined,
              );
            });
        } else if (StorageService.getEpgRefreshIntervalMs() === null) {
          EpgService.refresh(() => this.refreshEpgDependentViews())
            .then(() => {
              this.refreshEpgDependentViews();
            }, err => log.error('Initial EPG load failed:', err));
        } else {
          this.scheduleEpgRefresh(true);
        }
      }
      this.schedulePlaylistRefresh(true);
      this.searchPrewarm.schedule('startup');
      this.scheduleSearchCatalogPreload();
    } catch (err) {
      log.error('loadData failed:', err);
      this.showView('settings');
      this.settings.render();
      showToast(t('app.loadFailed'));
    } finally {
      this.loadingData = false;
      hide(this.views.loading);
      done();
    }
  }

  // New Live categories are announced only over the channel list, never over
  // fullscreen playback; otherwise they wait for the next visit.
  private showLiveCategoryNotices(): void {
    if (this.loadingData || !this.isCurrentView('channels')
      || !PlaylistService.hasLiveCategoryNotices()) return;
    const notices = PlaylistService.takeLiveCategoryNotices();
    const messages = notices.map(notice =>
      tp('liveCategories.newToast', notice.count, { name: notice.accountName }));
    log.info('Xtream Live categories announced', 'event=xtream.category_filter.announced',
      `count=${String(notices.reduce((sum, notice) => sum + notice.count, 0))}`,
      `items=${String(notices.length)}`);
    showToast(messages.join(' '), 3000 * messages.length);
  }

  private isCurrentView(name: ViewName): boolean {
    return this.viewStack[this.viewStack.length - 1] === name;
  }

  private leaveParentalControls(): void {
    this.settings.render();
    this.showView('settings');
  }

  private showView(name: ViewName, preserveChannelFocus = false, resumeChannelFocus = false): void {
    // Every way out of the manager (Back, color keys, tab bar, a reminder)
    // ends management so concealment returns; the manager never stays stacked.
    if (name !== 'parental-controls' && this.isCurrentView('parental-controls')) {
      this.parentalControls.close();
      this.parentalPinPrompt.dismissManagement();
      ParentalControlService.endManagement();
      this.viewStack = ['settings'];
    }
    this.historyDropdown?.close('view-change');
    this.livePreview?.beforeViewChange(name);
    if (name !== 'channels' && this.channelList.isEditing) this.channelList.exitEditMode();
    // Re-assert the persisted theme on every view transition. This reverts any
    // unsaved live preview when Settings closes (Back / section switch / Cancel)
    // while keeping a just-saved theme, since save() persists before this runs.
    applyTheme(StorageService.getTheme());
    applyOverlayStyle(StorageService.getOverlayStyle());
    applyTextSize(StorageService.getTextSize());
    applyAnimationMode(StorageService.getAnimationMode());
    this.player.closeSubtitleSearch(); // never let the subtitle overlay linger across a view change
    this.player.closeSubtitleOffset(); // never let the subtitle-sync overlay linger across a view change
    this.epgGrid.dismissPrompt(); // never let the catch-up prompt linger across a view change
    this.search.dismissPrompt();
    this.settings.dismissPrompt();
    this.reminderManager.dismissPrompt();
    for (const [key, el] of Object.entries(this.views)) {
      if (key === 'loading') continue;
      if (key === name) show(el);
      else hide(el);
    }

    if (name === 'player') {
      if (this.viewStack[this.viewStack.length - 1] !== name) this.viewStack.push(name);
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
    if (name === 'channels' && !this.tabBar.focused && !preserveChannelFocus) {
      this.channelList.highlightEntryPoint(resumeChannelFocus);
    }

    // Keep the active tab bound to the shown section view (so returning from
    // Settings, EPG, the player, etc. updates the underline). Skipped while the
    // search box is open — it overlays other views but stays "Search".
    if (section && !this.tabBar.searchOpen) this.tabBar.setActive(section);
    this.livePreview?.refresh();
    if (name === 'channels') this.showLiveCategoryNotices();
  }

  // Map a tab-bar section to its view and show it (Live = the channels view).
  private switchSection(section: Section): void {
    if (section !== 'live' && this.channelList.isEditing) this.channelList.exitEditMode();
    if (section !== 'movies' && section !== 'search') this.movies.deactivate();
    if (section !== 'series' && section !== 'search') this.series.deactivate();
    if (section !== 'search') this.search.deactivate();
    if (section === 'live') {
      if (!this.livePreview.returnFromFullscreen(false)) {
        this.player.stop();
        this.showView('channels');
        this.channelList.render();
        // A switch from the bar lands on the entry point the bar's Down resumes.
        if (this.tabBar.focused) this.channelList.highlightEntryPoint();
      }
      return;
    }
    this.player.stop();
    if (section === 'epg') { this.openEpg(); return; }
    if (section === 'movies') {
      this.showView('movies');
      const account = this.activeXtreamAccount();
      if (account) {
        this.movies.open(account)
          .catch((err) => log.error(
            'Movies open failed',
            'event=xtream.view.open.failed',
            'operation=movies',
            err,
          ));
      }
      return;
    }
    if (section === 'series') {
      this.showView('series');
      const seriesAccount = this.activeXtreamAccount();
      if (seriesAccount) {
        this.series.open(seriesAccount)
          .catch((err) => log.error(
            'Series open failed',
            'event=xtream.view.open.failed',
            'operation=series',
            err,
          ));
      }
      return;
    }
    if (section === 'settings') {
      this.settings.render();
      this.showView('settings');
      return;
    }
    // Search: keep the current view, under the recent-searches dropdown; the
    // results view covers it once a query is typed (handleSearchQuery).
    // Remember where to return to.
    if (this.viewStack[this.viewStack.length - 1] !== 'search') {
      this.viewBeforeSearch = this.viewStack[this.viewStack.length - 1];
      // Left over from a search that ended by switching section.
      this.searchDetailViews.clear();
    }
    // Prep the results (loads the catalog once) into the still-hidden search view.
    this.search.open(this.activeXtreamAccount())
      .catch((err) => log.error(
        'Search open failed',
        'event=xtream.view.open.failed',
        'operation=search',
        err,
      ));
    this.lastSearchQuery = '';
    this.tabBar.afterSearchExpanded(() => {
      const skip = this.lastSearchQuery.trim() ? 'typed'
        : this.historyDropdown.isOpen ? 'open'
          : this.tabBar.accountMenuOpen ? 'account-menu' : '';
      if (skip) {
        log.debug('Recent searches deferred open skipped', 'event=search.history.open.skipped', `reason=${skip}`);
        return;
      }
      this.openHistoryDropdown();
    });
  }

  // The tab bar's search box query changed: show the results view over the
  // current one while non-empty; when cleared, restore the underlying view
  // and drop the recent searches back down over it.
  private handleSearchQuery(query: string): void {
    this.lastSearchQuery = query;
    this.search.scheduleQuery(query);
    const hasQuery = query.trim().length > 0;
    const current = this.viewStack[this.viewStack.length - 1];
    const onSearch = current === 'search';
    if (hasQuery) {
      this.historyDropdown.close('typed');
      if (!onSearch) this.showView('search');
      return;
    }
    const onResultDetail = (current === 'movies' || current === 'series')
      && this.searchDetailViews.has(current);
    if (onSearch || onResultDetail) this.restoreViewBeforeSearch();
    this.openHistoryDropdown();
  }

  // Show the view Search opened over. A result's detail left in a catalog view
  // is dropped; the returned-to catalog keeps its browse unless a deep link
  // interrupted its load or the account changed under Search.
  private restoreViewBeforeSearch(): void {
    const rv = this.viewBeforeSearch ?? 'channels';
    const catalog = rv === 'movies' || rv === 'series' ? rv : null;
    const reopen = catalog && this.searchDetailViews.has(catalog) ? catalog : null;
    this.searchDetailViews.forEach((view) => { if (view !== reopen) this[view].deactivate(); });
    const details = this.searchDetailViews.size;
    this.searchDetailViews.clear();
    this.showView(rv);
    if (reopen) this[reopen].leaveDeepLink();
    const account = this.activeXtreamAccount();
    log.debug(
      'Search left; view restored',
      'event=search.view.restored',
      `source=${rv}`,
      `count=${String(details)}`,
      `reason=${reopen ? (account ? 'browse-restored' : 'no-account') : 'shown'}`,
      `filter=${this.tabBar.activeSection}`,
    );
    if (catalog) this[catalog].ensureLoaded(account);
  }

  private openHistoryDropdown(): boolean {
    const anchor = this.tabBar.searchOpen ? this.tabBar.searchAnchor() : null;
    if (anchor && this.historyDropdown.open(anchor)) return true;
    log.debug(
      'Recent searches not opened',
      'event=search.history.open.skipped',
      `reason=${anchor ? 'empty' : 'no-anchor'}`,
    );
    return false;
  }

  // The search box was closed: clear it and return to the view it opened from
  // (showView re-syncs the active tab, since the box is already collapsed).
  private handleSearchClose(): void {
    this.search.deactivate();
    this.search.setQuery('');
    this.restoreViewBeforeSearch();
    this.viewBeforeSearch = null;
  }

  // Show the guide and refresh its data in the background (shared by the EPG
  // tab and the red-key shortcut).
  private openEpg(): void {
    this.epgGrid.focusChannel(this.player.getCurrentIndex());
    this.showView('epg');
    this.epgGrid.render(true);
    const renderEpg = () => {
      this.refreshEpgDependentViews();
      this.epgGrid.render();
    };
    EpgService.refresh(renderEpg).then(() => {
      renderEpg();
    });
  }

  private reloadGuide(): void {
    const sources = this.epgSources();
    if (!sources.length) {
      EpgService.reset();
      this.refreshEpgDependentViews();
      return;
    }
    void EpgService.load(sources, PlaylistService.getEpgEligibleChannels(), () => this.refreshEpgDependentViews())
      .then(() => this.refreshEpgDependentViews())
      .catch(err => log.error('Guide reload after a settings change failed:', err));
  }

  private refreshEpgDependentViews(): void {
    this.applyDisplayTz();
    this.channelList.render();
    this.livePreview.refresh();
    void this.search.refreshPrograms();
    this.searchPrewarm.schedule('epg');
  }

  private openReminderManager(origin: 'settings' | 'epg'): void {
    this.reminderManagerOrigin = origin;
    this.showView('reminders');
    this.reminderManager.open();
  }

  private authorizeLiveEditing(name: string, proceed: () => void): void {
    const guarded = ParentalControlService.guardsLiveEditing;
    log.info('Parental settings guard', 'event=parental.guard', 'action=live-edit',
      `guarded=${String(guarded)}`);
    if (!guarded) {
      proceed();
      return;
    }
    this.parentalPinPrompt.showVerify(t('parental.enterFor', { name }), proceed);
  }

  private authorizeSourceRemoval(id: string, proceed: () => void, turnOff = false): void {
    const guarded = ParentalControlService.guardsSourceRemoval(id);
    log.info('Parental settings guard', 'event=parental.guard',
      `action=${turnOff ? 'source-turn-off' : 'source-remove'}`, `source=${encodeURIComponent(id)}`,
      `guarded=${String(guarded)}`);
    if (!guarded) {
      proceed();
      return;
    }
    const name = StorageService.getPlaylists().find(entry => entry.id === id)?.name ?? '';
    this.parentalPinPrompt.showVerify(
      t(turnOff ? 'parental.enterToTurnOff' : 'parental.enterToRemove', { name }), proceed);
  }

  private openParentalControls(): void {
    const open = () => {
      this.showView('parental-controls');
      this.parentalControls.open();
      ParentalControlService.logState('manager-opened');
    };
    if (!ParentalControlService.configured) {
      this.parentalPinPrompt.showCreate(open);
      return;
    }
    this.parentalPinPrompt.showVerify(t('settings.parentalControls'), open);
  }

  // Down/Select/Back from the bar, or a click on a tab: switch to the section
  // and drop focus into content.
  private enterSection(section: Section, via: 'key' | 'pointer'): void {
    this.tabBar.setActive(section);
    // Back into the shown section: re-opening it would drop unsaved edits and
    // the position the ring comes back to.
    if (via === 'key' && sectionForView(this.viewStack[this.viewStack.length - 1]) === section) {
      if (section === 'settings') {
        this.settings.resumeFocus();
        return;
      }
      // The catalog resumes its tile even when a wheel-scrolled rail no
      // longer renders it; enter('resume') would fall back to the first.
      if (section === 'movies' || section === 'series') {
        (section === 'movies' ? this.movies : this.series).resumeFocus();
        return;
      }
      // A view scope without keys of its own (a plain `view.*`) has nothing to resume.
      const owner = Focus.owner();
      if (owner?.logical) owner.enter('resume');
      return;
    }
    this.switchSection(section);
    // The pointer still rests on the tab, so the content's focus waits for a
    // key. Search keeps the keys in its own box.
    if (via === 'pointer' && section !== 'search') {
      FocusRing.defer(this.viewStack[this.viewStack.length - 1]);
    }
  }

  private goLive(): void {
    this.movies.deactivate();
    this.series.deactivate();
    this.search.deactivate();
    this.player.stop();
    this.tabBar.setActive('live');
    this.showView('channels');
    this.channelList.render();
  }

  // Sources the next Search open will read; an open Search stores its own.
  private searchPrewarmSources(): SearchPrewarmSource[] {
    const current = this.viewStack[this.viewStack.length - 1];
    if (current === 'search' || this.tabBar.searchOpen) return [];
    const sources: SearchPrewarmSource[] = [];
    const playlist = PlaylistService.getChannelCacheSource()?.record;
    if (playlist) sources.push({ ...playlist });
    for (const record of EpgService.getProgrammeCacheRecords()) {
      sources.push({ store: EPG_STORE, key: record.url, timestamp: record.timestamp });
    }
    const account = this.activeXtreamAccount();
    if (account) {
      sources.push(
        { store: CATALOG_STORE, key: `${account.id}|${VOD_CATALOG_RESOURCE}` },
        { store: CATALOG_STORE, key: `${account.id}|${SERIES_CATALOG_RESOURCE}` },
      );
    }
    return sources;
  }

  private scheduleSearchCatalogPreload(): void {
    if (this.searchCatalogPreloadTimer !== null) clearTimeout(this.searchCatalogPreloadTimer);
    this.searchCatalogPreloadTimer = setTimeout(() => {
      this.searchCatalogPreloadTimer = null;
      const account = this.activeXtreamAccount();
      if (account) void preloadSearchCatalog(account);
    }, CONFIG.XTREAM.SEARCH_CATALOG_PRELOAD_DELAY_MS);
  }

  private activeXtreamAccount(): PlaylistEntry | null {
    const accounts = StorageService.getPlaylists()
      .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p));
    const selId = StorageService.getSelectedXtreamAccountId();
    return accounts.find((a) => a.id === selId) ?? accounts[0] ?? null;
  }

  // A different Xtream account was picked in the avatar dropdown: persist it and
  // reload whichever account-scoped section is showing. Live/Settings just store.
  private selectXtreamAccount(id: string): void {
    StorageService.setSelectedXtreamAccountId(id);
    ParentalControlService.lock('account-switched');
    const account = this.activeXtreamAccount();
    if (!account) return;
    log.info('Xtream account switched to', account.name);
    this.searchPrewarm.schedule('account');
    this.tabBar.setAccounts(
      StorageService.getPlaylists()
        .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p)),
      account.id,
    );
    this.reopenAccountSection(account);
  }

  private reopenAccountSection(account: PlaylistEntry): void {
    const current = this.viewStack[this.viewStack.length - 1];
    if (current === 'movies') {
      this.movies.open(account)
        .catch((err) => log.error(
          'Movies reopen failed',
          'event=xtream.view.open.failed',
          'operation=movies_reopen',
          err,
        ));
    } else if (current === 'series') {
      this.series.open(account)
        .catch((err) => log.error(
          'Series reopen failed',
          'event=xtream.view.open.failed',
          'operation=series_reopen',
          err,
        ));
    }
    // Recent searches keep the box open over Live/Guide, so the stack may not
    // say 'search' even though the box will search the new account next.
    if (current === 'search' || this.tabBar.searchOpen) {
      this.search.open(account)
        .then(() => this.search.setQuery(this.lastSearchQuery))
        .catch((err) => log.error(
          'Search reopen failed',
          'event=xtream.view.open.failed',
          'operation=search_reopen',
          err,
        ));
    }
  }

  // Rebuild every surface that drops concealed content. Lists re-derive from the
  // filtered channels and catalogs; stored favorites/history are never touched.
  private onParentalLocksChanged(concealmentChanged: boolean): void {
    if (concealmentChanged) {
      PlaylistService.applyCustomization();
      this.player.syncCurrentIndex();
      this.search.invalidateCatalog();
    }
    const current = this.viewStack[this.viewStack.length - 1];
    if (current === 'channels') this.channelList.render();
    else if (current === 'epg') this.epgGrid.render();
    else if (current === 'settings' && concealmentChanged) this.settings.refreshCollectionCounts();
    // The search box can be open over another view, with Search still live behind it.
    if (current === 'search' || this.tabBar.searchOpen) {
      if (concealmentChanged) void this.search.refreshConcealment();
      else this.search.refreshLocks();
    }
    const account = this.activeXtreamAccount();
    if (account && (current === 'movies' || current === 'series')) {
      if (concealmentChanged) this.reopenAccountSection(account);
      else (current === 'movies' ? this.movies : this.series).refreshLocks();
    }
    this.sidebar.refresh();
    ReminderService.refreshParentalCopy();
    this.tabBar?.setParentalSession(ParentalControlService.sessionActive);
    // The Lock button came or went, shifting the search box under the panel.
    if (this.historyDropdown?.isOpen) this.openHistoryDropdown();
    if (concealmentChanged) this.livePreview?.refresh();
  }

  private playChannel(index: number, catchup?: CatchupInfo, scope: ChannelScope | null = null): void {
    this.player.play(index, catchup, scope, false);
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
      return;
    }
    const concealed = ReminderService.resolveConcealedLaunchChannel(raw);
    if (concealed) this.playConcealedReminder(concealed.key, concealed.channel);
  }

  // The PIN prompt keeps the hidden channel's name out, as the notification did.
  private playConcealedReminder(key: string, channel: Channel): void {
    log.info('Concealed reminder channel requested', 'event=parental.reminder.concealed',
      `channel=${key}`);
    ParentalControlService.authorize({ ...liveParentalRequest(channel, 'reminder'), label: '' }, () => {
      // The unlock reveals the channel, but lists rebuild only after this runs.
      PlaylistService.applyCustomization();
      const index = ReminderService.resolveChannelIndex(key);
      if (index >= 0) this.playChannel(index);
      else {
        log.warn('Unlocked reminder channel is missing', 'event=parental.reminder.missing',
          `channel=${key}`);
      }
    });
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
    const concealed = ReminderService.concealedChannel(r.channelKey);
    this.reminderPrompt.show(
      truncate(r.title, CONFIG.REMINDER.TITLE_MAX),
      truncate(r.channelName, CONFIG.REMINDER.CHANNEL_MAX),
      {
      onConfirm: () => {
        ReminderService.remove(r.channelKey, r.startMs);
        const idx = ReminderService.resolveChannelIndex(r.channelKey);
        if (idx >= 0) this.playChannel(idx);
        else if (concealed) this.playConcealedReminder(r.channelKey, concealed);
        this.showNextReminder();
      },
      onCancel: () => {
        ReminderService.remove(r.channelKey, r.startMs);
        if (this.viewStack[this.viewStack.length - 1] === 'reminders') {
          this.reminderManager.open();
        }
        this.showNextReminder();
      },
    }, concealed !== null);
  }

  // The one answer to "who gets the next key": handleKey routes by the owner,
  // the key diagnostic timeline names it, and FocusRing lets only its root
  // show a ring. A "button does nothing" report is usually an unexpected
  // owner. Prompts, the tab bar, the sidebar, and the player's overlays push
  // themselves while shown (the player view still routes the menu's and the
  // subtitle search's keys); below them the shown view owns the keys.
  private initFocusScopes(): void {
    const current = () => this.viewStack[this.viewStack.length - 1];
    const views = new Map<ViewName, FocusScope>();
    const own: Partial<Record<ViewName, FocusScope>> = {
      epg: this.epgGrid.focusScope,
      channels: this.channelList.focusScope,
      settings: this.settings.focusScope,
      'parental-controls': this.parentalControls.focusScope,
      movies: this.movies.focusScope,
      series: this.series.focusScope,
      search: this.search.focusScope,
      reminders: this.reminderManager.focusScope,
    };
    for (const name of Object.keys(this.views) as ViewName[]) {
      views.set(name, own[name]
        ?? Focus.register({ id: `view.${name}`, root: this.views[name], leaveFor: { up: 'tabbar' } }));
    }
    Focus.setBase(() => views.get(current()) ?? null);
    Focus.install();
  }

  // Up off a view's top edge: the keys go wherever the owner hands them.
  private leaveUp(): void {
    Focus.owner()?.leave('up');
  }

  private handleKey(action: Action, event?: NumberEvent): void {
    const currentView = this.viewStack[this.viewStack.length - 1];
    const owner = Focus.owner();

    log.debug('Key routed', 'event=key.action', `action=${action}`,
      `view=${currentView}`, `owner=${owner?.id ?? 'none'}`,
      `number=${event ? String(event.number) : 'none'}`);

    // The digit OSD is body-mounted and outlives every view, so an abandoned
    // or committed entry must be cleared before a modal gets a chance to
    // swallow this.
    if (action === 'number_cancel') {
      hideNumberEntry();
      return;
    }
    if (action === 'number') hideNumberEntry();

    // The scope that owns the keys (by tier, then latest push) takes them first.
    if (owner?.handle(action, event)) return;

    // Direct channel entry: echo the digits while KeyHandler buffers them, in
    // the two views that act on them (the guide and prompts ignore numbers).
    if (action === 'number_input') {
      if (currentView === 'channels' || currentView === 'player') {
        showNumberEntry(event?.digits ?? '');
      }
      return;
    }

    // The manager owns its color keys (Lock all, Clear exceptions).
    if (currentView === 'parental-controls') {
      this.parentalControls.handleAction(action);
      return;
    }

    // Global shortcuts
    // While the channel list is in edit mode the color keys belong to the editor.
    const editingChannels = currentView === 'channels' && this.channelList.isEditing;
    if (action === 'red' && currentView !== 'epg' && !editingChannels) {
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.openEpg();
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
        } else if (!this.player.hideOsdForBack() && !this.livePreview.returnFromFullscreen(true)) {
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
        this.showView('channels', false, true);
        return;
      }
      if (currentView === 'settings') {
        if (this.settings.dismissDropdown()) return;
        this.tabBar.setActive('live');
        this.channelList.render();
        this.showView('channels');
        return;
      }
      if (currentView === 'reminders') {
        this.reminderManager.handleAction('back');
        return;
      }
      if (currentView === 'channels') {
        if (this.livePreview.handleBack()) return;
        if (this.channelList.handleBack()) return;
        const now = Date.now();
        if (now - this.backPressTime < 3000) {
          void this.exitApp();
        } else {
          this.backPressTime = now;
          showToast(t('app.exitHint'));
        }
        return;
      }
    }

    // The first key into a section the pointer entered only shows its focus:
    // it must not act on an item nobody has seen yet.
    if (FocusRing.revealForKey(action)) return;

    // Delegate to active view
    switch (currentView) {
      case 'channels': {
        if (this.livePreview.handleAction(action)) break;
        const moved = this.channelList.handleAction(action, event);
        if (action === 'up' && !moved) this.leaveUp();
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
          // An open VOD menu captures D-pad nav; Left or Right closes it. Right
          // opens it unless the player can seek; with the OSD up (kept up while
          // paused, until Back hides it), Left/Right seek and D-pad drives playback.
          if (this.menu.visible) {
            if (action === 'up' || action === 'down' || action === 'select') this.menu.handleAction(action);
            else if (action === 'left' || action === 'right') this.menu.hide();
          } else if (action === 'right' && this.player.vodRightOpensMenu()) {
            this.menu.show();
          } else {
            this.player.handleAction(action, event);
          }
          break;
        }
        // While the OSD is up on seekable catch-up, Left/Right seek instead of
        // opening the sidebar/menu (which stay reachable once the OSD hides).
        if ((action === 'left' || action === 'right')
            && !this.sidebar.visible && !this.menu.visible && this.player.canSeek()) {
          this.player.handleAction(action, event);
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
          this.player.handleAction(action, event);
        }
        break;
      case 'epg':
        this.epgGrid.handleAction(action, event);
        break;
      case 'settings':
        if (action === 'back') {
          this.channelList.render();
          this.showView('channels');
        } else if (!this.settings.handleAction(action) && action === 'up') {
          this.leaveUp();
        }
        break;
      case 'reminders':
        this.reminderManager.handleAction(action);
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
      // A modal over the player, such as the subtitle sync adjuster, keeps
      // the edge panels shut.
      const modal = !!Focus.owner()?.modal;

      // Protect the full-width area beside and below the OSD too: its edge
      // controls sit next to margins where an imprecise cursor can open a panel.
      const overTabs = !!(e.target as HTMLElement).closest('.player-sidebar .sidebar-tabs');
      if (!overOsd && !vod && !modal && e.clientX < 80 && !this.menu.visible) {
        this.sidebar.show();
        this.sidebar.handlePointerMove(e.clientX, false, overTabs);
      } else if (this.sidebar.visible) {
        const overSidebar = !!(e.target as HTMLElement).closest('.player-sidebar');
        const delayingDismiss = this.sidebar.handlePointerMove(e.clientX, overSidebar, overTabs);
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
      if (!overOsd && !modal && e.clientX > 1840 && !this.sidebar.visible) {
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
    this.toggleChannelFavorite(ch);
  }

  private toggleChannelFavorite(ch: Channel): void {
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
      this.channelList.enterEditMode('builtin:all');
      return;
    }
    if (action === 'reset') {
      await clearAllCachedData();
      await StorageService.clearUserData();
      StorageService.clearAll();
      log.info(
        'App reset completed',
        'event=persistence.reset.completed',
        'operation=clear',
      );
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
      // Republish on 'apply' too: subtitle credentials and other display-only
      // settings never reach the phone page otherwise. Advisory, so it never
      // holds up closing Settings.
      void SetupClient.publishState();
    }
    if (action === 'reload') {
      this.search.invalidateCatalog();
      await Promise.all([clearCachedPlaylist(), clearCachedCatalog()]);
      this.showView('channels');
      await this.loadData(true);
      return;
    }
    if (action === 'guide') this.reloadGuide();
    if (action !== 'cancel' && StorageService.getHideArabic() !== this.hideArabic) {
      this.hideArabic = StorageService.getHideArabic();
      // Hidden titles leave every list the way concealed ones do.
      this.onParentalLocksChanged(true);
    }
    // 'apply': only display settings changed — re-apply + re-render, no re-fetch.
    if (action === 'apply' || action === 'guide') {
      this.search.invalidateCatalog();
      this.applyDisplayTz();
      this.epgGrid.resetDay();
      this.scheduleEpgRefresh();
      this.schedulePlaylistRefresh();
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
