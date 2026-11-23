/**
 * Aspect ratio feature — webOS service integration. Registers
 * setAspectRatio, which only the app itself may call. The TV keeps a picture
 * aspect ratio per app (settingsservice category aspectRatio, key arcPerApp);
 * the web app's own identity is denied that service, so it asks here. Where
 * settingsservice refuses the key to every identity, the service crops and
 * places the app's own media through videooutput instead.
 */

import { appMethod, lunaFailure, type AppMsg, type LunaRegistry, type Respond } from '../luna-reply';
import { createLogger } from '../logger';
import { findAppVideo, videoDisplay, videoWindow, type VideoDisplay } from './videooutput';

const log = createLogger('aspect');

const SETTINGS_URI = 'luna://com.webos.settingsservice/setSystemSettings';
const VIDEO_URI = 'luna://com.webos.service.videooutput/';
// The arcPerApp values the TV lists as visible that the app offers.
const VALUES = ['original', '16x9', '4x3', 'allDirZoom'];
const TIMEOUT_MS = 5000;
// The bus itself failed, not settingsservice; a fresh handle may work.
const BUS_ERROR = 'bus_error';

export interface LunaReply {
  returnValue?: boolean;
  errorCode?: unknown;
  errorText?: unknown;
  video?: unknown;
}

// Sends one Luna request and answers once with its parsed payload; the
// returned function cancels it.
export type LunaCall = (
  uri: string,
  payload: Record<string, unknown>,
  done: (reply: LunaReply) => void,
) => () => void;

export type AspectLunaMsg = AppMsg<{ value?: unknown; mediaId?: unknown; display?: unknown }>;

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
        let reply: unknown;
        try {
          reply = JSON.parse(message.payload());
        } catch {
          reply = null;
        }
        if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
          drop();
          done({ returnValue: false, errorCode: BUS_ERROR, errorText: 'Invalid Luna response' });
          return;
        }
        cancel();
        done(reply as LunaReply);
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
  mediaId: string;
  display: VideoDisplay;
  respond: Respond;
}

// settingsservice refusing the key, as opposed to failing to answer.
const SETTINGS_REFUSED = /denied|not permitted|not allowed|unknown method|not supported|unsupported/i;

function replyText(reply: LunaReply, fallback: string): string {
  return typeof reply.errorText === 'string' && reply.errorText ? reply.errorText : fallback;
}

export function registerAspectService(service: LunaRegistry<AspectLunaMsg>, appId: string, call: LunaCall | null): void {
  // One write at a time, and only the newest waits: a slow or timed-out
  // write must not land after a newer one.
  let busy = false;
  let waiting: Job | null = null;
  // Set once settingsservice refuses the key; kept for the service's life.
  let useVideoOutput = false;

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
    // Each step's answer counts only while that step is the current one.
    let step = 0;
    const complete = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.respond(result);
      finish();
    };
    const fail = (reason: string, text: string, video: boolean): void => {
      log.warn('setAspectRatio outcome=failed reason=' + reason);
      complete(video ? lunaFailure(reason, text, { backend: 'videooutput' }) : lunaFailure(reason, text));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      if (cancel) cancel();
      fail('timeout', 'Aspect ratio request did not answer', useVideoOutput);
    }, TIMEOUT_MS);
    const request = (uri: string, parameters: Record<string, unknown>, done: (reply: LunaReply) => void): void => {
      const current = ++step;
      cancel = null;
      const handle = call!(uri, parameters, reply => {
        if (settled || current !== step) return;
        cancel = null;
        done(reply);
      });
      if (!settled && current === step) cancel = handle;
    };
    const videoFailure = (reply: LunaReply, text: string): void => {
      fail(reply.errorCode === BUS_ERROR ? BUS_ERROR : 'video_failed', replyText(reply, text), true);
    };
    // Expected until the app's media is connected; the app retries then.
    const pending = (): void => complete(lunaFailure('video_pending', 'The video is not ready', {
      backend: 'videooutput',
    }));
    const applyVideo = (): void => {
      if (!job.mediaId) {
        pending();
        return;
      }
      request(VIDEO_URI + 'getStatus', {}, reply => {
        if (reply.returnValue !== true) {
          videoFailure(reply, 'Video status request failed');
          return;
        }
        const video = findAppVideo(reply.video, appId, job.mediaId);
        if (!video) {
          pending();
          return;
        }
        request(VIDEO_URI + 'display/setDisplayWindow', videoWindow(video, job.value, job.display), result => {
          if (result.returnValue === true) complete({ returnValue: true, value: job.value, backend: 'videooutput' });
          else videoFailure(result, 'Video window request failed');
        });
      });
    };
    if (useVideoOutput) {
      applyVideo();
      return;
    }
    request(SETTINGS_URI,
      { category: 'aspectRatio', app_id: appId, settings: { arcPerApp: job.value } }, reply => {
        if (reply.returnValue === true) {
          complete({ returnValue: true, value: job.value });
          return;
        }
        const text = replyText(reply, '');
        if (reply.errorCode === BUS_ERROR || !SETTINGS_REFUSED.test(text)) {
          fail(reply.errorCode === BUS_ERROR ? BUS_ERROR : 'settings_failed', text || 'setSystemSettings failed', false);
          return;
        }
        useVideoOutput = true;
        log.warn('Aspect ratio fallback', 'event=player.aspect.fallback', 'backend=videooutput',
          'reason=' + (/denied|not permitted|not allowed/i.test(text) ? 'settings_denied' : 'settings_unsupported'));
        applyVideo();
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
    const mediaId = payload.mediaId;
    const display = videoDisplay(payload.display);
    if ((mediaId !== undefined && (typeof mediaId !== 'string' || !mediaId || mediaId.length > 128)) || !display) {
      respond(lunaFailure('bad_display', 'Invalid video or display'));
      return;
    }
    const job: Job = { value: value, mediaId: typeof mediaId === 'string' ? mediaId : '', display: display, respond: respond };
    if (!busy) {
      run(job);
      return;
    }
    if (waiting) waiting.respond(lunaFailure('superseded', 'A newer value was requested'));
    waiting = job;
  });
}
