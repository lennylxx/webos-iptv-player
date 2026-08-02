import type { NavDirection } from '../types';
import { VirtualList, type VirtualRange } from './virtual-list';

export interface VirtualGridOptions {
  columnStride: number;
  rowStride: number;
  overscanRows: number;
  fallbackViewportWidth: number;
  fallbackViewportHeight: number;
}

export interface VirtualGridRange extends VirtualRange {
  startRow: number;
  endRow: number;
  columns: number;
}

export interface VirtualGridPosition {
  left: number;
  top: number;
}

export class VirtualGrid {
  private readonly rows: VirtualList;
  private readonly columnStride: number;
  readonly fallbackViewportWidth: number;
  readonly fallbackViewportHeight: number;

  constructor(options: VirtualGridOptions) {
    if (options.columnStride <= 0) throw new RangeError('columnStride must be greater than zero');
    if (options.fallbackViewportWidth <= 0) {
      throw new RangeError('fallbackViewportWidth must be greater than zero');
    }
    this.columnStride = options.columnStride;
    this.fallbackViewportWidth = options.fallbackViewportWidth;
    this.fallbackViewportHeight = options.fallbackViewportHeight;
    this.rows = new VirtualList({
      itemSize: options.rowStride,
      overscan: options.overscanRows,
      fallbackViewportSize: options.fallbackViewportHeight,
    });
  }

  get scrollOffset(): number {
    return this.rows.scrollOffset;
  }

  setScrollOffset(offset: number): void {
    this.rows.setScrollOffset(offset);
  }

  getColumnCount(viewportWidth = this.fallbackViewportWidth): number {
    return Math.max(1, Math.floor(viewportWidth / this.columnStride));
  }

  getRowCount(itemCount: number, viewportWidth = this.fallbackViewportWidth): number {
    return Math.ceil(Math.max(0, itemCount) / this.getColumnCount(viewportWidth));
  }

  getTotalSize(itemCount: number, viewportWidth = this.fallbackViewportWidth): number {
    return this.rows.getTotalSize(this.getRowCount(itemCount, viewportWidth));
  }

  getRange(
    itemCount: number,
    viewportWidth = this.fallbackViewportWidth,
    viewportHeight = this.fallbackViewportHeight,
  ): VirtualGridRange {
    const columns = this.getColumnCount(viewportWidth);
    const rowRange = this.rows.getRange(this.getRowCount(itemCount, viewportWidth), viewportHeight);
    return {
      start: Math.min(itemCount, rowRange.start * columns),
      end: Math.min(itemCount, rowRange.end * columns),
      startRow: rowRange.start,
      endRow: rowRange.end,
      columns,
    };
  }

  getItemPosition(index: number, columns: number): VirtualGridPosition {
    const safeIndex = Math.max(0, index);
    return {
      left: (safeIndex % columns) * this.columnStride,
      top: this.rows.getItemOffset(Math.floor(safeIndex / columns)),
    };
  }

  ensureVisible(
    index: number,
    viewportWidth = this.fallbackViewportWidth,
    viewportHeight = this.fallbackViewportHeight,
  ): boolean {
    const row = Math.floor(index / this.getColumnCount(viewportWidth));
    return this.rows.ensureVisible(row, viewportHeight);
  }

  centerOn(
    index: number,
    viewportWidth = this.fallbackViewportWidth,
    viewportHeight = this.fallbackViewportHeight,
  ): void {
    const row = Math.floor(index / this.getColumnCount(viewportWidth));
    this.rows.centerOn(row, viewportHeight);
  }

  getAdjacentIndex(
    index: number,
    direction: NavDirection,
    itemCount: number,
    viewportWidth = this.fallbackViewportWidth,
  ): number {
    if (itemCount <= 0) return -1;
    const current = Math.max(0, Math.min(index, itemCount - 1));
    const columns = this.getColumnCount(viewportWidth);
    switch (direction) {
      case 'left':
        return current % columns === 0 ? current : current - 1;
      case 'right':
        return current % columns === columns - 1 || current === itemCount - 1
          ? current
          : current + 1;
      case 'up':
        return current - columns < 0 ? current : current - columns;
      case 'down':
        return current + columns >= itemCount ? current : current + columns;
    }
  }
}
