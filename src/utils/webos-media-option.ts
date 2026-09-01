// webOS selects the native media transport from mediaTransportType encoded in
// the source type's mediaOption parameter.
export interface WebOSMediaOption {
  mediaTransportType: 'MPEG-DASH' | 'HLS' | 'MSIIS' | 'PLAYREADY';
  option?: {
    drm?: {
      type: 'playready';
      clientId: string;
    };
  };
}

export function mediaOptionSourceType(mime: string, option: WebOSMediaOption): string {
  return `${mime};mediaOption=${encodeURIComponent(JSON.stringify(option))}`;
}

export function parseMediaOption(sourceType: string): WebOSMediaOption | null {
  const marker = 'mediaOption=';
  const at = sourceType.indexOf(marker);
  if (at < 0) return null;
  try {
    return JSON.parse(decodeURIComponent(sourceType.slice(at + marker.length))) as WebOSMediaOption;
  } catch {
    return null;
  }
}
