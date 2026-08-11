import {
  booleanValue,
  httpUrl,
  objectValue,
  stringValue,
  subtitleLanguage,
} from './validation';

export interface OnlineSubtitleState {
  preferredLanguage: string;
  subdlConfigured: boolean;
  assrtConfigured: boolean;
  opensubtitlesConfigured: boolean;
  opensubtitlesApiKeyConfigured: boolean;
  opensubtitlesPasswordConfigured: boolean;
  opensubtitlesUsername: string;
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
  epgUrl: string;
  onlineSubtitles: OnlineSubtitleState;
}

function enabledState(value: unknown): { enabled?: false } {
  if (value === undefined) return {};
  return booleanValue(value, 'source enabled state') ? {} : { enabled: false };
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
  const onlineSubtitles = objectValue(input.onlineSubtitles);
  return {
    playlists,
    xtreamAccounts,
    uploadedPlaylists,
    epgUrl: input.epgUrl === '' ? '' : httpUrl(input.epgUrl, 'program guide URL'),
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
  };
}

export class SetupStateStore {
  private state: SetupState = {
    playlists: [],
    xtreamAccounts: [],
    uploadedPlaylists: [],
    epgUrl: '',
    onlineSubtitles: {
      preferredLanguage: '',
      subdlConfigured: false,
      assrtConfigured: false,
      opensubtitlesConfigured: false,
      opensubtitlesApiKeyConfigured: false,
      opensubtitlesPasswordConfigured: false,
      opensubtitlesUsername: '',
    },
  };

  set(state: SetupState): void {
    this.state = {
      playlists: state.playlists.map(item => ({ ...item })),
      xtreamAccounts: state.xtreamAccounts.map(item => ({ ...item })),
      uploadedPlaylists: state.uploadedPlaylists.map(item => ({ ...item })),
      epgUrl: state.epgUrl,
      onlineSubtitles: { ...state.onlineSubtitles },
    };
  }

  get(): SetupState {
    return {
      playlists: this.state.playlists.map(item => ({ ...item })),
      xtreamAccounts: this.state.xtreamAccounts.map(item => ({ ...item })),
      uploadedPlaylists: this.state.uploadedPlaylists.map(item => ({ ...item })),
      epgUrl: this.state.epgUrl,
      onlineSubtitles: { ...this.state.onlineSubtitles },
    };
  }
}
