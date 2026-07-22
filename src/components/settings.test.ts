// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TzMode } from '../types';
import type { XtreamAccountInfo } from '../services/xtream-client';

const { state, storageMock, themeMock, toastMock, uploadMock, xtreamMock } = vi.hoisted(() => {
  const state = {
    playlists: [] as {
      id?: string;
      name: string;
      url: string;
      source?: 'upload' | 'url' | 'xtream';
      count?: number;
      xtream?: { username: string; password: string };
    }[],
    epg: '',
    autoPlay: false,
    theme: 'midnight' as string,
    overlayStyle: 'dark' as string,
    tzMode: 'device' as TzMode,
    tzOffset: null as number | null,
    onlineSubtitles: {
      preferredLanguage: '',
      subdl: { apiKey: '' },
      opensubtitles: { apiKey: '', username: '', password: '', token: '', tokenTs: 0 },
      assrt: { apiKey: '' },
    },
  };
  return {
    state,
    themeMock: { previewTheme: vi.fn(), applyTheme: vi.fn(), initTheme: vi.fn() },
    storageMock: {
      getPlaylists: vi.fn(() => state.playlists),
      getEpgUrl: vi.fn(() => state.epg),
      getAutoPlay: vi.fn(() => state.autoPlay),
      getTheme: vi.fn(() => state.theme),
      getOverlayStyle: vi.fn(() => state.overlayStyle),
      getTzMode: vi.fn(() => state.tzMode),
      getEpgTzOffset: vi.fn(() => state.tzOffset),
      getOnlineSubtitleConfig: vi.fn(() => state.onlineSubtitles),
      getSelectedXtreamAccountId: vi.fn(() => null),
      setPlaylists: vi.fn(),
      setEpgUrl: vi.fn(),
      setAutoPlay: vi.fn(),
      setTheme: vi.fn((id: string) => { state.theme = id; }),
      setOverlayStyle: vi.fn((s: string) => { state.overlayStyle = s; }),
      setTzMode: vi.fn(),
      setOnlineSubtitleConfig: vi.fn((cfg: any) => { state.onlineSubtitles = cfg; }),
      remove: vi.fn(),
      clearRecentlyWatched: vi.fn(),
      clearWatchlist: vi.fn(),
    },
    toastMock: { showToast: vi.fn() },
    uploadMock: {
      // Default to "service unreachable" so render's async loadUploadInfo is a
      // no-op for existing tests. Tests can override via mockResolvedValueOnce.
      getInfo: vi.fn(async () => null),
      list: vi.fn(async () => null),
      remove: vi.fn(async () => true),
      reconcile: vi.fn(async () => undefined),
    },
    // Default to "unverifiable" so a stray Check is inert; tests opt in with
    // mockResolvedValueOnce. Never touches the network.
    xtreamMock: {
      getAccountInfo: vi.fn(async (): Promise<XtreamAccountInfo | null> => null),
    },
  };
});

vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../services/theme-service', () => themeMock);
vi.mock('../services/idb-cache', () => ({ clearCachedEpg: vi.fn(async () => {}) }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));
vi.mock('../services/xtream-client', () => ({
  createXtreamClient: () => ({ getAccountInfo: xtreamMock.getAccountInfo }),
}));
vi.mock('../services/upload-client', () => ({
  UploadClient: uploadMock,
  uploadIdFromUrl: (url: string) => {
    const m = url.match(/\/uploads\/([^/]+?)(?:\.m3u)?$/i);
    return m ? decodeURIComponent(m[1]) : '';
  },
}));

import { Settings } from './settings';
import { clearCachedEpg } from '../services/idb-cache';

let container: HTMLElement;
let onSave: ReturnType<typeof vi.fn>;
let settings: Settings;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  state.playlists = [];
  state.epg = '';
  state.autoPlay = false;
  state.theme = 'midnight';
  state.overlayStyle = 'dark';
  storageMock.getSelectedXtreamAccountId.mockReturnValue(null);
  state.onlineSubtitles = {
    preferredLanguage: '',
    subdl: { apiKey: '' },
    opensubtitles: { apiKey: '', username: '', password: '', token: '', tokenTs: 0 },
    assrt: { apiKey: '' },
  };
  vi.clearAllMocks();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  onSave = vi.fn();
  settings = new Settings(container, onSave);
});

