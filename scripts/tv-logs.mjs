#!/usr/bin/env node
// Stream the webOS app's DevTools console to the terminal over the Chrome
// DevTools Protocol — the same console `ares-inspect` shows in its GUI, but
// headless so it can be captured without copy-pasting out of a browser tab.
//
// Usage:
//   node scripts/tv-logs.mjs [--app <id>] [--port 9998] [--seconds N] [--history]
// IP comes from `ares-setup-device` (default device, or TV_DEVICE=<name>).
import {
  CdpClient,
  resolveCdpTarget,
  resolveConfiguredDeviceIp,
} from './cdp-client.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const appFilter = opt('--app', '');
const port = opt('--port', '9998');
const seconds = parseInt(opt('--seconds', '0'), 10); // 0 = run until Ctrl-C
const history = args.includes('--history');
const toErrorMessage = (value) => {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return String(value);
};

// Resolve the device IP from ares-setup-device (no secrets needed for CDP).
let ip;
try {
  ip = resolveConfiguredDeviceIp();
} catch (e) {
  console.error(`tv-logs: ${toErrorMessage(e)}`);
  process.exit(1);
}

let page;
let wsUrl;
try {
  ({ target: page, wsUrl } = await resolveCdpTarget({
    host: ip,
    port,
    target: appFilter,
    targetSelection: 'legacy-tv-app',
  }));
} catch (e) {
  console.error(`tv-logs: ${toErrorMessage(e)}`);
  process.exit(1);
}

console.error(`tv-logs: attached to "${page?.title || ''}" (${page?.description || page?.url || ''})`);

// Render a CDP RemoteObject argument as a short string.
const render = (a) => {
  if (a == null) return '';
  if ('value' in a) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
  if (a.unserializableValue != null) return String(a.unserializableValue);
  if (a.preview?.properties) {
    const body = a.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ');
    return a.subtype === 'array' ? `[${body}]` : `{${body}}`;
  }
  return a.description ?? a.type ?? '';
};
// Prefer the CDP event time (buffered history is replayed on attach, so
// receive-time would mislabel old entries as "now").
const stamp = (ts) => new Date(ts ?? Date.now()).toTimeString().slice(0, 8);

let client;
try {
  client = await CdpClient.connect(wsUrl);
} catch (e) {
  console.error('tv-logs: ws error', toErrorMessage(e));
  process.exit(0);
}

client.on('Runtime.consoleAPICalled', (params) => {
  const text = (params.args || []).map(render).join(' ');
  const tag = params.type === 'log' ? '' : `.${params.type}`;
  console.log(`${stamp(params.timestamp)} [console${tag}] ${text}`);
});
client.on('Runtime.exceptionThrown', (params) => {
  const details = params.exceptionDetails;
  console.log(`${stamp(params.timestamp)} [exception] ${details.exception?.description || details.text}`);
});
client.on('Log.entryAdded', (params) => {
  console.log(`${stamp(params.entry.timestamp)} [${params.entry.level}] ${params.entry.text}`);
});
client.socket.addEventListener('error', (event) => {
  console.error('tv-logs: ws error', event.message || event);
});
client.socket.addEventListener('close', () => {
  process.exit(0);
});

const callAndCloseOnError = (method) => {
  void client.call(method).catch((error) => {
    console.error(`tv-logs: ${toErrorMessage(error)}`);
    client.close();
  });
};
callAndCloseOnError('Runtime.enable');
if (history) callAndCloseOnError('Log.enable'); // replays buffered browser-side log entries
callAndCloseOnError('Console.enable');

if (seconds > 0) setTimeout(() => client.close(), seconds * 1000);
process.on('SIGINT', () => client.close());
