import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { faultBytes, faultCut, faultFor, type Fault, type FaultPlan, type ResponseFault } from '../../src/test/fault-plan';

// A real HTTP server that plays the shared fault vocabulary, for the faults
// page.route cannot express: a body that stalls, trickles, or is cut partway.

export type FaultRoutes =
  | Record<string, FaultPlan>
  | ((path: string, request: number) => Fault | undefined);

export interface FaultServer {
  /** The address of `path` on this server. */
  url(path?: string): string;
  /** Requests so far, to `path` or to any path. */
  hits(path?: string): number;
  /**
   * Finishes a held response by request number. With none, finishes every
   * stalled body and stalls none after; held headers wait for their number.
   */
  release(request?: number): void;
  /** Drops a request's connection, mid-body or not. */
  cut(request: number): void;
  close(): Promise<void>;
}

interface Held {
  path: string;
  res: http.ServerResponse;
  release: (() => void) | null;
  /** What waits: the rest of the body, or the whole response. */
  holding: 'body' | 'headers' | null;
}

const CORS = { 'access-control-allow-origin': '*' };

export async function startFaultServer(routes: FaultRoutes): Promise<FaultServer> {
  const requests: Held[] = [];
  const perPath = new Map<string, number>();
  let bodiesReleased = false;

  const faultFor_ = (path: string, request: number): Fault | undefined => {
    if (typeof routes === 'function') return routes(path, request);
    const plan = routes[path];
    if (!plan) return undefined;
    const count = perPath.get(path) ?? 0;
    perPath.set(path, count + 1);
    return faultFor(plan, count);
  };

  const hold = (entry: Held, holding: 'body' | 'headers', resume: () => void): void => {
    entry.holding = holding;
    entry.release = () => { entry.release = null; entry.holding = null; resume(); };
    if (holding === 'body' && bodiesReleased) entry.release();
  };

  const sendBody = async (entry: Held, fault: ResponseFault): Promise<void> => {
    const { res } = entry;
    const bytes = faultBytes(fault.body);
    const { end, then } = faultCut(fault, bytes.length);
    const size = fault.chunkSize ?? Math.max(end, 1);
    for (let sent = 0; sent < end && !res.destroyed;) {
      if (sent && fault.chunkDelayMs) await new Promise(resolve => setTimeout(resolve, fault.chunkDelayMs));
      const piece = bytes.subarray(sent, Math.min(end, sent + size));
      res.write(piece);
      sent += piece.length;
    }
    if (res.destroyed) return;
    if (then === 'close') res.end();
    else if (then === 'reset') res.socket?.destroy();
    else hold(entry, 'body', () => res.end(Buffer.from(bytes.subarray(end))));
  };

  const respond = (entry: Held, fault: ResponseFault): void => {
    const length = faultBytes(fault.body).length;
    entry.res.writeHead(fault.status ?? 200, {
      ...CORS,
      'content-length': String(length),
      ...fault.headers,
    });
    void sendBody(entry, fault);
  };

  const server = http.createServer((req, res) => {
    // A CORS preflight (a Range header can need one) passes, and is not a request.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS,
        'access-control-allow-methods': '*',
        'access-control-allow-headers': '*',
      });
      res.end();
      return;
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const entry: Held = { path, res, release: null, holding: null };
    const request = requests.push(entry) - 1;
    const fault = faultFor_(path, request);
    if (!fault) {
      res.writeHead(404, CORS);
      res.end();
      return;
    }
    if ('networkError' in fault) {
      req.socket.destroy();
      return;
    }
    if ('hang' in fault) {
      hold(entry, 'headers', () => { res.writeHead(200, CORS); res.end(); });
      return;
    }
    const start = (): void => {
      if (fault.holdHeaders) hold(entry, 'headers', () => respond(entry, fault));
      else respond(entry, fault);
    };
    if (fault.delayMs) setTimeout(start, fault.delayMs);
    else start();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    url: (path = '/') => base + path,
    hits: (path) => path === undefined ? requests.length : requests.filter(entry => entry.path === path).length,
    release: (request) => {
      if (request !== undefined) {
        requests[request]?.release?.();
        return;
      }
      bodiesReleased = true;
      for (const entry of requests) if (entry.holding === 'body') entry.release?.();
    },
    cut: (request) => { requests[request]?.res.destroy(); },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
