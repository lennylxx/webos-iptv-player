import type { Action, CatchupInfo, Channel, PlaylistEntry, Programme, VodItem, SeriesItem } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { ReminderService } from '../services/reminder-service';
import { StorageService } from '../services/storage-service';
import { XtreamArchiveService } from '../services/xtream-archive';
import { loadAllVodStreams, loadAllSeries } from '../services/xtream-catalog';
import { prepareSearchItems, rankByName, rankPrepared, type PreparedSearchItem } from '../utils/channel-search';
import { channelKey } from '../utils/channel';
import { formatDayLabel, formatTime } from '../utils/time';
import { showToast } from './toast';
import { CatchupResumePrompt } from './catchup-resume-prompt';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';

const log = createLogger('Search');

export interface SearchHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayChannel: (index: number, catchup?: CatchupInfo) => void;
  onOpenMovie: (account: PlaylistEntry, vod: VodItem) => void;
  onOpenSeries: (account: PlaylistEntry, series: SeriesItem) => void;
}

interface ProgramResult {
  channel: Channel;
  channelIndex: number;
  programme: Programme;
}

// The Search section: one query box over Channels / Programs / Movies / Series.
// Results are relevance-ranked and capped; movies and series match the account's
// full catalogs, loaded once on open and cached.
// Up from the box reveals the tab bar; Back returns to Live. The global key
// handler ignores INPUT keydowns, so the box owns its own text input + focus-out
// keys.
export class Search {
  private nav: SpatialNav;
  private account: PlaylistEntry | null = null;
  private query = '';
  private allVod: VodItem[] = [];
  private allSeries: SeriesItem[] = [];
  private programIndex: PreparedSearchItem<ProgramResult>[] = [];
  private loadedFor: string | null = null;
  private visiblePrograms: ProgramResult[] = [];
  private resumePrompt = new CatchupResumePrompt();

