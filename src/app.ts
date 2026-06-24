import { CONFIG } from './config';
import { KeyHandler } from './navigation/key-handler';
import { PlaylistService } from './services/playlist-service';
import { EpgService } from './services/epg-service';
import { StorageService } from './services/storage-service';
import { UploadClient, setServicePort } from './services/upload-client';
import { ChannelList } from './components/channel-list';
import { Player } from './components/player';
import { EpgGrid } from './components/epg-grid';
import { Settings, type SaveAction } from './components/settings';
import { Sidebar } from './components/sidebar';
import { PlayerMenu } from './components/player-menu';
import { showToast } from './components/toast';
import { setDisplayTz } from './utils/time';
import { channelKey } from './utils/channel';
import { $, show, hide } from './utils/dom';
import { createLogger, installGlobalErrorHandlers, logEnvironment } from './utils/logger';
import type { Action, NumberEvent, CatchupInfo } from './types';

const log = createLogger('App');

type ViewName = 'channels' | 'player' | 'epg' | 'settings' | 'loading';

class App {
  private views!: Record<ViewName, HTMLElement>;
  private viewStack: ViewName[] = ['channels'];
  private backPressTime = 0;
  private channelList!: ChannelList;
  private player!: Player;
  private epgGrid!: EpgGrid;
  private settings!: Settings;
  private sidebar!: Sidebar;
  private menu!: PlayerMenu;

  async init(): Promise<void> {
    const done = log.time('init');
    log.info('Initializing app');
    this.views = {
      channels: $('#view-channels')!,
      player: $('#view-player')!,
      epg: $('#view-epg')!,
      settings: $('#view-settings')!,
      loading: $('#view-loading')!,
    };

    this.channelList = new ChannelList(
      this.views.channels,
      (idx) => this.playChannel(idx),
      () => {
        this.settings.render();
        this.showView('settings');
      },
    );
    this.player = new Player(this.views.player, () => {
      this.channelList.setPlayingIndex(this.player.getCurrentIndex());
      this.channelList.render();
      this.showView('channels');
    });
    this.epgGrid = new EpgGrid(this.views.epg, (idx, catchup) => this.playChannel(idx, catchup));
    this.settings = new Settings(this.views.settings, (action) => this.onSettingsSaved(action));

    this.player.init($('#video-player') as HTMLVideoElement);

    this.sidebar = new Sidebar(
      this.views.player,
      () => this.player.getCurrentIndex(),
      (idx) => this.playChannel(idx),
    );
    this.menu = new PlayerMenu(
      this.views.player,
      () => this.player.getCurrentIndex(),
      (action) => this.onMenuAction(action),
      () => this.player.getAudioTracks(),
      (index) => this.player.selectAudioTrack(index),
    );

    KeyHandler.init();
    KeyHandler.setHandler((action, event) => this.handleKey(action, event));

    this.initSidebarTrigger();

    done();
    await this.startUploadService();
    this.subscribeToUploadEvents();
    this.bindUploadServiceLifecycle();
    await this.loadData();
  }