function click(selector: string): void {
  container.querySelector<HTMLElement>(selector)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('Settings.render', () => {
  it('shows an empty hint when there are no playlists', () => {
    settings.render();
    expect(container.querySelector('#playlist-entries .empty-hint')?.textContent).toBe('No playlists added yet');
  });

  it('renders a row per configured playlist with its values', () => {
    state.playlists = [{ name: 'P1', url: 'http://a' }, { name: 'P2', url: 'http://b' }];
    state.epg = 'http://epg';
    settings.render();
    const names = Array.from(container.querySelectorAll<HTMLInputElement>('.playlist-name'));
    const urls = Array.from(container.querySelectorAll<HTMLInputElement>('.playlist-url'));
    expect(names.map(n => n.value)).toEqual(['P1', 'P2']);
    expect(urls.map(u => u.value)).toEqual(['http://a', 'http://b']);
    expect(container.querySelector<HTMLInputElement>('#epg-url')!.value).toBe('http://epg');
  });

  it('reflects the auto-play state on the toggle', () => {
    state.autoPlay = true;
    settings.render();
    expect(container.querySelector('#auto-play .toggle-option.active')!.getAttribute('data-value')).toBe('on');
  });
});

describe('Settings theme picker', () => {
  beforeEach(() => settings.render());

  it('renders a swatch per registered theme with the saved theme active', () => {
    expect(container.querySelectorAll('.theme-swatch')).toHaveLength(14);
    expect(container.querySelector('.theme-swatch.active')!.getAttribute('data-theme-id')).toBe('midnight');
  });

  it('marks the saved theme active on open', () => {
    state.theme = 'plum-night';
    settings.render();
    const active = container.querySelectorAll('.theme-swatch.active');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('data-theme-id')).toBe('plum-night');
  });

  it('selecting a swatch previews it and moves the active marker', () => {
    click('.theme-swatch[data-theme-id="arctic"]');
    expect(themeMock.previewTheme).toHaveBeenCalledWith('arctic');
    const active = container.querySelectorAll('.theme-swatch.active');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('data-theme-id')).toBe('arctic');
  });

  it('previews on pointer hover and restores the selected theme when the pointer leaves', () => {
    // Select Arctic (pending), then hover a different swatch and move the pointer off.
    click('.theme-swatch[data-theme-id="arctic"]');
    const amber = container.querySelector<HTMLElement>('.theme-swatch[data-theme-id="vintage-amber"]')!;
    amber.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(themeMock.previewTheme).toHaveBeenLastCalledWith('vintage-amber');
    // Leaving to a non-swatch restores the selected (Arctic), not the saved (midnight).
    amber.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    expect(themeMock.previewTheme).toHaveBeenLastCalledWith('arctic');
  });

  it('keeps previewing when the pointer moves between swatches', () => {
    const arctic = container.querySelector<HTMLElement>('.theme-swatch[data-theme-id="arctic"]')!;
    const amber = container.querySelector<HTMLElement>('.theme-swatch[data-theme-id="vintage-amber"]')!;
    themeMock.previewTheme.mockClear();
    arctic.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: amber }));
    // Moving swatch→swatch must NOT restore the saved theme.
    expect(themeMock.previewTheme).not.toHaveBeenCalled();
  });

  it('persists the selected theme only on Save & Apply', () => {
    click('.theme-swatch[data-theme-id="vintage-amber"]');
    expect(storageMock.setTheme).not.toHaveBeenCalled();
    click('#save-settings');
    expect(storageMock.setTheme).toHaveBeenCalledWith('vintage-amber');
  });

  it('reflects the saved overlay style on the toggle', () => {
    state.overlayStyle = 'frosted';
    settings.render();
    expect(container.querySelector('#overlay-style .toggle-option.active')!.getAttribute('data-value')).toBe('frosted');
  });

  it('persists the overlay style on Save & Apply', () => {
    click('#overlay-style .toggle-option[data-value="frosted"]');
    click('#save-settings');
    expect(storageMock.setOverlayStyle).toHaveBeenCalledWith('frosted');
  });
});

