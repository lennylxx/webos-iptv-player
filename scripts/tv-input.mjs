#!/usr/bin/env node
// Drive remote-control input on the LG webOS TV the way a real remote does.
//
// The default evdev backend writes Linux input events into the TV's own input
// devices over the developer-mode shell, so webOS's compositor, cursor
// show/hide logic, and native scrolling all run exactly as with a physical
// remote. The --cdp backend synthesizes DOM events through DevTools instead,
// for targets without a writable /dev/input (the webOS 4 emulator).
//
// wake powers the TV back on with a Wake-on-LAN magic packet. Its MAC comes
// from this computer's ARP cache or else from the TV over SSH, remembered in a
// per-user cache file outside the repository, so no address lives in a
// tracked file or in the output.
import { execFileSync, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectCdpWithAresFallback,
  resolveConfiguredDevice,
  resolveConfiguredDeviceIp,
} from './cdp-client.mjs';
import { enableCdpLogs, normalizeCdpLogEvent, subscribeCdpLogs } from './cdp-logs.mjs';
import { formatOptions, parseArgs } from './cli-args.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TV_SCRIPT = join(SCRIPT_DIR, 'tv.sh');
const DEFAULT_APP_ID = 'com.lennylxx.iptv';
const DEFAULT_PORT = 9998;
const SCREEN = { width: 1920, height: 1080 };
const MOVE_TOLERANCE = 1;
const MOVE_ROUNDS = 5;
const DEFAULT_SSH_PORT = 9922;
const SSH_GRACE_SECONDS = 5;
const WAKE_PORTS = [9, 7];
const LIMITED_BROADCAST = '255.255.255.255';
const DEFAULT_SETTLE_MS = 100;
const SETTLE_POLL_MS = 50;

// name -> [Linux evdev code on the "LGE RCU" device, DOM keyCode it produces]
export const KEYS = new Map([
  ['up', [103, 38]],
  ['down', [108, 40]],
  ['left', [105, 37]],
  ['right', [106, 39]],
  ['ok', [28, 13]],
  ['back', [412, 461]],
  ['red', [398, 403]],
  ['green', [399, 404]],
  ['yellow', [400, 405]],
  ['blue', [401, 406]],
  ['ch-up', [402, 33]],
  ['ch-down', [403, 34]],
  ['play', [207, 415]],
  ['pause', [119, 19]],
  ['stop', [128, 413]],
  ['rewind', [168, 412]],
  ['forward', [208, 417]],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), [n + 1, 48 + n]]),
  ['0', [11, 48]],
  // webOS keeps power and home for itself; no page sees a key event for them.
  ['power', [116, null]],
  ['home', [773, null]],
]);

// Relative ClickableMouse step -> CSS pixels moved, measured on webOS 25 with
// steps at least 30 ms apart. webOS accelerates by magnitude and caps a single
// step near 58 px; faster bursts accelerate further, so steps are spaced out.
export const POINTER_GAIN = [[16, 58], [12, 41], [8, 22], [6, 14], [4, 8], [3, 5], [2, 2], [1, 1]];

export const INPUT_SPEC = {
  commands: ['key', 'move', 'click', 'wheel', 'tap', 'do', 'pos', 'wake'],
  options: {
    gap: {
      type: 'integer',
      min: 0,
      default: 150,
      commands: ['key', 'wheel'],
      valueName: '<ms>',
      description: 'Delay between repeated keys or wheel notches',
    },
    at: {
      type: 'integer',
      arity: 2,
      commands: ['wheel'],
      valueName: '<px>',
      description: 'Scroll at this x y point instead of at the pointer',
    },
    if: {
      type: 'string',
      commands: ['key', 'move', 'click', 'wheel', 'tap'],
      valueName: '<js>',
      description: 'Act only if this page expression is truthy, or else fail',
    },
    wait: {
      type: 'string',
      commands: ['key', 'move', 'click', 'wheel', 'tap', 'do'],
      valueName: '<js>',
      description: 'Then poll this page expression until it is truthy and print it',
    },
    'wait-timeout': {
      type: 'number',
      positive: true,
      default: 5,
      commands: ['key', 'move', 'click', 'wheel', 'tap', 'do'],
      valueName: '<s>',
      description: 'Seconds to wait for --wait and --wait-log, for tap to find '
        + 'its target, and for --settle',
    },
    'wait-log': {
      type: 'string',
      commands: ['key', 'move', 'click', 'wheel', 'tap', 'do'],
      valueName: '<regex>',
      description: 'Then wait for a console line matching this regex and print it',
    },
    settle: {
      type: 'boolean',
      commands: ['tap'],
      description: `Click only once the target's box has held still for ${String(DEFAULT_SETTLE_MS)} ms; `
        + '--settle=<ms> sets the time',
    },
    cdp: {
      type: 'boolean',
      description: 'Synthesize DOM events over DevTools instead of writing the '
        + 'TV\'s input devices (for the webOS 4 emulator)',
    },
    app: {
      type: 'string',
      default: DEFAULT_APP_ID,
      valueName: '<id>',
      description: 'App page to observe',
    },
    timeout: {
      type: 'number',
      positive: true,
      default: 90,
      commands: ['wake'],
      valueName: '<s>',
      description: 'Seconds to wait for the TV to wake',
    },
    'no-wait': {
      type: 'boolean',
      commands: ['wake'],
      description: 'Send the packet and return',
    },
    learn: {
      type: 'boolean',
      commands: ['wake'],
      description: 'Remember the MAC of the TV, which must be on',
    },
    help: { type: 'boolean', short: 'h', description: 'Show this help' },
  },
};

