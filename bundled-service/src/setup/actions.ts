import { httpUrl, objectValue, stringValue } from './validation';

export type SetupActionPayload =
  | { type: 'playlist'; name: string; url: string }
  | { type: 'xtream'; serverUrl: string; username: string; password: string }
  | { type: 'epg'; url: string }
  | { type: 'remove-source'; sourceId: string };

export type SetupAction = SetupActionPayload & { id: number };

function passwordValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error('Invalid password');
  }
  return value;
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
