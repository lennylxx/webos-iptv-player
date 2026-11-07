import { describe, expect, it } from 'vitest';
import { proxyUrl, resolveUri, rewriteDash, rewriteHls, sniffManifest, targetFromPath } from './rewrite';

const PREFIX = 'http://127.0.0.1:1/p/' + 'a'.repeat(32);
const map = (absolute: string): string | null => proxyUrl(PREFIX, absolute);

describe('resolveUri', () => {
  it('resolves relative, root-relative, scheme-relative, and dot segments', () => {
    const base = 'http://host/a/b/c.m3u8?x=1';
    expect(resolveUri(base, 'd.ts')).toBe('http://host/a/b/d.ts');
    expect(resolveUri(base, '../d.ts?y=2')).toBe('http://host/a/d.ts?y=2');
    expect(resolveUri(base, './x/../d.ts')).toBe('http://host/a/b/d.ts');
    expect(resolveUri(base, '/d.ts')).toBe('http://host/d.ts');
    expect(resolveUri(base, '//cdn/d.ts')).toBe('http://cdn/d.ts');
    expect(resolveUri(base, '?z=3')).toBe('http://host/a/b/c.m3u8?z=3');
    expect(resolveUri(base, 'https://other/e.ts')).toBe('https://other/e.ts');
  });

  it('keeps encoding and DASH template identifiers byte for byte', () => {
    expect(resolveUri('http://host/a/', 'seg-$Number%05d$.m4s')).toBe('http://host/a/seg-$Number%05d$.m4s');
    expect(resolveUri('http://host/a/', 'b%20c.ts')).toBe('http://host/a/b%20c.ts');
  });
});

describe('proxyUrl and targetFromPath', () => {
  it('round-trips the scheme, host, port, path, and query and drops credentials', () => {
    const url = proxyUrl(PREFIX, 'https://user:pw@host:8443/a/b.m3u8?t=1#frag');
    expect(url).toBe(PREFIX + '/https/host:8443/a/b.m3u8?t=1');
    const target = targetFromPath(url!.slice('http://127.0.0.1:1'.length));
    expect(target).toEqual({ token: 'a'.repeat(32), url: 'https://host:8443/a/b.m3u8?t=1' });
  });

  it('rejects non-http URLs and malformed paths', () => {
    expect(proxyUrl(PREFIX, 'data:text/plain,x')).toBeNull();
    expect(proxyUrl(PREFIX, 'skd://key')).toBeNull();
    expect(targetFromPath('/p/short/http/host/a')).toBeNull();
    expect(targetFromPath('/p/' + 'a'.repeat(32) + '/ftp/host/a')).toBeNull();
  });
});

describe('sniffManifest', () => {
  it('tells HLS, DASH, and media apart', () => {
    expect(sniffManifest(Buffer.from('\ufeff #EXTM3U\n'), false)).toBe('hls');
    expect(sniffManifest(Buffer.from('<?xml version="1.0"?>\n<MPD xmlns="x">'), false)).toBe('dash');
    expect(sniffManifest(Buffer.from('<mpd:MPD>'), false)).toBe('dash');
    expect(sniffManifest(Buffer.from([0x47, 0x40, 0x00]), false)).toBe('');
    expect(sniffManifest(Buffer.from('#EXT'), false)).toBeNull();
    expect(sniffManifest(Buffer.from('#EXT'), true)).toBe('');
    expect(sniffManifest(Buffer.from('<?xml version="1.0"?>'), false)).toBeNull();
  });

  it('calls a whole sniff window of whitespace neither, so the body streams through', () => {
    expect(sniffManifest(Buffer.from(new Array(1024).join(' ')), false)).toBeNull();
    expect(sniffManifest(Buffer.from(new Array(1026).join(' ')), false)).toBe('');
    expect(sniffManifest(Buffer.from(new Array(1022).join(' ') + '#EX'), false)).toBe('');
  });
});