export const INPUT_HELP = `Drive remote-control input on the LG webOS TV.

Usage:
  scripts/tv.sh input key <name>... [--gap <ms>]
  scripts/tv.sh input move <x> <y>
  scripts/tv.sh input click [<x> <y>]
  scripts/tv.sh input wheel <notches> [--at <x> <y>] [--gap <ms>]
  scripts/tv.sh input tap <selector> | key=<data-key> | text=<text>
  scripts/tv.sh input do '<step>'... [--cdp] [--wait <js>] [--wait-log <regex>]
  scripts/tv.sh input pos
  scripts/tv.sh input wake [--timeout <s>] [--no-wait]
  scripts/tv.sh input wake --learn

${formatOptions(INPUT_SPEC)}

Keys: ${[...KEYS.keys()].join(' ')}
Coordinates are CSS pixels on the 1920x1080 app canvas. A positive wheel count
scrolls down, a negative one up, at --at or else where the pointer is. A
hidden webOS cursor reappears at the screen center on the next move; any key
press hides it. Keys go straight to the TV, so they work with the app closed.
power turns the TV off; wake turns it back on. home opens webOS Home. --cdp
cannot send power, home, or wake.

tap skips the remote: it finds the first visible element by CSS selector, by
data-key, or by the text (or else aria-label) of a [data-focusable] element,
exact match first. It waits up to --wait-timeout for the element to appear,
scrolls it into view, and clicks its center with a DevTools mouse event, the
same trusted click a Magic Remote sends. It fails, naming the element, when
something else covers that point. A virtualized list renders only rows near
its focus, so a far row is not found until the list scrolls there. It then
checks where the press and click landed and fails, naming what was hit and
where the target had moved, when they missed the target. --settle waits for
a list that is still scrolling or re-rendering to hold still first.

--if '<js>' checks the page first and fails, sending nothing, unless the
expression is truthy: guard a down or ok that must land in an open menu, or it
zaps channels instead.

do runs each quoted step (any key, move, click, wheel, tap, or pos command,
with its own --if and --wait) in order over one DevTools connection and stops
at the first failure. --cdp on do applies to every step; a trailing --wait
runs after the last one.
  scripts/tv.sh input do 'tap text=Audio' 'key down ok --cdp --gap 0' --wait '<js>'
Put a step's --if or --wait expression in double quotes inside the step.
--if, --gap, --at, and --settle belong to one step and go inside its quotes.

--wait '<js>' runs after the action in the same connection: it polls the
expression every 100 ms until it is truthy and prints the value, or fails
after --wait-timeout seconds, so one call both acts and confirms. Example:
  scripts/tv.sh input tap text=ch2 --wait "document.querySelector('#player:not(.hidden)') && 'playing'"

--wait-log '<regex>' listens to the page console from just before the action
(from the first step of a do) and prints the first line that matches, or
fails after --wait-timeout seconds. It runs before --wait. Example:
  scripts/tv.sh input tap key=ch:2 --wait-log 'event=playback\\.path'

wake sends a Wake-on-LAN packet, then waits until the TV answers over SSH and
reports it is active, not in standby. The TV's
MAC is learned while the TV is on, from this computer's ARP cache or else
from the TV over SSH, and remembered outside the repository
(${'$'}XDG_CACHE_HOME or ~/.cache); run wake --learn once with the TV on, or set
TV_MAC. The TV must have Wake-on-LAN enabled, and this computer must share its
subnet. A TV that is on with its SSH port closed fails within a few seconds.
`;

const integer = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
};

const coordinate = (value, name, max) => {
  const number = integer(value, name);
  if (number < 0 || number >= max) throw new Error(`${name} must be from 0 to ${max - 1}`);
  return number;
};

// --settle takes an optional =<ms>, which the shared parser has no form for.
function takeSettle(argv) {
  let settle;
  const rest = argv.filter((arg) => {
    const match = /^--settle(?:=(.*))?$/s.exec(arg);
    if (!match) return true;
    if (match[1] === undefined) {
      settle = DEFAULT_SETTLE_MS;
      return true;
    }
    const ms = Number(match[1]);
    if (!match[1] || !Number.isInteger(ms) || ms <= 0) {
      throw new Error('Invalid value for --settle: must be a positive integer of ms');
    }
    settle = ms;
    return false;
  });
  if (settle !== undefined && !rest.includes('--settle')) rest.push('--settle');
  return { argv: rest, settle };
}

// A do step's own option written after the step, outside its quotes.
function checkDoOptions(argv) {
  for (const arg of argv.slice(1)) {
    if (arg === '--') return;
    const name = /^--([\w-]+)/.exec(arg)?.[1];
    const spec = name && Object.hasOwn(INPUT_SPEC.options, name) ? INPUT_SPEC.options[name] : null;
    if (!spec || !spec.commands || spec.commands.includes('do')) continue;
    const value = spec.type === 'boolean' ? '' : ` ${spec.valueName === '<js>' ? '"<js>"' : spec.valueName ?? '<value>'}`;
    throw new Error(`--${name} belongs to one step: put it inside that step's quotes, `
      + `as in do 'key down --cdp --${name}${value}', not after the step`);
  }
}

const regex = (source, flag) => {
  try {
    return new RegExp(source);
  } catch (e) {
    throw new Error(`Invalid value for ${flag}: ${e.message}`);
  }
};

