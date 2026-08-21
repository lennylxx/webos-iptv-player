import { describe, expect, it } from 'vitest';
import {
  containerMime,
  mpdOpeningVerdict,
  sniffStreamContentType,
  streamMime,
  streamUrlMime,
} from './url';

const DASH = 'application/dash+xml';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// A synthetic TS payload: 0x47 sync bytes at the packet stride the sniffer scans.
function tsPrefix(packetSize: number, payload = ''): Uint8Array {
  const buffer = new Uint8Array(packetSize * 3 + 1);
  buffer[0] = 0x47;
  buffer[packetSize] = 0x47;
  buffer[packetSize * 2] = 0x47;
  buffer.set(bytes(payload), 1);
  return buffer;
}

describe('streamUrlMime', () => {
  it('keeps the existing TS, FLV and HLS classifications', () => {
    expect(streamUrlMime('http://host/a.ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a?extension=ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a?output=ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a?output_format=ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a.flv')).toBe('video/x-flv');
    expect(streamUrlMime('http://host/a.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/a?output=m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/a?output_format=m3u8'))
      .toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/a')).toBe('');
  });

  it('classifies an .mpd URL as DASH', () => {
    expect(streamUrlMime('http://host/a.mpd')).toBe(DASH);
    expect(streamUrlMime('http://host/a.MPD')).toBe(DASH);
    expect(streamUrlMime('http://host/a.mpd?token=1')).toBe(DASH);
    expect(streamUrlMime('http://host/a.mpd#f')).toBe(DASH);
  });

  it('classifies a requested mpd format as DASH', () => {
    expect(streamUrlMime('http://host/a?extension=mpd')).toBe(DASH);
    expect(streamUrlMime('http://host/a?x=1&output=mpd')).toBe(DASH);
    expect(streamUrlMime('http://host/a?output_format=mpd&x=1')).toBe(DASH);
  });

  it('does not classify a path that merely contains mpd', () => {
    expect(streamUrlMime('http://host/mpd/a')).toBe('');
    expect(streamUrlMime('http://host/a.mpd2')).toBe('');
  });
});

describe('streamMime', () => {
  it('classifies the DASH content types', () => {
    expect(streamMime('application/dash+xml')).toBe(DASH);
    expect(streamMime('Application/DASH+XML; charset=utf-8')).toBe(DASH);
    expect(streamMime('application/vnd.mpeg.dash.mpd')).toBe(DASH);
  });

  it('keeps the existing classifications', () => {
    expect(streamMime('video/mp2t')).toBe('video/mp2t');
    expect(streamMime('application/vnd.apple.mpegurl')).toBe('application/vnd.apple.mpegurl');
    expect(streamMime('text/html')).toBe('');
  });
});

describe('sniffStreamContentType', () => {
  it('sniffs an MPD served as octet-stream', () => {
    expect(sniffStreamContentType('application/octet-stream',
      bytes('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream', bytes('<MPD '))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream',
      bytes('\uFEFF\n  <?xml version="1.0" encoding="UTF-8"?>\n<MPD>'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream',
      bytes('<?xml version="1.0"?>\n<!-- c -->\n<MPD>'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream', bytes('<dash:MPD/>')))
      .toBe(DASH);
    expect(sniffStreamContentType('application/xml', bytes('<MPD/>'))).toBe(DASH);
    expect(sniffStreamContentType('text/xml', bytes('<?xml version="1.0"?><MPD/>')))
      .toBe(DASH);
  });

  describe('mpdOpeningVerdict', () => {
    it('accepts legal MPD preambles split across chunks', () => {
      expect(mpdOpeningVerdict(bytes(' \n<!-- lead'), false)).toBe('undecided');
      expect(mpdOpeningVerdict(
        bytes(' \n<!-- lead -->\n<?xml version="1.0"?>\n<dash:MPD>'),
        false,
      )).toBe('match');
    });

    it('rejects a completed non-MPD root', () => {
      expect(mpdOpeningVerdict(bytes('<html><body>error</body>'), false))
        .toBe('mismatch');
    });
  });

  it('leaves other XML alone', () => {
    expect(sniffStreamContentType('application/octet-stream',
      bytes('<?xml version="1.0"?><error>no</error>')))
      .toBe('application/octet-stream');
    expect(sniffStreamContentType('application/xml', bytes('<error>no</error>')))
      .toBe('application/xml');
  });

  it('prefers a TS payload that happens to carry MPD bytes', () => {
    expect(sniffStreamContentType('application/octet-stream', tsPrefix(188, '<MPD')))
      .toBe('video/mp2t');
    expect(sniffStreamContentType('application/octet-stream', tsPrefix(192)))
      .toBe('video/mp2t');
  });

  it('keeps a declared content type', () => {
    expect(sniffStreamContentType('application/dash+xml', bytes('<MPD>'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream', bytes('#EXTM3U\n')))
      .toBe('application/vnd.apple.mpegurl');
  });
});

describe('containerMime', () => {
  it('never treats an MPD as a progressive container', () => {
    expect(containerMime('http://host/a.mpd')).toBe('');
    expect(containerMime('http://host/a.mp4')).toBe('video/mp4');
  });
});
