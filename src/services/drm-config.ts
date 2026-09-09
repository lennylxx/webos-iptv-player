import { CLEARKEY_SCHEME, PLAYREADY_SCHEME, WIDEVINE_SCHEME } from '../parsers/mpd-manifest';

export interface PlayReadyConfig {
  type: 'playready';
  licenseUrl: string;
  customData: string;
  unsupportedOptions: string[];
}

export interface WidevineConfig {
  type: 'widevine';
  licenseUrl: string;
  headers: Record<string, string>;
  unsupportedOptions: string[];
}

export interface ClearKeyConfig {
  type: 'clearkey';
  licenseUrl: string;
  headers: Record<string, string>;
  clearKeys: Record<string, string>;
  unsupportedOptions: string[];
}

export interface UnsupportedDrmConfig {
  type: 'unsupported';
  value: string;
}

export type ShakaDrmConfig = WidevineConfig | ClearKeyConfig;
export type DrmConfig = PlayReadyConfig | ShakaDrmConfig | UnsupportedDrmConfig;

export function isShakaDrmConfig(config: DrmConfig | null): config is ShakaDrmConfig {
  return config?.type === 'widevine' || config?.type === 'clearkey';
}

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
const CUSTOM_DATA_KEYS = ['drm_custom_data'];
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

function isWidevine(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'widevine'
    || normalized === 'com.widevine.alpha'
    || normalized === WIDEVINE_SCHEME;
}

function isClearKey(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'clearkey'
    || normalized === 'org.w3.clearkey'
    || normalized === CLEARKEY_SCHEME;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function keyHex(value: unknown, jwk = false): string | null {
  const source = text(value);
  if (!jwk && /^[a-f\d]{32}$/i.test(source)) return source.toLowerCase();
  if (!/^[a-z\d+/_-]{22}(?:==)?$/i.test(source)) return null;
  try {
    const normalized = source.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const bytes = atob(normalized + '==');
    if (bytes.length !== 16 || btoa(bytes).replace(/=+$/, '') !== normalized) return null;
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += ('0' + bytes.charCodeAt(i).toString(16)).slice(-2);
    }
    return hex;
  } catch {
    return null;
  }
}

function invalidClearKeyConfig(): UnsupportedDrmConfig {
  return { type: 'unsupported', value: 'invalid ClearKey license configuration' };
}

function clearKeyConfig(
  value: unknown,
  headers: Record<string, string>,
  unsupportedOptions: string[],
): ClearKeyConfig | UnsupportedDrmConfig {
  const invalid = invalidClearKeyConfig();
  const config: ClearKeyConfig = {
    type: 'clearkey', licenseUrl: '', headers, clearKeys: {}, unsupportedOptions,
  };
  let source: unknown = value;
  if (typeof source === 'string') {
    const input = source.trim();
    if (!input) return config;
    if (/^https?:\/\//i.test(input)) {
      try {
        new URL(input);
        config.licenseUrl = input;
        return config;
      } catch {
        return invalid;
      }
    }
    try {
      if (/^data:/i.test(input)) {
        const match = /^data:application\/json(?:;charset=utf-8)?(;base64)?,(.*)$/i.exec(input);
        if (!match) return invalid;
        source = JSON.parse(match[1] ? atob(match[2]) : decodeURIComponent(match[2]));
      } else if (input.startsWith('{')) {
        source = JSON.parse(input);
      } else {
        const pairs: Record<string, string> = {};
        for (const pair of input.split(',')) {
          const parts = pair.split(':');
          if (parts.length !== 2) return invalid;
          const kid = keyHex(parts[0]);
          const key = keyHex(parts[1]);
          if (!kid || !key || (pairs[kid] !== undefined && pairs[kid] !== key)) return invalid;
          pairs[kid] = key;
        }
        source = pairs;
      }
    } catch {
      return invalid;
    }
  }
  const object = record(source);
  if (!object) return invalid;
  const pairs: [unknown, unknown][] = [];
  const jwk = Object.prototype.hasOwnProperty.call(object, 'keys');
  if (jwk) {
    if (!Array.isArray(object.keys) || (object.type !== undefined && object.type !== 'temporary')) {
      return invalid;
    }
    for (const item of object.keys) {
      const key = record(item);
      if (!key || key.kty !== 'oct') return invalid;
      pairs.push([key.kid, key.k]);
    }
  } else {
    for (const kid of Object.keys(object)) pairs.push([kid, object[kid]]);
  }
  if (!pairs.length) return invalid;
  for (const [id, value] of pairs) {
    const kid = keyHex(id, jwk);
    const key = keyHex(value, jwk);
    if (!kid || !key || (config.clearKeys[kid] !== undefined && config.clearKeys[kid] !== key)) {
      return invalid;
    }
    config.clearKeys[kid] = key;
  }
  return config;
}

function headerText(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of value.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const rawName = equals < 0 ? pair : pair.slice(0, equals);
    const rawValue = equals < 0 ? '' : pair.slice(equals + 1);
    try {
      const name = decodeURIComponent(rawName.replace(/\+/g, ' ')).trim();
      if (!name) continue;
      headers[name] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      const name = rawName.trim();
      if (name) headers[name] = rawValue;
    }
  }
  return headers;
}