export function parseInputArgs(rawArgv) {
  if (!rawArgv.length || rawArgv.includes('-h') || rawArgv.includes('--help')) return { help: true };
  if (rawArgv[0] === 'do') checkDoOptions(rawArgv);
  const { argv, settle } = takeSettle(rawArgv);
  const { command, values, positionals: rest } = parseArgs(argv, INPUT_SPEC);
  const options = {
    help: false,
    cdp: values.cdp ?? false,
    app: values.app,
    gap: values.gap,
    when: values.if,
    wait: values.wait,
    waitLog: values['wait-log'] === undefined ? undefined : regex(values['wait-log'], '--wait-log'),
    waitTimeout: values['wait-timeout'],
  };
  const point = () => ({
    x: coordinate(rest[0], 'x', SCREEN.width),
    y: coordinate(rest[1], 'y', SCREEN.height),
  });
  switch (command) {
    case 'key': {
      if (!rest.length) throw new Error('key needs at least one key name');
      const unknown = rest.filter((name) => !KEYS.has(name));
      if (unknown.length) throw new Error(`unknown key ${unknown.join(', ')}`);
      const systemOnly = rest.filter((name) => KEYS.get(name)[1] === null);
      if (options.cdp && systemOnly.length) {
        throw new Error(`--cdp cannot send ${systemOnly.join(', ')}; it has no DOM key`);
      }
      return { ...options, command, keys: rest };
    }
    case 'move':
      if (rest.length !== 2) throw new Error('move needs <x> <y>');
      return { ...options, command, to: point() };
    case 'click':
      if (rest.length !== 0 && rest.length !== 2) throw new Error('click takes no point or <x> <y>');
      return { ...options, command, to: rest.length ? point() : undefined };
    case 'wheel': {
      if (rest.length !== 1) throw new Error('wheel needs <notches>');
      const notches = integer(rest[0], 'notches');
      if (notches === 0) throw new Error('notches must not be 0');
      const at = values.at && {
        x: coordinate(values.at[0], '--at x', SCREEN.width),
        y: coordinate(values.at[1], '--at y', SCREEN.height),
      };
      return { ...options, command, notches, at };
    }
    case 'tap': {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('tap needs <selector>, key=<data-key>, or text=<text>');
      return { ...options, command, target: parseTarget(text), settle };
    }
    case 'do': {
      if (!rest.length) throw new Error('do needs at least one quoted step');
      const steps = rest.map((step) => {
        const parsed = parseInputArgs(splitWords(step));
        if (parsed.help || ['do', 'wake'].includes(parsed.command)) {
          throw new Error(`do cannot run "${step}"`);
        }
        return options.cdp ? { ...parsed, cdp: true } : parsed;
      });
      return { ...options, command, steps };
    }
    case 'pos':
      if (rest.length) throw new Error('pos takes no arguments');
      return { ...options, command };
    case 'wake':
      if (rest.length) throw new Error('wake takes no arguments');
      if (options.cdp) throw new Error('--cdp cannot wake the TV');
      return {
        ...options,
        command,
        timeout: values.timeout,
        wait: !values['no-wait'],
        learn: values.learn ?? false,
      };
    default:
      throw new Error(`unknown command ${command}`);
  }
}

