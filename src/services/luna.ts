export interface LunaResponse {
  returnValue?: boolean;
  errorCode?: number;
  errorText?: string;
}

export interface LunaRequestOptions<T extends LunaResponse = LunaResponse> {
  method?: string;
  parameters?: Record<string, unknown>;
  subscribe?: boolean;
  onSuccess?: (response: T) => void;
  onFailure?: (response: T) => void;
  onComplete?: (response: T) => void;
}

export interface LunaRequestHandle {
  cancel(): void;
}

interface PalmServiceBridgeInstance {
  onservicecallback: ((message: string) => void) | null;
  call(uri: string, payload: string): void;
  cancel(): void;
}

type PalmServiceBridgeConstructor = new () => PalmServiceBridgeInstance;

const activeRequests: LunaRequestHandle[] = [];

function bridgeConstructor(): PalmServiceBridgeConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as {
    PalmServiceBridge?: PalmServiceBridgeConstructor;
  }).PalmServiceBridge;
  return typeof candidate === 'function' ? candidate : null;
}

export function isLunaAvailable(): boolean {
  return bridgeConstructor() !== null;
}

function removeActiveRequest(request: LunaRequestHandle): void {
  const index = activeRequests.indexOf(request);
  if (index !== -1) activeRequests.splice(index, 1);
}

function failureResponse(error: unknown, fallback: string): LunaResponse {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
  return {
    returnValue: false,
    errorCode: -1,
    errorText: message,
  };
}

function isFailure(response: LunaResponse): boolean {
  return response.returnValue === false ||
    (typeof response.errorCode === 'number' && response.errorCode !== 0);
}

export function lunaRequest<T extends LunaResponse = LunaResponse>(
  uri: string,
  options: LunaRequestOptions<T> = {},
): LunaRequestHandle {
  const parameters = options.parameters ?? {};
  const subscribe = options.subscribe === true || parameters.subscribe === true;
  const onSuccess = options.onSuccess ?? (() => {});
  const onFailure = options.onFailure ?? (() => {});
  const onComplete = options.onComplete ?? (() => {});
  let bridge: PalmServiceBridgeInstance | null = null;
  let cancelled = false;

  const request: LunaRequestHandle = {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      removeActiveRequest(request);
      if (!bridge) return;
      bridge.onservicecallback = null;
      try {
        bridge.cancel();
      } catch {
        // Cancellation is best-effort after the request has left our control.
      }
      bridge = null;
    },
  };
  activeRequests.push(request);

  const completeFailure = (response: LunaResponse): void => {
    try {
      onFailure(response as T);
    } finally {
      try {
        onComplete(response as T);
      } finally {
        request.cancel();
      }
    }
  };

  const Bridge = bridgeConstructor();
  if (!Bridge) {
    completeFailure(failureResponse(null, 'PalmServiceBridge unavailable'));
    return request;
  }

  try {
    bridge = new Bridge();
  } catch (error) {
    completeFailure(failureResponse(error, 'PalmServiceBridge unavailable'));
    return request;
  }

  bridge.onservicecallback = (message: string): void => {
    if (cancelled) return;

    let response: LunaResponse;
    try {
      const parsed: unknown = JSON.parse(message);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid Luna response');
      response = parsed as LunaResponse;
    } catch (error) {
      response = failureResponse(error, 'Invalid Luna response');
    }

    try {
      if (isFailure(response)) onFailure(response as T);
      else onSuccess(response as T);
    } finally {
      try {
        onComplete(response as T);
      } finally {
        if (!subscribe) request.cancel();
      }
    }
  };

  const payload: Record<string, unknown> = {};
  for (const key in parameters) {
    if (Object.prototype.hasOwnProperty.call(parameters, key)) {
      payload[key] = parameters[key];
    }
  }
  if (subscribe) payload.subscribe = true;

  const base = uri.charAt(uri.length - 1) === '/' ? uri.slice(0, -1) : uri;
  const requestUri = base + (options.method ? '/' + options.method : '');
  try {
    bridge.call(requestUri, JSON.stringify(payload));
  } catch (error) {
    completeFailure(failureResponse(error, 'PalmServiceBridge call failed'));
  }

  return request;
}
