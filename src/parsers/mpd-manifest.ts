import type { DashSubtitleSegment,
DashSubtitleSource,
ManifestAudio, ManifestClosedCaption, ManifestSubtitle } from '../types';
import { hdrFromTransfer, type StreamVariant } from '../utils/stream-info';

export interface MpdManifest {
  audio: ManifestAudio[];
  subtitles: ManifestSubtitle[];
  closedCaptions: ManifestClosedCaption[];
  variants: StreamVariant[];
  isLive: boolean;
  hasContentProtection: boolean;
  drm: MpdDrmInfo | null;
}

export interface MpdDrmInfo {
  type: 'playready' | 'unsupported';
  scheme: string;
}

const ROLE_SCHEME = 'urn:mpeg:dash:role:2011';
const CICP_TRANSFER = 'urn:mpeg:mpegb:cicp:transfercharacteristics';
const CEA608_SCHEME = 'urn:scte:dash:cc:cea-608:2015';
const CEA708_SCHEME = 'urn:scte:dash:cc:cea-708:2015';
const WEBVTT_MIMES = ['text/vtt', 'application/x-subtitle-vtt'];
const SUBTITLE_MIMES = WEBVTT_MIMES.concat(['application/ttml+xml']);
const MP4_PROTECTION_SCHEME = 'urn:mpeg:dash:mp4protection:2011';
export const PLAYREADY_SCHEME = 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95';
const DV_CODECS = ['dvh1', 'dvhe', 'dvav', 'dva1', 'dav1', 'dvc1'];

const EMPTY: MpdManifest = {
  audio: [], subtitles: [], closedCaptions: [], variants: [],
  isLive: false, hasContentProtection: false, drm: null,
};

function drmProtection(root: Element): MpdDrmInfo | null {
  const schemes = descendants(root, 'ContentProtection').map(element =>
    (element.getAttribute('schemeIdUri') || '').toLowerCase()).filter(scheme =>
    scheme && scheme !== MP4_PROTECTION_SCHEME);
  if (schemes.indexOf(PLAYREADY_SCHEME) >= 0) {
    return { type: 'playready', scheme: PLAYREADY_SCHEME };
  }
  const scheme = schemes[0];
  return scheme ? { type: 'unsupported', scheme } : null;
}

// localName lookup — an MPD may be served with a default namespace or a prefix,
// and getElementsByTagName() matches the qualified name.
function children(el: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === 1 && (node as Element).localName === name) out.push(node as Element);
  }
  return out;
}

function descendants(el: Element | Document, name: string): Element[] {
  return Array.prototype.slice.call(el.getElementsByTagNameNS('*', name)) as Element[];
}

// AdaptationSet-level attributes are inherited by their Representations, so read
// the set first and let the first Representation override it.
function attr(set: Element, rep: Element | null, name: string): string {
  return rep?.getAttribute(name) || set.getAttribute(name) || '';
}

function descriptorValue(set: Element, names: readonly string[], scheme: string): string {
  for (const name of names) {
    for (const el of children(set, name)) {
      if ((el.getAttribute('schemeIdUri') || '').toLowerCase() === scheme) {
        return el.getAttribute('value') || '';
      }
    }
  }
  return '';
}

function hasRole(set: Element, value: string): boolean {
  return children(set, 'Role').some(r =>
    (r.getAttribute('schemeIdUri') || ROLE_SCHEME) === ROLE_SCHEME &&
    r.getAttribute('value') === value);
}

function label(set: Element): string {
  const el = children(set, 'Label')[0];
  return (el?.textContent || '').trim() || set.getAttribute('label') || '';
}

function firstBaseUrl(el: Element): string {
  return (children(el, 'BaseURL')[0]?.textContent || '').trim();
}

function resolveUrl(value: string, base: string): string {
  if (!value) return base;
  try {
    return new URL(value, base || undefined).href;
  } catch {
    return value;
  }
}

function resolvedBaseUrl(
  manifestUrl: string,
  root: Element,
  period: Element,
  set: Element,
  rep: Element | null,
): { url: string; explicit: boolean } {
  let url = manifestUrl;
  let explicit = false;
  for (const scope of [root, period, set, rep]) {
    if (!scope) continue;
    const value = firstBaseUrl(scope);
    if (!value) continue;
    url = resolveUrl(value, url);
    explicit = true;
  }
  return { url, explicit };
}

