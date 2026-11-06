/**
 * Manifest fetch feature — webOS service integration. Registers
 * fetchManifest, which only the app itself may call; the fetch lives in
 * manifest-fetch.ts.
 */

import { fetchManifest, manifestFetchFailure, type ManifestFetchRequest } from './manifest-fetch';
import { createLogger } from '../logger';

const log = createLogger('fetch');

// Minimal shape of the webos-service Service object this module uses.
interface LunaService {
  register(method: string, handler: (msg: LunaMsg) => void): void;
}

export type LunaMsg = {
  respond: (r: unknown) => unknown;
  payload?: ManifestFetchRequest;
  // webos-service's Message: the caller's LS2 application id with WAM's
  // " <pid>" suffix split off, or its service name when it has no app id.
  sender?: unknown;
  ls2Message?: {
    applicationID?: () => string;
    senderServiceName?: () => string;
  };
};

type SenderSource = 'applicationID' | 'senderServiceName' | 'sender' | 'none';

// A lookup that throws counts as empty, so the next one still runs.
function ls2Field(ls2: LunaMsg['ls2Message'], key: 'applicationID' | 'senderServiceName'): string {
  if (!ls2 || typeof ls2[key] !== 'function') return '';
  try {
    return ls2[key]!() || '';
  } catch {
    return '';
  }
}

// The LS2 fields first, since only they tell an app id from a service name.
function rawSender(msg: LunaMsg): { value: string; source: SenderSource } {
  const ls2 = msg.ls2Message;
  const appId = ls2Field(ls2, 'applicationID');
  if (appId) return { value: appId, source: 'applicationID' };
  const name = ls2Field(ls2, 'senderServiceName');
  if (name) return { value: name, source: 'senderServiceName' };
  if (typeof msg.sender === 'string' && msg.sender) return { value: msg.sender, source: 'sender' };
  return { value: '', source: 'none' };
}

/**
 * Whether a Luna message comes from the app: its application id, alone or
 * with WAM's " <pid>" suffix, or a service name "<appId>-<pid>". Another
 * app's id may itself end in "-<digits>", so only a service name may.
 */
export function isAppCaller(msg: LunaMsg, appId: string): boolean {
  if (!appId) return false;
  const sender = rawSender(msg);
  if (sender.value === appId) return true;
  const suffix = (separator: string): boolean =>
    sender.value.indexOf(appId + separator) === 0 && /^\d+$/.test(sender.value.slice(appId.length + 1));
  return sender.source === 'senderServiceName' ? suffix('-') : suffix(' ');
}

/**
 * The caller's id for a denial log, digits masked (a pid varies per launch)
 * and its source named, so a sender form the check misses shows up.
 */
export function senderShape(msg: LunaMsg): string {
  const sender = rawSender(msg);
  return JSON.stringify(sender.value.replace(/\d/g, 'N').slice(0, 96)) + ' source=' + sender.source;
}

export function registerManifestFetchService(service: LunaService, appId: string): void {
  service.register('fetchManifest', (msg) => {
    const respond = (result: unknown): void => {
      try {
        msg.respond(result);
      } catch (e) {
        log.error('fetchManifest respond failed:', e);
      }
    };
    if (!isAppCaller(msg, appId)) {
      log.warn('fetchManifest outcome=denied sender=' + senderShape(msg));
      respond(manifestFetchFailure('denied', 'Caller is not allowed'));
      return;
    }
    fetchManifest(msg.payload || {}, (result) => {
      // No URL, header, or body in the log.
      if (result.returnValue) log.info('fetchManifest outcome=ok status=' + String(result.status));
      else log.info('fetchManifest outcome=failed reason=' + result.errorCode);
      respond(result);
    });
  });
}
