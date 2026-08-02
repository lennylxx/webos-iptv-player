import { describe, expect, it } from 'vitest';
import { VirtualGrid } from './virtual-grid';

function createGrid(): VirtualGrid {
  return new VirtualGrid({
    columnStride: 250,
    rowStride: 400,
    overscanRows: 1,
    fallbackViewportWidth: 1000,
    fallbackViewportHeight: 800,
  });
}

describe('VirtualGrid', () => {
  it('calculates columns, rows and a bounded window for 50,000 items', () => {
    const grid = createGrid();

    expect(grid.getColumnCount()).toBe(4);
    expect(grid.getRowCount(50_000)).toBe(12_500);
    expect(grid.getTotalSize(50_000)).toBe(5_000_000);
    expect(grid.getRange(50_000)).toEqual({
      start: 0,
      end: 16,
      startRow: 0,
      endRow: 4,
      columns: 4,
    });
  });

  it('updates item ranges and absolute positions after scrolling', () => {
    const grid = createGrid();
    grid.setScrollOffset(4000);

    expect(grid.getRange(50_000)).toEqual({
      start: 36,
      end: 52,
      startRow: 9,
      endRow: 13,
      columns: 4,
    });
    expect(grid.getItemPosition(38, 4)).toEqual({ left: 500, top: 3600 });
  });

  it('keeps grid navigation within rows and item bounds', () => {
    const grid = createGrid();

    expect(grid.getAdjacentIndex(4, 'left', 10)).toBe(4);
    expect(grid.getAdjacentIndex(4, 'right', 10)).toBe(5);
    expect(grid.getAdjacentIndex(8, 'down', 10)).toBe(8);
    expect(grid.getAdjacentIndex(9, 'right', 10)).toBe(9);
    expect(grid.getAdjacentIndex(1, 'up', 10)).toBe(1);
  });

  it('scrolls the focused row into view', () => {
    const grid = createGrid();

    expect(grid.ensureVisible(12)).toBe(true);
    expect(grid.scrollOffset).toBe(800);
    grid.centerOn(40);
    expect(grid.scrollOffset).toBe(3800);
  });
});
