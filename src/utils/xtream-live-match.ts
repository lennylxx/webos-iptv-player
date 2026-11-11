import { stableStreamUrl } from './channel';
import {
  normalizeXtreamBaseUrl,
  xtreamCredentialsFromLiveUrl,
} from './xtream-url';

export interface XtreamLiveReference {
  streamId: string;
  directSource: string;
  /** Set only for a stream the account archives, so catch-up can be stamped. */
  archive?: boolean;
  archiveDurationDays?: number;
}

export interface XtreamLiveMatcher {
  resolveStreamId: (url: string) => string;
  streamLocationPrefilter: (location: string) => boolean;
}

type DirectSourceStreamIdResolver =
  (url: string) => string | null | undefined;

export function createXtreamLiveMatcher(
  references: readonly XtreamLiveReference[],
  baseUrl = '',
): XtreamLiveMatcher {
  const resolveDirectSourceStreamId =
    createDirectSourceStreamIdResolver(references);
  return {
    resolveStreamId: createLiveStreamIdResolver(
      references,
      baseUrl,
      resolveDirectSourceStreamId,
    ),
    streamLocationPrefilter: createStreamLocationPrefilter(
      baseUrl,
      resolveDirectSourceStreamId,
    ),
  };
}

export function createXtreamLiveStreamIdResolver(
  references: readonly XtreamLiveReference[],
  baseUrl = '',
): (url: string) => string {
  return createLiveStreamIdResolver(
    references,
    baseUrl,
    createDirectSourceStreamIdResolver(references),
  );
}

export function createXtreamStreamLocationPrefilter(
  references: readonly XtreamLiveReference[],
  baseUrl = '',
): (location: string) => boolean {
  return createStreamLocationPrefilter(
    baseUrl,
    createDirectSourceStreamIdResolver(references),
  );
}

function createLiveStreamIdResolver(
  references: readonly XtreamLiveReference[],
  baseUrl: string,
  resolveDirectSourceStreamId: DirectSourceStreamIdResolver,
): (url: string) => string {
  const liveIds = new Set<string>();
  for (const reference of references) liveIds.add(reference.streamId);

  return url => {
    const direct = resolveDirectSourceStreamId(url);
    if (direct !== undefined) return direct || '';
    if (isExplicitXtreamNonLiveUrl(url)) return '';
    const inferred = xtreamCredentialsFromLiveUrl(url)
      || (baseUrl ? xtreamCredentialsFromLiveUrl(url, baseUrl) : null);
    if (inferred && liveIds.has(inferred.streamId)) return inferred.streamId;
    if (url.indexOf('?') >= 0) {
      const queryId = explicitQueryStreamId(url);
      if (queryId && liveIds.has(queryId)) return queryId;
    }
    return '';
  };
}

function createStreamLocationPrefilter(
  baseUrl: string,
  resolveDirectSourceStreamId: DirectSourceStreamIdResolver,
): (location: string) => boolean {
  const basePathPrefix = xtreamBasePathPrefix(baseUrl);
  const basePathHasKind = /\/(?:movie|series|vod)\//.test(`${basePathPrefix}/`);
  return location => {
    if (!isCanonicalXtreamNonLiveUrl(location, basePathPrefix, basePathHasKind)) {
      return true;
    }
    return typeof resolveDirectSourceStreamId(location) === 'string';
  };
}

function createDirectSourceStreamIdResolver(
  references: readonly XtreamLiveReference[],
): DirectSourceStreamIdResolver {
  const exactSources = new Map<string, string | null>();
  const stableSources = new Map<string, string | null>();
  for (const reference of references) {
    if (!isHttpUrl(reference.directSource)) continue;
    addDirectSource(exactSources, reference.directSource, reference.streamId);
    const stable = stableStreamUrl(reference.directSource);
    addDirectSource(stableSources, stable, reference.streamId);
  }

  if (!exactSources.size) return () => undefined;
  return url => {
    const exact = exactSources.get(url);
    if (exact !== undefined) return exact;
    if (url.indexOf('?') >= 0 && stableSources.size) {
      const stable = stableSources.get(stableStreamUrl(url));
      if (stable !== undefined) return stable;
    }
    return undefined;
  };
}

function addDirectSource(
  sources: Map<string, string | null>,
  url: string,
  streamId: string,
): void {
  const existing = sources.get(url);
  sources.set(
    url,
    existing === undefined || existing === streamId ? streamId : null,
  );
}

function explicitQueryStreamId(value: string): string {
  try {
    const url = new URL(value);
    return url.searchParams.get('stream_id')
      || url.searchParams.get('stream')
      || '';
  } catch {
    return '';
  }
}

function isExplicitXtreamNonLiveUrl(value: string): boolean {
  try {
    const parts = new URL(value).pathname.split('/').filter(Boolean);
    if (parts.length < 4) return false;
    const kind = parts[parts.length - 4].toLowerCase();
    return kind === 'movie' || kind === 'series' || kind === 'vod';
  } catch {
    return false;
  }
}

function xtreamBasePathPrefix(baseUrl: string): string {
  if (!baseUrl) return '';
  try {
    const base = new URL(normalizeXtreamBaseUrl(baseUrl));
    const path = base.pathname.replace(/\/+$/, '');
    return path ? `${base.origin}${path}` : '';
  } catch {
    return '';
  }
}

// Avoid allocating a URL object for every rejected entry on large playlists.
function isCanonicalXtreamNonLiveUrl(
  value: string,
  basePathPrefix: string,
  basePathHasKind: boolean,
): boolean {
  let authorityStart: number;
  if (value.startsWith('http://')) authorityStart = 7;
  else if (value.startsWith('https://')) authorityStart = 8;
  else return false;
  // A host named like a kind segment holds the first one, so the entry is kept.
  if (startsWithKind(value, authorityStart - 1)) return false;
  let pathStart = value.indexOf('/', authorityStart);
  if (pathStart < 0) return false;
  if (basePathPrefix && value.startsWith(basePathPrefix)
      && value.charCodeAt(basePathPrefix.length) === 47) {
    // A kind segment inside the base path comes first, so the entry is kept.
    if (basePathHasKind) return false;
    pathStart = basePathPrefix.length;
  }
  if (!startsWithKind(value, pathStart)) return false;
  let pathEnd = value.indexOf('?', pathStart);
  const hash = value.indexOf('#', pathStart);
  if (pathEnd < 0 || (hash >= 0 && hash < pathEnd)) pathEnd = hash;
  if (pathEnd < 0) pathEnd = value.length;

  const kindEnd = value.indexOf('/', pathStart + 1);
  if (kindEnd < 0 || kindEnd >= pathEnd) return false;
  const userEnd = value.indexOf('/', kindEnd + 1);
  const passwordEnd = value.indexOf('/', userEnd + 1);
  if (userEnd <= kindEnd + 1 || passwordEnd <= userEnd + 1
      || passwordEnd >= pathEnd) return false;
  const extraSlash = value.indexOf('/', passwordEnd + 1);
  if (extraSlash >= 0 && extraSlash < pathEnd) return false;
  const dot = value.lastIndexOf('.', pathEnd - 1);
  return dot > passwordEnd + 1 && dot < pathEnd - 1;
}

function startsWithKind(value: string, position: number): boolean {
  return value.startsWith('/movie/', position)
    || value.startsWith('/series/', position)
    || value.startsWith('/vod/', position);
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