describe('Settings editing', () => {
  beforeEach(() => settings.render());

  it('adds a playlist row and removes the empty hint', () => {
    click('#add-playlist');
    expect(container.querySelectorAll('#playlist-entries .settings-row:not(.playlist-header-row)')).toHaveLength(1);
    expect(container.querySelector('#playlist-entries .empty-hint')).toBeNull();
  });

  it('removes a playlist row', () => {
    state.playlists = [{ name: 'P1', url: 'http://a' }];
    settings.render();
    expect(container.querySelectorAll('#playlist-entries .settings-row:not(.playlist-header-row)')).toHaveLength(1);
    click('.remove-playlist');
    expect(container.querySelectorAll('#playlist-entries .settings-row:not(.playlist-header-row)')).toHaveLength(0);
  });

  it('keeps each survivor\'s name and stable id when a middle row is removed', () => {
    // Reproduces: add 5 with blank names, delete the 3rd, save. The 5th must
    // keep its "Playlist 5" name AND its original id — no positional renumber,
    // no re-id — so its tab/channels stay put.
    const urls = ['http://a', 'http://b', 'http://c', 'http://d', 'http://e'];
    for (let i = 0; i < 5; i++) {
      click('#add-playlist');
      const urlInputs = container.querySelectorAll<HTMLInputElement>('.playlist-url');
      urlInputs[urlInputs.length - 1].value = urls[i];
    }
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>(
      '#playlist-entries .settings-row:not(.playlist-header-row)'));
    const idBefore = rows().map(r => r.dataset.id);
    expect(rows().map(r => r.querySelector<HTMLInputElement>('.playlist-name')!.value))
      .toEqual(['Playlist 1', 'Playlist 2', 'Playlist 3', 'Playlist 4', 'Playlist 5']);

    container.querySelectorAll<HTMLElement>('.remove-playlist')[2]
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    click('#save-settings');

    const saved = storageMock.setPlaylists.mock.calls.at(-1)![0] as { id: string; name: string }[];
    expect(saved.map(p => p.name)).toEqual(['Playlist 1', 'Playlist 2', 'Playlist 4', 'Playlist 5']);
    expect(saved.map(p => p.id)).toEqual([idBefore[0], idBefore[1], idBefore[3], idBefore[4]]);
  });

  it('removes the row whose button was clicked, even after edits churn the row order', () => {
    // Regression: removal used to key off a positional data-index that went
    // stale/duplicate after an add-following-a-remove, so clicking one row's
    // Remove could delete a different row. It now deletes the row the button
    // sits in (closest), independent of ordering.
    const addRow = (name: string) => {
      click('#add-playlist');
      const last = Array.from(container.querySelectorAll<HTMLElement>(
        '#playlist-entries .settings-row:not(.playlist-header-row)')).at(-1)!;
      last.querySelector<HTMLInputElement>('.playlist-name')!.value = name;
      last.querySelector<HTMLInputElement>('.playlist-url')!.value = 'http://' + name;
    };
    const rowNames = () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('.playlist-name')).map(n => n.value);
    const removeByName = (name: string) =>
      Array.from(container.querySelectorAll<HTMLElement>('.settings-row'))
        .find(r => r.querySelector<HTMLInputElement>('.playlist-name')?.value === name)!
        .querySelector<HTMLElement>('.remove-playlist')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    addRow('A'); addRow('B'); addRow('C');
    removeByName('B');   // churn the middle
    addRow('D');         // re-add: under the old scheme D reused C's stale index
    expect(rowNames()).toEqual(['A', 'C', 'D']);

    removeByName('C');   // the old positional logic deleted D here instead
    expect(rowNames()).toEqual(['A', 'D']);
  });

  it("seeds the next-add name past the highest existing 'Playlist N'", () => {
    const urls = ['http://a', 'http://b', 'http://c', 'http://d'];
    for (let i = 0; i < 4; i++) {
      click('#add-playlist');
      container.querySelectorAll<HTMLInputElement>('.playlist-url')[i].value = urls[i];
    }
    container.querySelectorAll<HTMLElement>('.remove-playlist')[2] // remove 'Playlist 3'
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    click('#add-playlist');
    const names = Array.from(container.querySelectorAll<HTMLInputElement>('.playlist-name')).map(n => n.value);
    expect(names).toEqual(['Playlist 1', 'Playlist 2', 'Playlist 4', 'Playlist 5']);
  });

  it('shows Name/URL labels only once as column headers, not on every row', () => {
    state.playlists = [
      { name: 'P1', url: 'http://a' },
      { name: 'P2', url: 'http://b' },
      { name: 'P3', url: 'http://c' },
    ];
    settings.render();
    // Exactly two labels in #playlist-entries: one "Name", one "URL".
    const labels = Array.from(container.querySelectorAll<HTMLLabelElement>('#playlist-entries label'))
      .map((l) => l.textContent?.trim());
    expect(labels).toEqual(['Name', 'URL']);
    // The data rows themselves contain no labels (just inputs + Remove button).
    const dataRows = container.querySelectorAll('#playlist-entries .settings-row:not(.playlist-header-row)');
    for (const row of dataRows) {
      expect(row.querySelectorAll('label')).toHaveLength(0);
    }
  });

  it('removing the last playlist row also removes the column-header row', () => {
    state.playlists = [{ name: 'P1', url: 'http://a' }];
    settings.render();
    expect(container.querySelector('#playlist-entries .playlist-header-row')).not.toBeNull();
    click('.remove-playlist');
    expect(container.querySelector('#playlist-entries .playlist-header-row')).toBeNull();
    expect(container.querySelector('#playlist-entries .empty-hint')?.textContent).toBe('No playlists added yet');
  });

  it('add-playlist on an empty list inserts the header row first', () => {
    expect(container.querySelector('#playlist-entries .playlist-header-row')).toBeNull();
    click('#add-playlist');
    expect(container.querySelector('#playlist-entries .playlist-header-row')).not.toBeNull();
    expect(container.querySelectorAll('#playlist-entries .settings-row:not(.playlist-header-row)')).toHaveLength(1);
  });

  it('selecting On activates auto-play', () => {
    const activeVal = () => container.querySelector('#auto-play .toggle-option.active')!.getAttribute('data-value');
    expect(activeVal()).toBe('off');
    click('#auto-play [data-value="on"]');
    expect(activeVal()).toBe('on');
  });

  it('clears the playlist and EPG caches and shows a toast', () => {
    click('#clear-cache');
    expect(storageMock.remove).toHaveBeenCalledWith('cached_playlist');
    expect(clearCachedEpg).toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledWith('Cache cleared');
  });

  it('cancel discards; refresh reloads', () => {
    click('#cancel-settings');
    expect(onSave).toHaveBeenLastCalledWith('cancel');
    click('#refresh-data');
    expect(onSave).toHaveBeenLastCalledWith('reload');
  });
});