function licenseHeaders(value: unknown): Record<string, string> {
  if (typeof value === 'string') return headerText(value);
  const source = record(value);
  if (!source) return {};
  const headers: Record<string, string> = {};
  for (const name in source) {
    const value = source[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

function unsupportedJsonOptions(
  entry: Record<string, unknown>,
  type: 'playready' | 'widevine' | 'clearkey',
): string[] {
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
    for (const key in license) {
      const supported = key === 'server_url'
        || (type !== 'playready' && key === 'req_headers')
        || (type === 'clearkey' && key === 'keyids');
      if (!supported && license[key] !== undefined) {
        unsupported.push(`license.${key}`);
      }
    }
  }
  const keyParams = record(entry.optional_key_req_params);
  if (keyParams) {
    for (const key in keyParams) {
      const supported = type === 'playready' && key === 'custom_data';
      if (!supported && keyParams[key] !== undefined) {
        unsupported.push(`optional_key_req_params.${key}`);
      }
    }
  }
  return unsupported;
}

function kodiDrmConfig(value: string): DrmConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { type: 'unsupported', value: 'invalid inputstream.adaptive.drm' };
  }
  const configs = record(parsed);
  if (!configs) return { type: 'unsupported', value: 'invalid inputstream.adaptive.drm' };

  let firstType = '';
  let widevineEntry: Record<string, unknown> | null = null;
  let clearKeyEntry: unknown;
  for (const type in configs) {
    if (!firstType) firstType = type;
    const entry = record(configs[type]) ?? {};
    if (isWidevine(type) && !widevineEntry) widevineEntry = entry;
    if (isClearKey(type) && clearKeyEntry === undefined) clearKeyEntry = configs[type];
    if (!isPlayReady(type)) continue;
    const license = record(entry.license);
    const keyParams = record(entry.optional_key_req_params);
    return {
      type: 'playready',
      licenseUrl: text(license?.server_url),
      customData: text(keyParams?.custom_data),
      unsupportedOptions: unsupportedJsonOptions(entry, 'playready'),
    };
  }
  if (widevineEntry) {
    const license = record(widevineEntry.license);
    return {
      type: 'widevine',
      licenseUrl: text(license?.server_url),
      headers: licenseHeaders(license?.req_headers),
      unsupportedOptions: unsupportedJsonOptions(widevineEntry, 'widevine'),
    };
  }
  if (clearKeyEntry !== undefined) {
    const entry = record(clearKeyEntry);
    if (!entry) return invalidClearKeyConfig();
    const license = record(entry.license);
    if (entry.license !== undefined && !license) return invalidClearKeyConfig();
    if (license?.keyids !== undefined && !record(license.keyids)) return invalidClearKeyConfig();
    if (license?.keyids === undefined && license?.server_url !== undefined
        && typeof license.server_url !== 'string') return invalidClearKeyConfig();
    const headers = license?.req_headers;
    const headerMap = record(headers);
    if (headers !== undefined && typeof headers !== 'string'
        && (!headerMap || Object.keys(headerMap).some(name => typeof headerMap[name] !== 'string'))) {
      return invalidClearKeyConfig();
    }
    return clearKeyConfig(
      license?.keyids !== undefined ? license.keyids : text(license?.server_url),
      licenseHeaders(headers),
      unsupportedJsonOptions(entry, 'clearkey'),
    );
  }
  return { type: 'unsupported', value: firstType || 'empty inputstream.adaptive.drm' };
}

function kodiLegacyConfig(value: string): DrmConfig {
  const parts = value.split('|');
  const type = parts[0]?.trim() ?? '';
  if (isClearKey(type)) {
    return clearKeyConfig(parts[1]?.trim() ?? '', headerText(parts[2]?.trim() ?? ''),
      parts.slice(3).some(part => part.trim()) ? ['license request/response recipe'] : []);
  }
  if (isWidevine(type)) {
    return {
      type: 'widevine',
      licenseUrl: parts[1]?.trim() ?? '',
      headers: headerText(parts[2]?.trim() ?? ''),
      unsupportedOptions: [],
    };
  }
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

export function parseDrmConfig(
  extras: Record<string, string> | null,
): DrmConfig | null {
  if (!extras) return null;
  const drm = firstExtra(extras, DRM_KEYS);
  if (drm) return kodiDrmConfig(drm);
  const legacy = firstExtra(extras, DRM_LEGACY_KEYS);
  if (legacy) return kodiLegacyConfig(legacy);

  const type = firstExtra(extras, LICENSE_TYPE_KEYS);
  if (!type) return null;
  const licenseKey = firstExtra(extras, LICENSE_KEY_KEYS);
  const licenseParts = licenseKey.split('|');
  if (isClearKey(type)) {
    const unsupportedOptions: string[] = [];
    if (licenseParts.slice(2).some(part => part.trim())) {
      unsupportedOptions.push('license request/response recipe');
    }
    if (firstExtra(extras, LICENSE_DATA_KEYS)) unsupportedOptions.push('license data/PSSH');
    return clearKeyConfig(licenseParts[0]?.trim() ?? '',
      headerText(licenseParts[1]?.trim() ?? ''), unsupportedOptions);
  }
  if (isWidevine(type)) {
    const unsupportedOptions: string[] = [];
    if (licenseParts[2]?.trim() || licenseParts[3]?.trim()) {
      unsupportedOptions.push('license request/response recipe');
    }
    if (firstExtra(extras, LICENSE_DATA_KEYS)) {
      unsupportedOptions.push('license data/PSSH');
    }
    return {
      type: 'widevine',
      licenseUrl: licenseParts[0]?.trim() ?? '',
      headers: headerText(licenseParts[1]?.trim() ?? ''),
      unsupportedOptions,
    };
  }
  if (!isPlayReady(type)) return { type: 'unsupported', value: type };
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
