import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  KEYS,
  broadcastAddresses,
  cacheFile,
  evdevBackend,
  magicPacket,
  normalizeMac,
  parseArpMac,
  parseTvMac,
  learnMac,
  logWatch,
  settleTarget,
  wakeTv,
  POINTER_GAIN,
  parseInputArgs,
  parseTarget,
  runStep,
  splitWords,
  tap,
  targetScript,
  waitFor,
  readCachedMac,
  writeCachedMac,
  planAxis,
  planMove,
  remoteCommand,
  withGaps,
} from './tv-input.mjs';

const helper = createRequire(import.meta.url)('./tv-input-remote.js');

const pixelsFor = (steps) => steps.reduce((sum, step) => {
  const [, pixels] = POINTER_GAIN.find(([size]) => size === Math.abs(step));
  return sum + Math.sign(step) * pixels;
}, 0);

describe('TV input arguments', () => {
  it('shows help without arguments', () => {
    expect(parseInputArgs([])).toEqual({ help: true });
    expect(parseInputArgs(['key', 'ok', '--help'])).toEqual({ help: true });
  });

  it('parses keys with a gap', () => {
    expect(parseInputArgs(['key', 'red', 'down', '5', '--gap', '80'])).toMatchObject({
      command: 'key', keys: ['red', 'down', '5'], gap: 80, cdp: false,
    });
  });

  it('rejects an unknown key', () => {
    expect(() => parseInputArgs(['key', 'menu'])).toThrow(/unknown key menu/);
  });

  it('parses move, click, wheel, and the CDP backend', () => {
    expect(parseInputArgs(['move', '10', '20'])).toMatchObject({ command: 'move', to: { x: 10, y: 20 } });
    expect(parseInputArgs(['click'])).toMatchObject({ command: 'click', to: undefined });
    expect(parseInputArgs(['click', '5', '6', '--cdp'])).toMatchObject({
      command: 'click', to: { x: 5, y: 6 }, cdp: true,
    });
    expect(parseInputArgs(['wheel', '-3', '--at', '700', '450'])).toMatchObject({
      command: 'wheel', notches: -3, at: { x: 700, y: 450 },
    });
    expect(parseInputArgs(['pos', '--app', 'ch1', '--cdp'])).toMatchObject({
      command: 'pos', app: 'ch1', cdp: true, gap: 150,
    });
    expect(() => parseInputArgs(['--cdp', 'pos'])).toThrow(/Expected a command/);
  });

  it('rejects coordinates off the 1920x1080 canvas', () => {
    expect(() => parseInputArgs(['move', '1920', '0'])).toThrow(/x must be from 0 to 1919/);
    expect(() => parseInputArgs(['move', '0', '-1'])).toThrow(/y must be from 0 to 1079/);
    expect(() => parseInputArgs(['wheel', '0'])).toThrow(/notches must not be 0/);
    expect(() => parseInputArgs(['wheel', '1', '--at', '0', '1080'])).toThrow(/--at y must be from 0 to 1079/);
  });

  it('parses wake and keeps its options to wake', () => {
    expect(parseInputArgs(['wake'])).toMatchObject({
      command: 'wake', timeout: 90, wait: true, learn: false,
    });
    expect(parseInputArgs(['wake', '--timeout', '30', '--no-wait'])).toMatchObject({
      command: 'wake', timeout: 30, wait: false,
    });
    expect(parseInputArgs(['wake', '--learn'])).toMatchObject({ command: 'wake', learn: true });
    expect(() => parseInputArgs(['wake', '--timeout', '0'])).toThrow(/positive number/);
    expect(() => parseInputArgs(['wake', 'now'])).toThrow(/wake takes no arguments/);
    expect(() => parseInputArgs(['wake', '--cdp'])).toThrow(/--cdp cannot wake/);
    expect(() => parseInputArgs(['key', 'ok', '--no-wait'])).toThrow(/--no-wait is only valid for wake/);
    expect(() => parseInputArgs(['move', '1', '1', '--gap', '5'])).toThrow(/--gap is only valid for key or wheel/);
    expect(() => parseInputArgs(['key', 'up', '--at', '1', '1'])).toThrow(/--at is only valid for wheel/);
  });
});

