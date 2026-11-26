const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_URL = /(?:[?&#]v=|youtu\.be\/|\/(?:embed|v|shorts|live)\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

// A panel's trailer field is a bare video ID, a `v=ID` fragment, or a full
// YouTube URL; anything else is no trailer.
export function youtubeVideoId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (VIDEO_ID.test(text)) return text;
  if (!/youtu|^v=/i.test(text)) return '';
  const match = VIDEO_URL.exec(text.charAt(0) === 'v' ? '?' + text : text);
  return match ? match[1] : '';
}

export function firstYoutubeVideoId(...values: unknown[]): string {
  for (const value of values) {
    const id = youtubeVideoId(value);
    if (id) return id;
  }
  return '';
}
