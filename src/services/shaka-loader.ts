import { createLogger } from '../utils/logger';

const log = createLogger('Shaka');
const SHAKA_SCRIPT = 'js/shaka-player.dash.js';

interface SchemeRequest {
  headers: Record<string, string>;
}

export type ShakaSchemePlugin = (uri: string, request: SchemeRequest, type: number) => {
  promise: Promise<{
    uri: string;
    originalUri: string;
    originalRequest: SchemeRequest;
    data: ArrayBuffer;
    headers: Record<string, string>;
  }>;
  abort(): Promise<void>;
};

export interface ShakaNamespaceLike {
  Player: {
    new(): unknown;
    isBrowserSupported?: () => boolean;
  };
  net?: {
    NetworkingEngine?: {
      RequestType?: {
        LICENSE?: number;
      };
      PluginPriority?: { FALLBACK: number };
      registerScheme?: (scheme: string, plugin: ShakaSchemePlugin, priority: number) => void;
    };
  };
  polyfill?: {
    installAll(): void;
  };
  util: {
    Error: {
      Severity: {
        CRITICAL: number;
      };
    };
  };
}

interface ShakaWindow extends Window {
  __shaka?: ShakaNamespaceLike;
  __shakaReady?: Promise<ShakaNamespaceLike>;
  shaka?: ShakaNamespaceLike;
}

let scriptPromise: Promise<ShakaNamespaceLike> | null = null;
let initialized: ShakaNamespaceLike | null = null;

function prepare(shaka: ShakaNamespaceLike): ShakaNamespaceLike {
  if (initialized === shaka) return shaka;
  shaka.polyfill?.installAll();
  if (shaka.Player.isBrowserSupported && !shaka.Player.isBrowserSupported()) {
    throw new Error('This TV does not support the MSE/EME features required by Shaka');
  }
  const networking = shaka.net?.NetworkingEngine;
  const licenseType = networking?.RequestType?.LICENSE;
  if (networking?.registerScheme && networking.PluginPriority && licenseType !== undefined) {
    const prefix = 'data:application/json;base64,';
    // The pinned DASH artifact omits this scheme; an upstream plugin wins over FALLBACK.
    networking.registerScheme('data', (uri, request, type) => ({
      promise: Promise.resolve().then(() => {
        if (type !== licenseType || !uri.startsWith(prefix)) {
          throw new Error('Unsupported inline JSON license request');
        }
        const binary = atob(uri.slice(prefix.length));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return {
          uri, originalUri: uri, originalRequest: request, data: bytes.buffer,
          headers: { 'content-type': 'application/json' },
        };
      }),
      abort: () => Promise.resolve(),
    }), networking.PluginPriority.FALLBACK);
  }
  initialized = shaka;
  return shaka;
}

export function loadShaka(): Promise<ShakaNamespaceLike> {
  const scope = window as ShakaWindow;
  const existing = scope.__shaka ?? scope.shaka;
  if (existing) return Promise.resolve().then(() => prepare(existing));
  if (scope.__shakaReady) return scope.__shakaReady.then(prepare);
  if (scriptPromise) return scriptPromise;

  const pending = new Promise<ShakaNamespaceLike>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SHAKA_SCRIPT;
    script.async = true;
    script.onload = () => {
      const loaded = scope.shaka;
      if (!loaded) {
        reject(new Error('Shaka script loaded without exposing its namespace'));
        return;
      }
      scope.__shaka = loaded;
      try {
        resolve(prepare(loaded));
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error('Failed to load the Shaka player bundle'));
    document.head.appendChild(script);
  });
  const result = pending.catch(error => {
    scriptPromise = null;
    log.warn('Shaka bundle load failed', error);
    throw error;
  });
  scriptPromise = result;
  return result;
}
