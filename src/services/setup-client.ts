import type { ManualEpgSource, PlaylistEntry } from '../types';
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
import { ParentalControlService } from './parental-control';
import type { OnlineSubtitleConfig } from './subtitle-search/types';
import { completeServerUrl, endpointSignature, originOf } from './llm/config';
import type { LlmConfig } from './llm/types';

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
  | { id: number; type: 'manual-epg-sources'; sources: ManualEpgSource[] }
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
    }
  | {
      id: number;
      type: 'ai';
      baseUrl: string;
      model: string;
      apiKey?: string;
      extraHeaders?: string;
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
  manualEpgSources: ManualEpgSource[];
  onlineSubtitles: {
    preferredLanguage: string;
    subdlConfigured: boolean;
    assrtConfigured: boolean;
    opensubtitlesConfigured: boolean;
    opensubtitlesApiKeyConfigured: boolean;
    opensubtitlesPasswordConfigured: boolean;
    opensubtitlesUsername: string;
  };
  ai: {
    baseUrl: string;
    model: string;
    apiKeyConfigured: boolean;
    extraHeadersConfigured: boolean;
  };
}

/** Which settings-only groups a phone action changed. */
export interface SettingsChanges {
  subtitles: boolean;
  ai: boolean;
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
    const llm = StorageService.getLlmConfig();
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
      manualEpgSources: StorageService.getManualEpgSources(),
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
      ai: {
        baseUrl: llm.baseUrl,
        model: llm.model,
        apiKeyConfigured: llm.apiKey.trim() !== '',
        extraHeadersConfigured: llm.extraHeaders.trim() !== '',
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
   * Resolves true when sources or guides changed and data must reload;
   * subtitle and AI changes only call `onSettingsChanged`.
   */
  async applyPendingActions(onSettingsChanged?: (changed: SettingsChanges) => void): Promise<boolean> {
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
    const previousManualEpgSources = StorageService.getManualEpgSources();
    let manualEpgSources = previousManualEpgSources;
    const previousOnlineSubtitles = StorageService.getOnlineSubtitleConfig();
    let onlineSubtitles: OnlineSubtitleConfig = {
      preferredLanguage: previousOnlineSubtitles.preferredLanguage,
      subdl: { ...previousOnlineSubtitles.subdl },
      assrt: { ...previousOnlineSubtitles.assrt },
      opensubtitles: { ...previousOnlineSubtitles.opensubtitles },
    };
    const previousLlm = StorageService.getLlmConfig();
    let llm: LlmConfig = { ...previousLlm };
    const playlistActionIds: number[] = [];
    const epgActionIds: number[] = [];
    const subtitleActionIds: number[] = [];
    const llmActionIds: number[] = [];

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
            ...(existing >= 0 && playlists[existing].xtream?.liveCategories
              ? { liveCategories: playlists[existing].xtream!.liveCategories }
              : {}),
          },
        };
        if (existing >= 0) playlists[existing] = entry;
        else playlists.push(entry);
        playlistActionIds.push(action.id);
      } else if (action.type === 'manual-epg-sources' &&
          Array.isArray(action.sources)) {
        manualEpgSources = action.sources.map(source => ({
          url: source.url,
          playlistIds: source.playlistIds.slice(),
        }));
        epgActionIds.push(action.id);
      } else if (action.type === 'remove-source' &&
          typeof action.sourceId === 'string') {
        if (ParentalControlService.guardsSourceRemoval(action.sourceId)) {
          log.warn('Ignoring removal of a parental-locked source', 'event=parental.phone.refused',
            'op=remove-source', `action=${action.id}`, `source=${encodeURIComponent(action.sourceId)}`);
          playlistActionIds.push(action.id);
          continue;
        }
        playlists = playlists.filter(item =>
          item.source === 'upload' || item.id !== action.sourceId);
        playlistActionIds.push(action.id);
      } else if (action.type === 'set-source-enabled' &&
          typeof action.sourceId === 'string' &&
          typeof action.enabled === 'boolean') {
        const existing = playlists.findIndex(item => item.id === action.sourceId);
        if (existing >= 0 && !action.enabled &&
            ParentalControlService.guardsSourceRemoval(action.sourceId)) {
          log.warn('Ignoring turning off a parental-locked source', 'event=parental.phone.refused',
            'op=set-source-enabled', `action=${action.id}`, `source=${encodeURIComponent(action.sourceId)}`);
        } else if (existing >= 0) {
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
      } else if (action.type === 'ai' &&
          typeof action.baseUrl === 'string' &&
          typeof action.model === 'string') {
        const endpoint = { baseUrl: completeServerUrl(action.baseUrl), model: action.model.trim() };
        // A masked key the phone didn't resend stays only on the same server;
        // it must never follow a new address the phone typed.
        const sameServer = originOf(endpoint.baseUrl) === originOf(llm.baseUrl);
        const droppedKey = !sameServer && typeof action.apiKey !== 'string' && llm.apiKey !== '';
        const droppedHeaders = !sameServer && typeof action.extraHeaders !== 'string' && llm.extraHeaders !== '';
        if (droppedKey || droppedHeaders) {
          log.warn('AI key dropped for a new server', 'event=llm.setup.key_dropped',
            `key=${String(droppedKey)}`, `headers=${String(droppedHeaders)}`, `action=${action.id}`);
        }
        llm = {
          ...llm,
          ...endpoint,
          apiKey: typeof action.apiKey === 'string' ? action.apiKey : sameServer ? llm.apiKey : '',
          extraHeaders: typeof action.extraHeaders === 'string'
            ? action.extraHeaders
            : sameServer ? llm.extraHeaders : '',
        };
        if (llm.capabilities && llm.capabilities.signature !== endpointSignature(llm)) llm.capabilities = null;
        llmActionIds.push(action.id);
      } else {
        log.warn('Ignoring invalid action:', action.id);
      }
    }

    const playlistsChanged = JSON.stringify(playlists) !== JSON.stringify(previousPlaylists);
    const epgChanged =
      JSON.stringify(manualEpgSources) !== JSON.stringify(previousManualEpgSources);
    const subtitlesChanged =
      JSON.stringify(onlineSubtitles) !== JSON.stringify(previousOnlineSubtitles);
    const playlistsStored = !playlistsChanged || StorageService.setPlaylists(playlists);
    const epgStored =
      !epgChanged || StorageService.setManualEpgSources(manualEpgSources);
    const subtitlesStored =
      !subtitlesChanged || StorageService.setOnlineSubtitleConfig(onlineSubtitles);
    const llmChanged = JSON.stringify(llm) !== JSON.stringify(previousLlm);
    const llmStored = !llmChanged || StorageService.setLlmConfig(llm);

    if (!playlistsStored) log.error('Playlist setup actions were not persisted');
    if (!epgStored) log.error('EPG setup action was not persisted');
    if (!subtitlesStored) log.error('Online subtitle setup action was not persisted');
    if (!llmStored) log.error('AI setup action was not persisted');
    // At once, before the slower publish and acknowledgements, so an open
    // Settings form shows the new values before its Save could write old ones.
    const changed = { subtitles: subtitlesChanged && subtitlesStored, ai: llmChanged && llmStored };
    if (onSettingsChanged && (changed.subtitles || changed.ai)) onSettingsChanged(changed);
    const acknowledgedIds = [
      ...(playlistsStored ? playlistActionIds : []),
      ...(epgStored ? epgActionIds : []),
      ...(subtitlesStored ? subtitleActionIds : []),
      ...(llmStored ? llmActionIds : []),
    ];
    if (acknowledgedIds.length > 0 && await this.publishState()) {
      for (const id of acknowledgedIds) await this.acknowledgeAction(id);
    }
    return (playlistsChanged && playlistsStored) ||
      (epgChanged && epgStored);
  }
}

export const SetupClient = new SetupClientImpl();