  constructor(private container: HTMLElement, private handlers: SearchHandlers) {
    this.nav = new SpatialNav(container);
    this.container.addEventListener('mouseleave', () => this.nav.clearHighlight());
    // Activate the result under the pointer by coordinate hit-test, so it lands
    // here regardless of D-pad focus; the container is marked `data-self-activate`
    // so the global click handler skips this subtree and doesn't double-fire.
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY));
  }

  private onPointerRelease(x: number, y: number): void {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    if (!el || !this.container.contains(el)) return;
    this.nav.focus(el);
    this.onSelect();
  }

  async open(account: PlaylistEntry | null): Promise<void> {
    this.account = account;
    this.query = '';
    this.buildProgramIndex();
    this.render();
    if (account) await this.loadCatalog(account);
  }

  /** The tab bar's search box drives the query; re-render the results for it. */
  setQuery(query: string): void {
    this.query = query;
    this.render();
  }

  refreshPrograms(): void {
    this.buildProgramIndex();
    if (this.query.trim()) this.render();
  }

  dismissPrompt(): void {
    this.resumePrompt.hide();
  }

  handleAction(action: Action): void {
    if (this.resumePrompt.visible) {
      this.resumePrompt.handleAction(action);
      return;
    }
    switch (action) {
      case 'up':
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        return;
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.handlers.onBack();
        return;
      default:
        return;
    }
  }

  // Load the whole catalogs once per account (cached in IndexedDB), guarding
  // against account-switch races so a stale in-flight load can't clobber the
  // current account's catalog. Non-blocking: open() already rendered the box.
  private async loadCatalog(account: PlaylistEntry): Promise<void> {
    if (this.loadedFor === account.id) return;
    try {
      const [vod, series] = await Promise.all([loadAllVodStreams(account), loadAllSeries(account)]);
      // A newer open() (account switch) superseded this load — discard the stale
      // result instead of clobbering the current account's catalog.
      if (this.account?.id !== account.id) return;
      this.allVod = vod;
      this.allSeries = series;
      this.loadedFor = account.id;
      log.debug('catalog loaded', vod.length, 'movies,', series.length, 'series');
      if (this.query.trim()) this.render();
    } catch (err) {
      log.error('catalog load failed:', err);
    }
  }

  private onSelect(): void {
    const el = this.nav.focused;
    if (!el) return;
    if (el.classList.contains('search-input')) {
      const input = el as HTMLInputElement;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (el.dataset.channelIndex !== undefined) {
      this.handlers.onPlayChannel(parseInt(el.dataset.channelIndex, 10));
    } else if (el.dataset.programIndex !== undefined) {
      void this.activateProgram(parseInt(el.dataset.programIndex, 10));
    } else if (this.account && el.dataset.streamId !== undefined) {
      const v = this.allVod.find((x) => x.streamId === el.dataset.streamId);
      if (v) this.handlers.onOpenMovie(this.account, v);
    } else if (this.account && el.dataset.seriesId !== undefined) {
      const s = this.allSeries.find((x) => x.seriesId === el.dataset.seriesId);
      if (s) this.handlers.onOpenSeries(this.account, s);
    }
  }

  /** Move focus into the first result (called when the tab bar's search box
   *  hands off with Enter / Down). */
  focusFirstResult(): void {
    const first = this.container.querySelector<HTMLElement>('.search-results [data-focusable]');
    if (first) this.nav.focus(first);
  }

  private posterCell(name: string, poster: string): ReturnType<typeof html> {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  private rail(title: string, items: ReturnType<typeof html>[]): ReturnType<typeof html> {
    return html`
      <div class="catalog-rail">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track">${items}</div>
      </div>
    `;
  }

  private channelTile(ch: Channel): ReturnType<typeof html> {
    const idx = PlaylistService.indexOf(ch);
    return html`
      <div class="catalog-tile search-channel-tile" data-focusable data-key="ch:${String(idx)}"
           data-channel-index="${String(idx)}">
        <div class="catalog-poster-wrap">${this.posterCell(ch.name, ch.logo)}</div>
        <div class="catalog-tile-name">${ch.name}</div>
      </div>
    `;
  }

  // A vertical-list row (logo + name) used for the M3U-only channel results.
  private channelRow(ch: Channel): ReturnType<typeof html> {
    const idx = PlaylistService.indexOf(ch);
    return html`
      <div class="search-channel-row" data-focusable data-key="ch:${String(idx)}"
           data-channel-index="${String(idx)}">
        ${ch.logo
          ? html`<img class="search-row-logo" src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : html`<div class="search-row-logo search-row-logo-empty">${ch.name.charAt(0)}</div>`}
        <span class="search-row-name">${ch.name}</span>
      </div>
    `;
  }

  private movieTile(v: VodItem): ReturnType<typeof html> {
    return html`
      <div class="catalog-tile" data-focusable data-key="v:${v.streamId}" data-stream-id="${v.streamId}">
        <div class="catalog-poster-wrap">${this.posterCell(v.name, v.poster)}</div>
        <div class="catalog-tile-name">${v.name}</div>
      </div>
    `;
  }

  private seriesTile(s: SeriesItem): ReturnType<typeof html> {
    return html`
      <div class="catalog-tile" data-focusable data-key="s:${s.seriesId}" data-series-id="${s.seriesId}">
        <div class="catalog-poster-wrap">${this.posterCell(s.name, s.poster)}</div>
        <div class="catalog-tile-name">${s.name}</div>
      </div>
    `;
  }

  private buildProgramIndex(): void {
    const programs: ProgramResult[] = [];
    for (let channelIndex = 0; channelIndex < PlaylistService.channels.length; channelIndex++) {
      const channel = PlaylistService.channels[channelIndex];
      const epgId = EpgService.findChannelId(channel);
      if (!epgId) continue;
      for (const programme of EpgService.programmes[epgId] ?? []) {
        programs.push({ channel, channelIndex, programme });
      }
    }
    this.programIndex = prepareSearchItems(programs, result => [
      result.programme.title,
      result.programme.category,
      result.programme.description,
      result.channel.name,
      result.channel.group,
    ]);
  }

  private findPrograms(query: string): ProgramResult[] {
    return rankPrepared(this.programIndex, query);
  }

  private programRow(result: ProgramResult, index: number): ReturnType<typeof html> {
    const { channel, programme } = result;
    const now = Date.now();
    const state = programme.stop.getTime() <= now ? 'past' : programme.start.getTime() > now ? 'future' : 'live';
    const day = formatDayLabel(programme.start);
    const action = state === 'live'
      ? t('search.liveNow')
      : state === 'future'
        ? (ReminderService.has(channelKey(channel), programme.start.getTime()) ? t('search.reminderSet') : t('search.setReminder'))
        : XtreamArchiveService.isAvailable(channel, programme.start.getTime()) ? t('search.catchUp') : t('search.openChannel');
    return html`
      <div class="search-program-row state-${state}" data-focusable
           data-key="p:${String(result.channelIndex)}:${String(programme.start.getTime())}"
           data-program-index="${String(index)}">
        <div class="search-program-time">${day.weekday} ${day.date}<br>${formatTime(programme.start)}</div>
        <div class="search-program-body">
          <div class="search-program-title">${programme.title}</div>
          <div class="search-program-channel">${channel.name}${programme.category ? html` · ${programme.category}` : ''}</div>
        </div>
        <div class="search-program-action">${action}</div>
      </div>
    `;
  }

  private async activateProgram(index: number): Promise<void> {
    const result = this.visiblePrograms[index];
    if (!result) return;
    const { channel, programme } = result;
    const now = Date.now();
    if (programme.start.getTime() > now) {
      const key = channelKey(channel);
      const startMs = programme.start.getTime();
      if (ReminderService.has(key, startMs)) {
        ReminderService.remove(key, startMs);
        showToast(t('epg.reminderRemoved'));
      } else {
        ReminderService.add({
          channelKey: key,
          channelName: channel.name,
          title: programme.title,
          startMs,
          stopMs: programme.stop.getTime(),
        });
        showToast(t('epg.reminderSet'));
      }
      this.render();
      return;
    }

    if (programme.stop.getTime() <= now && channel.catchupAccountId && channel.catchupStreamId) {
      await XtreamArchiveService.load(channel);
      if (!XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
        showToast(t('epg.catchupUnavailable'));
        this.render();
        return;
      }
    }

    if (programme.stop.getTime() <= now &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
      const key = channelKey(channel);
      const startMs = programme.start.getTime();
      const progress = StorageService.getCatchupProgressList(key)
        .find(entry => entry.progStart === startMs && !entry.completed);
      if (progress) {
        this.resumePrompt.show(programme.title, progress.position, {
          onResume: () => this.playProgram(result, progress.position),
          onStartOver: () => {
            StorageService.clearCatchupProgress(key, startMs);
            this.playProgram(result);
          },
          onCancel: () => { /* keep Search open */ },
        });
        return;
      }
    }
    this.playProgram(result);
  }

  private playProgram(result: ProgramResult, resumeSecs?: number): void {
    const { channel, channelIndex, programme } = result;
    let catchup: CatchupInfo | undefined;
    if (programme.stop.getTime() <= Date.now() &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
      catchup = {
        start: Math.floor(programme.start.getTime() / 1000),
        end: Math.floor(programme.stop.getTime() / 1000),
        title: programme.title,
        description: programme.description,
        icon: programme.icon,
        resumeSecs,
      };
    }
    this.handlers.onPlayChannel(channelIndex, catchup);
  }

  private render(): void {
    const cap = CONFIG.XTREAM.SEARCH_RESULT_CAP;
    const q = this.query.trim();
    const channels = q ? PlaylistService.search(this.query).slice(0, cap) : [];
    const isXtream = !!this.account;
    this.visiblePrograms = q ? this.findPrograms(this.query).slice(0, cap) : [];

    // Xtream: horizontal poster rails for catalog results. M3U-only channels and
    // EPG programs use compact rows so their metadata remains readable.
    const movies = isXtream ? rankByName(this.allVod, this.query).slice(0, cap) : [];
    const series = isXtream ? rankByName(this.allSeries, this.query).slice(0, cap) : [];
    const hasResults = channels.length > 0 || this.visiblePrograms.length > 0 || movies.length > 0 || series.length > 0;
    const channelSection = channels.length
      ? html`
          <div class="search-channels">
            <h2 class="catalog-rail-title">${t('common.channels')}</h2>
            <div class="search-list">${channels.map((ch) => this.channelRow(ch))}</div>
          </div>
        `
      : '';
    const programSection = this.visiblePrograms.length
      ? html`
          <div class="search-programs">
            <h2 class="catalog-rail-title">${t('search.programs')}</h2>
            <div class="search-program-list">${this.visiblePrograms.map((result, index) => this.programRow(result, index))}</div>
          </div>
        `
      : '';

    // The results view is only shown while a query is typed (App.handleSearchQuery),
    // so the empty-query case renders nothing.
    const resultsBody = !q
      ? html``
      : !hasResults
        ? html`<p class="catalog-hint search-empty">${t('search.empty')}</p>`
        : isXtream
          ? html`
                ${channels.length ? this.rail(t('common.channels'), channels.map((ch) => this.channelTile(ch))) : ''}
                ${programSection}
                ${movies.length ? this.rail(t('common.movies'), movies.map((v) => this.movieTile(v))) : ''}
                ${series.length ? this.rail(t('common.series'), series.map((s) => this.seriesTile(s))) : ''}
              `
          : html`
              ${channelSection}
              ${programSection}
            `;

    // The query box lives in the tab bar; this view renders results only.
    morph(this.container, html`
      <div class="search-view" data-nav-container>
        <div class="search-results">${resultsBody}</div>
      </div>
    `);
  }
}
