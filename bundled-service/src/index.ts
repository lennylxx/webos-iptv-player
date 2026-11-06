/**
 * Bundled webOS JS service for the IPTV player — thin entry point.
 *
 * Resolves the data dir, binds the Luna service, and wires up each feature
 * module:
 *
 * - LAN setup and uploads over HTTP + Luna (lan/, setup/)
 * - Reminder alerts through dev-mode interactive createAlert (reminder/)
 * - Manifest fetch that carries the channel's headers (fetch/)
 *
 * Off webOS (local testing), it falls back to a direct upload HTTP
 * listener.
 */

import { registerLanService, startLanStandalone } from './lan/service';
import { resolveDataDir } from './upload/store';
import { registerReminderService } from './reminder/service';
import { registerManifestFetchService } from './fetch/service';
import { createLogger } from './logger';

const log = createLogger('service');

// Service id from services.json — the file webOS hubd reads to register
// this service on the Luna bus. Passing anything else into `new Service()`
// would fail to bind.
const SERVICE_ID: string = require('./services.json').id;
// The service id is the app id (which webOS requires as its prefix) + ".service".
const APP_ID = SERVICE_ID.replace(/\.service$/, '');
const DATA_DIR = resolveDataDir(process.env.WEBOS_UPLOAD_DIR);

log.info('starting, SERVICE_ID=' + SERVICE_ID + ', DATA_DIR=' + DATA_DIR);

let Service;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Service = require('webos-service');
} catch (e) {
  log.info('webos-service not available (' + (e instanceof Error ? e.message : String(e)) +
    '), falling back to direct HTTP listener');
  startLanStandalone(DATA_DIR);
}

if (Service) {
  try {
    const service = new Service(SERVICE_ID);
    log.info('registered with Luna as ' + SERVICE_ID);
    registerLanService(service, DATA_DIR);
    registerReminderService(service);
    registerManifestFetchService(service, APP_ID);
  } catch (e) {
    log.error('failed to register Luna service:', e);
    throw e;
  }
}
