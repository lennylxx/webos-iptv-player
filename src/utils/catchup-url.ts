// Catch-up URL building for M3U channels, following the catch-up modes and
// format specifiers of Kodi's pvr.iptvsimple, which most providers target:
// https://github.com/kodi-pvr/pvr.iptvsimple#catchup-format-specifiers
// Pure and dependency-free; the parser derives a channel's template once and
// the player fills it for each programme.

const SHIFT_QUERY = 'utc={utc}&lutc={lutc}';

/** Lower-cased mode with Kodi's aliases folded (`fs` is `flussonic`). */
export function normalizeCatchupMode(mode: string): string {
  const value = mode.trim().toLowerCase();
  return value === 'fs' ? 'flussonic' : value;
}

/** `url` plus a query fragment, joined with `?` or `&` as the URL needs. */
export function appendQuery(url: string, query: string): string {
  const fragment = query.replace(/^[?&]+/, '');
  if (!fragment) return url;
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const tail = hash >= 0 ? url.slice(hash) : '';
  const joiner = base.indexOf('?') >= 0 ? (/[?&]$/.test(base) ? '' : '&') : '?';
  return base + joiner + fragment + tail;
}

/**
 * Flussonic's fixed-window archive URL for a live Flussonic URL:
 * `.../<name>.m3u8?q` -> `.../<name>-{utc}-{duration}.m3u8?q` and
 * `.../mpegts?q` -> `.../archive-{utc}-{duration}.ts?q`. The fixed window
 * (instead of Kodi's sliding `timeshift_rel`) gives a finite, seekable
 * playlist that spans exactly the programme. Empty when the URL has no
 * Flussonic shape.
 */
export function flussonicCatchupSource(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^?#]*\/)([^/?#]+)(\?[^#]*)?$/i.exec(url);
  if (!match) return '';
  const [, dir, file, query = ''] = match;
  const hls = /^(.+)\.m3u8$/i.exec(file);
  if (hls) return `${dir}${hls[1]}-{utc}-{duration}.m3u8${query}`;
  if (/^mpegts$/i.test(file)) return `${dir}archive-{utc}-{duration}.ts${query}`;
  return '';
}

/**
 * The catch-up template for a channel's mode, or '' when the mode cannot
 * produce one from what the playlist declared.
 * - `default`: the declared source is the full URL.
 * - `append`: the declared source is appended to the stream URL.
 * - `shift`: SIPTV's `utc`/`lutc` query appended to the stream URL.
 * - `flussonic`: derived from the stream URL.
 */
export function catchupTemplate(mode: string, url: string, source: string): string {
  switch (mode) {
    case 'append':
      return source ? appendQuery(url, source) : '';
    case 'shift':
      return source || appendQuery(url, SHIFT_QUERY);
    case 'flussonic':
      return source || flussonicCatchupSource(url);
    default:
      return source;
  }
}

export interface CatchupTimes {
  /** Programme start, epoch seconds. */
  start: number;
  /** Programme end, epoch seconds. */
  end: number;
  /** Request time, epoch seconds. */
  now: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

function localParts(epochSeconds: number): Record<string, string> {
  const date = new Date(epochSeconds * 1000);
  return {
    Y: String(date.getFullYear()),
    m: pad2(date.getMonth() + 1),
    d: pad2(date.getDate()),
    H: pad2(date.getHours()),
    M: pad2(date.getMinutes()),
    S: pad2(date.getSeconds()),
  };
}

function formatLocal(epochSeconds: number, format: string): string {
  const parts = localParts(epochSeconds);
  return format.replace(/[YmdHMS]/g, letter => parts[letter]);
}

function positiveDivider(raw: string): number {
  const divider = parseInt(raw, 10);
  return divider >= 1 ? divider : 1;
}

/**
 * Fills every occurrence of Kodi's format specifiers. Date parts (`{Y}` ...
 * and the `{utc:YmdHMS}` format variants) use the device's local time, as
 * Kodi does; epoch specifiers are timezone-independent.
 */
export function fillCatchupTemplate(template: string, times: CatchupTimes): string {
  const { start, end, now } = times;
  const duration = Math.max(0, end - start);
  const offset = Math.max(0, now - start);
  const epochs: Record<string, number> = {
    '{utc': start,
    '${start': start,
    '{utcend': end,
    '${end': end,
    '{lutc': now,
    '${now': now,
    '${timestamp': now,
  };
  return template
    .replace(/(\$?\{(?:utc|start|utcend|end|lutc|now|timestamp)):([^}]*)\}/g, (whole, key: string, format: string) =>
      key in epochs ? formatLocal(epochs[key], format) : whole)
    .replace(/(\$?\{(?:utc|start|utcend|end|lutc|now|timestamp))\}/g, (whole, key: string) =>
      key in epochs ? String(epochs[key]) : whole)
    .replace(/\$?\{duration\}/g, String(duration))
    .replace(/\{duration:(\d+)\}/g, (_, divider: string) =>
      String(Math.floor(duration / positiveDivider(divider))))
    .replace(/\$\{offset\}/g, String(offset))
    .replace(/\{offset:(\d+)\}/g, (_, divider: string) =>
      String(Math.floor(offset / positiveDivider(divider))))
    .replace(/\{([YmdHMS])\}/g, (_, letter: string) => localParts(start)[letter]);
}

/** True when the channel's shift template was derived, not declared by the playlist. */
export function isDerivedShiftSource(channel: { catchup: string; catchupSource: string; url: string }): boolean {
  return channel.catchup === 'shift' && channel.catchupSource === catchupTemplate('shift', channel.url, '');
}
