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
  playlists: Array<{ id: string; name: string; url: string }>;
  xtreamAccounts: Array<{
    id: string;
    name: string;
    serverUrl: string;
    username: string;
  }>;
  epgUrl: string;
  onlineSubtitles: OnlineSubtitleState;
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
    };
  });
  const xtreamAccounts = input.xtreamAccounts.map(value => {
    const item = objectValue(value);
    return {
      id: stringValue(item.id, 'Xtream id', 120),
      name: stringValue(item.name, 'Xtream name', 120),
      serverUrl: httpUrl(item.serverUrl, 'server URL'),
      username: stringValue(item.username, 'username', 256),
    };
  });
  const onlineSubtitles = objectValue(input.onlineSubtitles);
  return {
    playlists,
    xtreamAccounts,
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
      epgUrl: state.epgUrl,
      onlineSubtitles: { ...state.onlineSubtitles },
    };
  }

  get(): SetupState {
    return {
      playlists: this.state.playlists.map(item => ({ ...item })),
      xtreamAccounts: this.state.xtreamAccounts.map(item => ({ ...item })),
      epgUrl: this.state.epgUrl,
      onlineSubtitles: { ...this.state.onlineSubtitles },
    };
  }
}
