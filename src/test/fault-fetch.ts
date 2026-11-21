import { faultBytes, faultCut, faultFor, type Fault, type FaultPlan, type ResponseFault } from './fault-plan';

export interface FaultFetchCall {
  url: string;
  init?: RequestInit;
}

export type FaultFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  calls: FaultFetchCall[];
};

const NULL_BODY = [204, 205, 304];

/**
 * A fetch stand-in that plays a FaultPlan per URL with real Responses. Like a
 * modern engine, an abort of the request's signal fails a pending request and
 * its body; with LegacyAbortController stubbed in, it does not, as on webOS 4.
 * An unrouted URL fails like an unreachable host.
 */
export function faultFetch(routes: Record<string, FaultPlan> | ((url: string) => FaultPlan | undefined)): FaultFetch {
  const counts = new Map<string, number>();
  const calls: FaultFetchCall[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, ...(init ? { init } : {}) });
    const plan = typeof routes === 'function' ? routes(url) : routes[url];
    if (!plan) return Promise.reject(new TypeError('Failed to fetch'));
    const request = counts.get(url) ?? 0;
    counts.set(url, request + 1);
    return play(faultFor(plan, request), url, init?.signal ?? undefined);
  };
  return Object.assign(fetchFn, { calls });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function play(fault: Fault, url: string, signal?: AbortSignal): Promise<Response> {
  if ('networkError' in fault) return Promise.reject(new TypeError('Failed to fetch'));
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort);
    if ('hang' in fault || fault.holdHeaders) return;
    const respond = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response(fault, url, signal));
    };
    if (fault.delayMs) timer = setTimeout(respond, fault.delayMs);
    else respond();
  });
}

function response(fault: ResponseFault, url: string, signal?: AbortSignal): Response {
  const status = fault.status ?? 200;
  const bytes = faultBytes(fault.body);
  const { end, then } = faultCut(fault, bytes.length);
  const size = fault.chunkSize ?? Math.max(end, 1);
  let sent = 0;
  const body = NULL_BODY.indexOf(status) >= 0 ? null : new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        try { controller.error(abortError()); } catch { /* already closed */ }
      });
    },
    pull(controller) {
      const next = (): void => {
        if (sent < end) {
          const piece = bytes.subarray(sent, Math.min(end, sent + size));
          sent += piece.length;
          controller.enqueue(piece);
        } else if (then === 'close') {
          controller.close();
        } else if (then === 'reset') {
          controller.error(new TypeError('network error'));
        }
        // A stall enqueues nothing and never closes.
      };
      if (sent >= end && then === 'stall') return new Promise<void>(() => undefined);
      if (!fault.chunkDelayMs || sent === 0) { next(); return undefined; }
      return new Promise<void>(resolve => setTimeout(() => { next(); resolve(); }, fault.chunkDelayMs));
    },
  });
  const result = new Response(body, { status, headers: fault.headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