  /**
   * Tie the upload service's lifetime to the app's foreground state. The
   * service holds an open LAN HTTP port and a Luna keepAlive activity, so we
   * stop it when the app is backgrounded (visibility → hidden) so neither
   * the port nor the service process lingers across the rest of webOS. On
   * visibility → visible we restart it and resubscribe.
   *
   * visibilitychange is reliable on this firmware (verified empirically; the
   * Player module's suspend/resume listens to the same event).
   */
  private bindUploadServiceLifecycle(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        log.info('App backgrounded — stopping upload service');
        this.stopUploadService();
      } else if (document.visibilityState === 'visible') {
        log.info('App foregrounded — restarting upload service');
        void (async () => {
          await this.startUploadService();
          this.subscribeToUploadEvents();
          // Settings may be the visible view; refresh the QR + upload list
          // so they reflect the new port and current upload set.
          void this.settings.refreshUploads();
        })();
      }
    });
  }

  /**
   * Fire-and-forget Luna call to gracefully shut down the upload service.
   * The service closes its HTTP listener, releases its keepAlive activity,
   * and lets the Node process exit so neither the port nor the process
   * persists in the background.
   */
  private stopUploadService(): void {
    type LunaService = { request: (uri: string, opts: unknown) => void };
    const w = window as unknown as { webOS?: { service?: LunaService } };
    const request = w.webOS?.service?.request;
    if (!request) return;
    try {
      request(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'stop',
        parameters: {},
        onSuccess: (resp: unknown) => log.info('Upload service stop onSuccess:', JSON.stringify(resp)),
        onFailure: (err: unknown) => log.warn('Upload service stop onFailure:', JSON.stringify(err)),
      });
    } catch (e) {
      log.warn('stopUploadService threw:', e);
    }
    // Forget the runtime port — next start will set it again via setServicePort.
    setServicePort(null);
  }

  /**
   * Ask the webOS Luna service bus to start the bundled webOS JS service
   * (see upload-service/). On non-webOS environments (desktop preview, e2e)
   * this is a no-op — the upload service is only available on device.
   *
   * We log onSuccess/onFailure explicitly so device logs (ares-inspect or
   * ares-monitor-log) show what happened, instead of guessing from silence.
   */
  private async startUploadService(): Promise<void> {
    type LunaService = { request: (uri: string, opts: unknown) => void };
    const w = window as unknown as { webOS?: { service?: LunaService } };
    const request = w.webOS?.service?.request;
    if (!request) {
      log.debug('webOS Luna service bus not available — skipping upload service start');
      return;
    }
    log.info('Calling luna://' + CONFIG.SERVICE_ID + '/start ...');
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (why: string): void => {
        if (settled) return;
        settled = true;
        log.info('startUploadService settled:', why);
        resolve();
      };
      const timer = setTimeout(() => finish('timeout after 3s'), 3000);
      // NOTE: no trailing '/' on the URI — the shim appends '/' + method,
      // so a trailing slash here produces 'luna://.../service//start' (double
      // slash) which Luna treats as a missing method and returns onFailure.
      try {
        request(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'start',
          parameters: {},
          onSuccess: (resp: unknown) => {
            clearTimeout(timer);
            if (resp && typeof resp === 'object' && 'port' in resp) {
              const p = (resp as { port?: unknown }).port;
              if (typeof p === 'number') setServicePort(p);
            }
            log.info('Upload service start onSuccess:', JSON.stringify(resp));
            finish('onSuccess');
          },
          onFailure: (err: unknown) => {
            clearTimeout(timer);
            log.error('Upload service start onFailure:', JSON.stringify(err));
            finish('onFailure');
          },
        });
      } catch (e) {
        clearTimeout(timer);
        log.error('Upload service start threw:', e);
        finish('threw');
      }
    });
  }

  /**
   * Subscribe to the upload service's `uploadEvents` push channel. Whenever
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
          // First response confirms the subscription (`{subscribed:true}`);
          // subsequent responses are change notifications. Either way, a
          // refresh is cheap and correct.
          void this.settings.refreshUploads();
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

  private async loadData(): Promise<void> {
    const done = log.time('loadData');
    show(this.views.loading);

    this.applyDisplayTz();
    this.epgGrid.resetDay(); // re-pick today; a tz change invalidates the remembered day index

    try {
      // Pull in uploaded playlists from the local upload service before we
      // read the configured playlist list. Reconcile is a no-op if the
      // service is unreachable, so this never blocks data load on device.
      await UploadClient.reconcile();
      const playlists = StorageService.getPlaylists();
      log.info('Configured playlists:', playlists.length);
      if (!playlists.length) {
        log.info('No playlists configured — opening settings');
        // Clear in-memory state so the channel list does not show stale
        // channels if the user navigates back from settings (e.g. with BACK).
        PlaylistService.reset();
        EpgService.reset();
        this.channelList.render();
        this.showView('settings');
        this.settings.render();
        showToast('Welcome! Add a playlist URL to get started.');
        return;
      }

      const loadingText = $('#loading-text');
      if (loadingText) loadingText.textContent = 'Loading channels...';
      await PlaylistService.load();
      log.info('Channels loaded:', PlaylistService.channels.length,
        '| groups:', PlaylistService.groups.length,
        '| epgUrls:', PlaylistService.epgUrls);

      // Use manually configured EPG URL, or fall back to embedded url-tvg from M3U
      let epgUrl = StorageService.getEpgUrl();
      if (!epgUrl && PlaylistService.epgUrls.length) {
        epgUrl = PlaylistService.epgUrls[0];
        StorageService.setEpgUrl(epgUrl);
        log.info('Using embedded EPG URL from M3U:', epgUrl);
      } else if (epgUrl) {
        log.info('Using configured EPG URL:', epgUrl);
      } else {
        log.warn('No EPG URL configured');
      }

      this.showView('channels');
      this.channelList.render();

      showToast(`${PlaylistService.channels.length} channels loaded`);

      if (StorageService.getAutoPlay()) {
        const lastCh = StorageService.getLastChannel();
        if (lastCh >= 0 && lastCh < PlaylistService.channels.length) {
          log.info('Auto-play resuming last channel index', lastCh);
          this.playChannel(lastCh);
        }
      }

      if (epgUrl) {
        EpgService.load()
          .then(() => { this.applyDisplayTz(); this.channelList.render(); })
          .catch(err => log.error('EPG load failed:', err));
        setInterval(() => EpgService.refresh()
          .then(() => { this.applyDisplayTz(); this.channelList.render(); })
          .catch(err => log.error('EPG refresh failed:', err)),
          CONFIG.EPG_REFRESH_INTERVAL);
      }
    } catch (err) {
      log.error('loadData failed:', err);
      this.showView('settings');
      this.settings.render();
      showToast('Failed to load playlist. Check your URL.');
    } finally {
      hide(this.views.loading);
      done();
    }
  }

  private showView(name: ViewName): void {
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

    // Focus search box (or gear if empty) on entry. No-op on first load (render runs after).
    if (name === 'channels') this.channelList.highlightEntryPoint();
  }

  private playChannel(index: number, catchup?: CatchupInfo): void {
    this.channelList.setPlayingIndex(index);
    this.showView('player');
    this.player.play(index, catchup);
  }

  private handleKey(action: Action, event?: NumberEvent): void {
    const currentView = this.viewStack[this.viewStack.length - 1];

    // Global shortcuts
    if (action === 'red' && currentView !== 'epg') {
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.showView('epg');
      this.epgGrid.render();
      // Refresh EPG data in background, then re-render
      EpgService.refresh().then(() => { this.applyDisplayTz(); this.epgGrid.render(); });
      return;
    }
    if (action === 'blue' && currentView !== 'settings') {
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
          this.sidebar.hide();
        } else if (this.menu.visible) {
          // Let the menu step out of its audio sub-menu before closing.
          if (!this.menu.handleBack()) this.menu.hide();
        } else {
          this.player.handleAction('back');
        }
        return;
      }
      if (currentView === 'epg' || currentView === 'settings') {
        this.channelList.render();
        this.showView('channels');
        return;
      }
      if (currentView === 'channels') {
        if (this.channelList.clearSearchIfActive()) return;
        const now = Date.now();
        if (now - this.backPressTime < 3000) {
          const webOS = (window as unknown as Record<string, { platformBack?: () => void }>).webOS;
          if (webOS?.platformBack) webOS.platformBack();
          else window.close();
        } else {
          this.backPressTime = now;
          showToast('Press back again to exit');
        }
        return;
      }
    }

    // Delegate to active view
    switch (currentView) {
      case 'channels':
        this.channelList.handleAction(action, event);
        break;
      case 'player':
        // While the OSD is up on seekable catch-up, Left/Right seek instead of
        // opening the sidebar/menu (which stay reachable once the OSD hides).
        if ((action === 'left' || action === 'right')
            && !this.sidebar.visible && !this.menu.visible && this.player.canSeek()) {
          this.player.handleAction(action);
          break;
        }
        if (action === 'left') {
          if (this.menu.visible) this.menu.hide();
          else if (this.sidebar.visible) this.sidebar.hide();
          else this.sidebar.show();
        } else if (action === 'right') {
          if (this.sidebar.visible) this.sidebar.hide();
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
        if (action === 'blue' || action === 'back') {
          this.channelList.render();
          this.showView('channels');
        } else {
          this.epgGrid.handleAction(action, event);
        }
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

      // Left sidebar (channels)
      if (e.clientX < 80 && !this.menu.visible) {
        this.sidebar.show();
      } else if (this.sidebar.visible) {
        const overSidebar = !!(e.target as HTMLElement).closest('.player-sidebar');
        if (overSidebar) {
          this.sidebar.resetTimer();
        } else if (e.clientX > 460 && !this.sidebar.keyboardOn) {
          // Never dismiss while the keyboard is on — the pointer naturally
          // leaves the sidebar on its way to the on-screen keyboard.
          this.sidebar.hide();
        }
      }

      // Right menu
      if (e.clientX > 1840 && !this.sidebar.visible) {
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
    const idx = this.player.getCurrentIndex();
    if (idx < 0) return;
    const ch = PlaylistService.getByIndex(idx);
    if (!ch) return;
    const key = channelKey(ch);
    StorageService.toggleFavorite(key);
    showToast(StorageService.getFavorites().includes(key)
      ? `Added "${ch.name}" to favorites`
      : `Removed "${ch.name}" from favorites`);
    this.channelList.render();
  }


  private async onSettingsSaved(action: SaveAction): Promise<void> {
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
