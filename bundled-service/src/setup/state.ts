import { createLogger } from '../logger';
import {
  booleanValue,
  httpUrl,
  objectValue,
  stringValue,
  subtitleLanguage,
} from './validation';

const log = createLogger('setup');

export interface OnlineSubtitleState {
  preferredLanguage: string;
  subdlConfigured: boolean;
  assrtConfigured: boolean;
  opensubtitlesConfigured: boolean;
  opensubtitlesApiKeyConfigured: boolean;
  opensubtitlesPasswordConfigured: boolean;
  opensubtitlesUsername: string;
}

export interface AiState {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  extraHeadersConfigured: boolean;
}

export interface ManualEpgSourceState {
  url: string;
  playlistIds: string[];
}

export interface SetupState {
  playlists: Array<{ id: string; name: string; url: string; enabled?: boolean }>;
  xtreamAccounts: Array<{
    id: string;
    name: string;
    serverUrl: string;
    username: string;
    enabled?: boolean;
  }>;
  uploadedPlaylists: Array<{
    id: string;
    uploadId: string;
    enabled?: boolean;
  }>;
  manualEpgSources: ManualEpgSourceState[];
  onlineSubtitles: OnlineSubtitleState;
  ai: AiState;
}

function defaultAiState(): AiState {
  return { baseUrl: '', model: '', apiKeyConfigured: false, extraHeadersConfigured: false };
}

// A missing or invalid AI state falls back to the default: a bad AI field
// must not reject the whole snapshot, which would stall every phone action.
function aiState(value: unknown): AiState {
  if (value === undefined) return defaultAiState();
  try {
    return parseAiState(value);
  } catch (e) {
    log.warn('Invalid AI state; publishing defaults', 'event=setup.ai_state.invalid',
      'reason=' + (e instanceof Error ? e.message.replace(/\s+/g, '_') : 'unknown'));
    return defaultAiState();
  }
}

function parseAiState(value: unknown): AiState {
  const input = objectValue(value);
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim() === ''
    ? ''
    : httpUrl(input.baseUrl, 'AI server URL');
  return {
    baseUrl,
    model: stringValue(input.model, 'AI model', 200, false),
    apiKeyConfigured: booleanValue(input.apiKeyConfigured, 'AI API key status'),
    extraHeadersConfigured: booleanValue(input.extraHeadersConfigured, 'AI HTTP headers status'),
  };
}

function enabledState(value: unknown): { enabled?: false } {
  if (value === undefined) return {};
  return booleanValue(value, 'source enabled state') ? {} : { enabled: false };
}

function manualEpgSources(value: unknown): ManualEpgSourceState[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Invalid program guide sources');
  }
  const seen: Record<string, boolean> = {};
  return value.map(source => {
    const item = objectValue(source);
    if (!Array.isArray(item.playlistIds) || item.playlistIds.length > 100) {
      throw new Error('Invalid program guide playlist scope');
    }
    const url = httpUrl(item.url, 'program guide URL');
    const playlistIds = item.playlistIds.map(id =>
      stringValue(id, 'playlist id', 120));
    if (seen[url]) throw new Error('Duplicate program guide source URL');
    seen[url] = true;
    return { url, playlistIds };
  });
}

