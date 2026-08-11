import type { PlaylistEntry } from '../types';
import { fetchWithTimeout } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import { genPlaylistId, isSourceEnabled } from '../utils/playlist';
import {
  normalizeXtreamBaseUrl,
  normalizeXtreamLiveOutputPreference,
} from '../utils/xtream-url';
import { serviceBase } from './service-http';
import { StorageService } from './storage-service';
import { uploadIdFromUrl } from './upload-client';
import { ReminderService } from './reminder-service';
import type { OnlineSubtitleConfig } from './subtitle-search/types';

const log = createLogger('Setup');
const TIMEOUT = 4000;

export interface ServiceInfo {
  ip: string;
  port: number;
  setupUrl: string;
  manualUrl: string;
  pairingCode: string;
  /** Absolute upload storage path on the device. Useful for debugging. */
  dataDir?: string;
}

export type SetupAction =
  | { id: number; type: 'playlist'; name: string; url: string }
  | { id: number; type: 'xtream'; serverUrl: string; username: string; password: string }
  | { id: number; type: 'epg'; url: string }
  | { id: number; type: 'remove-source'; sourceId: string }
  | { id: number; type: 'set-source-enabled'; sourceId: string; enabled: boolean }
  | {
      id: number;
      type: 'online-subtitles';
      preferredLanguage: string;
      subdlApiKey?: string;
      assrtApiKey?: string;
      opensubtitles?: {
        apiKey?: string;
        username?: string;
        password?: string;
      } | null;
    };

export interface SetupState {
  playlists: Array<{ id: string; name: string; url: string; enabled?: boolean }>;
  xtreamAccounts: Array<{
    id: string;
    name: string;
    serverUrl: string;
    username: string;
    enabled?: boolean;
  }>;
  uploadedPlaylists: Array<{ id: string; uploadId: string; enabled?: boolean }>;
  epgUrl: string;
  onlineSubtitles: {
    preferredLanguage: string;
    subdlConfigured: boolean;
    assrtConfigured: boolean;
    opensubtitlesConfigured: boolean;
    opensubtitlesApiKeyConfigured: boolean;
    opensubtitlesPasswordConfigured: boolean;
    opensubtitlesUsername: string;
  };
}

class SetupClientImpl {
  async getInfo(): Promise<ServiceInfo | null> {
    const base = serviceBase();
    if (!base) {
      log.debug('getInfo skipped: service port not yet known');
      return null;
    }
    try {
      const res = await fetchWithTimeout(`${base}/info`, {}, TIMEOUT);
      if (!res.ok) {
        log.warn('getInfo: HTTP', res.status);
        return null;
      }
      return (await res.json()) as ServiceInfo;
    } catch (e) {
      log.debug('getInfo failed (service likely not running):', e);
      return null;
    }
  }

  private async acknowledgeAction(id: number): Promise<void> {
    const base = serviceBase();
    if (!base) return;
    try {
      const res = await fetchWithTimeout(
        `${base}/setup-actions/${encodeURIComponent(String(id))}`,
        { method: 'DELETE' },
        TIMEOUT,
      );
      if (!res.ok) log.warn('Action acknowledgement failed: HTTP', res.status);
    } catch (e) {
      log.warn('Action acknowledgement failed:', e);
    }
  }

