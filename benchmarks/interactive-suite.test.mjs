import { describe, expect, it } from 'vitest';
import { assertInteractiveFlow } from './interactive-suite.mjs';

const fixture = { m3uChannels: 10, liveEntries: 5 };
const liveReport = afterReady => ({
  live: { interactiveMs: { p50: 1 }, channels: { samples: [10, 10] }, afterReady },
});
const searchReport = ({ hits, partialCatalogs, settled }) => ({
  live: { interactiveMs: { p50: 1 }, channels: { samples: [5, 5] } },
  search: {
    firstCandidateMs: { p50: 1 },
    settled,
    partialCatalogs: { samples: partialCatalogs },
    hits: {
      channels: { samples: [1, 1] },
      movies: { samples: hits },
      series: { samples: hits },
    },
  },
});

describe('assertInteractiveFlow', () => {
  it('fails a run whose background work never went quiet', () => {
    expect(() => assertInteractiveFlow('m3u', liveReport({ keys: { min: 5 }, settled: [true, false] }), fixture))
      .toThrow('m3u never went quiet');
    expect(() => assertInteractiveFlow('searchSteady', searchReport({
      hits: [1, 1], partialCatalogs: [0, 0], settled: [false, true],
    }), fixture)).toThrow('searchSteady never went quiet');
  });

  it('checks the channel count only of runs that report one', () => {
    const report = channels => ({
      live: {
        interactiveMs: { p50: 1 },
        channels,
        afterReady: { keys: { min: 5 }, settled: [true, true] },
      },
    });
    expect(() => assertInteractiveFlow('m3u', report({ samples: [10, null] }), fixture)).not.toThrow();
    expect(() => assertInteractiveFlow('m3u', report([null, null]), fixture)).not.toThrow();
    expect(() => assertInteractiveFlow('m3u', report({ samples: [null, 7] }), fixture))
      .toThrow('m3u showed 7 of 10 channels');
  });

  it('requires movie and series needles only from complete catalogs', () => {
    expect(() => assertInteractiveFlow('searchCold', searchReport({
      hits: [0, 1], partialCatalogs: [2, 0],
    }), fixture)).not.toThrow();
    expect(() => assertInteractiveFlow('searchCold', searchReport({
      hits: [1, 0], partialCatalogs: [2, 0],
    }), fixture)).toThrow('searchCold found no movies needle');
  });
});