export function parseSetupState(value: unknown): SetupState {
  const input = objectValue(value);
  if (!Array.isArray(input.playlists) || input.playlists.length > 100 ||
      !Array.isArray(input.xtreamAccounts) || input.xtreamAccounts.length > 100) {
    throw new Error('Invalid setup state');
  }
  const playlists = input.playlists.map(value => {
    const item = objectValue(value);
    return {
      id: stringValue(item.id, 'playlist id', 120),
      name: stringValue(item.name, 'playlist name', 120),
      url: httpUrl(item.url, 'playlist URL'),
      ...enabledState(item.enabled),
    };
  });
  const xtreamAccounts = input.xtreamAccounts.map(value => {
    const item = objectValue(value);
    return {
      id: stringValue(item.id, 'Xtream id', 120),
      name: stringValue(item.name, 'Xtream name', 120),
      serverUrl: httpUrl(item.serverUrl, 'server URL'),
      username: stringValue(item.username, 'username', 256),
      ...enabledState(item.enabled),
    };
  });
  if (input.uploadedPlaylists !== undefined &&
      (!Array.isArray(input.uploadedPlaylists) || input.uploadedPlaylists.length > 100)) {
    throw new Error('Invalid uploaded playlists');
  }
  const uploadedPlaylists = (input.uploadedPlaylists ?? []).map(value => {
    const item = objectValue(value);
    return {
      id: stringValue(item.id, 'uploaded playlist id', 120),
      uploadId: stringValue(item.uploadId, 'upload id', 60),
      ...enabledState(item.enabled),
    };
  });
  const parsedManualEpgSources = manualEpgSources(input.manualEpgSources);
  const onlineSubtitles = objectValue(input.onlineSubtitles);
  return {
    playlists,
    xtreamAccounts,
    uploadedPlaylists,
    manualEpgSources: parsedManualEpgSources,
    onlineSubtitles: {
      preferredLanguage: subtitleLanguage(onlineSubtitles.preferredLanguage),
      subdlConfigured: booleanValue(onlineSubtitles.subdlConfigured, 'SubDL status'),
      assrtConfigured: booleanValue(onlineSubtitles.assrtConfigured, 'Assrt status'),
      opensubtitlesConfigured: booleanValue(
        onlineSubtitles.opensubtitlesConfigured,
        'OpenSubtitles status',
      ),
      opensubtitlesApiKeyConfigured: booleanValue(
        onlineSubtitles.opensubtitlesApiKeyConfigured,
        'OpenSubtitles API key status',
      ),
      opensubtitlesPasswordConfigured: booleanValue(
        onlineSubtitles.opensubtitlesPasswordConfigured,
        'OpenSubtitles password status',
      ),
      opensubtitlesUsername: stringValue(
        onlineSubtitles.opensubtitlesUsername,
        'OpenSubtitles username',
        256,
        false,
      ),
    },
    ai: aiState(input.ai),
  };
}

export class SetupStateStore {
  private state: SetupState = {
    playlists: [],
    xtreamAccounts: [],
    uploadedPlaylists: [],
    manualEpgSources: [],
    onlineSubtitles: {
      preferredLanguage: '',
      subdlConfigured: false,
      assrtConfigured: false,
      opensubtitlesConfigured: false,
      opensubtitlesApiKeyConfigured: false,
      opensubtitlesPasswordConfigured: false,
      opensubtitlesUsername: '',
    },
    ai: defaultAiState(),
  };

  set(state: SetupState): void {
    this.state = {
      playlists: state.playlists.map(item => ({ ...item })),
      xtreamAccounts: state.xtreamAccounts.map(item => ({ ...item })),
      uploadedPlaylists: state.uploadedPlaylists.map(item => ({ ...item })),
      manualEpgSources: state.manualEpgSources.map(item => ({
        url: item.url,
        playlistIds: item.playlistIds.slice(),
      })),
      onlineSubtitles: { ...state.onlineSubtitles },
      ai: { ...state.ai },
    };
  }

  get(): SetupState {
    return {
      playlists: this.state.playlists.map(item => ({ ...item })),
      xtreamAccounts: this.state.xtreamAccounts.map(item => ({ ...item })),
      uploadedPlaylists: this.state.uploadedPlaylists.map(item => ({ ...item })),
      manualEpgSources: this.state.manualEpgSources.map(item => ({
        url: item.url,
        playlistIds: item.playlistIds.slice(),
      })),
      onlineSubtitles: { ...this.state.onlineSubtitles },
      ai: { ...this.state.ai },
    };
  }
}
