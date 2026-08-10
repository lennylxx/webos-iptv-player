export type SetupActionPayload =
  | { type: 'playlist'; name: string; url: string }
  | { type: 'xtream'; serverUrl: string; username: string; password: string }
  | { type: 'epg'; url: string };

export type SetupAction = SetupActionPayload & { id: number };

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid setup request');
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  field: string,
  maxLength: number,
  required = true,
): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  const text = value.trim();
  if ((required && !text) || text.length > maxLength) {
    throw new Error(`Invalid ${field}`);
  }
  return text;
}

function httpUrl(value: unknown, field: string): string {
  const text = stringValue(value, field, 4096);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${field}`);
  }
  return text;
}

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