describe('Settings Recently Watched clearing', () => {
  beforeEach(() => settings.render());

  it('groups the scope explanation and clear action in one setting', () => {
    const action = container.querySelector('.settings-history-action');
    expect(action?.textContent).toContain('Recently Watched');
    expect(action?.textContent).toContain('Clear recent live channels and Catch-up progress');
    expect(action?.querySelector('#clear-recently-watched')).not.toBeNull();
  });

  describe('Settings Watchlist clearing', () => {
    beforeEach(() => {
      state.playlists = [
        {
          id: 'x1',
          name: 'Account Alpha',
          url: 'http://host',
          source: 'xtream',
          xtream: { username: 'u', password: 'p' },
        },
        {
          id: 'x2',
          name: 'Account Bravo',
          url: 'http://host',
          source: 'xtream',
          xtream: { username: 'u2', password: 'p2' },
        },
      ];
      storageMock.getSelectedXtreamAccountId.mockReturnValue('x2');
      settings.render();
    });

    it('shows the selected account in the Watchlist clear setting', () => {
      const action = container.querySelector('#clear-watchlist')?.closest('.settings-history-action');
      expect(action?.textContent).toContain('Watchlist');
      expect(action?.textContent).toContain('Account Bravo');
    });

    it('requires confirmation and clears only the selected account', () => {
      click('#clear-watchlist');
      expect(document.querySelector('.confirmation-title')?.textContent).toBe('Clear Watchlist?');
      expect(document.querySelector('.confirmation-message')?.textContent).toContain('Account Bravo');
      expect(storageMock.clearWatchlist).not.toHaveBeenCalled();

      settings.handleAction('left');
      settings.handleAction('select');

      expect(storageMock.clearWatchlist).toHaveBeenCalledWith('x2');
      expect(toastMock.showToast).toHaveBeenCalledWith('Watchlist cleared for "Account Bravo"');
    });
  });

  it('requires confirmation before clearing Recently Watched', () => {
    click('#clear-recently-watched');
    expect(settings.isPromptVisible).toBe(true);
    expect(document.querySelector('.confirmation-title')?.textContent).toBe('Clear Recently Watched?');
    expect(storageMock.clearRecentlyWatched).not.toHaveBeenCalled();

    settings.handleAction('left');
    settings.handleAction('select');

    expect(storageMock.clearRecentlyWatched).toHaveBeenCalledTimes(1);
    expect(toastMock.showToast).toHaveBeenCalledWith('Recently Watched cleared');
    expect(settings.isPromptVisible).toBe(false);
  });

  it('cancels without clearing', () => {
    click('#clear-recently-watched');
    settings.handleAction('back');
    expect(storageMock.clearRecentlyWatched).not.toHaveBeenCalled();
    expect(settings.isPromptVisible).toBe(false);
  });
});

describe('Settings.save', () => {
  beforeEach(() => {
    state.playlists = [{ name: '', url: '' }, { name: '', url: '' }];
    settings.render();
  });

  it('persists trimmed playlists, EPG and auto-play, then reloads', () => {
    const names = container.querySelectorAll<HTMLInputElement>('.playlist-name');
    const urls = container.querySelectorAll<HTMLInputElement>('.playlist-url');
    names[0].value = 'My';
    urls[0].value = '  http://x  ';
    names[1].value = 'Unnamed';
    urls[1].value = '   '; // blank URL -> dropped
    container.querySelector<HTMLInputElement>('#epg-url')!.value = ' http://epg ';
    click('#auto-play [data-value="on"]');

    click('#save-settings');

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([{ id: expect.any(String), name: 'My', url: 'http://x', source: 'url' }]);
    expect(storageMock.setEpgUrl).toHaveBeenCalledWith('http://epg');
    expect(storageMock.setAutoPlay).toHaveBeenCalledWith(true);
    expect(onSave).toHaveBeenCalledWith('reload'); // playlist + EPG changed
  });

  it("reloads when a playlist is re-id'd (same name+url, new id)", () => {
    // Delete + re-add of the same name/url gives the row a fresh id; the
    // signature must notice the id changed (else cache keeps the old id).
    state.playlists = [{ id: 'a', name: 'P', url: 'http://p' }];
    settings.render();
    container.querySelector<HTMLElement>(
      '#playlist-entries .settings-row:not(.playlist-header-row)')!.dataset.id = 'b';
    click('#save-settings');
    expect(onSave).toHaveBeenCalledWith('reload');
  });

  it('applies a display-only change without a full reload', () => {
    state.playlists = [{ id: 'p1', name: 'P', url: 'http://p' }]; // unchanged by the form
    settings.render();
    click('#tz-mode [data-value="feed"]'); // only the time zone changes
    click('#save-settings');
    expect(storageMock.setTzMode).toHaveBeenCalledWith('feed');
    expect(onSave).toHaveBeenCalledWith('apply'); // no re-fetch
  });

  it('defaults a missing name to "Playlist N"', () => {
    const urls = container.querySelectorAll<HTMLInputElement>('.playlist-url');
    urls[0].value = 'http://only';
    click('#save-settings');
    expect(storageMock.setPlaylists).toHaveBeenCalledWith([{ id: expect.any(String), name: 'Playlist 1', url: 'http://only', source: 'url' }]);
  });

  it('selecting the Feed option persists the feed mode', () => {
    const activeTz = () => container.querySelector('#tz-mode .toggle-option.active')!.getAttribute('data-value');
    expect(activeTz()).toBe('device'); // default
    click('#tz-mode [data-value="feed"]');
    expect(activeTz()).toBe('feed');
    click('#save-settings');
    expect(storageMock.setTzMode).toHaveBeenCalledWith('feed');
  });

  it('saves online subtitle credentials', () => {
    settings.render();
    (container.querySelector('#subdl-key') as HTMLInputElement).value = 'SK';
    (container.querySelector('#os-key') as HTMLInputElement).value = 'OK';
    (container.querySelector('#os-user') as HTMLInputElement).value = 'u';
    (container.querySelector('#os-pass') as HTMLInputElement).value = 'p';
    click('[data-dropdown-value="zh-CN"]');
    click('#save-settings');
    const cfg = storageMock.getOnlineSubtitleConfig();
    expect(cfg.subdl.apiKey).toBe('SK');
    expect(cfg.opensubtitles).toMatchObject({ apiKey: 'OK', username: 'u', password: 'p' });
    expect(cfg.preferredLanguage).toBe('zh-CN');
  });

  it('saves the Assrt token', () => {
    settings.render();
    (container.querySelector('#assrt-key') as HTMLInputElement).value = 'AZ';
    click('#save-settings');
    expect(storageMock.getOnlineSubtitleConfig().assrt.apiKey).toBe('AZ');
  });
});

