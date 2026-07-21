import { execFileSync } from 'node:child_process';

const CONNECTION_CLOSED_ERROR = 'CDP connection closed';
const NO_PAGE_TARGET_PATTERN = /^No page target matched "([^"]+)"/;
const NETWORK_ERROR_DETAILS = new Map([
  ['ECONNREFUSED', {
    reason: 'connection refused',
    hint: 'Check that Developer Mode is active, the app is open, and the CDP port is correct.',
  }],
  ['ECONNRESET', {
    reason: 'connection reset',
    hint: 'The app, TV, or network closed the connection while it was being established.',
  }],
  ['EHOSTUNREACH', {
    reason: 'host unreachable',
    hint: 'Check that the TV is on, its IP address is current, and the computer is on the same LAN.',
  }],
  ['ENETUNREACH', {
    reason: 'network unreachable',
    hint: 'Check the computer network connection and that the TV is on the same LAN.',
  }],
  ['ENOTFOUND', {
    reason: 'host name not found',
    hint: 'Check the configured TV host name or use its current IP address.',
  }],
  ['ETIMEDOUT', {
    reason: 'connection timed out',
    hint: 'Check that the TV is on, reachable on the LAN, and not blocked by a firewall.',
  }],
]);

const matchFields = (page) => [
  page.id ?? '',
  page.url ?? '',
  page.title ?? '',
  page.description ?? '',
];

const describeTarget = (page) => {
  const title = page.title || page.id || '(untitled)';
  const details = [page.description, page.url].filter(Boolean).join(' ');
  return details ? `${title} (${details})` : title;
};

const selectLegacyTvAppTarget = (pages, filter) => {
  if (!filter) return pages[0];

  return (
    pages.find((page) => page.description === filter || (page.url ?? '').includes(filter)) ||
    pages[0]
  );
};

const toErrorMessage = (value, fallback) => {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return fallback;
};

const findNetworkErrorCode = (error) => {
  const queue = [error];
  const visited = new Set();

  while (queue.length) {
    const value = queue.shift();
    if (value == null || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);

    if (typeof value.code === 'string' && NETWORK_ERROR_DETAILS.has(value.code)) {
      return value.code;
    }
    if (value.cause) queue.push(value.cause);
    if (Array.isArray(value.errors)) queue.push(...value.errors);
  }

  const message = toErrorMessage(error, '');
  return [...NETWORK_ERROR_DETAILS.keys()].find((code) => message.includes(code)) ?? null;
};