function isoDurationSeconds(value: string): number {
  const match = value.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return 0;
  return (parseFloat(match[1] || '0') * 86400)
    + (parseFloat(match[2] || '0') * 3600)
    + (parseFloat(match[3] || '0') * 60)
    + parseFloat(match[4] || '0');
}

function templateAttr(scopes: Element[], name: string): string {
  let value = '';
  for (const scope of scopes) {
    const template = children(scope, 'SegmentTemplate')[0];
    value = template?.getAttribute(name) || value;
  }
  return value;
}

function templateTimeline(scopes: Element[]): Element | null {
  let out: Element | null = null;
  for (const scope of scopes) {
    const template = children(scope, 'SegmentTemplate')[0];
    const timeline = template && children(template, 'SegmentTimeline')[0];
    if (timeline) out = timeline;
  }
  return out;
}

function segmentListElement(scopes: Element[]): Element | null {
  let out: Element | null = null;
  for (const scope of scopes) {
    const list = children(scope, 'SegmentList')[0];
    if (list) out = list;
  }
  return out;
}

function segmentListAttr(scopes: Element[], name: string): string {
  let value = '';
  for (const scope of scopes) {
    const list = children(scope, 'SegmentList')[0];
    value = list?.getAttribute(name) || value;
  }
  return value;
}

function segmentListTimeline(scopes: Element[]): Element | null {
  let out: Element | null = null;
  for (const scope of scopes) {
    const list = children(scope, 'SegmentList')[0];
    const timeline = list && children(list, 'SegmentTimeline')[0];
    if (timeline) out = timeline;
  }
  return out;
}

function fillTemplate(
  template: string,
  repId: string,
  bandwidth: string,
  number: number,
  time: number,
): string {
  const escapedDollar = '\u0000';
  const values: Record<string, string> = {
    RepresentationID: repId,
    Bandwidth: bandwidth,
    Number: String(number),
    Time: String(time),
  };
  return template
    .replace(/\$\$/g, escapedDollar)
    .replace(
      /\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
      (_match, identifier: string, width: string | undefined) => {
        const raw = values[identifier];
        const size = width ? parseInt(width, 10) : 0;
        if (!size || raw.length >= size) return raw;
        return new Array(size - raw.length + 1).join('0') + raw;
      },
    )
    .replace(/\u0000/g, '$');
}

function timelineSegments(
  timeline: Element,
  media: string,
  baseUrl: string,
  repId: string,
  bandwidth: string,
  timescale: number,
  startNumber: number,
  periodStart: number,
  presentationTimeOffset: number,
  presentationTime: number | undefined,
  expansionEnd: number | null,
): DashSubtitleSegment[] {
  const entries = children(timeline, 'S');
  const out: DashSubtitleSegment[] = [];
  let time = 0;
  let number = startNumber;
  for (let i = 0; i < entries.length && out.length < 200; i++) {
    const entry = entries[i];
    const explicit = entry.getAttribute('t');
    if (explicit !== null) time = parseInt(explicit, 10) || 0;
    const duration = parseInt(entry.getAttribute('d') || '0', 10) || 0;
    if (!duration) continue;
    let repeat = parseInt(entry.getAttribute('r') || '0', 10) || 0;
    if (repeat < 0) {
      const nextTime = entries[i + 1]?.getAttribute('t');
      repeat = nextTime !== null && nextTime !== undefined
        ? Math.max(0, Math.ceil(((parseInt(nextTime, 10) || time) - time) / duration) - 1)
        : expansionEnd == null
          ? 0
          : Math.max(0, Math.ceil((expansionEnd - time) / duration) - 1);
    }
    const target = presentationTime === undefined
      ? null
      : presentationTimeOffset
        + Math.max(0, presentationTime - periodStart - 4) * timescale;
    let skip = target == null ? 0 : Math.floor((target - time) / duration);
    skip = Math.max(0, Math.min(repeat, skip));
    time += skip * duration;
    number += skip;
    for (let r = skip; r <= repeat && out.length < 200; r++) {
      out.push({
        url: resolveUrl(fillTemplate(media, repId, bandwidth, number, time), baseUrl),
        start: periodStart + (time - presentationTimeOffset) / timescale,
        duration: duration / timescale,
      });
      time += duration;
      number++;
    }
  }
  return out;
}