describe('Settings.handleAction', () => {
  it('select activates the focused control (remote OK)', () => {
    state.playlists = [{ name: 'P1', url: 'http://a' }];
    settings.render();
    container.querySelector<HTMLElement>('#save-settings')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    settings.handleAction('select');
    expect(storageMock.setPlaylists).toHaveBeenCalled();
  });
});

describe('Settings uploads section', () => {
  beforeEach(() => {
    state.playlists = [
      { name: 'Manual', url: 'http://manual', source: 'url' },
      { name: 'From Phone', url: 'http://127.0.0.1:8890/uploads/from-phone.m3u', source: 'upload' },
    ];
  });

  it('renders uploaded playlists in the upload section, not the URL editor', () => {
    settings.render();
    expect(container.querySelectorAll('#playlist-entries .settings-row:not(.playlist-header-row)')).toHaveLength(1);
    expect(container.querySelector('#playlist-entries input.playlist-name')!).toHaveProperty('value', 'Manual');
    const uploadRows = container.querySelectorAll('#upload-entries .settings-row');
    expect(uploadRows).toHaveLength(1);
    expect(uploadRows[0].querySelector('label')!.textContent).toBe('From Phone');
    expect(uploadRows[0].querySelector<HTMLElement>('.remove-upload')!.dataset.url)
      .toBe('http://127.0.0.1:8890/uploads/from-phone.m3u');
  });

  it('appends the channel count to the upload label when stored', () => {
    state.playlists = [
      { name: 'My Phone List', url: 'http://127.0.0.1:8890/uploads/p.m3u', source: 'upload', count: 12 },
    ];
    settings.render();
    expect(container.querySelector('#upload-entries label')!.textContent)
      .toBe('My Phone List — 12 channels');
  });

  it('uses singular "channel" when the count is exactly 1', () => {
    state.playlists = [
      { name: 'Solo', url: 'http://127.0.0.1:8890/uploads/solo.m3u', source: 'upload', count: 1 },
    ];
    settings.render();
    expect(container.querySelector('#upload-entries label')!.textContent)
      .toBe('Solo — 1 channel');
  });

  it('falls back to the bare name when no count is available (offline / pre-reconcile storage)', () => {
    state.playlists = [
      { name: 'Anon', url: 'http://127.0.0.1:8890/uploads/anon.m3u', source: 'upload' },
    ];
    settings.render();
    expect(container.querySelector('#upload-entries label')!.textContent).toBe('Anon');
  });

  it('shows the empty-hint when there are no uploaded playlists', () => {
    state.playlists = [];
    settings.render();
    expect(container.querySelector('#upload-entries .empty-hint')?.textContent)
      .toBe('No uploaded playlists');
  });

  it('escapes a malicious upload name (no live element injected)', () => {
    state.playlists = [
      { name: '<img src=x onerror=alert(1)>', url: 'http://127.0.0.1:8890/uploads/x.m3u', source: 'upload' },
    ];
    settings.render();
    expect(container.querySelector('#upload-entries img')).toBeNull();
    expect(container.querySelector('#upload-entries label')!.textContent)
      .toContain('<img src=x onerror=');
  });

  it('removeUpload calls the service, drops the entry from storage, and toasts', async () => {
    settings.render();
    container.querySelector<HTMLElement>('.remove-upload')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // settings.removeUpload is async (awaits UploadClient.remove); flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(uploadMock.remove).toHaveBeenCalledWith('from-phone');
    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { name: 'Manual', url: 'http://manual', source: 'url' },
    ]);
    expect(storageMock.remove).toHaveBeenCalledWith('cached_playlist');
    expect(toastMock.showToast).toHaveBeenCalledWith('Uploaded playlist removed');
  });

  it('save() preserves uploaded playlists alongside the edited URL list', () => {
    settings.render();
    const urls = container.querySelectorAll<HTMLInputElement>('.playlist-url');
    urls[0].value = 'http://renamed';
    container.querySelector<HTMLElement>('#save-settings')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { id: expect.any(String), name: 'Manual', url: 'http://renamed', source: 'url' },
      { name: 'From Phone', url: 'http://127.0.0.1:8890/uploads/from-phone.m3u', source: 'upload' },
    ]);
  });

  it('renders the QR + URL when the upload service is reachable', async () => {
    uploadMock.getInfo.mockResolvedValueOnce({
      ip: '192.168.1.2', port: 8890, uploadUrl: 'http://192.168.1.2:8890/upload',
    });
    settings.render();
    await new Promise((r) => setTimeout(r, 0));
    const info = container.querySelector('#upload-info')!;
    expect(info.querySelector('.upload-url')!.textContent).toBe('http://192.168.1.2:8890/upload');
    const img = info.querySelector<HTMLImageElement>('img.upload-qr');
    expect(img).not.toBeNull();
    expect(img!.src.startsWith('data:image/')).toBe(true);
  });

  it('shows an unavailable message when the upload service is unreachable', async () => {
    // Default mock returns null -> service unreachable.
    settings.render();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('#upload-info')!.textContent)
      .toContain('Upload service is not running');
  });
});

