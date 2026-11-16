/**
 * Aspect ratio feature — webOS service integration. Registers
 * setAspectRatio, which only the app itself may call. The TV keeps a picture
 * aspect ratio per app (settingsservice category aspectRatio, key arcPerApp);
 * the web app's own identity is denied that service, so it asks here.
 */

import { appMethod, lunaFailure, type AppMsg, type LunaRegistry, type Respond } from '../luna-reply';
import { createLogger } from '../logger';

const log = createLogger('aspect');

const SETTINGS_URI = 'luna://com.webos.settingsservice/setSystemSettings';
// The arcPerApp values the TV lists as visible that the app offers.
const VALUES = ['original', '16x9', '4x3', 'allDirZoom'];
const TIMEOUT_MS = 5000;
// The bus itself failed, not settingsservice; a fresh handle may work.
const BUS_ERROR = 'bus_error';

export interface LunaReply {
  returnValue?: boolean;
  errorCode?: unknown;
  errorText?: unknown;
}

// Sends one Luna request and answers once with its parsed payload; the
// returned function cancels it.
export type LunaCall = (
  uri: string,
  payload: Record<string, unknown>,
  done: (reply: LunaReply) => void,
) => () => void;

export type AspectLunaMsg = AppMsg<{ value?: unknown }>;

interface PalmbusRequest {
  addListener(event: 'response', listener: (message: { payload(): string }) => void): void;
  cancel(): void;
}

interface PalmbusHandle {
  call(uri: string, payload: string): PalmbusRequest;
}

type PalmbusModule = { Handle: new (name: string, publicBus?: boolean) => PalmbusHandle };

// settingsservice denies the service's own identity but answers an anonymous
// palmbus handle.
export function anonymousLunaCall(palmbus?: PalmbusModule): LunaCall | null {
  let bus = palmbus;
  if (!bus) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      bus = require('palmbus') as PalmbusModule;
    } catch {
      return null;
    }
  }
  const Handle = bus.Handle;
  let handle: PalmbusHandle | null = null;
  return (uri, payload, done) => {
    let request: PalmbusRequest | null = null;
    let used: PalmbusHandle | null = null;
    const cancel = (): void => {
      if (!request) return;
      try {
        request.cancel();
      } catch {
        // Already complete.
      }
      request = null;
    };
    // A handle that threw, garbled a reply, or never answered may be dead;
    // the next write builds a new one.
    const drop = (): void => {
      cancel();
      if (handle === used) handle = null;
    };
    try {
      if (!handle) {
        try {
          handle = new Handle('');
        } catch {
          handle = new Handle('', true);
        }
      }
      used = handle;
      request = handle.call(uri, JSON.stringify(payload));
      request.addListener('response', (message) => {
        let reply: LunaReply;
        try {
          reply = JSON.parse(message.payload()) as LunaReply;
        } catch {
          drop();
          done({ returnValue: false, errorCode: BUS_ERROR, errorText: 'Invalid Luna response' });
          return;
        }
        cancel();
        done(reply);
      });
    } catch (e) {
      drop();
      done({ returnValue: false, errorCode: BUS_ERROR, errorText: e instanceof Error ? e.message : String(e) });
    }
    // A caller cancels a request still open only when it gave up waiting.
    return () => {
      if (request) drop();
    };
  };
}

interface Job {
  value: string;
  respond: Respond;
}

export function registerAspectService(service: LunaRegistry<AspectLunaMsg>, appId: string, call: LunaCall | null): void {
  // One write at a time, and only the newest waits: a slow or timed-out
  // write must not land after a newer one.
  let busy = false;
  let waiting: Job | null = null;

  const finish = (): void => {
    busy = false;
    const next = waiting;
    waiting = null;
    if (next) run(next);
  };

  const run = (job: Job): void => {
    busy = true;
    let settled = false;
    let cancel: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (cancel) cancel();
      log.warn('setAspectRatio outcome=failed reason=timeout');
      job.respond(lunaFailure('timeout', 'settingsservice did not answer'));
      finish();
    }, TIMEOUT_MS);
    cancel = call!(SETTINGS_URI,
      { category: 'aspectRatio', app_id: appId, settings: { arcPerApp: job.value } }, (reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (reply && reply.returnValue === true) {
          job.respond({ returnValue: true, value: job.value });
        } else {
          const text = reply && typeof reply.errorText === 'string' ? reply.errorText : '';
          const reason = reply && reply.errorCode === BUS_ERROR ? BUS_ERROR
            : /denied/i.test(text) ? 'settings_denied' : 'settings_failed';
          log.warn('setAspectRatio outcome=failed reason=' + reason);
          job.respond(lunaFailure(reason, text || 'setSystemSettings failed'));
        }
        finish();
      });
  };

  appMethod(service, appId, 'setAspectRatio', log, (payload, respond) => {
    const value = payload.value;
    if (typeof value !== 'string' || VALUES.indexOf(value) === -1) {
      respond(lunaFailure('bad_value', 'Unsupported aspect ratio'));
      return;
    }
    if (!call) {
      log.warn('setAspectRatio outcome=failed reason=no_bus');
      respond(lunaFailure('no_bus', 'Luna bus unavailable'));
      return;
    }
    const job: Job = { value: value, respond: respond };
    if (!busy) {
      run(job);
      return;
    }
    if (waiting) waiting.respond(lunaFailure('superseded', 'A newer value was requested'));
    waiting = job;
  });
}
