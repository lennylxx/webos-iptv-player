import { describe, expect, it } from 'vitest';
import { setDisplayTz } from '../../utils/time';
import { askPlan, askWindows, inWindows } from './time-window';

// Wednesday, 7 January 2026, 20:30 local time.
const NOW = new Date(2026, 0, 7, 20, 30).getTime();
const at = (day: number, hour: number): number => new Date(2026, 0, day, hour).getTime();

describe('askWindows', () => {
  it('has no window for any time without hours', () => {
    expect(askWindows('any', -1, -1, NOW)).toBeNull();
  });

  it('narrows tonight to the evening, and hours to today', () => {
    expect(askWindows('tonight', -1, -1, NOW)).toEqual([[at(7, 18), at(8, 0)]]);
    expect(askWindows('today', 9, 12, NOW)).toEqual([[at(7, 9), at(7, 12)]]);
  });

  it('runs a range that ends before it starts past midnight', () => {
    expect(askWindows('tomorrow', 22, 2, NOW)).toEqual([[at(8, 22), at(9, 2)]]);
  });

  it('finds the coming weekend and weekdays', () => {
    expect(askWindows('weekend', -1, -1, NOW)).toEqual([[at(10, 0), at(11, 0)], [at(11, 0), at(12, 0)]]);
    expect(askWindows('monday', -1, -1, NOW)).toEqual([[at(12, 0), at(13, 0)]]);
    expect(askWindows('wednesday', -1, -1, NOW)).toEqual([[at(7, 0), at(8, 0)]]);
    expect(askWindows('yesterday', -1, -1, NOW)).toEqual([[at(6, 0), at(7, 0)]]);
  });

  it('keeps only today when the weekend has reached Sunday', () => {
    const sunday = new Date(2026, 0, 11, 9).getTime();
    expect(askWindows('weekend', -1, -1, sunday)).toEqual([[at(11, 0), at(12, 0)]]);
  });

  it('matches what airs now', () => {
    const windows = askWindows('now', -1, -1, NOW)!;
    expect(inWindows(windows, at(7, 20), at(7, 21))).toBe(true);
    expect(inWindows(windows, at(7, 19), at(7, 20))).toBe(false);
  });
});

describe('askHours', () => {
  it('reads a single hour as that hour, not the whole day', () => {
    expect(askWindows('today', 20, 20, NOW)).toEqual([[at(7, 20), at(7, 21)]]);
  });

  it('reads a start of 24 as the next midnight', () => {
    expect(askWindows('today', 24, -1, NOW)).toEqual([[at(8, 0), at(8, 1)]]);
    expect(askWindows('today', 24, 2, NOW)).toEqual([[at(8, 0), at(8, 2)]]);
  });

  it('reads tonight before 04:00 as the night under way', () => {
    const late = new Date(2026, 0, 7, 1).getTime();
    expect(askWindows('tonight', -1, -1, late)).toEqual([[at(6, 18), at(7, 4)]]);
    expect(askWindows('tonight', 22, 2, late)).toEqual([[at(6, 22), at(7, 2)]]);
    expect(askWindows('tonight', -1, -1, new Date(2026, 0, 7, 4).getTime())).toEqual([[at(7, 18), at(8, 0)]]);
  });

  it('keeps a night past midnight that is under way', () => {
    expect(askWindows('any', 22, 2, new Date(2026, 0, 7, 0, 30).getTime())).toEqual([[at(6, 22), at(7, 2)]]);
  });

  it('moves hours without a day that have passed to tomorrow', () => {
    expect(askWindows('any', 20, 21, new Date(2026, 0, 7, 23).getTime())).toEqual([[at(8, 20), at(8, 21)]]);
    expect(askWindows('any', 20, 21, new Date(2026, 0, 7, 20, 30).getTime())).toEqual([[at(7, 20), at(7, 21)]]);
  });
});

describe('askWindows edge cases', () => {
  it('reads tonight with hours that ended in the small hours as this evening', () => {
    const late = new Date(2026, 0, 7, 1).getTime();
    expect(askWindows('tonight', 21, 21, late)).toEqual([[at(7, 21), at(7, 22)]]);
    expect(askWindows('tonight', 23, 1, new Date(2026, 0, 7, 3, 59).getTime())).toEqual([[at(7, 23), at(8, 1)]]);
    expect(askPlan('tonight', 21, -1, late)?.hours).toEqual([21, 28]);
  });

  it('reads an end of 0 alone as the end of the day', () => {
    expect(askWindows('today', -1, 0, NOW)).toEqual([[at(7, 0), at(8, 0)]]);
  });

  it('counts hours from the feed offset in feed time', () => {
    setDisplayTz('feed', 60);
    try {
      // 20:30 local on 7 January is the same instant; the feed day starts at 23:00 UTC.
      const windows = askWindows('today', 9, 10, Date.UTC(2026, 0, 7, 12))!;
      expect(windows).toEqual([[Date.UTC(2026, 0, 7, 8), Date.UTC(2026, 0, 7, 9)]]);
    } finally {
      setDisplayTz('device', null);
    }
  });

  it('has no window for an hour a spring-forward change skips', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const morning = new Date(2026, 2, 8, 0, 30).getTime();
      expect(askWindows('today', 2, 3, morning)).toEqual([]);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
