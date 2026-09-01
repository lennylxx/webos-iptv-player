import { PLAYREADY_SCHEME } from '../parsers/mpd-manifest';
import { createLogger } from '../utils/logger';

const log = createLogger('PlayReady');
const DRM_URI = 'luna://com.webos.service.drm';
const PLAYREADY_SYSTEM_ID = 'urn:dvb:casystemid:19219';
const PLAYREADY_MESSAGE_TYPE = 'application/vnd.ms-playready.initiator+xml';

interface ServiceResponse {
  returnValue?: boolean;
  clientId?: string;
  msgId?: string;
  resultCode?: number;
  errorCode?: number;
  errorText?: string;
  contentId?: string;
  errorState?: number;
  rightIssueUrl?: string;
}

interface ServiceHandle {
  cancel(): void;
}

interface ServiceOptions {
  method: string;
  parameters: Record<string, unknown>;
  onSuccess?: (response: ServiceResponse) => void;
  onFailure?: (error: ServiceResponse) => void;
}

type ServiceRequest = (uri: string, options: ServiceOptions) => ServiceHandle;

export interface PlayReadyConfig {
  type: 'playready';
  licenseUrl: string;
  customData: string;
  unsupportedOptions: string[];
}

export interface UnsupportedDrmConfig {
  type: 'unsupported';
  value: string;
}

export type NativeDrmConfig = PlayReadyConfig | UnsupportedDrmConfig;

const LICENSE_TYPE_KEYS = [
  'inputstream.adaptive.license_type',
  'license_type',
  'drm_type',
];
const DRM_KEYS = ['inputstream.adaptive.drm'];
const DRM_LEGACY_KEYS = [
  'inputstream.adaptive.drm_legacy',
  'drm_legacy',
];
const LICENSE_KEY_KEYS = [
  'inputstream.adaptive.license_key',
  'license_key',
  'drm_license_url',
];
const CUSTOM_DATA_KEYS = [
  'drm_custom_data',
];
const LICENSE_DATA_KEYS = [
  'inputstream.adaptive.license_data',
  'license_data',
];

function firstExtra(extras: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = extras[key]?.trim();
    if (value) return value;
  }
  return '';
}

function isPlayReady(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'playready'
    || normalized === 'com.microsoft.playready'
    || normalized === 'com.microsoft.playready.recommendation'
    || normalized === PLAYREADY_SCHEME;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function unsupportedJsonOptions(entry: Record<string, unknown>): string[] {
  const unsupported: string[] = [];
  const supportedEntry = {
    priority: true,
    license: true,
    optional_key_req_params: true,
  };
  for (const key in entry) {
    if (!Object.prototype.hasOwnProperty.call(supportedEntry, key)
        && entry[key] !== undefined) {
      unsupported.push(key);
    }
  }
  const license = record(entry.license);
  if (license) {
    const supported = { server_url: true };
    for (const key in license) {
      if (!Object.prototype.hasOwnProperty.call(supported, key) && license[key] !== undefined) {
        unsupported.push(`license.${key}`);
      }
    }
  }
  const keyParams = record(entry.optional_key_req_params);
  if (keyParams) {
    const supported = { custom_data: true };
    for (const key in keyParams) {
      if (!Object.prototype.hasOwnProperty.call(supported, key)
          && keyParams[key] !== undefined) {
        unsupported.push(`optional_key_req_params.${key}`);
      }
    }
  }
  return unsupported;
}

function kodiDrmConfig(value: string): NativeDrmConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { type: 'unsupported', value: 'invalid inputstream.adaptive.drm' };
  }
  const configs = record(parsed);
  if (!configs) return { type: 'unsupported', value: 'invalid inputstream.adaptive.drm' };

  let firstType = '';
  for (const type in configs) {
    if (!firstType) firstType = type;
    if (!isPlayReady(type)) continue;
    const entry = record(configs[type]) ?? {};
    const license = record(entry.license);
    const keyParams = record(entry.optional_key_req_params);
    return {
      type: 'playready',
      licenseUrl: text(license?.server_url),
      customData: text(keyParams?.custom_data),
      unsupportedOptions: unsupportedJsonOptions(entry),
    };
  }
  return { type: 'unsupported', value: firstType || 'empty inputstream.adaptive.drm' };
}

function kodiLegacyConfig(value: string): NativeDrmConfig {
  const parts = value.split('|');
  const type = parts[0]?.trim() ?? '';
  if (!isPlayReady(type)) return { type: 'unsupported', value: type || value };
  const unsupportedOptions: string[] = [];
  if (parts[2]?.trim()) unsupportedOptions.push('license headers');
  return {
    type: 'playready',
    licenseUrl: parts[1]?.trim() ?? '',
    customData: '',
    unsupportedOptions,
  };
}

