// One vocabulary of network faults, played by faultFetch() in unit tests and
// by the E2E fault server, so a failure case reads the same in both layers.

export type FaultBody = string | Uint8Array;

export interface ResponseFault {
  status?: number;
  headers?: Record<string, string>;
  body?: FaultBody;
  /** Before the headers. */
  delayMs?: number;
  /** Sends the body in pieces this big, `chunkDelayMs` apart: slow, never stalled. */
  chunkSize?: number;
  chunkDelayMs?: number;
  /** After this many body bytes, sends nothing more and keeps the connection open, until released. */
  stallAfterBytes?: number;
  /** After this many body bytes, cuts the connection. */
  resetAfterBytes?: number;
  /** Holds the whole response, headers too, until the E2E fault server releases it; faultFetch never does. */
  holdHeaders?: boolean;
}

export type Fault =
  | ResponseFault
  /** The request fails before any response, as a refused or unresolvable host does. */
  | { networkError: true }
  /** No headers ever arrive; only the client's own timeout or cancel ends it. */
  | { hang: true };

/** One fault for every request, or one per request in order with the last repeating. */
export type FaultPlan = Fault | readonly Fault[];

export function faultFor(plan: FaultPlan, request: number): Fault {
  if (!Array.isArray(plan)) return plan as Fault;
  const list = plan as readonly Fault[];
  return list[Math.min(request, list.length - 1)];
}

export function faultBytes(body: FaultBody | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

/** Where a body send ends: the whole body, or the bytes before a stall or a reset. */
export function faultCut(fault: ResponseFault, length: number): { end: number; then: 'close' | 'stall' | 'reset' } {
  if (fault.resetAfterBytes !== undefined) return { end: Math.min(fault.resetAfterBytes, length), then: 'reset' };
  if (fault.stallAfterBytes !== undefined) return { end: Math.min(fault.stallAfterBytes, length), then: 'stall' };
  return { end: length, then: 'close' };
}
