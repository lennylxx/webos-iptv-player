import { describe, expect, it } from 'vitest';
import { VirtualList } from './virtual-list';

function createList(): VirtualList {
  return new VirtualList({
    itemSize: 100,
    overscan: 2,
    fallbackViewportSize: 300,
  });
}

describe('VirtualList', () => {
  it('calculates total size and an overscanned visible range', () => {
    const list = createList();

    expect(list.getTotalSize(20)).toBe(2000);
    expect(list.getRange(20)).toEqual({ start: 0, end: 7 });

    list.setScrollOffset(600);
    expect(list.getRange(20)).toEqual({ start: 4, end: 11 });
  });

  it('keeps the rendered window bounded for 50,000 items', () => {
    const list = createList();
    list.setScrollOffset(2_500_000);

    const range = list.getRange(50_000);
    expect(range.end - range.start).toBe(7);
    expect(range.start).toBeGreaterThan(20_000);
    expect(list.getTotalSize(50_000)).toBe(5_000_000);
  });

  it('clamps a stale offset to the final visible window after data shrinks', () => {
    const list = createList();
    list.setScrollOffset(2_500_000);

    expect(list.getRange(5)).toEqual({ start: 2, end: 5 });
  });

  it('moves only enough to reveal an item', () => {
    const list = createList();

    expect(list.ensureVisible(2)).toBe(false);
    expect(list.ensureVisible(3)).toBe(true);
    expect(list.scrollOffset).toBe(100);
    expect(list.ensureVisible(0)).toBe(true);
    expect(list.scrollOffset).toBe(0);
  });

  it('centers an item and clamps offsets at the start', () => {
    const list = createList();

    list.centerOn(5);
    expect(list.scrollOffset).toBe(400);

    list.centerOn(0);
    expect(list.scrollOffset).toBe(0);
  });

  it('rejects invalid sizing options', () => {
    expect(() => new VirtualList({
      itemSize: 0,
      overscan: 0,
      fallbackViewportSize: 300,
    })).toThrow(RangeError);
    expect(() => new VirtualList({
      itemSize: 100,
      overscan: -1,
      fallbackViewportSize: 300,
    })).toThrow(RangeError);
  });

  it('calculates offsets and ranges from mixed item sizes', () => {
    const list = new VirtualList({
      overscan: 1,
      fallbackViewportSize: 200,
    });
    list.setItemSizes([88, 100, 88, 100]);

    expect(list.getTotalSize(4)).toBe(376);
    expect([0, 1, 2, 3].map(index => list.getItemOffset(index)))
      .toEqual([0, 88, 188, 276]);
    list.setScrollOffset(190);
    expect(list.getRange(4, 80)).toEqual({ start: 1, end: 4 });
  });

  it('keeps a mixed 50,000-item window bounded', () => {
    const list = new VirtualList({
      overscan: 1,
      fallbackViewportSize: 200,
    });
    list.setItemSizes(Array.from({ length: 50_000 }, (_, index) =>
      index % 2 === 0 ? 88 : 100));
    list.setScrollOffset(2_350_000);

    const range = list.getRange(50_000);
    expect(range.end - range.start).toBeLessThan(6);
    expect(range.start).toBeGreaterThan(20_000);
    expect(list.getTotalSize(50_000)).toBe(4_700_000);
  });

  it('updates measured variable sizes and all following offsets', () => {
    const list = new VirtualList({
      overscan: 1,
      fallbackViewportSize: 200,
    });
    list.setItemSizes([100, 100, 100]);

    expect(list.updateItemSizes([{ index: 1, size: 140 }])).toBe(true);
    expect(list.getItemOffset(2)).toBe(240);
    expect(list.getTotalSize(3)).toBe(340);
    expect(list.updateItemSizes([{ index: 1, size: 140 }])).toBe(false);
    expect(() => list.setItemSizes([100, 0])).toThrow(RangeError);
  });
});
