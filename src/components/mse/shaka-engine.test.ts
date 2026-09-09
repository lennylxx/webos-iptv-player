import { describe, expect, it, vi } from 'vitest';
import { createShakaEngine, type ShakaPlayerLike } from './shaka-engine';

describe('Shaka stream information', () => {
  it.each([
    ['ec-3', true, true],
    [' EC-3 ', true, true],
    ['ec-3', false, false],
    ['ec-3', undefined, false],
    ['ac-4', true, false],
    ['mp4a.40.2', true, false],
  ] as const)('maps codec %s and spatialAudio %s to Atmos %s', (audioCodec, spatialAudio, expected) => {
    const track = {
      active: true, audioCodec, spatialAudio, channelsCount: 6,
      videoCodec: 'dvh1.05.06', hdr: 'PQ', frameRate: 59.94,
    };
    const player: ShakaPlayerLike = {
      getAudioTracks: () => [],
      getTextTracks: () => [],
      getVariantTracks: () => [track],
      selectAudioTrack: vi.fn(),
      selectTextTrack: vi.fn(),
      destroy: vi.fn(),
    };
    const engine = createShakaEngine(player);
    expect(engine.streamInfo()).toEqual({
      videoCodec: 'dvh1.05.06', audioCodec, videoRange: 'PQ',
      frameRate: 59.94, audioChannels: '6', audioAtmos: expected,
    });
    track.active = false;
    expect(engine.streamInfo()).toBeNull();
  });
});
