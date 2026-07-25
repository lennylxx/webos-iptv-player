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
