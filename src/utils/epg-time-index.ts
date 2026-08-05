import type { Programme } from '../types';

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function sortProgrammes(programmes: Programme[]): Programme[] {
  for (let i = 1; i < programmes.length; i++) {
    if (programmes[i - 1].start.getTime() <= programmes[i].start.getTime()) continue;
    return programmes
      .map((programme, index) => ({ programme, index }))
      .sort((a, b) => a.programme.start.getTime() - b.programme.start.getTime()
        || a.index - b.index)
      .map(item => item.programme);
  }
  return programmes;
}

export class EpgTimeIndex {
  readonly programmes: Programme[];
  private readonly starts: number[];
  private readonly maxStops: number[];

  constructor(programmes: Programme[]) {
    this.programmes = sortProgrammes(programmes);
    this.starts = new Array<number>(this.programmes.length);
    this.maxStops = new Array<number>(this.programmes.length);
    let maxStop = -Infinity;
    for (let i = 0; i < this.programmes.length; i++) {
      const programme = this.programmes[i];
      this.starts[i] = programme.start.getTime();
      maxStop = Math.max(maxStop, programme.stop.getTime());
      this.maxStops[i] = maxStop;
    }
  }

  firstEndingAfter(timestamp: number): Programme | null {
    return this.programmes[upperBound(this.maxStops, timestamp)] ?? null;
  }

  currentAt(timestamp: number): Programme | null {
    const first = upperBound(this.maxStops, timestamp);
    for (let i = first; i < this.programmes.length && this.starts[i] <= timestamp; i++) {
      if (this.programmes[i].stop.getTime() > timestamp) return this.programmes[i];
    }
    return null;
  }

  startingInRange(from: number, to: number): Programme[] {
    if (to <= from) return [];
    return this.programmes.slice(lowerBound(this.starts, from), lowerBound(this.starts, to));
  }

  intersectingRange(from: number, to: number): Programme[] {
    if (to <= from) return [];
    const result: Programme[] = [];
    const first = upperBound(this.maxStops, from);
    for (let i = first; i < this.programmes.length && this.starts[i] < to; i++) {
      if (this.programmes[i].stop.getTime() > from) result.push(this.programmes[i]);
    }
    return result;
  }

  upcomingAfter(timestamp: number, count: number): Programme[] {
    if (count <= 0) return [];
    const first = upperBound(this.starts, timestamp);
    return this.programmes.slice(first, first + count);
  }

  atStart(timestamp: number): Programme | null {
    const index = lowerBound(this.starts, timestamp);
    return this.starts[index] === timestamp ? this.programmes[index] : null;
  }
}
