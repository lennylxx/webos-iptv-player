import { describe, it, expect, vi } from 'vitest';
import {
  decodePlaylistBytes,
  detectPlaylistFormat,
  M3UStreamParser,
  parseM3U,
  parseM3UBytes,
} from './m3u-parser';
import { UNCATEGORIZED_GROUP } from '../types';

describe('parseM3U', () => {
  it('parses a basic channel with URL', () => {
    const m3u = ['#EXTM3U', '#EXTINF:-1,Channel One', 'http://example.com/1.m3u8'].join('\n');
    const result = parseM3U(m3u);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].name).toBe('Channel One');
    expect(result.channels[0].url).toBe('http://example.com/1.m3u8');
  });

  it('extracts tvg attributes and group-title', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="c1" tvg-name="News HD" tvg-logo="http://logo/1.png" group-title="News",News',
      'http://example.com/news.m3u8',
    ].join('\n');
    const ch = parseM3U(m3u).channels[0];
    expect(ch.id).toBe('c1');
    expect(ch.name).toBe('News HD'); // tvg-name takes precedence over the display title
    expect(ch.logo).toBe('http://logo/1.png');
    expect(ch.group).toBe('News');
    expect(ch.sourceGroups).toBeUndefined();
    expect(ch.sourceAttributes).toBeUndefined();
  });

  it('accepts single-quoted, unquoted and spaced attributes', () => {
    const m3u = [
      '#EXTM3U url-tvg = http://host/guide.xml',
      '#EXTINF:-1 tvg-id = \'ch1\' tvg-name=Alpha group-title = "Local" catchup-days = 7,Display',
      'http://host/a',
    ].join('\n');
    const result = parseM3U(m3u);
    expect(result.epgUrl).toBe('http://host/guide.xml');
    expect(result.channels[0]).toMatchObject({
      id: 'ch1',
      name: 'Alpha',
      group: 'Local',
      catchupDays: 7,
    });
  });

  it('keeps commas and equals inside quoted values and the display title', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch1" group-title="Alpha, Bravo" catchup-source=\'http://host/a?x=1,y=2\',Display, Name',
      'http://host/a',
    ].join('\n');
    const ch = parseM3U(m3u).channels[0];
    expect(ch.group).toBe('Alpha, Bravo');
    expect(ch.catchupSource).toBe('http://host/a?x=1,y=2');
    expect(ch.name).toBe('Display, Name');
  });

  it('infers Xtream catch-up candidates for catchup=xc', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 catchup="xc" catchup-days="3",Alpha',
      'http://host:8080/live/u1/p1/42.m3u8',
    ].join('\n');
    const channel = parseM3U(m3u).channels[0];
    expect(channel).toMatchObject({
      catchup: 'xtream',
      catchupDays: 3,
      catchupStreamId: '42',
      catchupSource: 'http://host:8080/timeshift/u1/p1/{duration}/{start}/42.m3u8',
    });
    expect(channel.catchupSources).toBeUndefined();
  });

  it('keeps an explicit catchup-source instead of inferring catchup=xc', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 catchup="xc" catchup-source="http://host/archive/{utc}",Alpha',
      'http://host/live/u1/p1/42.ts',
    ].join('\n');
    const channel = parseM3U(m3u).channels[0];
    expect(channel.catchup).toBe('xc');
    expect(channel.catchupSource).toBe('http://host/archive/{utc}');
    expect(channel.catchupSources).toBeUndefined();
  });

  it('reads SIPTV timeshift as catch-up days in shift mode', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:0 tvg-id="ch1" timeshift="7",Alpha',
      'http://host/ch1/mono.m3u8?k=v',
      '#EXTINF:0 tvg-id="ch2" timeshift="0",Bravo',
      'http://host/ch2/mono.m3u8',
    ].join('\n');
    const [alpha, bravo] = parseM3U(m3u).channels;
    expect(alpha).toMatchObject({
      catchup: 'shift',
      catchupDays: 7,
      catchupSource: 'http://host/ch1/mono.m3u8?k=v&utc={utc}&lutc={lutc}',
    });
    expect(alpha.tvgShift).toBeUndefined();
    expect(bravo).toMatchObject({ catchup: '', catchupDays: 0, catchupSource: '' });
  });

  it('reads tvg-rec like SIPTV timeshift', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:0 tvg-rec="3",Alpha',
      'http://host/ch1/index.m3u8',
    ].join('\n');
    expect(parseM3U(m3u).channels[0]).toMatchObject({
      catchup: 'shift',
      catchupDays: 3,
      catchupSource: 'http://host/ch1/index.m3u8?utc={utc}&lutc={lutc}',
    });
  });

  it('keeps an explicit mode and catchup-days over SIPTV timeshift', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:0 catchup="default" catchup-days="2" timeshift="7" '
        + 'catchup-source="http://host/c/{utc}",Alpha',
      'http://host/ch1/mono.m3u8',
    ].join('\n');
    expect(parseM3U(m3u).channels[0]).toMatchObject({
      catchup: 'default',
      catchupDays: 2,
      catchupSource: 'http://host/c/{utc}',
    });
  });

  it('builds sources for append, shift and flussonic modes', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:0 catchup="append" catchup-source="?cutv={Y}-{m}-{d}",Alpha',
      'http://host/a.m3u8?k=v',
      '#EXTINF:0 catchup="shift" catchup-days="1",Bravo',
      'http://host/b.m3u8',
      '#EXTINF:0 catchup="fs",Charlie',
      'http://host/ch3/mono.m3u8?k=v',
      '#EXTINF:0 catchup="flussonic",Delta',
      'http://host/ch4/mpegts',
    ].join('\n');
    const channels = parseM3U(m3u).channels;
    expect(channels.map(ch => [ch.catchup, ch.catchupSource])).toEqual([
      ['append', 'http://host/a.m3u8?k=v&cutv={Y}-{m}-{d}'],
      ['shift', 'http://host/b.m3u8?utc={utc}&lutc={lutc}'],
      ['flussonic', 'http://host/ch3/mono-{utc}-{duration}.m3u8?k=v'],
      ['flussonic', 'http://host/ch4/archive-{utc}-{duration}.ts'],
    ]);
  });

  it('applies header catch-up defaults to entries without their own', () => {
    const m3u = [
      '#EXTM3U catchup-type="flussonic" catchup-time="604800"',
      '#EXTINF:0 tvg-id="ch1",Alpha',
      'http://host/ch1/mono.m3u8?k=v',
      '#EXTINF:0 tvg-id="ch2" catchup="shift" catchup-days="3",Bravo',
      'http://host/ch2/mono.m3u8',
    ].join('\n');
    for (const options of [{}, { streamLocationPrefilter: () => true }]) {
      const [alpha, bravo] = parseM3U(m3u, '', options).channels;
      expect(alpha).toMatchObject({
        catchup: 'flussonic',
        catchupDays: 7,
        catchupSource: 'http://host/ch1/mono-{utc}-{duration}.m3u8?k=v',
      });
      expect(bravo).toMatchObject({
        catchup: 'shift',
        catchupDays: 3,
        catchupSource: 'http://host/ch2/mono.m3u8?utc={utc}&lutc={lutc}',
      });
    }
  });

  it('inherits a header catchup-source only for the header mode', () => {
    const m3u = [
      '#EXTM3U catchup="default" catchup-source="http://host/c/{utc}" catchup-days="5"',
      '#EXTINF:0,Alpha',
      'http://host/a.m3u8',
      '#EXTINF:0 catchup="shift",Bravo',
      'http://host/b.m3u8',
    ].join('\n');
    const [alpha, bravo] = parseM3U(m3u).channels;
    expect(alpha).toMatchObject({ catchup: 'default', catchupDays: 5, catchupSource: 'http://host/c/{utc}' });
    expect(bravo).toMatchObject({ catchup: 'shift', catchupSource: 'http://host/b.m3u8?utc={utc}&lutc={lutc}' });
  });

  it('matches attribute names without regard to case', () => {
    const m3u = [
      '#EXTM3U X-TVG-URL="http://host/guide.xml"',
      '#EXTINF:-1 TVG-ID="ch1" TVG-NAME="Alpha" GROUP-TITLE="Bravo",Display',
      'http://host/a',
    ].join('\n');
    const result = parseM3U(m3u);
    expect(result.epgUrl).toBe('http://host/guide.xml');
    expect(result.channels[0]).toMatchObject({
      id: 'ch1',
      name: 'Alpha',
      group: 'Bravo',
    });
  });

  it('falls back to the display title and the ungrouped bucket', () => {
    const m3u = ['#EXTM3U', '#EXTINF:-1,Bare Channel', 'http://example.com/bare.m3u8'].join('\n');
    const ch = parseM3U(m3u).channels[0];
    expect(ch.name).toBe('Bare Channel');
    expect(ch.group).toBe(UNCATEGORIZED_GROUP);
  });

  it('keeps a provider group named "Uncategorized" separate from the ungrouped bucket', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="Uncategorized",One',
      'http://host/1',
      '#EXTINF:-1,Two',
      'http://host/2',
    ].join('\n');
    const parsed = parseM3U(m3u);
    expect(parsed.channels[0].group).toBe('Uncategorized');
    expect(parsed.channels[1].group).toBe(UNCATEGORIZED_GROUP);
    expect(parsed.groups).toEqual(['Uncategorized', UNCATEGORIZED_GROUP]);
  });

  it('collects the distinct set of groups', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="A",One',
      'http://e/1',
      '#EXTINF:-1 group-title="B",Two',
      'http://e/2',
      '#EXTINF:-1 group-title="A",Three',
      'http://e/3',
    ].join('\n');
    expect(parseM3U(m3u).groups).toEqual(['A', 'B']);
  });

  it('reads the embedded EPG url from #EXTM3U (url-tvg / x-tvg-url)', () => {
    expect(parseM3U('#EXTM3U url-tvg="http://epg/guide.xml"').epgUrl).toBe('http://epg/guide.xml');
    expect(parseM3U('#EXTM3U x-tvg-url="http://epg/alt.xml"').epgUrl).toBe('http://epg/alt.xml');
  });

  it('collects multiple EPG URLs and preserves all header attributes', () => {
    const result = parseM3U(
      '#EXTM3U url-tvg="http://host/a.xml,http://host/b.xml" '
      + 'tvg-url="http://host/c.xml" max-conn="2" custom-header="v"',
    );
    expect(result.epgUrls).toEqual([
      'http://host/a.xml',
      'http://host/b.xml',
      'http://host/c.xml',
    ]);
    expect(result.epgUrl).toBe('http://host/a.xml');
    expect(result.maxConnections).toBe(2);
    expect(result.headerAttributes['custom-header']).toBe('v');
  });

  it('lets #EXTGRP override the group-title', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="Old",Ch',
      '#EXTGRP:Movies',
      'http://e/1',
    ].join('\n');
    expect(parseM3U(m3u).channels[0].group).toBe('Movies');
  });

  it('captures #EXTVLCOPT and #KODIPROP as extras', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1,Ch',
      '#EXTVLCOPT:http-user-agent=Mozilla',
      '#KODIPROP:inputstream.adaptive.license_type=clearkey',
      'http://e/1',
    ].join('\n');
    const ch = parseM3U(m3u).channels[0];
    expect(ch.extras).toMatchObject({
      'http-user-agent': 'Mozilla',
      'inputstream.adaptive.license_type': 'clearkey',
    });
  });

  it('preserves unknown attributes and extended channel metadata', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch1" group-title="Alpha;Bravo" custom-field="v" '
        + 'tvg-chno="12" tvg-shift="-1.5" radio="true",Channel',
      'http://host/a',
    ].join('\n');
    const ch = parseM3U(m3u).channels[0];
    expect(ch.sourceAttributes).toEqual({ 'custom-field': 'v' });
    expect(ch.sourceGroups).toEqual(['Alpha', 'Bravo']);
    expect(ch.group).toBe('Alpha');
    expect(ch.channelNumber).toBe(12);
    expect(ch.tvgShift).toBe(-1.5);
    expect(ch.radio).toBe(true);
  });

  it('parses EXTHTTP headers and maps common playback headers', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1,Channel',
      '#EXTHTTP:{"User-Agent":"Agent","Referer":"http://host/a","X-Test":"v"}',
      'http://host/a',
    ].join('\n');
    const ch = parseM3U(m3u).channels[0];
    expect(ch.httpHeaders).toEqual({
      'User-Agent': 'Agent',
      Referer: 'http://host/a',
      'X-Test': 'v',
    });
    expect(ch.extras).toMatchObject({
      'http-user-agent': 'Agent',
      'http-referrer': 'http://host/a',
    });
  });

  it('reports malformed EXTHTTP without dropping the channel', () => {
    const result = parseM3U([
      '#EXTM3U',
      '#EXTINF:-1,Channel',
      '#EXTHTTP:{bad',
      'http://host/a',
    ].join('\n'));
    expect(result.channels).toHaveLength(1);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'bad-exthttp',
      line: 3,
    }));
  });

  it('ignores blank lines and CRLF line endings', () => {
    const m3u = '#EXTM3U\r\n\r\n#EXTINF:-1,Ch\r\nhttp://e/1\r\n';
    expect(parseM3U(m3u).channels).toHaveLength(1);
  });

  it('preserves parser semantics across arbitrary chunk boundaries', () => {
    const m3u = [
      '#EXTM3U url-tvg="http://host/guide.xml"',
      '#EXTINF:-1 tvg-id="ch1" group-title="Alpha;Bravo" custom="v",Channel',
      '#EXTVLCOPT:http-user-agent=Agent',
      '#KODIPROP:inputstream.adaptive.license_type=clearkey',
      '#EXTHTTP:{"Referer":"http://host/a"}',
      'http://host/live/u1/p1/42.ts',
    ].join('\r\n');
    const parser = new M3UStreamParser();
    for (let index = 0; index < m3u.length; index++) {
      parser.write(m3u.slice(index, index + 1));
    }

    expect(parser.finish()).toEqual(parseM3U(m3u));
  });

  it('filters a completed entry before retaining its groups', () => {
    const parser = new M3UStreamParser('', {
      channelPostfilter: channel => channel.url.endsWith('/keep'),
    });
    parser.write([
      '#EXTM3U',
      '#EXTINF:-1 group-title="Dropped",Drop',
      'http://host/drop',
      '#EXTINF:-1 group-title="Kept",Keep',
      'http://host/keep',
    ].join('\n'));

    const result = parser.finish();
    expect(result.channels.map(channel => channel.name)).toEqual(['Keep']);
    expect(result.groups).toEqual(['Kept']);
  });

  it('can reject a location before materializing channel metadata', () => {
    const channelPostfilter = vi.fn(() => true);
    const parser = new M3UStreamParser('', {
      streamLocationPrefilter: location => !location.includes('/movie/'),
      channelPostfilter,
    });
    parser.write([
      '#EXTM3U',
      '#EXTINF:-1 group-title="Dropped" custom-field="value",Movie',
      '#EXTHTTP:{bad',
      'http://host/movie/u1/p1/201.mp4',
      '#EXTINF:-1 group-title="Live",Alpha',
      '#EXTHTTP:{"User-Agent":"Agent"}',
      'http://host/live/u1/p1/101.ts',
    ].join('\n'));

    const result = parser.finish();

    expect(channelPostfilter).toHaveBeenCalledTimes(1);
    expect(result.channels).toEqual([
      expect.objectContaining({
        name: 'Alpha',
        group: 'Live',
        extras: { 'http-user-agent': 'Agent' },
      }),
    ]);
    expect(result.groups).toEqual(['Live']);
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: 'bad-exthttp' }),
    );
  });

  it('keeps ordinary M3U parsing unchanged without a location hook', () => {
    const result = parseM3U([
      '#EXTM3U',
      '#EXTINF:-1 group-title="Movies" custom-field="value",Movie',
      '#EXTHTTP:{bad',
      'http://host/movie/u1/p1/201.mp4',
    ].join('\n'));

    expect(result.channels).toEqual([
      expect.objectContaining({
        name: 'Movie',
        group: 'Movies',
        sourceAttributes: { 'custom-field': 'value' },
      }),
    ]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'bad-exthttp' }),
    );
  });

  it('accepts lone CR line endings', () => {
    const m3u = '#EXTM3U\r#EXTINF:-1,Ch\rhttp://host/a\r';
    expect(parseM3U(m3u).channels).toHaveLength(1);
  });

  it('returns an empty result for input with no entries', () => {
    const result = parseM3U('#EXTM3U');
    expect(result.channels).toEqual([]);
    expect(result.groups).toEqual([]);
  });

  it('accepts a bare URL playlist and reports the missing header', () => {
    const result = parseM3U('http://host/alpha.ts\nhttp://host/bravo.ts');
    expect(result.format).toBe('simple-m3u');
    expect(result.channels.map(channel => channel.name)).toEqual(['alpha', 'bravo']);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'missing-extm3u',
    }));
  });

  it('does not turn arbitrary text into a channel', () => {
    const result = parseM3U('Access denied');
    expect(result.channels).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'unrecognized-line',
      line: 1,
    }));
  });

  it('bounds channels and retained issues', () => {
    const result = parseM3U([
      '#EXTM3U',
      '#EXTINF:-1,Missing',
      '#EXTINF:-1,Alpha',
      'http://host/a',
      '#EXTINF:-1,Bravo',
      'http://host/b',
    ].join('\n'), '', { maxChannels: 1, maxIssues: 2 });
    expect(result.channels).toHaveLength(1);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map(issue => issue.code)).toEqual([
      'orphan-extinf',
      'channel-limit',
    ]);
  });

  it('wraps a bare HLS stream (HLS tags, no #EXTINF) as a single channel from the source URL', () => {
    const hls = [
      '#EXTM3U url-tvg="http://host/guide.xml" custom="v"',
      '#PLAYLIST:Alpha',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      'https://cdn/inner.m3u8',
    ].join('\n');
    const result = parseM3U(hls, 'https://example.com/hls/news.m3u8');
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].url).toBe('https://example.com/hls/news.m3u8'); // the stream URL itself, not the inner variant
    expect(result.channels[0].name).toBe('news');
    expect(result.groups).toEqual([UNCATEGORIZED_GROUP]);
    expect(result.epgUrls).toEqual(['http://host/guide.xml']);
    expect(result.headerAttributes.custom).toBe('v');
    expect(result.name).toBe('Alpha');
  });

  it('wraps a bare HLS *media* playlist (segments, not channels) as one channel — no "no desc" rows', () => {
    const media = [
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:100', '#EXT-X-TARGETDURATION:10',
      '#EXTINF:10.000, no desc', 'seg-100.ts',
      '#EXTINF:10.000, no desc', 'seg-101.ts',
      '#EXTINF:10.000, no desc', 'seg-102.ts',
    ].join('\n');
    const result = parseM3U(media, 'https://example.com/live/stream_hd.m3u8');
    expect(result.channels).toHaveLength(1); // the whole stream, not one channel per segment
    expect(result.channels[0].name).toBe('stream_hd');
    expect(result.channels[0].url).toBe('https://example.com/live/stream_hd.m3u8');
  });

  it('does not wrap an HLS stream when no source URL is supplied', () => {
    const hls = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'https://cdn/inner.m3u8'].join('\n');
    expect(parseM3U(hls).channels).toEqual([]);
  });

  it('wraps a bare DASH MPD as a single channel from the source URL', () => {
    const mpd = [
      '<?xml version="1.0"?>',
      '<!-- manifest -->',
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"></MPD>',
    ].join('\n');
    const result = parseM3U(mpd, 'http://host/live.mpd?token=1');
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].name).toBe('live');
    expect(result.channels[0].url).toBe('http://host/live.mpd?token=1');
    expect(result.groups).toEqual([UNCATEGORIZED_GROUP]);
    expect(result.format).toBe('dash');
    expect(result.issues).toEqual([]);
  });

  it('does not wrap a DASH MPD when no source URL is supplied', () => {
    const result = parseM3U('<MPD type="static"></MPD>');
    expect(result.channels).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      level: 'error',
      code: 'dash-without-source',
      line: 1,
    })]);
  });

  it('does not wrap a normal channel list (no HLS tags) even with a source URL', () => {
    const m3u = ['#EXTM3U', '#EXTINF:-1,Ch', 'http://e/1'].join('\n');
    const result = parseM3U(m3u, 'http://host/list.m3u');
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].name).toBe('Ch');
  });

  it('detects playlist, HLS and common wrong-document formats', () => {
    expect(detectPlaylistFormat('#EXTM3U\n#EXTINF:-1,Ch\nhttp://host/a').format)
      .toBe('extended-m3u');
    expect(detectPlaylistFormat('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1').format)
      .toBe('hls-master');
    expect(detectPlaylistFormat('#EXTM3U\n#EXT-X-TARGETDURATION:5').format)
      .toBe('hls-media');
    expect(detectPlaylistFormat('#extm3u\n#ext-x-endlist').format)
      .toBe('hls-media');
    expect(detectPlaylistFormat('<?xml version="1.0"?><MPD/>').format)
      .toBe('dash');
    expect(detectPlaylistFormat('<tv></tv>').format).toBe('xmltv');
    expect(detectPlaylistFormat('<html></html>').format).toBe('html');
    expect(detectPlaylistFormat('{"error":true}').format).toBe('json');
  });

  it('rejects a recognized non-playlist document with a structured issue', () => {
    const result = parseM3U('<html><body>Denied</body></html>');
    expect(result.channels).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      level: 'error',
      code: 'wrong-format',
      line: 1,
    })]);
  });

  it('decodes UTF-8 BOM and UTF-16 byte playlists', () => {
    const source = '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/a';
    const utf8 = new TextEncoder().encode(source);
    const utf8Bom = new Uint8Array(utf8.length + 3);
    utf8Bom.set([0xef, 0xbb, 0xbf]);
    utf8Bom.set(utf8, 3);
    expect(decodePlaylistBytes(utf8Bom)).toBe(source);

    const utf16Le = encodeUtf16(source, true);
    const utf16Be = encodeUtf16(source, false);
    expect(parseM3UBytes(utf16Le).channels[0].name).toBe('Alpha');
    expect(parseM3UBytes(utf16Be).channels[0].name).toBe('Alpha');
  });
});

function encodeUtf16(value: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(value.length * 2 + 2);
  bytes.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const offset = index * 2 + 2;
    bytes[offset] = littleEndian ? code & 0xff : code >> 8;
    bytes[offset + 1] = littleEndian ? code >> 8 : code & 0xff;
  }
  return bytes;
}