export function normalizeCdpConnectionError(error, { endpoint, phase }) {
  const message = toErrorMessage(error, String(error));
  const noPageTargetMatch = message.match(NO_PAGE_TARGET_PATTERN);
  if (noPageTargetMatch) {
    return new Error(
      `app target "${noPageTargetMatch[1]}" is not open or inspectable. ${message}`,
    );
  }
  if (message === 'No inspectable page targets available.') {
    return new Error(
      'CDP endpoint is reachable, but no inspectable app page is open. Open the app on the TV and retry.',
    );
  }

  const networkCode = findNetworkErrorCode(error);
  if (networkCode) {
    const detail = NETWORK_ERROR_DETAILS.get(networkCode);
    return new Error(`${phase} failed at ${endpoint}: ${detail.reason}. ${detail.hint}`);
  }
  if (message === 'fetch failed' || message === 'CDP connection failed') {
    return new Error(
      `${phase} failed at ${endpoint}: ${message}. Check that the TV is on, reachable, and the app is open.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

export function normalizeDeviceConfigurationError(error) {
  const message = toErrorMessage(error, 'cannot resolve device IP');
  if (message.startsWith('TV device configuration failed:')) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(
    `TV device configuration failed: ${message}. `
    + 'Run "ares-setup-device -F" and set a default device or TV_DEVICE.',
  );
}

export function resolveConfiguredDeviceIp({ deviceName, execFile = execFileSync } = {}) {
  try {
    const raw = execFile(
      'ares-setup-device',
      ['-F', '-j'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const devices = JSON.parse(raw);
    const requestedNames = [deviceName, process.env.TV_DEVICE].filter(Boolean);
    const device =
      requestedNames
        .map((name) => devices.find((entry) => entry.name === name))
        .find(Boolean) ||
      devices.find((entry) => entry.default) ||
      devices[0];
    const ip = device?.deviceinfo?.ip;
    if (!ip) throw new Error('missing device ip');
    return ip;
  } catch {
    throw normalizeDeviceConfigurationError(
      new Error('cannot resolve device IP from ares-setup-device'),
    );
  }
}

export function selectPageTarget(
  targets,
  filter,
  { fallbackToFirst = false, targetSelection = 'strict' } = {},
) {
  const pages = targets.filter((target) => target?.type === 'page');
  if (!pages.length) throw new Error('No inspectable page targets available.');

  if (targetSelection === 'legacy-tv-app') {
    return selectLegacyTvAppTarget(pages, filter);
  }

  if (!filter) return pages[0];

  const exactMatches = pages.filter((page) => matchFields(page).some((field) => field === filter));
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    throw new Error(`Ambiguous page target "${filter}". Matches: ${exactMatches.map(describeTarget).join('; ')}`);
  }

  const partialMatches = pages.filter((page) => matchFields(page).some((field) => field.includes(filter)));
  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length > 1) {
    throw new Error(`Ambiguous page target "${filter}". Matches: ${partialMatches.map(describeTarget).join('; ')}`);
  }

  if (fallbackToFirst) return pages[0];

  throw new Error(
    `No page target matched "${filter}". Available targets: ${pages.map(describeTarget).join('; ')}`,
  );
}

export async function resolveCdpWebSocketUrl({
  url,
  host = '127.0.0.1',
  port = 9222,
  target,
  fallbackToFirst = false,
  targetSelection = 'strict',
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  const resolved = await resolveCdpTarget({
    url,
    host,
    port,
    target,
    fallbackToFirst,
    targetSelection,
    fetchImpl,
  });
  return resolved.wsUrl;
}

export async function resolveCdpTarget({
  url,
  host = '127.0.0.1',
  port = 9222,
  target,
  fallbackToFirst = false,
  targetSelection = 'strict',
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (url && /^wss?:\/\//.test(url)) {
    return { target: null, wsUrl: url };
  }
  if (!fetchImpl) throw new Error('CDP target discovery requires fetch.');

  const discoveryBase = url
    ? new URL(url)
    : new URL(`http://${host}:${String(port)}`);
  const discoveryUrl = discoveryBase.pathname === '/json/list'
    ? discoveryBase.href
    : new URL('/json/list', discoveryBase).href;
  let response;
  try {
    response = await fetchImpl(discoveryUrl);
  } catch (error) {
    throw normalizeCdpConnectionError(error, {
      endpoint: discoveryUrl,
      phase: 'CDP discovery',
    });
  }
  if (!response.ok) {
    throw new Error(`CDP target discovery failed: ${response.status}`);
  }

  let targets;
  try {
    targets = await response.json();
  } catch {
    throw new Error('CDP target discovery failed: invalid JSON');
  }

  let selected;
  try {
    selected = selectPageTarget(targets, target, { fallbackToFirst, targetSelection });
  } catch (error) {
    throw normalizeCdpConnectionError(error, {
      endpoint: discoveryUrl,
      phase: 'CDP discovery',
    });
  }
  const wsUrl = selected?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('Selected page target does not expose a WebSocket debugger URL.');

  const socketUrl = new URL(wsUrl);
  if (socketUrl.hostname === 'localhost' || socketUrl.hostname === '127.0.0.1') {
    socketUrl.hostname = discoveryBase.hostname;
  }
  return {
    target: selected,
    wsUrl: socketUrl.toString(),
  };
}

export class CdpClient {
  static connect(url, { WebSocketImpl = WebSocket } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      const onOpen = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        resolve(new CdpClient(socket));
      };
      const onError = (event) => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        reject(normalizeCdpConnectionError(event, {
          endpoint: url,
          phase: 'CDP WebSocket connection',
        }));
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.handleMessage = this.handleMessage.bind(this);
    this.handleClose = this.handleClose.bind(this);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(CONNECTION_CLOSED_ERROR));

    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      const current = this.listeners.get(method);
      if (!current) return;
      current.delete(listener);
      if (!current.size) this.listeners.delete(method);
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    this.rejectPending(CONNECTION_CLOSED_ERROR);
    this.socket.close();
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (!message.method) return;
    const listeners = this.listeners.get(message.method);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(message.params);
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    this.rejectPending(CONNECTION_CLOSED_ERROR);
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}
