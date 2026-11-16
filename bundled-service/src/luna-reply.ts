/**
 * Luna replies for the methods only the app may call: the caller check, a
 * one-shot responder, and the failure shape.
 */

import type { ServiceLogger } from './logger';

// webos-service's Message: the caller's LS2 application id with WAM's
// " <pid>" suffix split off, or its service name when it has no app id.
export type CallerMsg = {
  sender?: unknown;
  ls2Message?: {
    applicationID?: () => string;
    senderServiceName?: () => string;
  };
  respond?: unknown;
  payload?: unknown;
};

export type AppMsg<P> = CallerMsg & {
  respond: (r: unknown) => unknown;
  payload?: P;
};

// Minimal shape of the webos-service Service object.
export interface LunaRegistry<M> {
  register(method: string, handler: (msg: M) => void): void;
}

export type Respond = (result: unknown) => void;

export interface LunaFailure {
  returnValue: false;
  errorCode: string;
  errorText: string;
}

type SenderSource = 'applicationID' | 'senderServiceName' | 'sender' | 'none';

// A lookup that throws counts as empty, so the next one still runs.
function ls2Field(ls2: CallerMsg['ls2Message'], key: 'applicationID' | 'senderServiceName'): string {
  if (!ls2 || typeof ls2[key] !== 'function') return '';
  try {
    return ls2[key]!() || '';
  } catch {
    return '';
  }
}

// The LS2 fields first, since only they tell an app id from a service name.
function rawSender(msg: CallerMsg): { value: string; source: SenderSource } {
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
export function isAppCaller(msg: CallerMsg, appId: string): boolean {
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
export function senderShape(msg: CallerMsg): string {
  const sender = rawSender(msg);
  return JSON.stringify(sender.value.replace(/\d/g, 'N').slice(0, 96)) + ' source=' + sender.source;
}

export function lunaFailure(errorCode: string, errorText: string): LunaFailure;
export function lunaFailure<E extends object>(errorCode: string, errorText: string, extra: E): LunaFailure & E;
export function lunaFailure(errorCode: string, errorText: string, extra?: object): LunaFailure {
  const result: LunaFailure = { returnValue: false, errorCode: errorCode, errorText: errorText };
  if (extra) {
    for (const key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        (result as unknown as Record<string, unknown>)[key] = (extra as Record<string, unknown>)[key];
      }
    }
  }
  return result;
}

// Answers once; a throwing respond is logged, not rethrown.
export function onceResponder(msg: { respond: (r: unknown) => unknown }, method: string, log: ServiceLogger): Respond {
  let answered = false;
  return (result) => {
    if (answered) return;
    answered = true;
    try {
      msg.respond(result);
    } catch (e) {
      log.error(method + ' respond failed:', e);
    }
  };
}

// Registers a method only the app may call; anyone else is denied.
export function appMethod<P extends object>(
  service: LunaRegistry<AppMsg<P>>,
  appId: string,
  method: string,
  log: ServiceLogger,
  handler: (payload: P, respond: Respond, msg: AppMsg<P>) => void,
): void {
  service.register(method, (msg) => {
    const respond = onceResponder(msg, method, log);
    if (!isAppCaller(msg, appId)) {
      log.warn(method + ' outcome=denied sender=' + senderShape(msg));
      respond(lunaFailure('denied', 'Caller is not allowed'));
      return;
    }
    handler((msg.payload || {}) as P, respond, msg);
  });
}
