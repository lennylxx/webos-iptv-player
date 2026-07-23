// Reminder-alert logic for the bundled service. Kept out of index.ts so that
// entry stays a thin wiring file (same split as ./upload/server).
//
// On webOS, createAlert is refused to every identity a third-party app can
// present; only luna-send-pub (role type "devmode") may raise it, and only
// while Developer Mode is enabled. So this path is dev-mode-only.

import { execFile } from 'child_process';
import { existsSync } from 'fs';

const DEVMODE_FLAG = '/var/luna/preferences/devmode_enabled';

export function isDevMode(): boolean {
  return existsSync(DEVMODE_FLAG);
}

export interface AlertButton {
  label: string;
  focus?: boolean;
  onclick?: string;
  params?: unknown;
}

export interface AlertPayload {
  sourceId: string;
  title: string;
  message: string;
  modal: boolean;
  buttons: AlertButton[];
}

export interface AlertCopy {
  title: string;
  message: string;
  watchLabel: string;
  cancelLabel: string;
}

// Pure — unit-tested without child_process/fs.
export function buildAlertPayload(
  title: string,
  channelName: string,
  channelKey: string,
  appId: string,
  copy?: AlertCopy,
): AlertPayload {
  return {
    sourceId: appId,
    title: copy ? copy.title : 'Program reminder',
    message: copy ? copy.message : `${channelName} - ${title} is now live — watch it?`,
    modal: true,
    buttons: [
      {
        label: copy ? copy.watchLabel : 'Watch now',
        focus: true,
        onclick: 'luna://com.webos.applicationManager/launch',
        params: { id: appId, params: { reminderChannelKey: channelKey } },
      },
      { label: copy ? copy.cancelLabel : 'Cancel' },
    ],
  };
}

// Side-effecting — the verified luna-send-pub exec path. luna-send-pub is the
// only handle allowed to call createAlert, and only in Developer Mode.
export function fireAlert(payload: AlertPayload, cb: (ok: boolean, detail: string) => void): void {
  execFile(
    '/usr/bin/luna-send-pub',
    ['-n', '1', 'luna://com.webos.notification/createAlert', JSON.stringify(payload)],
    { timeout: 6000 },
    (err, stdout) => cb(!err, err ? String(err) : String(stdout).trim()),
  );
}
