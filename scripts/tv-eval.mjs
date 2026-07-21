#!/usr/bin/env node
// Evaluate a JS expression inside the running webOS app's page over the Chrome
// DevTools Protocol — the headless counterpart of typing into the console
// `ares-inspect` opens. Use it to probe live app/DOM state from the terminal.
//
// Usage:
//   node scripts/tv-eval.mjs [--app <id>] [--port 9998] '<expression>'
//   node scripts/tv-eval.mjs [--app <id>] --file <path.js>   # read JS from a file
//   node scripts/tv-eval.mjs [--app <id>] -  <<'JS' … JS      # read JS from stdin
// Prefer --file / stdin for anything with backticks or `$` — the shell can't mangle it.
// IP comes from `ares-setup-device` (default device, or TV_DEVICE=<name>).
// The expression must return a JSON-serializable value (strings, numbers, plain
// objects) — DOM nodes and the like can't cross the protocol, so JSON.stringify
// what you need:
//   scripts/tv.sh eval --app <id> 'JSON.stringify(<expression>)'
import { readFileSync } from 'node:fs';
import {
  CdpClient,
  resolveCdpWebSocketUrl,
  resolveConfiguredDeviceIp,
} from './cdp-client.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const appFilter = opt('--app', '');
const port = opt('--port', '9998');
const file = opt('--file', opt('-f', ''));
const toErrorMessage = (value) => {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return String(value);
};
// Everything that isn't a recognized flag (or a flag's value) is the expression.
const flags = new Set(['--app', '--port', '--file', '-f']);
const positional = args
  .filter((a, i) => !flags.has(a) && !flags.has(args[i - 1]))
  .join(' ');
// Source the JS from `--file <path>` / `-f <path>`, stdin (`-`, e.g. a heredoc), or the
// positional arg. A file/stdin reads the bytes directly, so backticks / `$` / `${…}` in the
// expression survive — the shell never sees them (unlike inlining `"$(cat foo.js)"`).
let expression;
try {
  if (file) expression = readFileSync(file === '-' ? 0 : file, 'utf-8');
  else if (positional === '-') expression = readFileSync(0, 'utf-8');
  else expression = positional;
} catch (e) {
  console.error(`tv-eval: cannot read ${file || 'stdin'}: ${e.message}`);
  process.exit(2);
}
if (!expression.trim()) {
  console.error('tv-eval: no expression given.\n'
    + 'Usage: tv-eval.mjs [--app <id>] [--port 9998] (\'<expression>\' | --file <path.js> | -)');
  process.exit(2);
}

// Resolve the device IP from ares-setup-device (no secrets needed for CDP).
let ip;
try {
  ip = resolveConfiguredDeviceIp();
} catch (e) {
  console.error(`tv-eval: ${toErrorMessage(e)}`);
  process.exit(1);
}

let client;
let exitCode = 0;
try {
  const wsUrl = await resolveCdpWebSocketUrl({
    host: ip,
    port,
    target: appFilter,
    targetSelection: 'legacy-tv-app',
  });
  client = await CdpClient.connect(wsUrl);

  // awaitPromise resolves an async expression; returnByValue ships the result
  // back as JSON rather than a remote handle.
  const { result, exceptionDetails } = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    console.error(`tv-eval: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
    exitCode = 1;
  } else {
    if (result.type === 'undefined') console.log('undefined');
    else if (result.value !== undefined && typeof result.value === 'object') {
      console.log(JSON.stringify(result.value, null, 2));
    } else {
      console.log(String(result.value ?? result.description ?? ''));
    }
  }
} catch (e) {
  console.error(`tv-eval: ${toErrorMessage(e)}`);
  exitCode = 1;
} finally {
  client?.close();
}
process.exit(exitCode);