function durationSegments(
  root: Element,
  duration: number,
  media: string,
  baseUrl: string,
  repId: string,
  bandwidth: string,
  timescale: number,
  startNumber: number,
  periodStart: number,
  periodDuration: number,
  presentationTimeOffset: number,
  presentationTime: number | undefined,
): DashSubtitleSegment[] {
  if (!duration) return [];
  const seconds = duration / timescale;
  const dynamic = root.getAttribute('type') === 'dynamic';
  let first = 0;
  let count = 0;
  if (dynamic) {
    const availability = Date.parse(root.getAttribute('availabilityStartTime') || '');
    if (!Number.isFinite(availability)) return [];
    const now = Math.max(0, (Date.now() - availability) / 1000);
    const depth = isoDurationSeconds(root.getAttribute('timeShiftBufferDepth') || '') || 30;
    first = Math.max(0, Math.floor((now - depth - periodStart) / seconds));
    count = Math.min(200, Math.ceil(depth / seconds) + 2);
  } else {
    const total = periodDuration
      || Math.max(0, isoDurationSeconds(
        root.getAttribute('mediaPresentationDuration') || '',
      ) - periodStart);
    first = presentationTime === undefined
      ? 0
      : Math.max(0, Math.floor((presentationTime - periodStart - 4) / seconds));
    count = Math.min(200, Math.max(0, Math.ceil(total / seconds) - first));
  }
  const out: DashSubtitleSegment[] = [];
  for (let i = first; i < first + count; i++) {
    out.push({
      url: resolveUrl(
        fillTemplate(
          media,
          repId,
          bandwidth,
          startNumber + i,
          presentationTimeOffset + i * duration,
        ),
        baseUrl,
      ),
      start: periodStart + i * seconds,
      duration: seconds,
    });
  }
  return out;
}

function segmentListSegments(
  scopes: Element[],
  baseUrl: string,
  periodStart: number,
): DashSubtitleSegment[] {
  const list = segmentListElement(scopes);
  if (!list) return [];
  const urls = children(list, 'SegmentURL');
  if (!urls.length) return [];
  const timescale = parseInt(segmentListAttr(scopes, 'timescale') || '1', 10) || 1;
  const presentationTimeOffset = parseInt(
    segmentListAttr(scopes, 'presentationTimeOffset') || '0',
    10,
  ) || 0;
  const duration = parseInt(segmentListAttr(scopes, 'duration') || '0', 10) || 0;
  const timeline = segmentListTimeline(scopes);
  const timings: Array<{ start: number; duration: number }> = [];
  if (timeline) {
    let time = 0;
    for (const entry of children(timeline, 'S')) {
      const explicit = entry.getAttribute('t');
      if (explicit !== null) time = parseInt(explicit, 10) || 0;
      const d = parseInt(entry.getAttribute('d') || '0', 10) || 0;
      if (!d) continue;
      const rawRepeat = parseInt(entry.getAttribute('r') || '0', 10) || 0;
      const repeat = rawRepeat < 0
        ? Math.max(0, urls.length - timings.length - 1)
        : rawRepeat;
      for (let i = 0; i <= repeat && timings.length < urls.length; i++) {
        timings.push({
          start: periodStart + (time - presentationTimeOffset) / timescale,
          duration: d / timescale,
        });
        time += d;
      }
    }
  }
  return urls.map((segment, index) => {
    const timing = timings[index];
    const media = segment.getAttribute('media') || '';
    const range = segment.getAttribute('mediaRange') || '';
    return {
      url: media ? resolveUrl(media, baseUrl) : '',
      start: timing?.start
        ?? periodStart + (index * duration - presentationTimeOffset) / timescale,
      duration: timing?.duration ?? duration / timescale,
      ...(range ? { range } : {}),
    };
  }).filter(segment => !!segment.url);
}

