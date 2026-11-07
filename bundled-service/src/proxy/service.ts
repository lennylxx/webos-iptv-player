/**
 * Loopback proxy feature — webOS service integration. Registers openProxy,
 * touchProxy, and closeProxy, which only the app itself may call, and holds an activity
 * while sessions exist so webOS does not stop the service mid-stream. The
 * proxy itself lives in server.ts.
 */

import { isAppCaller, senderShape } from '../fetch/service';
import { createStreamProxy, type ProxyOpenResult, type StreamProxy } from './server';
import { createKeepAlive, type ActivityManagerLike } from '../keep-alive';
import { createLogger } from '../logger';

const log = createLogger('proxy');
const ACTIVITY = 'proxyKeepAlive';

// Minimal shape of the webos-service Service object this module uses.
interface LunaService {
  register(method: string, handler: (msg: ProxyLunaMsg) => void): void;
  activityManager?: ActivityManagerLike;
}

export type ProxyLunaMsg = {
  respond: (r: unknown) => unknown;
  payload?: { url?: unknown; headers?: unknown; token?: unknown };
  sender?: unknown;
  ls2Message?: {
    applicationID?: () => string;
    senderServiceName?: () => string;
  };
};

export function registerProxyService(service: LunaService, appId: string, proxy?: StreamProxy): StreamProxy {
  const keepAlive = createKeepAlive(() => service.activityManager, ACTIVITY, log);
  const activity = (busy: boolean): void => {
    if (busy) keepAlive.hold();
    else keepAlive.release();
  };
  const streamProxy = proxy || createStreamProxy({ onBusyChange: activity });

  const responder = (method: string, msg: ProxyLunaMsg) => (result: unknown): void => {
    try {
      msg.respond(result);
    } catch (e) {
      log.error(method + ' respond failed:', e);
    }
  };
  const denied = (method: string, msg: ProxyLunaMsg): boolean => {
    if (isAppCaller(msg, appId)) return false;
    log.warn(method + ' outcome=denied sender=' + senderShape(msg));
    responder(method, msg)({ returnValue: false, errorCode: 'denied', errorText: 'Caller is not allowed' });
    return true;
  };

  service.register('openProxy', (msg) => {
    if (denied('openProxy', msg)) return;
    const payload = msg.payload || {};
    streamProxy.open({ url: payload.url, headers: payload.headers }, (result: ProxyOpenResult) => {
      // No URL or header in the log.
      if (result.returnValue) log.info('openProxy outcome=ok sessions=' + String(streamProxy.sessionCount()));
      else log.info('openProxy outcome=failed reason=' + result.errorCode);
      responder('openProxy', msg)(result);
    });
  });

  service.register('touchProxy', (msg) => {
    if (denied('touchProxy', msg)) return;
    const payload = msg.payload || {};
    const status = streamProxy.touch(payload.token);
    responder('touchProxy', msg)({ returnValue: true, alive: status.alive, lastStatus: status.lastStatus,
      manifestStatus: status.manifestStatus, cookies: status.cookies });
  });

  service.register('closeProxy', (msg) => {
    if (denied('closeProxy', msg)) return;
    const payload = msg.payload || {};
    const result = streamProxy.closeWithStatus(payload.token);
    responder('closeProxy', msg)({ returnValue: true, closed: result.closed, cookies: result.cookies });
  });

  return streamProxy;
}

export const DEFAULT_STANDALONE_PROXY_PORT = 47390;

/** Desktop simulation: a fixed-port proxy whose POST /open, /touch, and /close stand in for Luna. */
export function startProxyStandalone(portSetting: string | undefined, allowLoopback = false): StreamProxy {
  const parsed = Number(portSetting);
  const port = portSetting && parsed >= 0 && parsed < 65536 && Math.floor(parsed) === parsed
    ? parsed : DEFAULT_STANDALONE_PROXY_PORT;
  const proxy = createStreamProxy({ port: port, control: true, allowLoopback: allowLoopback });
  proxy.listen((error, bound) => {
    if (error) log.warn('standalone proxy unavailable port=' + String(port));
    else log.info('standalone proxy ready on http://127.0.0.1:' + String(bound) + ' (POST /open, /touch, /close)');
  });
  return proxy;
}