// Shell-style words: whitespace splits, quotes group, backslash escapes.
export function splitWords(text) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < text.length) {
      word = (word ?? '') + text[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in "${text}"`);
  if (word !== null) words.push(word);
  return words;
}

export function parseTarget(text) {
  const match = /^(key|text)=(.*)$/s.exec(text);
  if (!match) return { by: 'selector', value: text };
  if (!match[2]) throw new Error(`${match[1]}= needs a value`);
  return { by: match[1], value: match[2] };
}

const describeTarget = (target) => (target.by === 'selector' ? target.value : `${target.by}=${target.value}`);

// Runs in the page. Chromium 53 compatible: no optional chaining or spread.
// mode 'scroll' scrolls the target into view; 'measure' reports its center and
// what covers it; 'arm' also records, from the window capture phase, where the
// next pointer events land and where the target is at that moment.
export function targetScript(target, mode) {
  return `(() => {
  const by = ${JSON.stringify(target.by)};
  const value = ${JSON.stringify(target.value)};
  const mode = ${JSON.stringify(mode)};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const text = (el) => ((el.textContent || '').replace(/\\s+/g, ' ').trim()
    || el.getAttribute('aria-label') || '');
  let el = null;
  if (by === 'selector') {
    el = Array.prototype.find.call(document.querySelectorAll(value), visible) || null;
  } else if (by === 'key') {
    el = Array.prototype.find.call(document.querySelectorAll('[data-key]'),
      (e) => e.getAttribute('data-key') === value && visible(e)) || null;
  } else {
    const want = value.toLowerCase();
    const items = Array.prototype.filter.call(document.querySelectorAll('[data-focusable]'), visible);
    el = items.find((e) => text(e).toLowerCase() === want)
      || items.find((e) => text(e).toLowerCase().indexOf(want) >= 0) || null;
  }
  if (!el) return { found: false };
  if (mode === 'scroll') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return { found: true };
  }
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
    + (e.getAttribute('data-key') ? '[data-key=' + e.getAttribute('data-key') + ']' : '');
  const box = (e) => {
    const r = e.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  const rect = box(el);
  const x = Math.round(rect[0] + rect[2] / 2);
  const y = Math.round(rect[1] + rect[3] / 2);
  const hit = document.elementFromPoint(x, y);
  if (mode === 'arm') {
    const tap = window.__tvTap || (window.__tvTap = {});
    tap.el = el;
    tap.events = [];
    if (!tap.installed) {
      tap.installed = true;
      const keyed = (e) => {
        let n = e;
        while (n && n.nodeType === 1 && !n.getAttribute('data-key')) n = n.parentNode;
        return n && n.nodeType === 1 ? n : e;
      };
      const record = (e) => {
        const t = window.__tvTap;
        if (!t.el || t.events.length >= 8 || !e.target || e.target.nodeType !== 1) return;
        const k = keyed(e.target);
        t.events.push({
          type: e.type, x: e.clientX, y: e.clientY,
          hit: name(k), key: k.getAttribute('data-key'), text: text(k).slice(0, 60),
          inside: t.el === e.target || t.el.contains(e.target),
          attached: document.documentElement.contains(t.el),
          rect: box(t.el),
        });
      };
      ['mousemove', 'mousedown', 'mouseup', 'click'].forEach((type) => {
        window.addEventListener(type, record, true);
      });
    }
  }
  return {
    found: true, x: x, y: y, rect: rect, name: name(el), text: text(el).slice(0, 60),
    covered: hit && hit !== el && !el.contains(hit) ? name(hit) : null,
  };
})()`;
}

const TAP_REPORT = `(() => {
  const t = window.__tvTap;
  if (!t || !t.el) return null;
  const events = t.events;
  t.el = null;
  t.events = [];
  return events;
})()`;

export async function waitFor(page, expression, seconds, now = Date.now, wait = sleep) {
  const deadline = now() + seconds * 1000;
  for (;;) {
    let value;
    let error = null;
    try {
      value = await page.evaluate(expression);
    } catch (e) {
      error = e;
    }
    if (!error && value) return value;
    if (now() >= deadline) {
      const last = error ? `threw ${error.message}` : `was ${JSON.stringify(value)}`;
      throw new Error(`--wait timed out after ${String(seconds)} s; it last ${last}`);
    }
    await wait(100);
  }
}

const sameRect = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const at = (point) => `${String(point.x)},${String(point.y)}`;
const rectText = (rect) => `${String(rect[0])},${String(rect[1])} ${String(rect[2])}x${String(rect[3])}`;

// Polls the target until its box is unchanged for ms, so a list that is
// still scrolling or re-rendering cannot move a row under the click.
export async function settleTarget(page, target, ms, seconds, wait = sleep, now = Date.now) {
  const start = now();
  const deadline = start + seconds * 1000;
  let last = await page.evaluate(targetScript(target, 'measure'));
  let since = start;
  let moves = 0;
  for (;;) {
    if (!last || !last.found) throw new Error(`${describeTarget(target)} disappeared while settling`);
    if (now() - since >= ms) return { ...last, moves, settledMs: since - start };
    if (now() >= deadline) {
      throw new Error(`${last.name} kept moving for ${String(seconds)} s; last at ${rectText(last.rect)}`);
    }
    await wait(SETTLE_POLL_MS);
    const next = await page.evaluate(targetScript(target, 'measure'));
    if (!next || !next.found || !sameRect(next.rect, last.rect)) {
      since = now();
      moves += 1;
    }
    last = next;
  }
}

// Judges the recorded pointer events: the press and the click must both land
// inside the measured element, or the app acted on something else.
export function checkTapEvents(hit, events) {
  if (!events) return { verified: false, problem: 'the page lost the tap recorder' };
  const press = events.find((e) => e.type === 'mousedown');
  const click = events.find((e) => e.type === 'click');
  const where = (e) => `${e.hit}${e.text ? ` "${e.text}"` : ''}`;
  const moved = (e) => {
    if (!e.attached) return `; ${hit.name} was no longer in the page`;
    if (sameRect(e.rect, hit.rect)) return '';
    const hint = hit.settledMs === undefined ? '; retry with --settle' : '';
    return `; ${hit.name} had moved from ${rectText(hit.rect)} to ${rectText(e.rect)}${hint}`;
  };
  if (!press) return { verified: false, events, problem: `no mousedown reached the page at ${at(hit)}` };
  if (!press.inside) {
    return { verified: false, events, problem: `the press at ${at(hit)} hit ${where(press)}, not ${hit.name}${moved(press)}` };
  }
  if (!click) {
    return { verified: false, events, problem: `the press hit ${hit.name}, but no click followed${moved(press)}` };
  }
  if (!click.inside) {
    return { verified: false, events, problem: `the click at ${at(hit)} hit ${where(click)}, not ${hit.name}${moved(click)}` };
  }
  return { verified: true, events, landed: where(click) };
}

export async function tap(page, backend, target, seconds = 5, wait = sleep, now = Date.now, settle) {
  const deadline = now() + seconds * 1000;
  let located = await page.evaluate(targetScript(target, 'scroll'));
  while ((!located || !located.found) && now() < deadline) {
    await wait(100);
    located = await page.evaluate(targetScript(target, 'scroll'));
  }
  if (!located || !located.found) {
    throw new Error(`no visible element matches ${describeTarget(target)} within ${String(seconds)} s`);
  }
  await wait(150);
  const settled = settle ? await settleTarget(page, target, settle, seconds, wait, now) : null;
  const hit = await page.evaluate(targetScript(target, 'arm'));
  if (!hit || !hit.found) throw new Error(`${describeTarget(target)} disappeared after scrolling`);
  if (settled) hit.settledMs = settled.settledMs;
  if (hit.x < 0 || hit.x >= SCREEN.width || hit.y < 0 || hit.y >= SCREEN.height) {
    throw new Error(`${hit.name} is off the canvas at ${at(hit)}`);
  }
  if (hit.covered) throw new Error(`${hit.name} is covered by ${hit.covered} at ${at(hit)}`);
  await backend.move({ x: hit.x, y: hit.y });
  await backend.click();
  let events;
  try {
    events = await page.evaluate(TAP_REPORT);
  } catch (e) {
    return { ...hit, verified: false, problem: `could not read where the click landed: ${e.message}` };
  }
  const check = checkTapEvents(hit, events);
  if (!check.verified && check.events) {
    throw new Error(`tapped ${hit.name} "${hit.text}" at ${at(hit)}, but ${check.problem}`);
  }
  return { ...hit, ...check };
}

// Split one axis distance into relative steps, largest first.
export function planAxis(distance) {
  const steps = [];
  let left = Math.abs(distance);
  const sign = Math.sign(distance);
  for (const [step, pixels] of POINTER_GAIN) {
    while (left >= pixels) {
      steps.push(step * sign);
      left -= pixels;
    }
  }
  return steps;
}

export function planMove(from, to) {
  return [
    ...planAxis(to.x - from.x).map((dx) => `m:${dx},0`),
    ...planAxis(to.y - from.y).map((dy) => `m:0,${dy}`),
  ];
}

const REMOTE_HELPER = join(SCRIPT_DIR, 'tv-input-remote.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

// The helper travels inline with `node -e`, so each command is a single ssh
// round trip with nothing left behind on the TV.
export function remoteCommand(steps, source = readFileSync(REMOTE_HELPER, 'utf8')) {
  return `node -e ${shellQuote(source)} ${steps.join(' ')}`;
}

export function withGaps(steps, gap) {
  return steps.flatMap((step, i) => (i && gap ? [`s:${gap}`, step] : [step]));
}

// Tracks the pointer from inside the page so moves can close the loop. The
// cursorStateChange event is webOS's own cursor show/hide notification.
const TRACKER = `(() => {
  const t = window.__tvInput || (window.__tvInput = { x: null, y: null, visible: null });
  if (!t.installed) {
    t.installed = true;
    document.addEventListener('mousemove', (e) => { t.x = e.clientX; t.y = e.clientY; t.visible = true; }, true);
    document.addEventListener('cursorStateChange', (e) => {
      t.visible = !!(e.detail && e.detail.visibility);
    }, true);
  }
  return { x: t.x, y: t.y, visible: t.visible };
})()`;

function runOnTv(steps) {
  if (!steps.length) return;
  const result = spawnSync(TV_SCRIPT, ['run', remoteCommand(steps)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw new Error(`tv.sh run failed: ${result.error.message}`);
  if (result.signal) throw new Error(`tv.sh run was killed by ${result.signal}`);
  if (result.status !== 0) throw new Error(`tv.sh run failed with exit code ${result.status}`);
}

export function evdevBackend(page, run = runOnTv) {
  const position = () => page.evaluate(TRACKER);
  // A hidden cursor jumps to the center before applying the first step, and a
  // tracker installed after the last move has no position yet: nudge to learn it.
  const locate = async () => {
    const pos = await position();
    if (pos.x !== null && pos.visible !== false) return pos;
    run(['m:1,0', 'm:-1,0']);
    await sleep(150);
    return position();
  };
  return {
    async key(names, gap) {
      run(withGaps(names.map((name) => `k:${KEYS.get(name)[0]}`), gap));
    },
    async move(to) {
      let pos = await locate();
      if (pos.x === null) throw new Error('pointer position unknown; move the Magic Remote once and retry');
      for (let round = 0; round < MOVE_ROUNDS; round++) {
        if (Math.abs(pos.x - to.x) <= MOVE_TOLERANCE && Math.abs(pos.y - to.y) <= MOVE_TOLERANCE) return pos;
        const steps = planMove(pos, to);
        run(steps.length ? steps : [`m:${Math.sign(to.x - pos.x)},${Math.sign(to.y - pos.y)}`]);
        await sleep(150);
        pos = await position();
      }
      throw new Error(`pointer stopped at ${pos.x},${pos.y}, not ${to.x},${to.y}`);
    },
    async click() {
      run(['c:']);
    },
    async wheel(notches, gap, at) {
      const pos = at || await locate();
      const where = pos.x === null ? '' : `@${pos.x},${pos.y}`;
      run(withGaps(
        Array.from({ length: Math.abs(notches) }, () => `w:${Math.sign(notches)}${where}`),
        gap,
      ));
    },
    position: locate,
  };
}

// Chromium 53 ignores keyCode in the KeyboardEvent constructor, so the codes
// are defined on the event instance the app reads.
const keyScript = (keyCode, type) => `(() => {
  const e = new KeyboardEvent('${type}', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => ${keyCode} });
  Object.defineProperty(e, 'which', { get: () => ${keyCode} });
  (document.activeElement || document.body).dispatchEvent(e);
})()`;

export function cdpBackend(page, client) {
  let last = { x: SCREEN.width / 2, y: SCREEN.height / 2 };
  const mouse = (type, extra = {}) => client.call('Input.dispatchMouseEvent', {
    type, x: last.x, y: last.y, ...extra,
  });
  return {
    async key(names, gap) {
      for (const [i, name] of names.entries()) {
        if (i && gap) await sleep(gap);
        const code = KEYS.get(name)[1];
        await page.evaluate(keyScript(code, 'keydown'));
        await page.evaluate(keyScript(code, 'keyup'));
      }
    },
    async move(to) {
      last = to;
      await mouse('mouseMoved');
      return to;
    },
    async click() {
      await mouse('mousePressed', { button: 'left', clickCount: 1 });
      await mouse('mouseReleased', { button: 'left', clickCount: 1 });
    },
    async wheel(notches, gap, at) {
      if (at) last = at;
      for (let i = 0; i < Math.abs(notches); i++) {
        if (i && gap) await sleep(gap);
        await mouse('mouseWheel', { deltaX: 0, deltaY: 120 * Math.sign(notches) });
      }
    },
    async position() {
      const pos = await page.evaluate(TRACKER);
      return pos.x === null ? last : pos;
    },
  };
}

// Wake-on-LAN

export function normalizeMac(text) {
  const parts = String(text).trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || parts.some((part) => !/^[0-9a-f]{1,2}$/.test(part))) return null;
  const mac = parts.map((part) => part.padStart(2, '0')).join(':');
  return mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff' ? null : mac;
}

// Accepts `arp -n <ip>` (macOS and Linux) and `ip neigh show <ip>` output.
export function parseArpMac(output, ip) {
  for (const line of String(output).split('\n')) {
    if (!line.split(/[\s()]+/).includes(ip)) continue;
    const match = line.match(/(?:^|\s)((?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})(?=\s|$)/i);
    const mac = match && normalizeMac(match[1]);
    if (mac) return mac;
  }
  return null;
}

export function magicPacket(mac) {
  const bytes = normalizeMac(mac)?.split(':').map((part) => parseInt(part, 16));
  if (!bytes) throw new Error('invalid MAC address');
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) Buffer.from(bytes).copy(packet, 6 + i * 6);
  return packet;
}

function ipToInt(ip) {
  return ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

// The directed broadcast of the local subnet holding ip, then the limited one.
export function broadcastAddresses(ip, interfaces = networkInterfaces()) {
  const target = ipToInt(ip);
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      const mask = ipToInt(entry.netmask);
      if ((ipToInt(entry.address) & mask) !== (target & mask)) continue;
      const broadcast = intToIp((target & mask) | (~mask >>> 0));
      if (!addresses.includes(broadcast)) addresses.push(broadcast);
    }
  }
  addresses.push(LIMITED_BROADCAST);
  return addresses;
}

export function cacheFile(env = process.env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'webos-iptv-player', 'wake.json');
}

export function readCachedMac(ip, file = cacheFile()) {
  try {
    return normalizeMac(JSON.parse(readFileSync(file, 'utf8'))[ip] ?? '');
  } catch {
    return null;
  }
}

export function writeCachedMac(ip, mac, file = cacheFile()) {
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    cache = {};
  }
  cache[ip] = mac;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

function lookupArp(ip) {
  for (const [command, args] of [['arp', ['-n', ip]], ['ip', ['neigh', 'show', ip]]]) {
    try {
      const mac = parseArpMac(execFileSync(command, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }), ip);
      if (mac) return mac;
    } catch {
      // Try the next tool.
    }
  }
  return null;
}

export function probePort(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function sendPacket(packet, addresses) {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(() => {
      socket.setBroadcast(true);
      const sends = [];
      for (const address of addresses) {
        for (const port of WAKE_PORTS) {
          sends.push(new Promise((ok, fail) => {
            socket.send(packet, port, address, (error) => (error ? fail(error) : ok()));
          }));
        }
      }
      Promise.allSettled(sends).then((results) => {
        socket.close();
        if (results.every((result) => result.status === 'rejected')) reject(results[0].reason);
        else resolve();
      });
    });
  });
}

// One ssh round trip that works without ip or ifconfig, which webOS lacks:
// the kernel route table maps the IP to an interface, sysfs gives its MAC.
export const TV_MAC_COMMAND = [
  'echo @addr; (ip -o -4 addr || ifconfig) 2>/dev/null',
  'echo @route; cat /proc/net/route 2>/dev/null',
  'echo @mac; for f in /sys/class/net/*/address; do n=${f%/address}; echo "${n##*/} $(cat "$f" 2>/dev/null)"; done',
].join('; ');

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// /proc/net/route prints addresses as native-endian hex, little-endian on TVs.
const routeHexToInt = (hex) => {
  const value = parseInt(hex, 16);
  return (((value & 255) << 24) | (((value >>> 8) & 255) << 16)
    | (((value >>> 16) & 255) << 8) | (value >>> 24)) >>> 0;
};

const baseInterface = (name) => name.replace(/:$/, '').replace(/[:@].*$/, '');

function addressInterface(lines, ip, macs) {
  let block = null;
  let found = null;
  for (const line of lines) {
    const short = line.match(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)\//);
    if (short) {
      if (short[2] === ip) return baseInterface(short[1]);
      continue;
    }
    if (/^\S/.test(line)) {
      if (found) break;
      block = baseInterface(line.split(/\s+/)[0]);
    }
    if (!block) continue;
    const hardware = line.match(/(?:HWaddr|ether)\s+(\S+)/);
    const mac = hardware && normalizeMac(hardware[1]);
    if (mac && !macs.has(block)) macs.set(block, mac);
    const inet = line.match(/\binet\s+(?:addr:)?([\d.]+)/);
    if (inet && inet[1] === ip) found = block;
  }
  return found;
}

function routeInterface(lines, ip) {
  const target = ipToInt(ip);
  let best = null;
  for (const line of lines) {
    const [name, destination, gateway, flags, , , , mask] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{8}$/i.test(destination ?? '') || !/^[0-9a-f]{8}$/i.test(mask ?? '')) continue;
    if (!(parseInt(flags, 16) & 1) || parseInt(gateway, 16) !== 0) continue;
    const bits = routeHexToInt(mask);
    if ((target & bits) >>> 0 !== routeHexToInt(destination)) continue;
    if (!best || bits > best.bits) best = { name: baseInterface(name), bits };
  }
  return best && best.name;
}

// Finds, in TV_MAC_COMMAND output, the MAC of the TV interface holding ip.
export function parseTvMac(output, ip) {
  if (!IPV4.test(ip)) return null;
  const sections = { addr: [], route: [], mac: [] };
  let current = null;
  for (const raw of String(output).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const marker = line.match(/^@(addr|route|mac)$/);
    if (marker) current = sections[marker[1]];
    else if (current) current.push(line);
  }
  const macs = new Map();
  for (const line of sections.mac) {
    const [name, address] = line.trim().split(/\s+/);
    const mac = address && normalizeMac(address);
    if (name && mac) macs.set(name, mac);
  }
  const name = addressInterface(sections.addr, ip, macs) || routeInterface(sections.route, ip);
  return (name && macs.get(name)) || null;
}

function lookupTvMac(ip) {
  const result = spawnSync(TV_SCRIPT, ['run', TV_MAC_COMMAND], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000,
  });
  return result.status === 0 ? parseTvMac(result.stdout, ip) : null;
}

// LG's LAN control ports answer whenever the TV is on, even with the
// Developer Mode SSH server down, and close in standby.
const CONTROL_PORTS = [3000, 3001];
const SSH_CLOSED = 'the TV is on but its SSH port is closed; check Developer Mode';

const POWER_COMMAND = "luna-send -n 1 -f luna://com.webos.service.tvpower/power/getPowerState '{}'";

export function parsePowerState(output) {
  const text = String(output);
  try {
    const state = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).state;
    return typeof state === 'string' ? state : null;
  } catch {
    return null;
  }
}

// Right after power-off the TV may idle in standby with SSH still up.
function lookupPowerState() {
  const result = spawnSync(TV_SCRIPT, ['run', POWER_COMMAND], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
  });
  return result.status === 0 ? parsePowerState(result.stdout) : null;
}

export async function tvPowerState(ip, port = DEFAULT_SSH_PORT, probe = probePort) {
  if (await probe(ip, port)) return 'ssh';
  const control = await Promise.all(CONTROL_PORTS.map((port) => probe(ip, port, 1000)));
  return control.some(Boolean) ? 'on' : 'off';
}

// macOS can hide the ARP cache from a process without Local Network access,
// so an awake TV is also asked for its own MAC over SSH.
export async function learnMac(ip, {
  port = DEFAULT_SSH_PORT, probe = probePort, arp = lookupArp, tv = lookupTvMac, write = writeCachedMac,
} = {}) {
  // A TCP attempt refreshes the ARP entry even when the port is closed.
  const state = await tvPowerState(ip, port, probe);
  const mac = arp(ip) || (state === 'ssh' ? tv(ip) : null);
  if (mac) write(ip, mac);
  if (mac) return 'learned';
  return { ssh: 'unknown', on: 'no-ssh', off: 'asleep' }[state];
}

export async function wakeTv(options, {
  ip,
  port,
  env = process.env,
  probe = probePort,
  learn = learnMac,
  cached = readCachedMac,
  arp = lookupArp,
  send = sendPacket,
  power = lookupPowerState,
  wait = sleep,
  now = Date.now,
  log = console.log,
} = {}) {
  if (!ip) ({ ip, port } = resolveConfiguredDevice());
  port = port || DEFAULT_SSH_PORT;
  const remember = async () => {
    if (!cached(ip)) await learn(ip, { port });
  };
  // An unreadable power state leaves an answering SSH port as the only signal.
  const active = async () => {
    const state = await power();
    return state === null || state === 'Active';
  };
  if (options.learn) {
    const status = await learn(ip, { port });
    if (status === 'asleep') throw new Error('the TV is off; turn it on and retry');
    if (status === 'no-ssh') throw new Error(SSH_CLOSED);
    if (status === 'unknown') {
      throw new Error('could not read the TV\'s MAC address from the ARP cache or over SSH; check `scripts/tv.sh run true`, or set TV_MAC');
    }
    log('remembered the TV\'s MAC address');
    return;
  }
  const envMac = env.TV_MAC ? normalizeMac(env.TV_MAC) : null;
  if (env.TV_MAC && !envMac) throw new Error('TV_MAC is not a valid MAC address');
  const initial = await tvPowerState(ip, port, probe);
  const mac = envMac || cached(ip) || arp(ip);
  // A TV in standby can still answer; an active one ignores the packet.
  if (mac) await send(magicPacket(mac), broadcastAddresses(ip));
  if (initial === 'ssh' && await active()) {
    await remember();
    log('TV is already awake');
    return;
  }
  if (!mac && initial !== 'on') {
    throw new Error('no MAC address known for the TV; turn it on once and run `scripts/tv.sh input wake --learn`, or set TV_MAC');
  }
  if (mac) log('sent the Wake-on-LAN packet');
  if (!options.wait && initial !== 'on') return;
  const seconds = initial === 'on' ? SSH_GRACE_SECONDS : options.timeout;
  const deadline = now() + seconds * 1000;
  let last = 'off';
  while (now() < deadline) {
    const current = await tvPowerState(ip, port, probe);
    if (current === 'ssh' && await active()) {
      await remember();
      log('TV is awake');
      return;
    }
    if (current !== 'off') last = current;
    await wait(initial === 'on' ? 1000 : 2000);
  }
  if (last === 'on') throw new Error(SSH_CLOSED);
  if (last === 'ssh') throw new Error(`the TV stayed in standby for ${String(seconds)} s`);
  throw new Error(`the TV did not answer within ${String(seconds)} s; check that Wake-on-LAN is enabled on the TV`);
}

// Collects console lines on the open DevTools connection; a cursor taken just
// before an action lets --wait-log match only what the action caused.
export function logWatch(client, wait = sleep, now = Date.now) {
  const lines = [];
  const stops = subscribeCdpLogs(client, (method, params) => {
    lines.push(normalizeCdpLogEvent(method, params).text);
  });
  return {
    lines,
    // Enabling replays earlier messages before it resolves; the caller marks after.
    start: () => enableCdpLogs(client, { history: true }),
    mark: () => lines.length,
    async waitFor(pattern, cursor, seconds) {
      const deadline = now() + seconds * 1000;
      for (;;) {
        const line = lines.slice(cursor).find((text) => pattern.test(text));
        if (line !== undefined) return line;
        if (now() >= deadline) {
          const seen = lines.length - cursor;
          const last = seen ? `; last: ${JSON.stringify(lines[lines.length - 1].slice(0, 200))}` : '';
          throw new Error(`--wait-log timed out after ${String(seconds)} s; no console line matched `
            + `${String(pattern)} (${String(seen)} seen${last})`);
        }
        await wait(50);
      }
    },
    stop: () => stops.forEach((stop) => stop()),
  };
}

const printValue = (value) => console.log(typeof value === 'object' ? JSON.stringify(value) : String(value));

export async function runStep(page, client, options, backends = {
  cdp: () => cdpBackend(page, client),
  evdev: () => evdevBackend(page),
}, logs = null) {
  if (options.when !== undefined) {
    let value;
    try {
      value = await page.evaluate(options.when);
    } catch (e) {
      throw new Error(`--if threw ${e.message}; nothing sent`);
    }
    if (!value) throw new Error(`--if was ${JSON.stringify(value)}; nothing sent`);
  }
  const backend = options.cdp || options.command === 'tap' ? backends.cdp() : backends.evdev();
  const cursor = options.waitLog ? logs.mark() : 0;
  switch (options.command) {
    case 'tap': {
      const hit = await tap(page, backend, options.target, options.waitTimeout, sleep, Date.now, options.settle);
      const settled = hit.settledMs ? ` once it held still (moved for ${String(hit.settledMs)} ms)` : '';
      const landed = hit.verified ? `; click landed on ${hit.landed}` : `; ${hit.problem}`;
      console.log(`tapped ${hit.name} "${hit.text}" at ${at(hit)}${settled}${landed}`);
      break;
    }
    case 'key':
      await backend.key(options.keys, options.gap);
      break;
    case 'move':
      await backend.move(options.to);
      break;
    case 'click':
      if (options.to) await backend.move(options.to);
      await backend.click();
      break;
    case 'wheel':
      await backend.wheel(options.notches, options.gap, options.at);
      break;
    default:
      break;
  }
  if (!['key', 'tap'].includes(options.command)) {
    await sleep(150);
    const pos = await backend.position();
    console.log(`pointer ${pos.x},${pos.y}`);
  }
  await finishWaits(page, options, logs, cursor);
}

async function finishWaits(page, options, logs, cursor) {
  if (options.waitLog) console.log(`log ${await logs.waitFor(options.waitLog, cursor, options.waitTimeout)}`);
  if (options.wait) printValue(await waitFor(page, options.wait, options.waitTimeout));
}

async function main() {
  let options;
  try {
    options = parseInputArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`tv-input: ${e.message}`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(INPUT_HELP);
    return;
  }
  if (options.command === 'wake') {
    await wakeTv(options);
    return;
  }
  if (options.command === 'key' && !options.cdp && !options.wait && !options.waitLog
      && options.when === undefined) {
    await evdevBackend(null).key(options.keys, options.gap);
    return;
  }
  const connection = await connectCdpWithAresFallback({
    appId: options.app,
    device: process.env.TV_DEVICE,
    host: resolveConfiguredDeviceIp(),
    port: DEFAULT_PORT,
    target: options.app,
    targetSelection: 'legacy-tv-app',
  });
  const { client } = connection;
  const page = {
    async evaluate(expression) {
      const { result, exceptionDetails } = await client.call('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    },
  };
  const steps = options.command === 'do' ? options.steps : [];
  const logs = [options, ...steps].some((step) => step.waitLog) ? logWatch(client) : null;
  try {
    await page.evaluate(TRACKER);
    if (logs) await logs.start();
    if (options.command !== 'do') {
      await runStep(page, client, options, undefined, logs);
      return;
    }
    const cursor = logs ? logs.mark() : 0;
    for (const [i, step] of steps.entries()) {
      try {
        await runStep(page, client, step, undefined, logs);
      } catch (e) {
        throw new Error(`step ${String(i + 1)} (${step.command}): ${e.message}`);
      }
    }
    await finishWaits(page, options, logs, cursor);
  } finally {
    logs?.stop();
    connection.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(0), (e) => {
    console.error(`tv-input: ${e?.message || e}`);
    process.exit(1);
  });
}
