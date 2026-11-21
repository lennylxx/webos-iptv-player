import type { EpgSource } from '../types';

// Which guide channel a playlist channel shows. The page's EpgService and the
// app worker's Search index both match through this, so the programmes the
// worker indexes are the ones the page shows for the same channel.

export interface GuideMatchChannel {
  id?: string;
  name: string;
  sourceName?: string;
  playlistIds: string[];
}

export interface GuideMatchLookup {
  /** The guide sources in priority order. */
  sources(): EpgSource[];
  /** Whether a loaded guide lists the channel under `key`. */
  hasChannel(key: string): boolean;
  /** How many programmes the guide channel under `key` holds; 0 when none. */
  programmeCount(key: string): number;
  /** The guide ids named `name` (normalized), or undefined while the source has no loaded guide. */
  idsByName(url: string, name: string): string[] | undefined;
}

export function guideChannelKey(url: string, id: string): string {
  return `${encodeURIComponent(url)}::${id}`;
}

export function splitEpgChannelKey(key: string): { url: string; id: string } | null {
  const separator = key.indexOf('::');
  if (separator < 0) return null;
  try {
    return {
      url: decodeURIComponent(key.slice(0, separator)),
      id: key.slice(separator + 2),
    };
  } catch {
    return null;
  }
}

export function normalizeGuideName(name: string): string {
  return name.toLowerCase();
}

export function indexGuideChannelName(index: Map<string, string[]>, name: string, id: string): void {
  const normalized = normalizeGuideName(name);
  const ids = index.get(normalized);
  if (!ids) index.set(normalized, [id]);
  else if (ids.indexOf(id) < 0) ids.push(id);
}

export function sourceAppliesToChannel(
  source: EpgSource,
  channel: { playlistIds: string[] },
): boolean {
  return (source.kind === 'manual' && source.playlistIds.length === 0)
    || source.playlistIds.some((id) => channel.playlistIds.indexOf(id) >= 0);
}

/** The guide channel key for `channel` before any time offset, or null. */
export function matchGuideChannel(
  channel: GuideMatchChannel,
  overrideId: string | undefined,
  lookup: GuideMatchLookup,
): string | null {
  const sources = lookup.sources();
  if (overrideId && lookup.hasChannel(overrideId)) {
    const mapped = splitEpgChannelKey(overrideId);
    const source = mapped && sources.find(item => item.url === mapped.url);
    if (source && sourceAppliesToChannel(source, channel)) return overrideId;
  }
  const candidates = sources.filter(source => sourceAppliesToChannel(source, channel));

  for (const source of candidates) {
    if (!channel.id) continue;
    const key = guideChannelKey(source.url, channel.id);
    if (lookup.programmeCount(key)) return key;
  }

  const name = normalizeGuideName(channel.name);
  const sourceName = normalizeGuideName(channel.sourceName ?? '');
  if (!name && !sourceName) return null;
  for (const source of candidates) {
    const index = lookup.idsByName(source.url, name);
    if (index === undefined) continue;
    const ids = sourceName && sourceName !== name
      ? index.concat(lookup.idsByName(source.url, sourceName) ?? [])
      : index;
    for (const id of ids) {
      const key = guideChannelKey(source.url, id);
      if (lookup.programmeCount(key)) return key;
    }
  }
  return null;
}
