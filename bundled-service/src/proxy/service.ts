/**
 * Loopback proxy feature — webOS service integration. Registers openProxy,
 * touchProxy, and closeProxy, which only the app itself may call, and holds an activity
 * while sessions exist so webOS does not stop the service mid-stream. The
 * proxy itself lives in server.ts.
 */

import { appMethod, type AppMsg, type LunaRegistry } from '../luna-reply';
import { createStreamProxy, type ProxyOpenResult, type StreamProxy } from './server';
import { createKeepAlive, type ActivityManagerLike } from '../keep-alive';
import { createLogger } from '../logger';

const log = createLogger('proxy');
const ACTIVITY = 'proxyKeepAlive';

interface LunaService extends LunaRegistry<ProxyLunaMsg> {
  activityManager?: ActivityManagerLike;
}

export type ProxyLunaMsg = AppMsg<{ url?: unknown; headers?: unknown; token?: unknown }>;

export function registerProxyService(service: LunaService, appId: string, proxy?: StreamProxy): StreamProxy {
  const keepAlive = createKeepAlive(() => service.activityManager, ACTIVITY, log);
  const activity = (busy: boolean): void => {
    if (busy) keepAlive.hold();
    else keepAlive.release();
  };
  const streamProxy = proxy || createStreamProxy({ onBusyChange: activity });

  appMethod(service, appId, 'openProxy', log, (payload, respond) => {
    streamProxy.open({ url: payload.url, headers: payload.headers }, (result: ProxyOpenResult) => {
      // No URL or header in the log.
      if (result.returnValue) log.info('openProxy outcome=ok sessions=' + String(streamProxy.sessionCount()));
      else log.info('openProxy outcome=failed reason=' + result.errorCode);
      respond(result);
    });
  });

  appMethod(service, appId, 'touchProxy', log, (payload, respond) => {
    const status = streamProxy.touch(payload.token);
    respond({ returnValue: true, alive: status.alive, lastStatus: status.lastStatus,
      manifestStatus: status.manifestStatus, cookies: status.cookies });
  });

  appMethod(service, appId, 'closeProxy', log, (payload, respond) => {
    const result = streamProxy.closeWithStatus(payload.token);
    respond({ returnValue: true, closed: result.closed, cookies: result.cookies });
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
