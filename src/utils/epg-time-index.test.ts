import { describe, expect, it } from 'vitest';
import type { Programme } from '../types';
import { EpgTimeIndex } from './epg-time-index';

function programme(start: number, stop: number, title = `${String(start)}-${String(stop)}`): Programme {
  return {
    start: new Date(start),
    stop: new Date(stop),
    title,
    description: '',
    category: '',
    icon: '',
  };
}

describe('EpgTimeIndex', () => {
  it('handles empty and single-programme schedules at exact boundaries', () => {
    const empty = new EpgTimeIndex([]);
    expect(empty.currentAt(10)).toBeNull();
    expect(empty.upcomingAfter(10, 5)).toEqual([]);
    expect(empty.startingInRange(0, 20)).toEqual([]);

    const only = programme(10, 20);
    const index = new EpgTimeIndex([only]);
    expect(index.currentAt(9)).toBeNull();
    expect(index.currentAt(10)).toBe(only);
    expect(index.currentAt(19)).toBe(only);
    expect(index.currentAt(20)).toBeNull();
    expect(index.firstEndingAfter(19)).toBe(only);
    expect(index.firstEndingAfter(20)).toBeNull();
  });

  it('normalizes unsorted input while preserving duplicate-start order', () => {
    const later = programme(30, 40, 'Later');
    const firstDuplicate = programme(10, 20, 'First duplicate');
    const secondDuplicate = programme(10, 25, 'Second duplicate');
    const index = new EpgTimeIndex([later, firstDuplicate, secondDuplicate]);

    expect(index.programmes.map(item => item.title))
      .toEqual(['First duplicate', 'Second duplicate', 'Later']);
    expect(index.atStart(10)).toBe(firstDuplicate);
  });

  it('finds overlapping programmes and programmes crossing range boundaries', () => {
    const long = programme(0, 100, 'Long');
    const short = programme(10, 20, 'Short');
    const future = programme(40, 50, 'Future');
    const index = new EpgTimeIndex([long, short, future]);

    expect(index.currentAt(30)).toBe(long);
    expect(index.intersectingRange(20, 40)).toEqual([long]);
    expect(index.intersectingRange(19, 41)).toEqual([long, short, future]);
    expect(index.startingInRange(10, 40)).toEqual([short]);
  });

  it('returns strictly upcoming programmes with a count cap', () => {
    const atBoundary = programme(10, 20);
    const next = programme(20, 30);
    const later = programme(30, 40);
    const index = new EpgTimeIndex([atBoundary, next, later]);

    expect(index.upcomingAfter(10, 1)).toEqual([next]);
    expect(index.upcomingAfter(10, 0)).toEqual([]);
  });

  it('matches linear lookups over a large generated overlapping schedule', () => {
    const input: Programme[] = [];
    for (let i = 1999; i >= 0; i--) {
      const start = i * 10;
      input.push(programme(start, start + 5 + (i % 7) * 4));
    }
    const sorted = input.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
    const index = new EpgTimeIndex(input);

    for (let timestamp = 0; timestamp < 20000; timestamp += 137) {
      const expectedCurrent = sorted.find(item =>
        item.start.getTime() <= timestamp && item.stop.getTime() > timestamp) ?? null;
      const expectedUpcoming = sorted
        .filter(item => item.start.getTime() > timestamp)
        .slice(0, 7);
      expect(index.currentAt(timestamp)).toBe(expectedCurrent);
      expect(index.upcomingAfter(timestamp, 7)).toEqual(expectedUpcoming);
    }

    for (let from = 0; from < 20000; from += 311) {
      const to = from + 173;
      expect(index.intersectingRange(from, to)).toEqual(sorted.filter(item =>
        item.stop.getTime() > from && item.start.getTime() < to));
      expect(index.startingInRange(from, to)).toEqual(sorted.filter(item =>
        item.start.getTime() >= from && item.start.getTime() < to));
    }
  });
});