  async publishState(): Promise<boolean> {
    const base = serviceBase();
    if (!base) return false;
    const playlists = StorageService.getPlaylists();
    const onlineSubtitles = StorageService.getOnlineSubtitleConfig();
    const state: SetupState = {
      playlists: playlists
        .filter(item => item.source !== 'upload' && item.source !== 'xtream')
        .map(item => ({
          id: item.id,
          name: item.name,
          url: item.url,
          ...(isSourceEnabled(item) ? {} : { enabled: false }),
        })),
      xtreamAccounts: playlists
        .filter(item => item.source === 'xtream' && item.xtream)
        .map(item => ({
          id: item.id,
          name: item.name,
          serverUrl: item.url,
          username: item.xtream!.username,
          ...(isSourceEnabled(item) ? {} : { enabled: false }),
        })),
      uploadedPlaylists: playlists
        .filter(item => item.source === 'upload')
        .map(item => ({
          id: item.id,
          uploadId: uploadIdFromUrl(item.url),
          ...(isSourceEnabled(item) ? {} : { enabled: false }),
        })),
      epgUrl: StorageService.getEpgUrl(),
        onlineSubtitles: {
          preferredLanguage: onlineSubtitles.preferredLanguage,
          subdlConfigured: onlineSubtitles.subdl.apiKey.trim() !== '',
          assrtConfigured: onlineSubtitles.assrt.apiKey.trim() !== '',
          opensubtitlesConfigured:
            onlineSubtitles.opensubtitles.apiKey.trim() !== '' &&
            onlineSubtitles.opensubtitles.username.trim() !== '' &&
            onlineSubtitles.opensubtitles.password !== '',
          opensubtitlesApiKeyConfigured:
            onlineSubtitles.opensubtitles.apiKey.trim() !== '',
          opensubtitlesPasswordConfigured:
            onlineSubtitles.opensubtitles.password !== '',
          opensubtitlesUsername: onlineSubtitles.opensubtitles.username,
        },
    };
    try {
      const res = await fetchWithTimeout(
        `${base}/setup-state`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
        },
        TIMEOUT,
      );
      if (!res.ok) log.warn('Setup state publish failed: HTTP', res.status);
      return res.ok;
    } catch (e) {
      log.warn('Setup state publish failed:', e);
      return false;
    }
  }

  /**
   * Apply phone-submitted source changes to the same storage used by Settings.
   * Actions are idempotent so a failed acknowledgement can be retried safely.
   */
  async applyPendingActions(): Promise<boolean> {
    const base = serviceBase();
    if (!base) {
      log.debug('Action sync skipped: service port not yet known');
      return false;
    }

    let actions: SetupAction[];
    try {
      const res = await fetchWithTimeout(`${base}/setup-actions`, {}, TIMEOUT);
      if (!res.ok) {
        log.warn('Action sync: HTTP', res.status);
        return false;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        log.warn('Action sync returned a non-array response');
        return false;
      }
      actions = data as SetupAction[];
    } catch (e) {
      log.warn('Action sync failed:', e);
      return false;
    }

    if (actions.length === 0) return false;

    const previousPlaylists = StorageService.getPlaylists();
    let playlists: PlaylistEntry[] = previousPlaylists
      .map(item => ({ ...item, xtream: item.xtream && { ...item.xtream } }));
    const previousEpgUrl = StorageService.getEpgUrl();
    let epgUrl = previousEpgUrl;
    const previousOnlineSubtitles = StorageService.getOnlineSubtitleConfig();
    let onlineSubtitles: OnlineSubtitleConfig = {
      preferredLanguage: previousOnlineSubtitles.preferredLanguage,
      subdl: { ...previousOnlineSubtitles.subdl },
      assrt: { ...previousOnlineSubtitles.assrt },
      opensubtitles: { ...previousOnlineSubtitles.opensubtitles },
    };
    const playlistActionIds: number[] = [];
    const epgActionIds: number[] = [];
    const subtitleActionIds: number[] = [];

    for (const action of actions) {
      if (!action || !Number.isSafeInteger(action.id)) continue;

      if (action.type === 'playlist' && typeof action.url === 'string' &&
          typeof action.name === 'string') {
        const existing = playlists.findIndex(item =>
          item.source !== 'upload' && item.source !== 'xtream' && item.url === action.url);
        const name = action.name.trim() ||
          (existing >= 0 ? playlists[existing].name : new URL(action.url).hostname);
        const entry: PlaylistEntry = {
          id: existing >= 0 ? playlists[existing].id : genPlaylistId(),
          name,
          url: action.url,
          source: 'url',
          ...(existing >= 0 && playlists[existing].enabled === false
            ? { enabled: false }
            : {}),
        };
        if (existing >= 0) playlists[existing] = entry;
        else playlists.push(entry);
        playlistActionIds.push(action.id);
      } else if (action.type === 'xtream' &&
          typeof action.serverUrl === 'string' &&
          typeof action.username === 'string' &&
          typeof action.password === 'string') {
        const url = normalizeXtreamBaseUrl(action.serverUrl);
        const existing = playlists.findIndex(item =>
          item.source === 'xtream' && item.url === url &&
          item.xtream?.username === action.username);
        const entry: PlaylistEntry = {
          id: existing >= 0 ? playlists[existing].id : genPlaylistId(),
          name: existing >= 0 ? playlists[existing].name : url.replace(/^https?:\/\//i, ''),
          url,
          source: 'xtream',
          ...(existing >= 0 && playlists[existing].enabled === false
            ? { enabled: false }
            : {}),
          xtream: {
            username: action.username,
            password: action.password,
            liveOutput: normalizeXtreamLiveOutputPreference(
              existing >= 0 ? playlists[existing].xtream?.liveOutput : undefined,
            ),
          },
        };
        if (existing >= 0) playlists[existing] = entry;
        else playlists.push(entry);
        playlistActionIds.push(action.id);
      } else if (action.type === 'epg' && typeof action.url === 'string') {
        epgUrl = action.url;
        epgActionIds.push(action.id);
      } else if (action.type === 'remove-source' &&
          typeof action.sourceId === 'string') {
        playlists = playlists.filter(item =>
          item.source === 'upload' || item.id !== action.sourceId);
        playlistActionIds.push(action.id);
      } else if (action.type === 'set-source-enabled' &&
          typeof action.sourceId === 'string' &&
          typeof action.enabled === 'boolean') {
        const existing = playlists.findIndex(item => item.id === action.sourceId);
        if (existing >= 0) {
          const updated = { ...playlists[existing] };
          if (action.enabled) delete updated.enabled;
          else updated.enabled = false;
          playlists[existing] = updated;
        }
        playlistActionIds.push(action.id);
      } else if (action.type === 'online-subtitles' &&
          typeof action.preferredLanguage === 'string') {
        onlineSubtitles.preferredLanguage = action.preferredLanguage;
        if (typeof action.subdlApiKey === 'string') {
          onlineSubtitles.subdl.apiKey = action.subdlApiKey;
        }
        if (typeof action.assrtApiKey === 'string') {
          onlineSubtitles.assrt.apiKey = action.assrtApiKey;
        }
        if (action.opensubtitles === null) {
          onlineSubtitles.opensubtitles = {
            apiKey: '',
            username: '',
            password: '',
            token: '',
            tokenTs: 0,
          };
        } else if (action.opensubtitles) {
          onlineSubtitles.opensubtitles = {
            apiKey: action.opensubtitles.apiKey ??
              onlineSubtitles.opensubtitles.apiKey,
            username: action.opensubtitles.username ??
              onlineSubtitles.opensubtitles.username,
            password: action.opensubtitles.password ??
              onlineSubtitles.opensubtitles.password,
            token: '',
            tokenTs: 0,
          };
        }
        subtitleActionIds.push(action.id);
      } else {
        log.warn('Ignoring invalid action:', action.id);
      }
    }

    const playlistsChanged = JSON.stringify(playlists) !== JSON.stringify(previousPlaylists);
    const epgChanged = epgUrl !== previousEpgUrl;
    const subtitlesChanged =
      JSON.stringify(onlineSubtitles) !== JSON.stringify(previousOnlineSubtitles);
    if (playlistsChanged) ReminderService.backfillSourceIds();
    const playlistsStored = !playlistsChanged || StorageService.setPlaylists(playlists);
    const epgStored = !epgChanged || StorageService.setEpgUrl(epgUrl);
    const subtitlesStored =
      !subtitlesChanged || StorageService.setOnlineSubtitleConfig(onlineSubtitles);

    if (!playlistsStored) log.error('Playlist setup actions were not persisted');
    if (!epgStored) log.error('EPG setup action was not persisted');
    if (!subtitlesStored) log.error('Online subtitle setup action was not persisted');
    const acknowledgedIds = [
      ...(playlistsStored ? playlistActionIds : []),
      ...(epgStored ? epgActionIds : []),
      ...(subtitlesStored ? subtitleActionIds : []),
    ];
    if (acknowledgedIds.length > 0 && await this.publishState()) {
      for (const id of acknowledgedIds) await this.acknowledgeAction(id);
    }
    return (playlistsChanged && playlistsStored) ||
      (epgChanged && epgStored) ||
      (subtitlesChanged && subtitlesStored);
  }
}

export const SetupClient = new SetupClientImpl();
