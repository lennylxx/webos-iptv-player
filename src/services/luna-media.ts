import { CONFIG } from '../config';
import { lunaRequest, type LunaRequestHandle, type LunaResponse } from './luna';

// Direct UMS playback, used when a stream needs HTTP headers that the page's
// <video> pipeline overwrites with its own Referer and User-Agent.
const MEDIA = 'luna://com.webos.media';
const VIDEO_OUTPUT = 'luna://com.webos.service.videooutput/display';

export type LunaTransport = 'HLS' | 'MPEG-DASH';

export interface LunaDisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LunaDisplay = LunaDisplayRect | 'full';

export class LunaMediaError extends Error {
  /** timedOut: no answer, so not proof the method is missing. */
  constructor(message: string, readonly code: number, readonly timedOut = false, readonly text = '') {
    super(message);
    this.name = 'LunaMediaError';
  }
}

// The bus's own answer for a method this firmware does not have. A missing
// service is transient (at boot, or while uMediaServer restarts), as is any
// other failure.
export function isMissingMethod(error: unknown): boolean {
  return error instanceof LunaMediaError && !error.timedOut && error.code === -1
    && /unknown method|\bmethod\b[^:]*\bdoes not exist/i.test(error.text);
}

interface LunaHeaderFields {
  referer: string;
  userAgent: string;
  cookie: string;
  extra: Record<string, string>;
}

function splitHeaders(headers: Record<string, string>): LunaHeaderFields {
  const fields: LunaHeaderFields = { referer: '', userAgent: '', cookie: '', extra: {} };
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (typeof value !== 'string' || !value) continue;
    const key = name.toLowerCase();
    if (key === 'referer' || key === 'referrer') fields.referer = value;
    else if (key === 'user-agent') fields.userAgent = value;
    else if (key === 'cookie') fields.cookie = value;
    else fields.extra[key] = value;
  }
  return fields;
}

/** The headers the Luna path exists for. A User-Agent alone keeps <video>,
 *  which plays most such streams and supports every track feature. */
export function hasLunaHeaders(headers: Record<string, string>): boolean {
  const fields = splitHeaders(headers);
  return Boolean(fields.referer || fields.cookie || Object.keys(fields.extra).length);
}

export function hasOnlyUserAgent(headers: Record<string, string>): boolean {
  return Boolean(splitHeaders(headers).userAgent) && !hasLunaHeaders(headers);
}

const TLS_UNSAFE_HEADERS = ['cookie', 'authorization'];

/** UMS does not verify TLS certificates, so credentials stay off https. */
export function tlsUnsafeHeaderNames(uri: string, headers: Record<string, string>): string[] {
  if (!/^https:/i.test(uri)) return [];
  const names: string[] = [];
  for (const name of Object.keys(headers)) {
    const key = name.toLowerCase();
    if (headers[name] && TLS_UNSAFE_HEADERS.indexOf(key) >= 0 && names.indexOf(key) < 0) {
      names.push(key);
    }
  }
  return names.sort();
}

export function withoutHeaders(
  headers: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    if (names.indexOf(name.toLowerCase()) < 0) kept[name] = headers[name];
  }
  return kept;
}

const LOGGED_HEADER_NAMES: Record<string, string | undefined> = {
  authorization: 'authorization',
  origin: 'origin',
};

// Diagnostic names only: header values and provider-specific names stay out.
export function lunaHeaderNames(headers: Record<string, string>): string {
  const fields = splitHeaders(headers);
  const names: string[] = [];
  if (fields.referer) names.push('referer');
  if (fields.userAgent) names.push('ua');
  if (fields.cookie) names.push('cookie');
  let other = false;
  for (const key of Object.keys(fields.extra)) {
    const logged = LOGGED_HEADER_NAMES[key];
    if (logged) names.push(logged);
    else other = true;
  }
  if (other) names.push('other');
  return names.join(',');
}

export function buildLoadParameters(
  uri: string,
  transport: LunaTransport,
  appId: string,
  windowId: string,
  headers: Record<string, string>,
  playReadyClientId = '',
): Record<string, unknown> {
  const fields = splitHeaders(headers);
  const httpHeader: Record<string, string> = {};
  if (fields.referer) httpHeader.referer = fields.referer;
  if (fields.userAgent) httpHeader.userAgent = fields.userAgent;
  if (fields.cookie) httpHeader.cookies = fields.cookie;
  const transmission: Record<string, unknown> = {};
  if (Object.keys(httpHeader).length) transmission.httpHeader = httpHeader;
  if (Object.keys(fields.extra).length) transmission.extraHttpHeader = fields.extra;
  const option: Record<string, unknown> = { appId, windowId };
  if (Object.keys(transmission).length) option.transmission = transmission;
  // The license request is the DRM client's own; it never carries these headers.
  if (playReadyClientId) option.drm = { type: 'playready', clientId: playReadyClientId };
  return {
    uri,
    type: 'media',
    payload: { mediaTransportType: transport, option },
  };
}

