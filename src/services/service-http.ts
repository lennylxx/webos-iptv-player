import { CONFIG } from '../config';

// The LAN service binds to an OS-assigned port at startup and reports it
// through the Luna `start` response (see app.ts → startBundledService). Until
// setServicePort() receives that value, serviceBase() returns null and both LAN
// clients behave as if the service were unreachable. This also covers dev and
// e2e environments where Luna is unavailable and no service runs.
let runtimePort: number | null = null;

export function setServicePort(port: number | null): void {
  if (port === null) {
    runtimePort = null;
    return;
  }
  if (typeof port === 'number' && port > 0 && port < 65536) {
    runtimePort = port;
  }
}

export function serviceBase(): string | null {
  if (runtimePort === null) return null;
  return `http://${CONFIG.SERVICE_HOST}:${runtimePort}`;
}
