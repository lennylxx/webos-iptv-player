/**
 * Manifest rewriting for the loopback proxy: every URI an HLS playlist or a
 * DASH MPD names resolves against the manifest's final URL and points back
 * at the proxy, so the player fetches segments, keys, and renditions through
 * it too. Pure string work; no XML parser exists on Node.js 0.12.
 */

export type ManifestKind = 'hls' | 'dash';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_URL = /^(https?):\/\/([^\/?#]*)([^#]*)/i;
const HOST = /^[A-Za-z0-9.\-_~%\[\]:]+$/;
const SNIFF_BYTES = 1024;

function removeDotSegments(path: string): string {
  const input = path.split('/');
  const output: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const segment = input[i];
    const last = i === input.length - 1;
    if (segment === '.') {
      if (last) output.push('');
    } else if (segment === '..') {
      if (output.length > 1) output.pop();
      if (last) output.push('');
    } else {
      output.push(segment);
    }
  }
  const joined = output.join('/');
  return joined.charAt(0) === '/' ? joined : '/' + joined;
}

function normalizePath(pathAndQuery: string): string {
  const cut = pathAndQuery.search(/[?#]/);
  const path = cut < 0 ? pathAndQuery : pathAndQuery.slice(0, cut);
  const rest = cut < 0 ? '' : pathAndQuery.slice(cut);
  return removeDotSegments(path) + rest;
}

/**
 * RFC 3986 reference resolution without re-encoding, so a DASH template's
 * `$Number%05d$` and an already-encoded path pass through byte for byte.
 */
export function resolveUri(base: string, ref: string): string {
  const value = ref.trim();
  if (SCHEME.test(value)) return value;
  const match = /^([a-z][a-z0-9+.-]*:)(\/\/[^\/?#]*)?([^?#]*)(\?[^#]*)?/i.exec(base);
  if (!match) return value;
  const scheme = match[1];
  const authority = match[2] || '';
  const path = match[3] || '/';
  const query = match[4] || '';
  if (value.indexOf('//') === 0) return scheme + value;
  if (value.charAt(0) === '/') return scheme + authority + normalizePath(value);
  if (!value || value.charAt(0) === '#') return scheme + authority + path + query;
  if (value.charAt(0) === '?') return scheme + authority + path + value;
  const dir = path.slice(0, path.lastIndexOf('/') + 1) || '/';
  return scheme + authority + normalizePath(dir + value);
}

/**
 * `<prefix>/<scheme>/<host[:port]>/<path>?<query>` for an absolute http(s)
 * URL, without its user:password or fragment; null for anything else.
 */
export function proxyUrl(prefix: string, absolute: string): string | null {
  const match = HTTP_URL.exec(absolute);
  if (!match) return null;
  const authority = match[2];
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (!host || !HOST.test(host)) return null;
  let rest = match[3];
  if (!rest || rest.charAt(0) === '?') rest = '/' + rest;
  return prefix + '/' + match[1].toLowerCase() + '/' + host + rest;
}

/** The session token and upstream URL a proxy path names, or null. */
export function targetFromPath(path: string): { token: string; url: string } | null {
  const match = /^\/p\/([0-9a-f]{32})\/(https?)\/([^\/?#]+)([^#]*)$/.exec(path);
  if (!match || !HOST.test(match[3])) return null;
  let rest = match[4];
  if (!rest || rest.charAt(0) === '?') rest = '/' + rest;
  return { token: match[1], url: match[2] + '://' + match[3] + rest };
}

/** 'hls' or 'dash' from a body's start, '' for neither, null while more bytes may decide. */
export function sniffManifest(head: Buffer, ended: boolean): ManifestKind | '' | null {
  // 'binary' is latin1; Node.js 0.12 has no 'latin1' alias.
  let text = head.toString('binary', 0, Math.min(head.length, SNIFF_BYTES));
  if (text.indexOf('\xef\xbb\xbf') === 0) text = text.slice(3);
  text = text.replace(/^\s+/, '');
  // A sniff window of whitespace never decides; call it neither.
  const settled = ended || head.length >= SNIFF_BYTES;
  if (!text) return settled ? '' : null;
  if (text.charAt(0) === '#') {
    if (text.length < 7) return settled ? '' : null;
    return text.slice(0, 7) === '#EXTM3U' ? 'hls' : '';
  }
  if (text.charAt(0) !== '<') return '';
  if (/<(?:[\w.-]+:)?MPD[\s>\/]/.test(text)) return 'dash';
  return settled ? '' : null;
}

type Mapper = (absolute: string) => string | null;

// Whether a relative reference's `..` segments climb above the base URL's
// root: upstream clamps them there (RFC 3986), but under the proxy they
// would climb into the `/p/<token>/` prefix.
function climbsAboveRoot(base: string, ref: string): boolean {
  if (ref.indexOf('..') < 0) return false;
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^\/?#]*([^?#]*)/i.exec(base);
  if (!match) return false;
  const dir = match[1].slice(0, match[1].lastIndexOf('/') + 1);
  let depth = dir.split('/').filter(segment => !!segment).length;
  const path = ref.split(/[?#]/)[0].split('/');
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '..') {
      if (depth === 0) return true;
      depth--;
    } else if (path[i] && path[i] !== '.' && i < path.length - 1) {
      depth++;
    }
  }
  return false;
}

function mapUri(base: string, value: string, map: Mapper): string {
  if (!value.trim()) return value;
  const resolved = resolveUri(base, value);
  if (!/^https?:\/\//i.test(resolved)) return value;
  return map(resolved) || value;
}

/**
 * Rewrites every URI line and `URI="..."` attribute (EXT-X-MEDIA, -MAP, -KEY,
 * -I-FRAME-STREAM-INF, -SESSION-KEY, -PART, ...). data:, skd:, and other
 * non-http schemes stay as they are.
 */
export function rewriteHls(text: string, baseUrl: string, map: Mapper): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cr = line.charAt(line.length - 1) === '\r' ? '\r' : '';
    const body = cr ? line.slice(0, -1) : line;
    const trimmed = body.trim();
    if (!trimmed) continue;
    if (trimmed.charAt(0) === '#') {
      if (body.indexOf('URI="') < 0) continue;
      lines[i] = body.replace(/(^|[:,])URI="([^"]*)"/g, (_m: string, lead: string, value: string) =>
        lead + 'URI="' + mapUri(baseUrl, value, map) + '"') + cr;
    } else {
      const start = body.indexOf(trimmed);
      lines[i] = body.slice(0, start) + mapUri(baseUrl, trimmed, map)
        + body.slice(start + trimmed.length) + cr;
    }
  }
  return lines.join('\n');
}

function xmlUnescape(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m: string, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return '\'';
    const code = entity.charAt(1) === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCharCode(code);
  });
}

function xmlEscape(value: string, quote: string): string {
  let out = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote === '"') out = out.replace(/"/g, '&quot;');
  if (quote === '\'') out = out.replace(/'/g, '&apos;');
  return out;
}

// URL-valued attributes, by element local name.
const URL_ATTRIBUTES: Record<string, string[]> = {
  SegmentTemplate: ['media', 'initialization', 'index'],
  SegmentURL: ['media', 'index'],
  Initialization: ['sourceURL'],
  RepresentationIndex: ['sourceURL'],
};
// Elements whose text is a URL; they open no scope of their own.
const URL_TEXT = ['BaseURL', 'Location', 'PatchLocation'];

const TOKEN = new RegExp('<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\?[\\s\\S]*?\\?>|<![^>]*>'
  + '|<(\\/?)([A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?)'
  + '((?:\\s+[^\\s=\\/>]+\\s*=\\s*(?:"[^"]*"|\'[^\']*\'))*)\\s*(\\/?)>', 'g');
const ATTRIBUTE = /(\s+)([^\s=\/>]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g;

function localName(name: string): string {
  return name.slice(name.indexOf(':') + 1);
}

interface Frame {
  base: string;
  baseSet: boolean;
}

/**
 * Points every BaseURL, Location, and PatchLocation at the proxy, and every
 * absolute or root-relative segment attribute. A relative template or
 * segment URL stays relative: it resolves against the proxied BaseURL or
 * MPD URL, whose path the proxy URL preserves, so `$...$` templates and
 * inherited SegmentTemplates keep working; one whose `..` climbs above the
 * root is resolved, clamped there, and mapped like an absolute one. After a redirect, an MPD without
 * its own BaseURL gains one naming its final URL. DRM license URLs
 * (dashif:laurl, ms:laurl, clearkey:Laurl) are left alone.
 */
export function rewriteDash(text: string, baseUrl: string, redirected: boolean, map: Mapper): string {
  const out: string[] = [];
  const stack: Frame[] = [{ base: baseUrl, baseSet: false }];
  let last = 0;
  let mpdSlot = -1;
  let mpdHasBase = false;
  const token = new RegExp(TOKEN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    out.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    const name = match[2];
    if (!name) {
      out.push(match[0]);
      continue;
    }
    const local = localName(name);
    const selfClosing = match[4] === '/';
    const top = stack[stack.length - 1];
    if (match[1] === '/') {
      out.push(match[0]);
      if (URL_TEXT.indexOf(local) < 0 && stack.length > 1) stack.pop();
      continue;
    }
    const attributes = URL_ATTRIBUTES[local];
    let tag = match[0];
    if (attributes) {
      tag = '<' + name + match[3].replace(ATTRIBUTE,
        (whole: string, space: string, attr: string, eq: string, _q: string, dq?: string, sq?: string) => {
          if (attributes.indexOf(attr) < 0) return whole;
          const quote = dq !== undefined ? '"' : '\'';
          const raw = xmlUnescape(dq !== undefined ? dq : sq || '');
          // A relative URL already resolves under the proxy, unless it climbs above the root.
          if (!SCHEME.test(raw) && raw.charAt(0) !== '/' && !climbsAboveRoot(top.base, raw)) return whole;
          const resolved = resolveUri(top.base, raw);
          const mapped = /^https?:\/\//i.test(resolved) ? map(resolved) : null;
          return mapped ? space + attr + eq + quote + xmlEscape(mapped, quote) + quote : whole;
        }) + (selfClosing ? '/>' : '>');
    }
    out.push(tag);
    if (local === 'MPD' && mpdSlot < 0 && !selfClosing) {
      mpdSlot = out.length;
      out.push('');
    }
    if (URL_TEXT.indexOf(local) >= 0) {
      if (selfClosing) continue;
      const close = text.indexOf('</', last);
      if (close < 0) continue;
      const raw = text.slice(last, close);
      if (raw.indexOf('<') >= 0) continue;
      const resolved = resolveUri(local === 'BaseURL' ? top.base : baseUrl, xmlUnescape(raw.trim()));
      if (!/^https?:\/\//i.test(resolved)) continue;
      if (local === 'BaseURL') {
        if (!top.baseSet) {
          top.base = resolved;
          top.baseSet = true;
        }
        if (stack.length === 2 && mpdSlot >= 0) mpdHasBase = true;
      }
      const mapped = map(resolved);
      if (!mapped) continue;
      out.push(xmlEscape(mapped, ''));
      last = close;
      token.lastIndex = close;
      continue;
    }
    if (!selfClosing) stack.push({ base: top.base, baseSet: false });
  }
  out.push(text.slice(last));
  if (redirected && mpdSlot >= 0 && !mpdHasBase) {
    const mapped = map(baseUrl);
    if (mapped) out[mpdSlot] = '<BaseURL>' + xmlEscape(mapped, '') + '</BaseURL>';
  }
  return out.join('');
}
