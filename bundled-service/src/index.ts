/**
 * Bundled webOS JS service for the IPTV player — thin entry point.
 *
 * Resolves the data dir, binds the Luna service, and wires up each feature
 * module:
 *
 * - LAN setup and uploads over HTTP + Luna (lan/, setup/)
 * - Reminder alerts through dev-mode interactive createAlert (reminder/)
 * - Manifest fetch that carries the channel's headers (fetch/)
 * - Loopback stream proxy that plays a header-gated stream (proxy/)
 *
 * Off webOS (local testing), it falls back to a direct upload HTTP
 * listener and a loopback proxy on IPTV_PROXY_PORT (default 47390) whose
 * POST /open, /touch, and /close stand in for the Luna methods;
 * IPTV_PROXY_ALLOW_LOOPBACK=1 lets it reach an upstream on this machine.
 */

import { registerLanService, startLanStandalone } from './lan/service';
import { resolveDataDir } from './upload/store';
import { registerReminderService } from './reminder/service';
import { registerManifestFetchService } from './fetch/service';
import { registerProxyService, startProxyStandalone } from './proxy/service';
import { installServiceLog, serviceLogDir } from './service-log';
import { createLogger } from './logger';

const log = createLogger('service');

// Service id from services.json — the file webOS hubd reads to register
// this service on the Luna bus. Passing anything else into `new Service()`
// would fail to bind.
const SERVICE_ID: string = require('./services.json').id;
// The service id is the app id (which webOS requires as its prefix) + ".service".
const APP_ID = SERVICE_ID.replace(/\.service$/, '');

let Service;
let serviceLoadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Service = require('webos-service');
} catch (e) {
  serviceLoadError = e instanceof Error ? e.message : String(e);
}
// Only on the TV: a local run must not write into the host's /tmp.
if (Service) installServiceLog(serviceLogDir(process.versions.node) + '/' + SERVICE_ID + '.log');

const DATA_DIR = resolveDataDir(process.env.WEBOS_UPLOAD_DIR);

log.info('starting, SERVICE_ID=' + SERVICE_ID + ', DATA_DIR=' + DATA_DIR);

if (!Service) {
  log.info('webos-service not available (' + serviceLoadError +
    '), falling back to direct HTTP listener');
  startLanStandalone(DATA_DIR);
  startProxyStandalone(process.env.IPTV_PROXY_PORT, process.env.IPTV_PROXY_ALLOW_LOOPBACK === '1');
}

if (Service) {
  try {
    const service = new Service(SERVICE_ID);
    log.info('registered with Luna as ' + SERVICE_ID);
    registerLanService(service, DATA_DIR);
    registerReminderService(service);
    registerManifestFetchService(service, APP_ID);
    registerProxyService(service, APP_ID);
  } catch (e) {
    log.error('failed to register Luna service:', e);
    throw e;
  }
}
