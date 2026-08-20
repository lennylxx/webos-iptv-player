import type { FetchPrefixVerdict } from './fetch-helper';

// A stream URL's file extension, lowercased (empty if none).
export function extFromUrl(url: string): string {
  return (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
}

// Progressive-container MIME by file extension, for VOD played natively on webOS.
// An unknown or extension-less URL returns '', and the caller then omits the
// `type` attribute so the TV sniffs the container itself.
export function containerMime(url: string): string {
  switch (extFromUrl(url)) {
    case 'mp4': case 'm4v': return 'video/mp4';
    case 'mkv': return 'video/x-matroska';
    case 'avi': return 'video/x-msvideo';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    case 'ts': return 'video/mp2t';
    default: return '';
  }
}

// Identifies the route a stream URL belongs to, for the probed-MIME cache. A
// provider serves one container per route, so the first path segment is enough —
// except that the same route can serve a different container per requested format
// (Xtream `output=`, its native `output_format=` spelling), which lives in the
// query string. Keeping the format in the key stops a `ts` probe from deciding
// how an `m3u8` request is played.
export function streamRouteKey(url: string): string {
  try {
    const parsed = new URL(url);
    const route = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    const format = parsed.searchParams.get('output_format') ||
      parsed.searchParams.get('output') || '';
    return `${parsed.origin}/${route}${format ? `?output=${format}` : ''}`;
  } catch {
    return '';
  }
}

export function diagnosticStreamUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';

    const parts = parsed.pathname.split('/');
    const route = parts[1]?.toLowerCase();
    if (route === 'live' || route === 'movie' || route === 'series' || route === 'timeshift') {
      if (parts.length > 2) parts[2] = '***';
      if (parts.length > 3) parts[3] = '***';
      parsed.pathname = parts.join('/');
    }

    parsed.searchParams.forEach((_, key) => {
      if (!/^(?:start|end|duration|extension|stream)$/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    });
    return parsed.toString();
  } catch {
    return '(invalid URL)';
  }
}

export function streamUrlMime(url: string): string {
  if (/\.ts(?:[?#]|$)/i.test(url) || /[?&]extension=ts(?:[&#]|$)/i.test(url)) {
    return 'video/mp2t';
  }
  if (/\.flv(?:[?#]|$)/i.test(url) || /[?&]extension=flv(?:[&#]|$)/i.test(url)) {
    return 'video/x-flv';
  }
  if (/\.m3u8?(?:[?#]|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
  if (/\.mpd(?:[?#]|$)/i.test(url) ||
      /[?&](?:extension|output|output_format)=mpd(?:[&#]|$)/i.test(url)) {
    return 'application/dash+xml';
  }
  return '';
}

export function streamMime(contentType: string): string {
  const type = contentType.toLowerCase().split(';')[0].trim();
  if (type.includes('flv')) return 'video/x-flv';
  if (type.includes('mp2t')) return 'video/mp2t';
  if (type.includes('mpegurl') || type.includes('m3u8')) {
    return 'application/vnd.apple.mpegurl';
  }
  if (type.includes('dash+xml') || type.includes('dash.mpd')) {
    return 'application/dash+xml';
  }
  if (/^(?:video|audio)\//.test(type)) return type;
  return '';
}

// An XML prologue, comments and a doctype may precede the root element, and the
// root may carry a namespace prefix.
export function isMpdText(xml: string): boolean {
  let text = xml.replace(/^\uFEFF/, '').replace(/^\s+/, '');
  for (;;) {
    let end = -1;
    if (text.indexOf('<?') === 0) end = text.indexOf('?>') + 2;
    else if (text.indexOf('<!--') === 0) end = text.indexOf('-->') + 3;
    else if (text.indexOf('<!') === 0) end = text.indexOf('>') + 1;
    else break;
    if (end <= 0) return false;
    text = text.slice(end).replace(/^\s+/, '');
  }
  return /^<(?:[A-Za-z0-9_.-]+:)?MPD[\s/>]/.test(text);
}

export function mpdOpeningVerdict(
  bytes: Uint8Array,
  complete: boolean,
): FetchPrefixVerdict {
  let text = new TextDecoder().decode(bytes)
    .replace(/^\uFEFF/, '')
    .replace(/^\s+/, '');
  if (isMpdText(text)) return 'match';
  for (;;) {
    if (!text) return complete ? 'mismatch' : 'undecided';
    let end = -1;
    let closeLength = 0;
    if (text.indexOf('<?') === 0) {
      end = text.indexOf('?>');
      closeLength = 2;
    } else if (text.indexOf('<!--') === 0) {
      end = text.indexOf('-->');
      closeLength = 3;
    } else if (text.indexOf('<!') === 0) {
      end = text.indexOf('>');
      closeLength = 1;
    } else {
      break;
    }
    if (end < 0) return complete ? 'mismatch' : 'undecided';
    text = text.slice(end + closeLength).replace(/^\s+/, '');
    if (isMpdText(text)) return 'match';
  }
  const root = /^<([A-Za-z0-9_.:-]+)([\s/>])/.exec(text);
  if (root) {
    return /^(?:[A-Za-z0-9_.-]+:)?MPD$/.test(root[1]) ? 'match' : 'mismatch';
  }
  return !complete && text.indexOf('<') === 0 ? 'undecided' : 'mismatch';
}

export function sniffStreamContentType(contentType: string, prefix: Uint8Array): string {
  const type = contentType.toLowerCase().split(';')[0].trim();
  const genericXml = type === 'application/xml' || type === 'text/xml';
  if (type !== 'application/octet-stream' && !genericXml) return type;

  const packetSizes = [188, 192, 204];
  for (const packetSize of packetSizes) {
    for (let offset = 0; offset + packetSize * 2 < prefix.length; offset++) {
      if (prefix[offset] === 0x47 &&
          prefix[offset + packetSize] === 0x47 &&
          prefix[offset + packetSize * 2] === 0x47) {
        return 'video/mp2t';
      }
    }
  }

  const text = new TextDecoder().decode(prefix.slice(0, 7));
  if (text === '#EXTM3U') return 'application/vnd.apple.mpegurl';
  return isMpdText(new TextDecoder().decode(prefix.slice(0, 512)))
    ? 'application/dash+xml'
    : type;
}