describe('rewriteHls', () => {
  it('rewrites URI lines and URI attributes against the final URL', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="/keys/s.key"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",URI="audio/a.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2,AUDIO="a"',
      'v1/index.m3u8?t=1',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key1",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
      '#EXTINF:4,',
      'https://cdn/seg1.ts\r',
      '',
    ].join('\n');
    const out = rewriteHls(text, 'http://final/live/master.m3u8', map);
    expect(out).toContain('URI="' + PREFIX + '/http/final/keys/s.key"');
    expect(out).toContain('URI="' + PREFIX + '/http/final/live/audio/a.m3u8"');
    expect(out).toContain('URI="' + PREFIX + '/http/final/live/iframe.m3u8"');
    expect(out).toContain('\n' + PREFIX + '/http/final/live/v1/index.m3u8?t=1\n');
    expect(out).toContain('#EXT-X-MAP:URI="' + PREFIX + '/http/final/live/init.mp4",BYTERANGE="10@0"');
    expect(out).toContain('GROUP-ID="a",NAME="Track 1"');
    expect(out).toContain('URI="skd://key1"');
    expect(out).toContain('URI="data:text/plain;base64,AAAA"');
    expect(out).toContain('\n' + PREFIX + '/https/cdn/seg1.ts\r\n');
  });
});

describe('rewriteDash', () => {
  const mpd = [
    '<?xml version="1.0"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:dashif="https://dashif.org/CPS">',
    '<Location>http://origin/live/manifest.mpd</Location>',
    '<Period>',
    '<AdaptationSet>',
    '<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e">',
    '<dashif:laurl>https://license/ck</dashif:laurl>',
    '</ContentProtection>',
    '<SegmentTemplate media="v/$RepresentationID$/$Number%05d$.m4s" initialization="/abs/$RepresentationID$/init.mp4"/>',
    '<Representation id="r1"/>',
    '</AdaptationSet>',
    '<AdaptationSet>',
    '<BaseURL>https://cdn/x/</BaseURL>',
    '<SegmentList><Initialization sourceURL="init.mp4"/>',
    '<SegmentURL media="https://cdn2/s1.m4s?a=1&amp;b=2"/></SegmentList>',
    '</AdaptationSet>',
    '</Period>',
    '</MPD>',
  ].join('\n');

  it('proxies BaseURL, Location, and absolute segment URLs, keeping templates and license URLs', () => {
    const out = rewriteDash(mpd, 'http://origin/live/manifest.mpd', false, map);
    expect(out).toContain('<Location>' + PREFIX + '/http/origin/live/manifest.mpd</Location>');
    expect(out).toContain('<dashif:laurl>https://license/ck</dashif:laurl>');
    expect(out).toContain('media="v/$RepresentationID$/$Number%05d$.m4s"');
    expect(out).toContain('initialization="' + PREFIX + '/http/origin/abs/$RepresentationID$/init.mp4"');
    expect(out).toContain('<BaseURL>' + PREFIX + '/https/cdn/x/</BaseURL>');
    expect(out).toContain('<Initialization sourceURL="init.mp4"/>');
    expect(out).toContain('media="' + PREFIX + '/https/cdn2/s1.m4s?a=1&amp;b=2"');
    expect(out).not.toContain('<BaseURL>' + PREFIX + '/http/origin');
  });

  it('adds a BaseURL naming the final URL after a redirect', () => {
    const out = rewriteDash(mpd, 'http://final/live/manifest.mpd', true, map);
    expect(out).toMatch(new RegExp('<MPD [^>]*><BaseURL>' + PREFIX.replace(/[.]/g, '\\.')
      + '/http/final/live/manifest\\.mpd</BaseURL>'));
  });

  it('resolves a relative MPD-level BaseURL against the final URL and adds none', () => {
    const text = '<MPD><BaseURL>seg/</BaseURL><Period/></MPD>';
    const out = rewriteDash(text, 'http://final/live/m.mpd', true, map);
    expect(out).toBe('<MPD><BaseURL>' + PREFIX + '/http/final/live/seg/</BaseURL><Period/></MPD>');
  });

  it('clamps a relative segment URL whose dot segments climb above the root', () => {
    const text = '<MPD><Period><SegmentList><SegmentURL media="../../../s1.m4s"/>'
      + '<SegmentURL media="../s2.m4s"/></SegmentList></Period></MPD>';
    const out = rewriteDash(text, 'http://origin/live/m.mpd', false, map);
    expect(out).toContain('media="' + PREFIX + '/http/origin/s1.m4s"');
    expect(out).toContain('media="../s2.m4s"');
  });
});
