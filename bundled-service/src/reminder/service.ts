/**
 * Reminder feature — webOS service integration. Registers the dev-mode probe
 * (getDevMode) and the air-time alert (fireReminderAlert) the Activity Manager
 * callback invokes. The dev-mode check and alert payload/exec live in alert.ts.
 */

import { isDevMode, buildAlertPayload, fireAlert, type AlertCopy } from './alert';

// Minimal shape of the webos-service Service object this module uses.
interface LunaService {
  register(method: string, handler: (msg: LunaMsg) => void): void;
}

export type ReminderAlertPayload = {
  copyVersion?: unknown;
  title?: string;
  channelName?: string;
  channelKey?: string;
  appId?: string;
  alertTitle?: unknown;
  alertMessage?: unknown;
  watchLabel?: unknown;
  cancelLabel?: unknown;
};

type LunaMsg = {
  respond: (r: unknown) => void;
  payload?: ReminderAlertPayload;
};

export function localizedAlertCopy(payload: ReminderAlertPayload): AlertCopy | null | undefined {
  if (payload.copyVersion === undefined) return undefined;
  if (payload.copyVersion !== 1
      || typeof payload.alertTitle !== 'string' || !payload.alertTitle
      || typeof payload.alertMessage !== 'string' || !payload.alertMessage
      || typeof payload.watchLabel !== 'string' || !payload.watchLabel
      || typeof payload.cancelLabel !== 'string' || !payload.cancelLabel) {
    return null;
  }
  return {
    title: payload.alertTitle,
    message: payload.alertMessage,
    watchLabel: payload.watchLabel,
    cancelLabel: payload.cancelLabel,
  };
}

// Wire the reminder feature onto the Luna service.
export function registerReminderService(service: LunaService): void {
  service.register('getDevMode', (msg) => {
    msg.respond({ devmode: isDevMode() });
  });

  // Invoked by the Activity Manager callback at programme air time (dev mode
  // only). The scheduler passes appId (the app's own id) so the "Watch now"
  // button can relaunch it; the service stays app-id-agnostic.
  service.register('fireReminderAlert', (msg) => {
    const payload = msg.payload || {};
    const { title = '', channelName = '', channelKey = '', appId = '' } = payload;
    console.log('[reminder] fireReminderAlert for "' + title + '"');
    const copy = localizedAlertCopy(payload);
    if (copy === null) {
      console.error('[reminder] localized alert copy missing');
      msg.respond({ fired: false, result: 'Complete localized alert copy is required' });
      return;
    }
    fireAlert(buildAlertPayload(title, channelName, channelKey, appId, copy), (ok, detail) => {
      if (ok) console.log('[reminder] alert fired: ' + detail);
      else console.error('[reminder] alert failed: ' + detail);
      msg.respond({ fired: ok, result: detail });
    });
  });
}
