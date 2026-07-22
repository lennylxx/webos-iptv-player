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
import {
  enableCdpLogs,
  normalizeCdpLogEvent,
  subscribeCdpLogs,
} from './cdp-logs.mjs';

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

let client;
try {
  client = await CdpClient.connect(wsUrl);
} catch (e) {
  console.error('tv-logs: ws error', toErrorMessage(e));
  process.exit(0);
}

subscribeCdpLogs(client, (method, params) => {
  const event = normalizeCdpLogEvent(method, params);
  const stamp = new Date(event.observedAt).toTimeString().slice(0, 8);
  if (event.source === 'console') {
    const tag = event.level === 'log' ? '' : `.${event.level}`;
    console.log(`${stamp} [console${tag}] ${event.text}`);
  } else if (event.source === 'exception') {
    console.log(`${stamp} [exception] ${event.text}`);
  } else {
    console.log(`${stamp} [${event.level}] ${event.text}`);
  }
});
client.socket.addEventListener('error', (event) => {
  console.error('tv-logs: ws error', event.message || event);
});
client.socket.addEventListener('close', () => {
  process.exit(0);
});

void enableCdpLogs(client, { history }).catch((error) => {
  console.error(`tv-logs: ${toErrorMessage(error)}`);
  client.close();
});

if (seconds > 0) setTimeout(() => client.close(), seconds * 1000);
process.on('SIGINT', () => client.close());
