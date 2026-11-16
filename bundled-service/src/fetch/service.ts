/**
 * Manifest fetch feature — webOS service integration. Registers
 * fetchManifest, which only the app itself may call; the fetch lives in
 * manifest-fetch.ts.
 */

import { fetchManifest, type ManifestFetchRequest } from './manifest-fetch';
import { appMethod, type AppMsg, type LunaRegistry } from '../luna-reply';
import { createLogger } from '../logger';

const log = createLogger('fetch');

export type LunaMsg = AppMsg<ManifestFetchRequest>;

export function registerManifestFetchService(service: LunaRegistry<LunaMsg>, appId: string): void {
  appMethod(service, appId, 'fetchManifest', log, (payload, respond) => {
    fetchManifest(payload, (result) => {
      // No URL, header, or body in the log.
      if (result.returnValue) log.info('fetchManifest outcome=ok status=' + String(result.status));
      else log.info('fetchManifest outcome=failed reason=' + result.errorCode);
      respond(result);
    });
  });
}