describe('Settings uploads auto-refresh', () => {
  // Settings reconciles + morphs the upload list on open. While the view is
  // open, app.ts subscribes to the upload service's Luna `uploadEvents` push
  // channel and calls settings.refreshUploads() on each push (event-driven,
  // no polling).

  beforeEach(() => {
    // Open Settings with no uploads visible.
    state.playlists = [];
  });

  it('reconciles on render so an upload that arrived before opening shows up', async () => {
    // Simulate reconcile pulling in a new upload from the service.
    uploadMock.reconcile.mockImplementationOnce(async () => {
      state.playlists = [
        { name: 'Channel One', url: 'http://127.0.0.1:8890/uploads/channel-one.m3u', source: 'upload' },
      ];
    });

    settings.render();
    // First render reads empty storage → empty hint
    expect(container.querySelector('#upload-entries .empty-hint')).not.toBeNull();

    // Flush refreshUploads (reconcile resolves, then morph applies)
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadMock.reconcile).toHaveBeenCalled();
    const rows = container.querySelectorAll('#upload-entries .settings-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('label')!.textContent).toBe('Channel One');
    expect(container.querySelector('#upload-entries .empty-hint')).toBeNull();
  });

  it('refreshUploads() (the public hook fired by app.ts on each Luna push) reconciles + morphs in place', async () => {
    settings.render();
    await Promise.resolve(); await Promise.resolve();
    uploadMock.reconcile.mockClear();

    // Simulate a push from the upload service: a new file arrived.
    uploadMock.reconcile.mockImplementationOnce(async () => {
      state.playlists = [
        { name: 'Pushed', url: 'http://127.0.0.1:8890/uploads/pushed.m3u', source: 'upload' },
      ];
    });

    await settings.refreshUploads();

    expect(uploadMock.reconcile).toHaveBeenCalledTimes(1);
    const rows = container.querySelectorAll('#upload-entries .settings-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('label')!.textContent).toBe('Pushed');
  });

  it('refreshUploads() can be called when settings has never rendered (event arrives early) without throwing', async () => {
    // No render() yet — #upload-entries doesn't exist in the DOM.
    uploadMock.reconcile.mockImplementationOnce(async () => {
      state.playlists = [
        { name: 'Early', url: 'http://127.0.0.1:8890/uploads/early.m3u', source: 'upload' },
      ];
    });

    await expect(settings.refreshUploads()).resolves.toBeUndefined();
    // Reconcile still runs (storage gets updated), only the morph is skipped.
    expect(uploadMock.reconcile).toHaveBeenCalledTimes(1);
  });

  it('removes the empty-hint and replaces with rows in a single morph (no flicker)', async () => {
    uploadMock.reconcile.mockImplementationOnce(async () => {
      state.playlists = [
        { name: 'A', url: 'http://127.0.0.1:8890/uploads/a.m3u', source: 'upload' },
        { name: 'B', url: 'http://127.0.0.1:8890/uploads/b.m3u', source: 'upload' },
      ];
    });

    settings.render();
    await Promise.resolve(); await Promise.resolve();

    const labels = Array.from(container.querySelectorAll('#upload-entries label'))
      .map((l) => l.textContent);
    expect(labels).toEqual(['A', 'B']);
    // Each row has a stable data-key for morph identity.
    const keys = Array.from(container.querySelectorAll<HTMLElement>('#upload-entries .settings-row'))
      .map((r) => r.getAttribute('data-key'));
    expect(keys).toEqual([
      'http://127.0.0.1:8890/uploads/a.m3u',
      'http://127.0.0.1:8890/uploads/b.m3u',
    ]);
  });
});

describe('Settings listener lifecycle', () => {
  it('binds persistent-container listeners once, not per render', () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const spy = vi.spyOn(c, 'addEventListener');
    const s = new Settings(c, vi.fn());
    s.render();
    s.render();
    s.render();
    const count = (type: string) =>
      spy.mock.calls.filter(([t]) => t === type).length;
    expect(count('nav:hover')).toBe(1);
    expect(count('keydown')).toBe(1);
    expect(count('click')).toBe(1);
  });
});