function responseCode(response: LunaResponse | undefined): number {
  return typeof response?.errorCode === 'number' ? response.errorCode : -1;
}

// UMS answers some successful commands (unload, pause, play) with
// returnValue false but errorCode 0 "No Error".
export function isBenignFailure(response: LunaResponse | undefined): boolean {
  if (!response) return false;
  if (typeof response.errorCode === 'number') return response.errorCode === 0;
  return response.errorText === 'No Error';
}

function call<T extends LunaResponse>(
  uri: string,
  method: string,
  parameters: Record<string, unknown>,
  onLateSuccess?: (response: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    // A call UMS never answers must not hold playback start forever.
    const timer = setTimeout(() => {
      timedOut = true;
      if (!onLateSuccess) request.cancel();
      reject(new LunaMediaError(`${method} timed out`, -1, true));
    }, CONFIG.PLAYER.LUNA_MEDIA_CALL_TIMEOUT_MS);
    const succeed = (response: T): void => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve(response);
        return;
      }
      onLateSuccess?.(response);
      request.cancel();
    };
    const request = lunaRequest<T>(uri, {
      method,
      parameters,
      onSuccess: succeed,
      onFailure: (response) => {
        if (isBenignFailure(response)) {
          succeed(response as T);
          return;
        }
        clearTimeout(timer);
        if (timedOut) request.cancel();
        else {
          reject(new LunaMediaError(`${method} failed`, responseCode(response), false,
            typeof response?.errorText === 'string' ? response.errorText : ''));
        }
      },
    });
  });
}

export function validWindowId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^_Window_Id_[0-9]+$/.test(value);
}

// The entry for our own element: a stale entry or another player's window
// would put the picture in the wrong place or nowhere.
export function findWindowId(value: unknown, appId: string, mediaId: string): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const candidate = typeof record.mediaId === 'string'
    ? record.mediaId
    : typeof record.connectionId === 'string' ? record.connectionId : '';
  if (record.appId === appId && candidate === mediaId && validWindowId(record.windowId)) {
    return record.windowId;
  }
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const found = findWindowId(record[key], appId, mediaId);
    if (found) return found;
  }
  return '';
}

export function foregroundAppInfo(): Promise<unknown> {
  return call(MEDIA, 'getForegroundAppInfo', {});
}

export async function loadMedia(parameters: Record<string, unknown>): Promise<string> {
  // A load that answers after its timeout made a pipeline nobody owns.
  const response = await call<LunaResponse & { mediaId?: unknown }>(MEDIA, 'load', parameters,
    late => {
      if (typeof late.mediaId === 'string' && late.mediaId) {
        mediaCommand('unload', late.mediaId).catch(() => {});
      }
    });
  if (typeof response.mediaId !== 'string' || !response.mediaId) {
    throw new LunaMediaError('load returned no mediaId', responseCode(response));
  }
  return response.mediaId;
}

export function subscribeMedia(
  mediaId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onFailure: (code: number) => void,
): LunaRequestHandle {
  return lunaRequest<LunaResponse>(MEDIA, {
    method: 'subscribe',
    parameters: { mediaId },
    subscribe: true,
    onSuccess: response => onEvent(response as unknown as Record<string, unknown>),
    onFailure: response => onFailure(responseCode(response)),
  });
}

export function mediaCommand(
  method: 'play' | 'pause' | 'unload',
  mediaId: string,
): Promise<LunaResponse> {
  return call(MEDIA, method, { mediaId });
}

export function setMediaVolume(mediaId: string, volume: number): Promise<LunaResponse> {
  return call(MEDIA, 'setVolume', { mediaId, volume });
}

// Audio only: a text selectTrack kills the pipeline.
export function selectAudioTrack(mediaId: string, index: number): Promise<LunaResponse> {
  return call(MEDIA, 'selectTrack', { mediaId, type: 'audio', index });
}

export function seekMedia(mediaId: string, positionMs: number): Promise<LunaResponse> {
  return call(MEDIA, 'seek', { mediaId, position: Math.max(0, Math.round(positionMs)) });
}

export function setDisplayWindow(mediaId: string, display: LunaDisplay): Promise<LunaResponse> {
  if (display === 'full') {
    return call(VIDEO_OUTPUT, 'setDisplayWindow', { context: mediaId, fullScreen: true });
  }
  return call(VIDEO_OUTPUT, 'setDisplayWindow', {
    context: mediaId,
    fullScreen: false,
    displayOutput: {
      x: Math.round(display.x),
      y: Math.round(display.y),
      width: Math.round(display.width),
      height: Math.round(display.height),
    },
  });
}