function dashSubtitleSource(
  root: Element,
  period: Element,
  set: Element,
  rep: Element | null,
  manifestUrl: string,
  presentationTime: number | undefined,
): DashSubtitleSource {
  const mime = attr(set, rep, 'mimeType').toLowerCase();
  const kind = WEBVTT_MIMES.indexOf(mime) >= 0 ? 'webvtt' : 'native';
  if (kind === 'native') return { kind };

  const base = resolvedBaseUrl(manifestUrl, root, period, set, rep);
  const scopes = [period, set].concat(rep ? [rep] : []);
  const periodStart = isoDurationSeconds(period.getAttribute('start') || '');
  const periodDuration = isoDurationSeconds(period.getAttribute('duration') || '');
  const listed = segmentListSegments(scopes, base.url, periodStart);
  if (listed.length) return { kind, segments: listed };
  const media = templateAttr(scopes, 'media');
  if (media) {
    const timescale = parseInt(templateAttr(scopes, 'timescale') || '1', 10) || 1;
    const startNumber = parseInt(templateAttr(scopes, 'startNumber') || '1', 10) || 1;
    const presentationTimeOffset = parseInt(
      templateAttr(scopes, 'presentationTimeOffset') || '0',
      10,
    ) || 0;
    const repId = rep?.getAttribute('id') || '';
    const bandwidth = rep?.getAttribute('bandwidth') || '';
    const dynamic = root.getAttribute('type') === 'dynamic';
    const presentationDuration = periodDuration || Math.max(
      0,
      isoDurationSeconds(root.getAttribute('mediaPresentationDuration') || '')
        - periodStart,
    );
    const presentationEnd = dynamic
      ? (() => {
          const availability = Date.parse(root.getAttribute('availabilityStartTime') || '');
          return Number.isFinite(availability)
            ? presentationTimeOffset
              + Math.max(0, (Date.now() - availability) / 1000 - periodStart + 10)
              * timescale
            : null;
        })()
      : presentationDuration
        ? presentationTimeOffset + presentationDuration * timescale
        : null;
    const timelineElement = templateTimeline(scopes);
    const timeline = timelineElement ? timelineSegments(
      timelineElement,
      media,
      base.url,
      repId,
      bandwidth,
      timescale,
      startNumber,
      periodStart,
      presentationTimeOffset,
      presentationTime,
      presentationEnd,
    ) : [];
    const segments = timeline.length ? timeline : durationSegments(
      root,
      parseInt(templateAttr(scopes, 'duration') || '0', 10) || 0,
      media,
      base.url,
      repId,
      bandwidth,
      timescale,
      startNumber,
      periodStart,
      periodDuration,
      presentationTimeOffset,
      presentationTime,
    );
    return { kind, segments };
  }
  return { kind, url: base.explicit ? base.url : undefined };
}

// "30000/1001" → 29.97; "25" → 25; absent/zero denominator → 0.
function frameRate(raw: string): number {
  if (!raw) return 0;
  const [num, den] = raw.split('/');
  const n = parseFloat(num);
  if (!isFinite(n)) return 0;
  if (den === undefined) return n;
  const d = parseFloat(den);
  return d > 0 ? n / d : 0;
}

function kindOf(set: Element, rep: Element | null): 'video' | 'audio' | 'text' | '' {
  const contentType = set.getAttribute('contentType');
  if (contentType === 'video' || contentType === 'audio' || contentType === 'text') {
    return contentType;
  }
  const mime = attr(set, rep, 'mimeType').toLowerCase();
  if (SUBTITLE_MIMES.indexOf(mime) >= 0) return 'text';
  if (mime === 'application/mp4'
      && /^(?:stpp|wvtt)(?:\.|$)/i.test(attr(set, rep, 'codecs'))) return 'text';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime.indexOf('audio/') === 0) return 'audio';
  return '';
}

// CEA-608 values look like "CC1=l1;CC3=l2"; CEA-708 like "1=lang:l3" (service
// numbers, so the instream id gains its SERVICE prefix).
function parseCcValue(value: string, cea708: boolean): ManifestClosedCaption[] {
  const out: ManifestClosedCaption[] = [];
  for (const part of value.split(';')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const id = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const rest = eq < 0 ? '' : entry.slice(eq + 1).trim();
    const lang = rest.replace(/^lang:/i, '').split(',')[0].trim();
    if (!id) continue;
    out.push({
      name: '',
      lang,
      instreamId: cea708 && /^\d+$/.test(id) ? `SERVICE${id}` : id,
      isDefault: false,
    });
  }
  return out;
}

