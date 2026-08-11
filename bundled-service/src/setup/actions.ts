import { booleanValue, httpUrl, objectValue, stringValue, subtitleLanguage } from './validation';

interface OpenSubtitlesCredentials {
  apiKey?: string;
  username?: string;
  password?: string;
}

export type SetupActionPayload =
  | { type: 'playlist'; name: string; url: string }
  | { type: 'xtream'; serverUrl: string; username: string; password: string }
  | { type: 'epg'; url: string }
  | { type: 'remove-source'; sourceId: string }
  | { type: 'set-source-enabled'; sourceId: string; enabled: boolean }
  | {
      type: 'online-subtitles';
      preferredLanguage: string;
      subdlApiKey?: string;
      assrtApiKey?: string;
      opensubtitles?: OpenSubtitlesCredentials | null;
    };

export type SetupAction = SetupActionPayload & { id: number };

function passwordValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error('Invalid password');
  }
  return value;
}

function optionalApiKey(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) throw new Error(`Invalid ${field}`);
  return value.trim();
}

export function parseSetupAction(value: unknown): SetupActionPayload {
  const input = objectValue(value);
  if (input.type === 'playlist') {
    return {
      type: 'playlist',
      name: stringValue(input.name, 'playlist name', 120, false),
      url: httpUrl(input.url, 'playlist URL'),
    };
  }
  if (input.type === 'xtream') {
    return {
      type: 'xtream',
      serverUrl: httpUrl(input.serverUrl, 'server URL'),
      username: stringValue(input.username, 'username', 256),
      password: passwordValue(input.password),
    };
  }
  if (input.type === 'epg') {
    return {
      type: 'epg',
      url: httpUrl(input.url, 'program guide URL'),
    };
  }
  if (input.type === 'remove-source') {
    return {
      type: 'remove-source',
      sourceId: stringValue(input.sourceId, 'source id', 120),
    };
  }
  if (input.type === 'set-source-enabled') {
    return {
      type: 'set-source-enabled',
      sourceId: stringValue(input.sourceId, 'source id', 120),
      enabled: booleanValue(input.enabled, 'source enabled state'),
    };
  }
  if (input.type === 'online-subtitles') {
    const subdlApiKey = optionalApiKey(input.subdlApiKey, 'SubDL API key');
    const assrtApiKey = optionalApiKey(input.assrtApiKey, 'Assrt token');
    let opensubtitles: OpenSubtitlesCredentials | null | undefined;
    if (input.opensubtitles === null) {
      opensubtitles = null;
    } else if (input.opensubtitles !== undefined) {
      const credentials = objectValue(input.opensubtitles);
      const apiKey = optionalApiKey(credentials.apiKey, 'OpenSubtitles API key');
      const username = optionalApiKey(credentials.username, 'OpenSubtitles username');
      const password = credentials.password === undefined
        ? undefined
        : credentials.password === ''
          ? ''
          : passwordValue(credentials.password);
      if (apiKey === undefined && username === undefined && password === undefined) {
        throw new Error('Invalid OpenSubtitles credentials');
      }
      opensubtitles = {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(username === undefined ? {} : { username }),
        ...(password === undefined ? {} : { password }),
      };
    }
    return {
      type: 'online-subtitles',
      preferredLanguage: subtitleLanguage(input.preferredLanguage),
      ...(subdlApiKey === undefined ? {} : { subdlApiKey }),
      ...(assrtApiKey === undefined ? {} : { assrtApiKey }),
      ...(opensubtitles === undefined ? {} : { opensubtitles }),
    };
  }
  throw new Error('Invalid setup action type');
}

export class SetupActionStore {
  private actions: SetupAction[] = [];
  private nextId = 1;

  add(payload: SetupActionPayload): SetupAction {
    if (this.actions.length >= 100) throw new Error('Too many pending setup actions');
    const action = { ...payload, id: this.nextId++ } as SetupAction;
    this.actions.push(action);
    return action;
  }

  list(): SetupAction[] {
    return this.actions.map(action => ({ ...action }));
  }

  remove(id: number): boolean {
    const index = this.actions.findIndex(action => action.id === id);
    if (index < 0) return false;
    this.actions.splice(index, 1);
    return true;
  }
}
