import { describe, expect, it } from 'vitest';
import { mediaOptionSourceType, parseMediaOption } from './webos-media-option';

describe('mediaOptionSourceType', () => {
  it('carries the transport override on a platform-supported MIME', () => {
    const type = mediaOptionSourceType('video/mp4', { mediaTransportType: 'MPEG-DASH' });
    expect(type.split(';')[0]).toBe('video/mp4');
    expect(parseMediaOption(type)).toEqual({ mediaTransportType: 'MPEG-DASH' });
  });

  it('url-encodes the JSON so it survives the type parameter list', () => {
    const type = mediaOptionSourceType('video/mp4', { mediaTransportType: 'MPEG-DASH' });
    const value = type.slice(type.indexOf('mediaOption=') + 'mediaOption='.length);
    expect(value).not.toContain('"');
    expect(value).not.toContain(';');
    expect(value).not.toContain(' ');
  });

  it('never emits the DASH manifest MIME, which the platform rejects', () => {
    const type = mediaOptionSourceType('video/mp4', { mediaTransportType: 'MPEG-DASH' });
    expect(type).not.toContain('application/dash+xml');
  });
});