export function parseMpd(
  xml: string,
  manifestUrl = '',
  presentationTime?: number,
): MpdManifest {
  if (!xml) return EMPTY;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return EMPTY;
  }
  if (descendants(doc, 'parsererror').length || doc.getElementsByTagName('parsererror').length) {
    return EMPTY;
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'MPD') return EMPTY;

  const period = descendants(root, 'Period')[0];
  if (!period) {
    const drm = drmProtection(root);
    return { ...EMPTY, isLive: root.getAttribute('type') === 'dynamic',
      hasContentProtection: !!drm, drm };
  }

  const audio: ManifestAudio[] = [];
  const subtitles: ManifestSubtitle[] = [];
  const closedCaptions: ManifestClosedCaption[] = [];
  const videoSets: { set: Element; reps: Element[] }[] = [];
  const priorities: number[] = [];
  let audioCodec = '';
  let atmos = false;

  for (const set of children(period, 'AdaptationSet')) {
    const reps = children(set, 'Representation');
    const rep = reps[0] ?? null;
    const kind = kindOf(set, rep);
    if (kind === 'video') {
      videoSets.push({ set, reps });
      for (const el of children(set, 'Accessibility')) {
        const scheme = (el.getAttribute('schemeIdUri') || '').toLowerCase();
        if (scheme === CEA608_SCHEME || scheme === CEA708_SCHEME) {
          closedCaptions.push(
            ...parseCcValue(el.getAttribute('value') || '', scheme === CEA708_SCHEME));
        }
      }
    } else if (kind === 'audio') {
      audio.push({ name: label(set), lang: set.getAttribute('lang') || '', isDefault: false });
      priorities.push(parseInt(set.getAttribute('selectionPriority') || '0', 10) || 0);
      if (!audioCodec) audioCodec = attr(set, rep, 'codecs');
      if (!atmos) atmos = isAtmos(set, rep);
    } else if (kind === 'text') {
      subtitles.push({
        name: label(set),
        lang: set.getAttribute('lang') || '',
        isDefault: hasRole(set, 'main'),
        isForced: hasRole(set, 'forced-subtitle'),
        dash: dashSubtitleSource(
          root,
          period,
          set,
          rep,
          manifestUrl,
          presentationTime,
        ),
      });
    }
  }

  // Role=main wins; otherwise the highest selectionPriority, but only when one
  // set actually declares a higher priority than the rest.
  const mains = children(period, 'AdaptationSet')
    .filter(set => kindOf(set, children(set, 'Representation')[0] ?? null) === 'audio')
    .map(set => hasRole(set, 'main'));
  if (mains.some(Boolean)) {
    mains.forEach((isMain, i) => { audio[i].isDefault = isMain; });
  } else {
    const top = Math.max(0, ...priorities);
    if (top > 0 && priorities.filter(p => p === top).length === 1) {
      audio[priorities.indexOf(top)].isDefault = true;
    }
  }

  const variants: StreamVariant[] = [];
  for (const { set, reps } of videoSets) {
    const range = videoRange(set, reps[0] ?? null);
    for (const rep of reps.length ? reps : [null]) {
      const codecs = attr(set, rep, 'codecs');
      variants.push({
        width: parseInt(attr(set, rep, 'width') || '0', 10) || 0,
        height: parseInt(attr(set, rep, 'height') || '0', 10) || 0,
        videoCodec: codecs,
        audioCodec,
        atmos,
        videoRange: range || dvRange(codecs),
        frameRate: frameRate(attr(set, rep, 'frameRate')),
      });
    }
  }

  const drm = drmProtection(root);
  return {
    audio,
    subtitles,
    closedCaptions,
    variants,
    isLive: root.getAttribute('type') === 'dynamic',
    hasContentProtection: !!drm,
    drm,
  };
}

function videoRange(set: Element, rep: Element | null): string {
  const names = ['EssentialProperty', 'SupplementalProperty'] as const;
  const value = descriptorValue(set, names, CICP_TRANSFER) ||
    (rep ? descriptorValue(rep, names, CICP_TRANSFER) : '');
  return value ? hdrFromTransfer(parseInt(value, 10)) : '';
}

function dvRange(codecs: string): string {
  return DV_CODECS.indexOf(codecs.split('.')[0].toLowerCase()) >= 0 ? 'PQ' : '';
}

// A Dolby JOC descriptor identifies Atmos carried by E-AC-3 or AC-4.
function isAtmos(set: Element, rep: Element | null): boolean {
  const scopes = rep ? [set, rep] : [set];
  for (const scope of scopes) {
    for (const name of ['SupplementalProperty', 'EssentialProperty', 'AudioChannelConfiguration']) {
      for (const el of children(scope, name)) {
        const scheme = (el.getAttribute('schemeIdUri') || '').toLowerCase();
        const value = el.getAttribute('value') || '';
        if (scheme.indexOf('dolby') >= 0 && /\bJOC\b/i.test(value)) return true;
      }
    }
  }
  return false;
}
