// A stream URL's file extension, lowercased (empty if none).
export function extFromUrl(url: string): string {
  return (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
}

// Progressive-container MIME by file extension, for VOD played natively on webOS.
export function containerMime(url: string): string {
  switch (extFromUrl(url)) {
    case 'mp4': case 'm4v': return 'video/mp4';
    case 'mkv': return 'video/x-matroska';
    case 'avi': return 'video/x-msvideo';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    case 'ts': return 'video/mp2t';
    default: return 'video/mp4';
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
  return '';
}

export function streamMime(contentType: string): string {
  const type = contentType.toLowerCase().split(';')[0].trim();
  if (type.includes('flv')) return 'video/x-flv';
  if (type.includes('mp2t')) return 'video/mp2t';
  if (type.includes('mpegurl') || type.includes('m3u8')) {
    return 'application/vnd.apple.mpegurl';
  }
  if (/^(?:video|audio)\//.test(type)) return type;
  return '';
}

export function sniffStreamContentType(contentType: string, prefix: Uint8Array): string {
  const type = contentType.toLowerCase().split(';')[0].trim();
  if (type !== 'application/octet-stream') return type;

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
  return text === '#EXTM3U' ? 'application/vnd.apple.mpegurl' : type;
}