describe('TV tap', () => {
  it('parses a selector, a data-key, or text, and adds --wait to actions', () => {
    expect(parseInputArgs(['tap', '#channels', '.item'])).toMatchObject({
      command: 'tap', target: { by: 'selector', value: '#channels .item' },
    });
    expect(parseInputArgs(['tap', 'key=ch1', '--wait', '1', '--wait-timeout', '2'])).toMatchObject({
      target: { by: 'key', value: 'ch1' }, wait: '1', waitTimeout: 2,
    });
    expect(parseTarget('text=Alpha News')).toEqual({ by: 'text', value: 'Alpha News' });
    expect(() => parseInputArgs(['tap'])).toThrow(/tap needs/);
    expect(() => parseTarget('key=')).toThrow(/key= needs a value/);
    expect(() => parseInputArgs(['pos', '--wait', '1'])).toThrow(/--wait is only valid/);
    expect(() => parseInputArgs(['pos', '--if', '1'])).toThrow(/--if is only valid/);
  });

  const page = (body) => {
    const dom = new JSDOM(`<body>${body}</body>`, { runScripts: 'outside-only' });
    const { window } = dom;
    window.Element.prototype.getBoundingClientRect = function rect() {
      const hidden = this.hasAttribute('data-hidden');
      const top = Number(this.getAttribute('data-top') ?? 200);
      return { left: 100, top, width: hidden ? 0 : 300, height: hidden ? 0 : 60 };
    };
    window.Element.prototype.scrollIntoView = function scroll() { this.setAttribute('data-scrolled', ''); };
    let cover = null;
    // Without a cover, the point hits the [data-key] row whose box holds it.
    window.document.elementFromPoint = (x, y) => cover || Array.prototype.find.call(
      window.document.querySelectorAll('[data-key]'),
      (e) => {
        const r = e.getBoundingClientRect();
        return r.height && y >= r.top && y < r.top + r.height;
      },
    ) || window.document.body;
    return {
      window,
      cover: (selector) => { cover = window.document.querySelector(selector); },
      evaluate: async (expression) => window.eval(expression),
    };
  };

  // A DevTools mouse: each event goes to whatever is at the point right then.
  const mouse = (p, calls = [], beforePress = () => {}) => {
    let point = null;
    const fire = (type) => {
      const el = p.window.document.elementFromPoint(point.x, point.y);
      el.dispatchEvent(new p.window.MouseEvent(type, {
        bubbles: true, clientX: point.x, clientY: point.y,
      }));
    };
    return {
      move: async (to) => {
        point = to;
        calls.push(['move', to]);
        fire('mousemove');
      },
      click: async () => {
        beforePress();
        calls.push(['click']);
        fire('mousedown');
        fire('mouseup');
        fire('click');
      },
    };
  };

  it('finds the visible element by selector, data-key, or exact text first', async () => {
    const p = page(`
      <div class="row" data-hidden data-key="ch1">hidden</div>
      <div class="row" data-focusable data-key="ch1">Alpha News</div>
      <div data-focusable data-key="ch2">Alpha</div>
      <div data-focusable data-key="edit" aria-label="Edit list"></div>`);
    expect(await p.evaluate(targetScript({ by: 'selector', value: '.row' }, 'measure')))
      .toMatchObject({ found: true, x: 250, y: 230, name: 'div[data-key=ch1]', text: 'Alpha News' });
    expect(await p.evaluate(targetScript({ by: 'key', value: 'ch2' }, 'measure'))).toMatchObject({ text: 'Alpha' });
    expect(await p.evaluate(targetScript({ by: 'text', value: 'alpha' }, 'measure'))).toMatchObject({ name: 'div[data-key=ch2]' });
    expect(await p.evaluate(targetScript({ by: 'text', value: 'news' }, 'measure'))).toMatchObject({ name: 'div[data-key=ch1]' });
    expect(await p.evaluate(targetScript({ by: 'text', value: 'edit list' }, 'measure'))).toMatchObject({ name: 'div[data-key=edit]' });
    expect(await p.evaluate(targetScript({ by: 'key', value: 'ch9' }, 'measure'))).toEqual({ found: false });
  });

  it('scrolls the target into view, then clicks its center', async () => {
    const p = page('<div data-focusable data-key="ch1"><span>Bravo</span></div>');
    p.cover('span');
    const calls = [];
    const hit = await tap(p, mouse(p, calls), { by: 'text', value: 'Bravo' }, 0, async () => {});
    expect(p.window.document.querySelector('[data-scrolled]')).not.toBeNull();
    expect(hit).toMatchObject({ x: 250, y: 230, covered: null, verified: true, landed: 'div[data-key=ch1] "Bravo"' });
    expect(calls).toEqual([['move', { x: 250, y: 230 }], ['click']]);
  });

  it('fails, naming the row hit, when the list moves between measuring and clicking', async () => {
    const p = page(`
      <div data-focusable data-key="ch1" data-top="140">Alpha</div>
      <div data-focusable data-key="ch2" data-top="200">Bravo</div>
      <div data-focusable data-key="ch3" data-top="260">Charlie</div>`);
    const scroll = () => {
      p.window.document.querySelectorAll('[data-key]').forEach((row) => {
        row.setAttribute('data-top', String(Number(row.getAttribute('data-top')) - 60));
      });
    };
    await expect(tap(p, mouse(p, [], scroll), { by: 'key', value: 'ch2' }, 0, async () => {}))
      .rejects.toThrow('tapped div[data-key=ch2] "Bravo" at 250,230, but the press at 250,230 hit '
        + 'div[data-key=ch3] "Charlie", not div[data-key=ch2]; div[data-key=ch2] had moved from 100,200 300x60 to 100,140 300x60; retry with --settle');
  });

  it('fails when the app re-renders the row between press and click', async () => {
    const p = page('<div data-focusable data-key="ch1">Alpha</div>');
    const row = p.window.document.querySelector('[data-key=ch1]');
    row.addEventListener('mousedown', () => {
      const fresh = row.cloneNode(true);
      row.replaceWith(fresh);
    });
    await expect(tap(p, mouse(p), { by: 'key', value: 'ch1' }, 0, async () => {}))
      .rejects.toThrow('but the click at 250,230 hit div[data-key=ch1] "Alpha", not div[data-key=ch1]; '
        + 'div[data-key=ch1] was no longer in the page');
  });

  it('settles: waits until the target box holds still before clicking', async () => {
    const p = page('<div data-focusable data-key="ch1" data-top="500">Alpha</div>');
    const row = p.window.document.querySelector('[data-key=ch1]');
    let clock = 0;
    const wait = async (ms) => {
      clock += ms;
      const top = Number(row.getAttribute('data-top'));
      if (top > 200) row.setAttribute('data-top', String(top - 100));
    };
    const calls = [];
    const hit = await tap(p, mouse(p, calls), { by: 'key', value: 'ch1' }, 5, wait, () => clock, 100);
    expect(hit).toMatchObject({ y: 230, settledMs: 100, verified: true });
    expect(calls[0]).toEqual(['move', { x: 250, y: 230 }]);
    const still = () => clock;
    let flip = 0;
    const moving = async (ms) => {
      clock += ms;
      flip += 1;
      row.setAttribute('data-top', String(flip % 2 ? 300 : 310));
    };
    await expect(settleTarget(p, { by: 'key', value: 'ch1' }, 100, 0.3, moving, still))
      .rejects.toThrow(/div\[data-key=ch1\] kept moving for 0.3 s; last at 100,3\d0 300x60/);
  });

  it('refuses a covered or missing target instead of clicking something else', async () => {
    const p = page('<div data-focusable data-key="ch1">Charlie</div><div id="overlay"></div>');
    p.cover('#overlay');
    const backend = { move: async () => { throw new Error('moved'); }, click: async () => {} };
    await expect(tap(p, backend, { by: 'key', value: 'ch1' }, 0, async () => {}))
      .rejects.toThrow('div[data-key=ch1] is covered by div#overlay at 250,230');
    await expect(tap(p, backend, { by: 'key', value: 'ch2' }, 0, async () => {}))
      .rejects.toThrow('no visible element matches key=ch2 within 0 s');
  });

  it('waits for a target that appears late, such as a menu that is opening', async () => {
    const p = page('');
    let clock = 0;
    const wait = async (ms) => {
      clock += ms;
      if (clock === 300) p.window.document.body.innerHTML = '<div data-focusable data-key="t2">Track 2</div>';
    };
    expect(await tap(p, mouse(p), { by: 'text', value: 'Track 2' }, 1, wait, () => clock))
      .toMatchObject({ name: 'div[data-key=t2]' });
  });

  it('splits do steps like a shell and runs each with its own options', () => {
    expect(splitWords(`key down --if "a('x') && b" 'c d'\\ e`)).toEqual(['key', 'down', '--if', "a('x') && b", 'c d e']);
    expect(() => splitWords('tap "x')).toThrow(/unclosed "/);
    expect(parseInputArgs(['do', 'tap text=Audio', 'key down ok --gap 0 --if "1"', '--cdp', '--wait', 'done'])).toMatchObject({
      command: 'do',
      wait: 'done',
      steps: [
        { command: 'tap', target: { by: 'text', value: 'Audio' }, cdp: true },
        { command: 'key', keys: ['down', 'ok'], gap: 0, when: '1', cdp: true },
      ],
    });
    expect(() => parseInputArgs(['do'])).toThrow(/do needs/);
    expect(() => parseInputArgs(['do', 'wake'])).toThrow(/do cannot run "wake"/);
    expect(() => parseInputArgs(['do', 'key menu'])).toThrow(/unknown key menu/);
  });

  it('points a step option written after the step back inside its quotes', () => {
    expect(() => parseInputArgs(['do', 'key right --cdp', '--if', 'menu', 'tap key=a']))
      .toThrow(`--if belongs to one step: put it inside that step's quotes, as in do 'key down --cdp --if "<js>"'`);
    expect(() => parseInputArgs(['do', 'tap key=a', '--settle'])).toThrow(/--settle belongs to one step/);
    expect(() => parseInputArgs(['do', 'tap key=a', '--settle=50'])).toThrow(/--settle belongs to one step/);
    expect(parseInputArgs(['do', 'tap key=a --settle=50', '--wait-log', 'x'])).toMatchObject({
      waitLog: /x/, steps: [{ settle: 50 }],
    });
  });

  it('parses --settle with an optional time and --wait-log as a regex', () => {
    expect(parseInputArgs(['tap', 'key=a', '--settle'])).toMatchObject({ settle: 100 });
    expect(parseInputArgs(['tap', 'key=a', '--settle=250'])).toMatchObject({ settle: 250 });
    expect(parseInputArgs(['tap', 'key=a'])).toMatchObject({ settle: undefined });
    expect(() => parseInputArgs(['tap', 'key=a', '--settle=0'])).toThrow(/--settle: must be a positive integer/);
    expect(() => parseInputArgs(['key', 'ok', '--settle'])).toThrow(/--settle is only valid for tap/);
    expect(parseInputArgs(['key', 'ok', '--wait-log', 'event=a\\.b'])).toMatchObject({ waitLog: /event=a\.b/ });
    expect(() => parseInputArgs(['key', 'ok', '--wait-log', '('])).toThrow(/Invalid value for --wait-log/);
  });

  it('--wait-log prints the first console line the action caused', async () => {
    const listeners = new Map();
    const client = {
      on: (method, fn) => {
        listeners.set(method, fn);
        return () => listeners.delete(method);
      },
      call: async () => ({}),
    };
    const emit = (text) => listeners.get('Runtime.consoleAPICalled')({ type: 'log', args: [{ value: text }] });
    let clock = 0;
    const logs = logWatch(client, async (ms) => {
      clock += ms;
      if (clock === 100) emit('[Player] event=playback.path path=luna');
    }, () => clock);
    emit('[Player] event=playback.path path=old');
    const printed = [];
    const log = console.log;
    console.log = (line) => printed.push(line);
    try {
      const step = parseInputArgs(['key', 'ok', '--cdp', '--wait-log', 'playback\\.path']);
      const backends = { cdp: () => ({ key: async () => emit('[App] key ok') }) };
      await runStep({ evaluate: async () => true }, client, step, backends, logs);
    } finally {
      console.log = log;
    }
    expect(printed).toEqual(['log [Player] event=playback.path path=luna']);
    await expect(logs.waitFor(/never/, logs.mark() - 1, 0.1))
      .rejects.toThrow('--wait-log timed out after 0.1 s; no console line matched /never/ (1 seen; last: "[Player] event=playback.path path=luna")');
    logs.stop();
    expect(listeners.size).toBe(0);
  });

  it('sends nothing when --if is falsy or throws', async () => {
    const sent = [];
    const backends = { cdp: () => ({ key: async (keys) => sent.push(...keys) }), evdev: () => { throw new Error('evdev'); } };
    const step = parseInputArgs(['key', 'down', '--cdp', '--if', 'menu']);
    await expect(runStep({ evaluate: async () => null }, null, step, backends))
      .rejects.toThrow('--if was null; nothing sent');
    await expect(runStep({ evaluate: async () => { throw new Error('nope'); } }, null, step, backends))
      .rejects.toThrow('--if threw nope; nothing sent');
    expect(sent).toEqual([]);
    await runStep({ evaluate: async () => true }, null, step, backends);
    expect(sent).toEqual(['down']);
  });

  it('polls --wait until truthy, or times out with the last value', async () => {
    let clock = 0;
    const values = [null, 0, 'ready'];
    const p = { evaluate: async () => values.shift() };
    expect(await waitFor(p, 'x', 5, () => clock, async (ms) => { clock += ms; })).toBe('ready');
    const failing = { evaluate: async () => { throw new Error('boom'); } };
    await expect(waitFor(failing, 'x', 0.2, () => clock, async (ms) => { clock += ms; }))
      .rejects.toThrow('--wait timed out after 0.2 s; it last threw boom');
  });
});

describe('TV input key map', () => {
  it('maps the remote keys the app handles to their DOM key codes', () => {
    expect(KEYS.get('back')).toEqual([412, 461]);
    expect(KEYS.get('ok')).toEqual([28, 13]);
    expect(['red', 'green', 'yellow', 'blue'].map((name) => KEYS.get(name)[1])).toEqual([403, 404, 405, 406]);
    expect(KEYS.get('0')).toEqual([11, 48]);
    expect(KEYS.get('9')).toEqual([10, 57]);
  });

  it('sends power only through the TV input devices', () => {
    expect(KEYS.get('power')).toEqual([116, null]);
    expect(parseInputArgs(['key', 'power'])).toMatchObject({ command: 'key', keys: ['power'] });
    expect(() => parseInputArgs(['key', 'power', '--cdp'])).toThrow(/--cdp cannot send power/);
  });

  it('sends home only through the TV input devices', () => {
    expect(parseInputArgs(['key', 'home'])).toMatchObject({ command: 'key', keys: ['home'] });
    expect(() => parseInputArgs(['key', 'home', '--cdp'])).toThrow(/--cdp cannot send home/);
  });
});

describe('TV pointer planning', () => {
  it('plans steps that cover the distance exactly', () => {
    for (const distance of [0, 1, 7, 58, 123, 640, -1, -37, -960]) {
      const steps = planAxis(distance);
      expect(Math.abs(pixelsFor(steps) - distance)).toBe(0);
    }
  });

  it('moves each axis separately', () => {
    expect(planMove({ x: 0, y: 100 }, { x: 59, y: 98 })).toEqual(['m:16,0', 'm:1,0', 'm:0,-2']);
  });
});

describe('TV remote command', () => {
  it('spaces repeated steps with sleeps', () => {
    expect(withGaps(['k:1', 'k:2', 'k:3'], 50)).toEqual(['k:1', 's:50', 'k:2', 's:50', 'k:3']);
    expect(withGaps(['k:1', 'k:2'], 0)).toEqual(['k:1', 'k:2']);
  });

  it('sends the helper source inline to the TV Node.js', () => {
    const command = remoteCommand(['k:108', 'w:1@700,450'], "var a = 'b';");
    expect(command).toBe(`node -e 'var a = '\\''b'\\'';' k:108 w:1@700,450`);
  });
});

describe('TV input helper', () => {
  const devices = [
    'I: Bus=0000\nN: Name="LGE RCU"\nH: Handlers=kbd event0 ',
    'N: Name="LGE M-RCU - Builtin [1]"\nH: Handlers=kbd js1 event4 ',
    'N: Name="LGE M-RCU - Builtin [0]"\nH: Handlers=kbd js0 event3 ',
    'N: Name="ClickableMouse"\nH: Handlers=js6 event9 ',
  ].join('\n\n');

  it('reports a device missing after a pause as a clean error and closes what it opened', async () => {
    const closed = [];
    const io = {
      readFileSync: () => devices.split('\n\n')[0],
      openSync: () => 7,
      writeSync: () => {},
      closeSync: (fd) => closed.push(fd),
    };
    const error = await new Promise((resolve) => helper.run(['k:108', 's:1', 'c:'], io, resolve));
    expect(error.message).toMatch(/no input device named ClickableMouse/);
    expect(closed).toEqual([7]);
  });

  it('finds devices by name prefix', () => {
    const names = helper.parseDevices(devices);
    expect(helper.findDevice(names, 'LGE RCU')).toBe('/dev/input/event0');
    expect(helper.findDevice(names, 'LGE M-RCU')).toBe('/dev/input/event3');
    expect(helper.findDevice(names, 'ClickableMouse')).toBe('/dev/input/event9');
    expect(() => helper.findDevice(names, 'Missing')).toThrow(/no input device named Missing/);
  });

  it('encodes a 32-bit and a 64-bit input_event', () => {
    const short = helper.encodeEvent(1, 108, 1, 1700000000123, 4);
    expect(short.toString('hex')).toBe('00f1536578e001000100' + '6c0001000000');
    expect(helper.encodeEvent(2, 8, -1, 0, 8)).toHaveLength(24);
    expect(helper.encodeEvent(2, 8, -1, 0, 8).readInt32LE(20)).toBe(-1);
  });

  it('frames keys, clicks, moves, and positioned wheel notches', () => {
    expect(helper.planEvents(['k:108', 'c:', 'm:3,-2', 'w:1@700,450', 's:5'])).toEqual([
      ['k', 1, 108, 1], ['k', 0, 0, 0], 50, ['k', 1, 108, 0], ['k', 0, 0, 0],
      ['c', 1, 272, 1], ['c', 0, 0, 0], 50, ['c', 1, 272, 0], ['c', 0, 0, 0],
      ['m', 2, 0, 3], ['m', 2, 1, -2], ['m', 0, 0, 0], 60,
      ['w', 3, 0, 699], ['w', 3, 1, 449], ['w', 0, 0, 0],
      ['w', 3, 0, 700], ['w', 3, 1, 450], ['w', 0, 0, 0],
      ['w', 2, 8, -1], ['w', 0, 0, 0],
      5,
    ]);
    expect(() => helper.planEvents(['x:1'])).toThrow(/bad step x:1/);
  });
});

describe('evdevBackend', () => {
  it('stops instead of steering a pointer whose position stays unknown', async () => {
    const page = { evaluate: async () => ({ x: null, y: null, visible: null }) };
    const runs = [];
    const backend = evdevBackend(page, (steps) => runs.push(steps));
    await expect(backend.move({ x: 100, y: 100 })).rejects.toThrow(/pointer position unknown/);
    expect(runs).toEqual([['m:1,0', 'm:-1,0']]);
  });
});

describe('TV wake', () => {
  const mac = '02:00:00:00:00:01';

  it('normalizes MAC addresses and rejects placeholders', () => {
    expect(normalizeMac('2-0-0-0-0-1')).toBe(mac);
    expect(normalizeMac('02:00:00:00:00:0G')).toBeNull();
    expect(normalizeMac('00:00:00:00:00:00')).toBeNull();
    expect(normalizeMac('ff:ff:ff:ff:ff:ff')).toBeNull();
  });

  it('reads the MAC for one IP from arp and ip neigh output', () => {
    const arp = '? (10.0.0.9) at 2:0:0:0:0:9 on en0 ifscope [ethernet]\n'
      + '? (10.0.0.2) at 2:0:0:0:0:1 on en0 ifscope [ethernet]\n';
    expect(parseArpMac(arp, '10.0.0.2')).toBe(mac);
    expect(parseArpMac('10.0.0.2 dev eth0 lladdr 02:00:00:00:00:01 REACHABLE', '10.0.0.2')).toBe(mac);
    expect(parseArpMac('? (10.0.0.2) at (incomplete) on en0 ifscope [ethernet]', '10.0.0.2')).toBeNull();
    expect(parseArpMac(arp, '10.0.0.20')).toBeNull();
  });

  it('builds a 102-byte magic packet', () => {
    const packet = magicPacket(mac);
    expect(packet).toHaveLength(102);
    expect([...packet.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    expect([...packet.subarray(96)]).toEqual([2, 0, 0, 0, 0, 1]);
    expect(() => magicPacket('nope')).toThrow(/invalid MAC/);
  });

  it('broadcasts on the subnet that holds the TV, then the limited broadcast', () => {
    const interfaces = {
      lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
      en0: [{ family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', internal: false }],
      en1: [{ family: 'IPv4', address: '10.1.0.5', netmask: '255.255.0.0', internal: false }],
    };
    expect(broadcastAddresses('10.0.0.2', interfaces)).toEqual(['10.0.0.255', '255.255.255.255']);
  });

  it('remembers MACs per IP in a private cache file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-wake-'));
    try {
      const file = cacheFile({ XDG_CACHE_HOME: dir });
      expect(file).toBe(join(dir, 'webos-iptv-player', 'wake.json'));
      expect(readCachedMac('10.0.0.2', file)).toBeNull();
      writeCachedMac('10.0.0.2', mac, file);
      writeCachedMac('10.0.0.3', '02:00:00:00:00:02', file);
      expect(readCachedMac('10.0.0.2', file)).toBe(mac);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        '10.0.0.2': mac, '10.0.0.3': '02:00:00:00:00:02',
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const tvOutput = (addr, route) => [
    '@addr', ...addr, '@route',
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    ...route,
    '@mac', 'eth0 02:00:00:00:00:02', 'lo 00:00:00:00:00:00', 'wlan0 02:00:00:00:00:01', 'sit0 00:00:00:00',
  ].join('\r\n');
  const routes = [
    'wlan0\t00000000\t0100000A\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'wlan0\t0000000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
    'eth0\t0001000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
  ];

  it('finds the TV MAC from its route table when ip and ifconfig are missing', () => {
    expect(parseTvMac(tvOutput([], routes), '10.0.0.2')).toBe(mac);
    expect(parseTvMac(tvOutput([], routes), '10.0.1.2')).toBe('02:00:00:00:00:02');
    expect(parseTvMac(tvOutput([], routes), '10.0.2.2')).toBeNull();
    expect(parseTvMac(tvOutput([], []), '10.0.0.2')).toBeNull();
    expect(parseTvMac('sh: ip: not found', '10.0.0.2')).toBeNull();
  });

  it('prefers the interface that holds the IP in ip or ifconfig output', () => {
    const ip = ['3: wlan0    inet 10.0.0.2/24 brd 10.0.0.255 scope global wlan0\\       valid_lft forever'];
    expect(parseTvMac(tvOutput(ip, []), '10.0.0.2')).toBe(mac);
    expect(parseTvMac(tvOutput(ip, []), '10.0.0.20')).toBeNull();
    const ifconfig = [
      'eth0      Link encap:Ethernet  HWaddr 02:00:00:00:00:03',
      '          inet addr:10.0.0.2  Bcast:10.0.0.255  Mask:255.255.255.0',
      '',
      'wlan0     Link encap:Ethernet  HWaddr 02:00:00:00:00:01',
    ];
    expect(parseTvMac(tvOutput(ifconfig, routes), '10.0.0.2')).toBe('02:00:00:00:00:02');
    expect(parseTvMac(['@addr', ...ifconfig].join('\n'), '10.0.0.2')).toBe('02:00:00:00:00:03');
  });

  it('asks the TV for its MAC when this computer cannot read the ARP cache', async () => {
    const written = [];
    const tvCalls = [];
    const deps = {
      probe: async () => true,
      arp: () => null,
      tv: (ip) => {
        tvCalls.push(ip);
        return parseTvMac(tvOutput([], routes), ip);
      },
      write: (ip, value) => written.push([ip, value]),
    };
    expect(await learnMac('10.0.0.2', deps)).toBe('learned');
    expect(written).toEqual([['10.0.0.2', mac]]);
    expect(await learnMac('10.0.0.2', { ...deps, arp: () => '02:00:00:00:00:09' })).toBe('learned');
    expect(tvCalls).toEqual(['10.0.0.2']);
    expect(await learnMac('10.0.0.2', { ...deps, tv: () => null })).toBe('unknown');
    expect(await learnMac('10.0.0.2', { ...deps, probe: async () => false })).toBe('asleep');
    expect(tvCalls).toEqual(['10.0.0.2']);
  });

  // ports: which of 9922/3000/3001 answer, optionally only after the packet.
  const wakeDeps = ({ before = [], after = before, cachedMac = null } = {}) => {
    const calls = { sent: 0, learned: 0, log: [] };
    let clock = 0;
    return {
      calls,
      deps: {
        ip: '10.0.0.2',
        env: {},
        probe: async (_ip, port) => (calls.sent ? after : before).includes(port),
        learn: async () => {
          calls.learned += 1;
          return 'learned';
        },
        cached: () => cachedMac,
        arp: () => null,
        send: async () => {
          calls.sent += 1;
        },
        power: async () => 'Active',
        wait: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        log: (line) => calls.log.push(line),
      },
    };
  };
  const wakeOptions = { timeout: 10, wait: true, learn: false };

  it('fails soon after a packet when the TV is on but SSH is closed', async () => {
    const { calls, deps } = wakeDeps({ before: [3001], cachedMac: mac });
    await expect(wakeTv(wakeOptions, deps)).rejects.toThrow(/TV is on but its SSH port is closed/);
    expect(calls.sent).toBe(1);
    const learnDeps = { ...deps, learn: (ip) => learnMac(ip, { probe: deps.probe, arp: () => null, tv: () => mac }) };
    await expect(wakeTv({ ...wakeOptions, learn: true }, learnDeps))
      .rejects.toThrow(/TV is on but its SSH port is closed/);
  });

  it('blames SSH, not Wake-on-LAN, when the TV wakes without SSH', async () => {
    const { calls, deps } = wakeDeps({ before: [], after: [3000], cachedMac: mac });
    await expect(wakeTv(wakeOptions, deps)).rejects.toThrow(/TV is on but its SSH port is closed/);
    expect(calls.sent).toBe(1);
  });

  it('asks to enable Wake-on-LAN when the TV never answers', async () => {
    const { deps } = wakeDeps({ cachedMac: mac });
    await expect(wakeTv(wakeOptions, deps))
      .rejects.toThrow('the TV did not answer within 10 s; check that Wake-on-LAN is enabled on the TV');
  });

  it('reuses a cached MAC for an awake TV and refreshes only on --learn', async () => {
    const awake = wakeDeps({ before: [22, 9922], cachedMac: mac });
    await wakeTv(wakeOptions, awake.deps);
    expect(awake.calls).toMatchObject({ sent: 1, learned: 0, log: ['TV is already awake'] });
    await wakeTv({ ...wakeOptions, learn: true }, awake.deps);
    expect(awake.calls.learned).toBe(1);
    const woken = wakeDeps({ after: [9922], cachedMac: mac });
    await wakeTv(wakeOptions, woken.deps);
    expect(woken.calls).toMatchObject({ sent: 1, learned: 0 });
    const unknown = wakeDeps({ before: [9922] });
    await wakeTv(wakeOptions, unknown.deps);
    expect(unknown.calls.learned).toBe(1);
  });
});
