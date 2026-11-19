// A large live playlist and its guide, for specs that walk the Live and
// Guide screens.

const HALF_HOUR = 30 * 60 * 1000;

export function channelPlaylist(count: number, options: {
  name?: (i: number) => string; group?: (i: number) => string; catchup?: boolean;
} = {}): string {
  const name = options.name ?? ((i: number) => `Ch ${i}`);
  const group = options.group ?? ((i: number) => (i % 3 ? 'Alpha' : 'Bravo'));
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= count; i++) {
    const replay = options.catchup
      ? ` catchup="default" catchup-source="http://host/catchup/${i}/{utc}.m3u8" catchup-days="7"`
      : '';
    lines.push(`#EXTINF:-1 tvg-id="c${i}" group-title="${group(i)}"${replay},${name(i)}`);
    lines.push(`http://host/${i}.m3u8`);
  }
  return lines.join('\n');
}

function xmltvTime(ms: number): string {
  return `${new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;
}

// Twelve half-hour programmes a channel from `start`, by default four before
// the one airing now.
export function guide(channels: number, options: { start?: number; title?: (c: number, i: number) => string } = {}): string {
  const start = options.start ?? Math.floor(Date.now() / HALF_HOUR) * HALF_HOUR - 4 * HALF_HOUR;
  const title = options.title ?? ((c: number, i: number) => `Show ${c}-${i}`);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (let c = 1; c <= channels; c++) out.push(`<channel id="c${c}"><display-name>Ch ${c}</display-name></channel>`);
  for (let c = 1; c <= channels; c++) {
    for (let i = 0; i < 12; i++) {
      out.push(`<programme start="${xmltvTime(start + i * HALF_HOUR)}" stop="${xmltvTime(start + (i + 1) * HALF_HOUR)}" `
        + `channel="c${c}"><title>${title(c, i)}</title></programme>`);
    }
  }
  out.push('</tv>');
  return out.join('\n');
}