export function nativeDrmConfig(
  extras: Record<string, string> | null,
): NativeDrmConfig | null {
  if (!extras) return null;
  const drm = firstExtra(extras, DRM_KEYS);
  if (drm) return kodiDrmConfig(drm);
  const legacy = firstExtra(extras, DRM_LEGACY_KEYS);
  if (legacy) return kodiLegacyConfig(legacy);

  const type = firstExtra(extras, LICENSE_TYPE_KEYS);
  if (!type) return null;
  if (!isPlayReady(type)) return { type: 'unsupported', value: type };
  const licenseKey = firstExtra(extras, LICENSE_KEY_KEYS);
  const licenseParts = licenseKey.split('|');
  const unsupportedOptions: string[] = [];
  if (licenseParts[1]?.trim()) unsupportedOptions.push('license headers');
  if (licenseParts[2]?.trim() || licenseParts[3]?.trim()) {
    unsupportedOptions.push('license request/response recipe');
  }
  if (firstExtra(extras, LICENSE_DATA_KEYS)) unsupportedOptions.push('license data/PSSH');
  return {
    type: 'playready',
    licenseUrl: licenseParts[0]?.trim() ?? '',
    customData: firstExtra(extras, CUSTOM_DATA_KEYS),
    unsupportedOptions,
  };
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function licenseServerMessage(url: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<PlayReadyInitiator xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols/">'
    + '<LicenseServerUriOverride><LA_URL>' + xml(url) + '</LA_URL>'
    + '</LicenseServerUriOverride></PlayReadyInitiator>';
}

function customDataMessage(customData: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<PlayReadyInitiator xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols/">'
    + '<SetCustomData><CustomData>' + xml(customData) + '</CustomData>'
    + '</SetCustomData></PlayReadyInitiator>';
}

function serviceRequest(): ServiceRequest | null {
  const webOSWindow = window as unknown as {
    webOS?: { service?: { request?: ServiceRequest } };
  };
  return webOSWindow.webOS?.service?.request ?? null;
}

export class PlayReadyDrm {
  private generation = 0;
  private clientId = '';
  private subscription: ServiceHandle | null = null;
  private messageIds = new Set<string>();

  async prepare(
    config: PlayReadyConfig,
    onRightsError: (response: ServiceResponse) => void,
  ): Promise<string | null> {
    const generation = ++this.generation;
    await this.unloadCurrent();
    if (generation !== this.generation) return null;

    const request = serviceRequest();
    if (!request) throw new Error('webOS DRM service is unavailable');

    try {
      const loaded = await this.call(request, 'load', {
        drmType: 'playready',
        appId: __APP_ID__,
      });
      const clientId = loaded.clientId;
      if (!clientId) throw new Error('DRM service returned no clientId');
      if (generation !== this.generation) {
        await this.unload(request, clientId);
        return null;
      }
      this.clientId = clientId;
      this.messageIds.clear();
      this.subscription = request(DRM_URI, {
        method: 'getRightsError',
        parameters: { clientId, subscribe: true },
        onSuccess: response => {
          if (generation !== this.generation || typeof response.errorState !== 'number') return;
          if (!response.contentId || !this.messageIds.has(response.contentId)) return;
          onRightsError(response);
        },
        onFailure: error => {
          if (generation === this.generation) {
            log.warn('Rights-error subscription failed',
              `code=${String(error.errorCode ?? '')}`);
          }
        },
      });

      const messages = [licenseServerMessage(config.licenseUrl)];
      if (config.customData) messages.push(customDataMessage(config.customData));
      for (const msg of messages) {
        const sent = await this.call(request, 'sendDrmMessage', {
          clientId,
          msgType: PLAYREADY_MESSAGE_TYPE,
          msg,
          drmSystemId: PLAYREADY_SYSTEM_ID,
        });
        if (sent.resultCode !== undefined && sent.resultCode !== 0) {
          throw new Error(`PlayReady message failed with result ${String(sent.resultCode)}`);
        }
        if (sent.msgId) this.messageIds.add(sent.msgId);
        if (generation !== this.generation) return null;
      }
      return clientId;
    } catch (error) {
      if (generation === this.generation) await this.unloadCurrent();
      throw error;
    }
  }

  release(): void {
    this.generation++;
    void this.unloadCurrent().catch(error => {
      log.warn('DRM client unload failed', error);
    });
  }

  private call(
    request: ServiceRequest,
    method: string,
    parameters: Record<string, unknown>,
  ): Promise<ServiceResponse> {
    return new Promise((resolve, reject) => {
      request(DRM_URI, {
        method,
        parameters,
        onSuccess: response => {
          if (response.returnValue === false) {
            reject(new Error(response.errorText || `${method} failed`));
            return;
          }
          resolve(response);
        },
        onFailure: error => {
          reject(new Error(error.errorText || `${method} failed`));
        },
      });
    });
  }

  private async unloadCurrent(): Promise<void> {
    const request = serviceRequest();
    const clientId = this.clientId;
    this.clientId = '';
    this.messageIds.clear();
    this.subscription?.cancel();
    this.subscription = null;
    if (request && clientId) await this.unload(request, clientId);
  }

  private async unload(request: ServiceRequest, clientId: string): Promise<void> {
    await this.call(request, 'unload', { clientId });
  }
}