describe('Settings Xtream section', () => {
  it('renders credential fields with stored values for an xtream account', () => {
    state.playlists = [{
      id: 'x1', name: 'My Provider', url: 'http://host:8080',
      source: 'xtream', xtream: { username: 'user1', password: 'pass1' },
    }];
    settings.render();
    const card = container.querySelector('#xtream-entries .xtream-card')!;
    expect(card).not.toBeNull();
    expect(card.querySelector<HTMLInputElement>('.xtream-name')!.value).toBe('My Provider');
    expect(card.querySelector<HTMLInputElement>('.xtream-url')!.value).toBe('http://host:8080');
    expect(card.querySelector<HTMLInputElement>('.xtream-username')!.value).toBe('user1');
    const pw = card.querySelector<HTMLInputElement>('.xtream-password')!;
    expect(pw.value).toBe('pass1');
    expect(pw.type).toBe('password');
  });

  it('keeps xtream accounts out of the M3U Playlists list', () => {
    state.playlists = [
      { id: 'p1', name: 'M3U', url: 'http://m3u', source: 'url' },
      { id: 'x1', name: 'Acct', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ];
    settings.render();
    const rows = container.querySelectorAll('#playlist-entries .settings-row:not(.playlist-header-row)');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector<HTMLInputElement>('.playlist-url')!.value).toBe('http://m3u');
    expect(container.querySelectorAll('#xtream-entries .xtream-card')).toHaveLength(1);
  });

  it('shows the empty hint when no xtream accounts are configured', () => {
    state.playlists = [];
    settings.render();
    expect(container.querySelector('#xtream-entries .xtream-card')).toBeNull();
    expect(container.querySelector('#xtream-entries .empty-hint')?.textContent)
      .toBe('No Xtream accounts added yet');
    expect(container.querySelector<HTMLElement>('#add-xtream')).not.toBeNull();
  });

  it('renders the Xtream Account section first, above Playlists', () => {
    settings.render();
    const heads = Array.from(container.querySelectorAll('.settings-section h3'))
      .map((h) => h.textContent);
    expect(heads[0]).toBe('Xtream Account');
    expect(heads.indexOf('Xtream Account')).toBeLessThan(heads.indexOf('Playlists'));
  });

  it('adds a blank xtream card and drops the empty hint', () => {
    state.playlists = [];
    settings.render();
    expect(container.querySelector<HTMLElement>('#add-xtream')).not.toBeNull();
    click('#add-xtream');
    expect(container.querySelectorAll('#xtream-entries .xtream-card')).toHaveLength(1);
    expect(container.querySelector('#xtream-entries .empty-hint')).toBeNull();
    const card = container.querySelector('#xtream-entries .xtream-card')!;
    expect(card.querySelector<HTMLElement>('.xtream-card')).toBeNull(); // one card, not nested
    expect(card.getAttribute('data-id')).toBeTruthy(); // seeded a stable id
  });

  it('removes an xtream card and restores the empty hint when the last one goes', () => {
    state.playlists = [
      { id: 'x1', name: 'Acct', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ];
    settings.render();
    expect(container.querySelectorAll('#xtream-entries .xtream-card')).toHaveLength(1);
    click('#xtream-entries .remove-xtream');
    expect(container.querySelectorAll('#xtream-entries .xtream-card')).toHaveLength(0);
    expect(container.querySelector('#xtream-entries .empty-hint')?.textContent)
      .toBe('No Xtream accounts added yet');
  });

  it('removes only the card whose button was clicked', () => {
    state.playlists = [
      { id: 'x1', name: 'A', url: 'http://a:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
      { id: 'x2', name: 'B', url: 'http://b:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ];
    settings.render();
    const cardB = Array.from(container.querySelectorAll<HTMLElement>('#xtream-entries .xtream-card'))
      .find(c => c.dataset.id === 'x1')!; // remove the first
    cardB.querySelector<HTMLElement>('.remove-xtream')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const remaining = Array.from(container.querySelectorAll<HTMLElement>('#xtream-entries .xtream-card'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].dataset.id).toBe('x2');
  });

  function fillCard(card: HTMLElement, v: { name?: string; url?: string; user?: string; pass?: string }): void {
    if (v.name !== undefined) card.querySelector<HTMLInputElement>('.xtream-name')!.value = v.name;
    if (v.url !== undefined) card.querySelector<HTMLInputElement>('.xtream-url')!.value = v.url;
    if (v.user !== undefined) card.querySelector<HTMLInputElement>('.xtream-username')!.value = v.user;
    if (v.pass !== undefined) card.querySelector<HTMLInputElement>('.xtream-password')!.value = v.pass;
  }

  it('saves a complete card as a source:xtream entry (normalized url) and reloads', () => {
    state.playlists = [{ id: 'p1', name: 'M3U', url: 'http://m3u', source: 'url' }];
    settings.render();
    click('#add-xtream');
    const card = container.querySelector<HTMLElement>('#xtream-entries .xtream-card')!;
    fillCard(card, { name: 'My Provider', url: 'host:8080/', user: 'user1', pass: 'pass1' });
    const id = card.dataset.id!;

    click('#save-settings');

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { id: 'p1', name: 'M3U', url: 'http://m3u', source: 'url' },
      { id, name: 'My Provider', url: 'http://host:8080', source: 'xtream', xtream: { username: 'user1', password: 'pass1' } },
    ]);
    expect(onSave).toHaveBeenCalledWith('reload');
  });

  it('falls back to the host as the label when none is given', () => {
    state.playlists = [];
    settings.render();
    click('#add-xtream');
    const card = container.querySelector<HTMLElement>('#xtream-entries .xtream-card')!;
    fillCard(card, { url: 'http://host:8080', user: 'u', pass: 'p' });
    click('#save-settings');
    const saved = storageMock.setPlaylists.mock.calls.at(-1)![0] as { name: string }[];
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('host:8080');
  });

  it('skips an incomplete card (missing a credential) rather than persist a broken account', () => {
    state.playlists = [];
    settings.render();
    click('#add-xtream'); // complete
    click('#add-xtream'); // missing password
    const cards = container.querySelectorAll<HTMLElement>('#xtream-entries .xtream-card');
    fillCard(cards[0], { name: 'A', url: 'http://a:8080', user: 'u', pass: 'p' });
    fillCard(cards[1], { name: 'B', url: 'http://b:8080', user: 'u', pass: '' });
    click('#save-settings');
    const saved = storageMock.setPlaylists.mock.calls.at(-1)![0] as { name: string; source?: string }[];
    const xtream = saved.filter(p => p.source === 'xtream');
    expect(xtream).toHaveLength(1);
    expect(xtream[0].name).toBe('A');
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('Check shows status, expiry and connections for a verified account', async () => {
    state.playlists = [
      { id: 'x1', name: 'Acct', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ];
    settings.render();
    xtreamMock.getAccountInfo.mockResolvedValueOnce({
      auth: true, status: 'Active', expiresAt: 1786000000, maxConnections: 2, activeConnections: 1,
    });
    click('#xtream-entries .check-xtream');
    await flush();
    const status = container.querySelector('#xtream-entries .xtream-status')!;
    expect(status.classList.contains('ok')).toBe(true);
    expect(status.textContent).toContain('Active');
    expect(status.textContent).toMatch(/expires \d{4}-\d{2}-\d{2}/);
    expect(status.textContent).toContain('1/2');
  });

  it('Check reports a login failure for auth:0', async () => {
    state.playlists = [
      { id: 'x1', name: 'Acct', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ];
    settings.render();
    xtreamMock.getAccountInfo.mockResolvedValueOnce({
      auth: false, status: '', expiresAt: null, maxConnections: 0, activeConnections: 0,
    });
    click('#xtream-entries .check-xtream');
    await flush();
    const status = container.querySelector('#xtream-entries .xtream-status')!;
    expect(status.classList.contains('err')).toBe(true);
    expect(status.textContent).toContain('Login failed');
  });

  it('Check prompts to complete the fields when a credential is missing, without a lookup', async () => {
    state.playlists = [];
    settings.render();
    click('#add-xtream');
    const card = container.querySelector<HTMLElement>('#xtream-entries .xtream-card')!;
    fillCard(card, { url: 'http://host:8080', user: 'u', pass: '' }); // no password
    card.querySelector<HTMLElement>('.check-xtream')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(xtreamMock.getAccountInfo).not.toHaveBeenCalled();
    const status = card.querySelector('.xtream-status')!;
    expect(status.classList.contains('err')).toBe(true);
    expect(status.textContent).toContain('server, username and password');
  });

  it('Check reports a verify failure when the panel is unreachable (null)', async () => {
    state.playlists = [
      { id: 'x1', name: 'Acct', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ];
    settings.render();
    xtreamMock.getAccountInfo.mockResolvedValueOnce(null);
    click('#xtream-entries .check-xtream');
    await flush();
    const status = container.querySelector('#xtream-entries .xtream-status')!;
    expect(status.classList.contains('err')).toBe(true);
    expect(status.textContent).toContain('verify');
  });
});
