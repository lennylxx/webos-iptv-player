export interface VirtualListOptions {
  itemSize?: number;
  overscan: number;
  fallbackViewportSize: number;
}

export interface VirtualRange {
  start: number;
  end: number;
}

export class VirtualList {
  private offset = 0;
  private readonly itemSize: number | null;
  private sizes = new Float64Array(0);
  private offsets = new Float64Array(1);
  private readonly overscan: number;
  readonly fallbackViewportSize: number;

  constructor(options: VirtualListOptions) {
    if (options.itemSize !== undefined && options.itemSize <= 0) {
      throw new RangeError('itemSize must be greater than zero');
    }
    if (options.overscan < 0) throw new RangeError('overscan must not be negative');
    if (options.fallbackViewportSize <= 0) {
      throw new RangeError('fallbackViewportSize must be greater than zero');
    }
    this.itemSize = options.itemSize ?? null;
    this.overscan = options.overscan;
    this.fallbackViewportSize = options.fallbackViewportSize;
  }

  get scrollOffset(): number {
    return this.offset;
  }

  setScrollOffset(offset: number): void {
    this.offset = Math.max(0, offset);
  }

  setItemSizes(sizes: number[]): void {
    if (this.itemSize !== null) {
      throw new Error('setItemSizes is only available for variable-size lists');
    }
    this.sizes = new Float64Array(sizes.length);
    for (let index = 0; index < sizes.length; index++) {
      const size = sizes[index];
      if (size <= 0) throw new RangeError('item sizes must be greater than zero');
      this.sizes[index] = size;
    }
    this.rebuildOffsets();
  }

  updateItemSizes(updates: Array<{ index: number; size: number }>): boolean {
    if (this.itemSize !== null) {
      throw new Error('updateItemSizes is only available for variable-size lists');
    }
    let changed = false;
    for (const update of updates) {
      if (update.index < 0 || update.index >= this.sizes.length) continue;
      if (update.size <= 0) throw new RangeError('item sizes must be greater than zero');
      if (Math.abs(this.sizes[update.index] - update.size) < 0.1) continue;
      this.sizes[update.index] = update.size;
      changed = true;
    }
    if (changed) this.rebuildOffsets();
    return changed;
  }

  getTotalSize(itemCount: number): number {
    if (this.itemSize !== null) return Math.max(0, itemCount) * this.itemSize;
    return this.offsets[Math.min(Math.max(0, itemCount), this.offsets.length - 1)];
  }

  getRange(itemCount: number, viewportSize = this.fallbackViewportSize): VirtualRange {
    if (this.itemSize === null) return this.getVariableRange(itemCount, viewportSize);
    const count = Math.max(0, itemCount);
    const visibleItems = Math.max(1, Math.ceil(viewportSize / this.itemSize));
    const requestedStart = Math.max(
      0,
      Math.floor(this.offset / this.itemSize) - this.overscan,
    );
    const start = Math.min(requestedStart, Math.max(0, count - visibleItems));
    const end = Math.min(count, start + visibleItems + this.overscan * 2);
    return { start, end };
  }

  getItemOffset(index: number): number {
    if (this.itemSize !== null) return Math.max(0, index) * this.itemSize;
    return this.offsets[Math.min(Math.max(0, index), this.offsets.length - 1)];
  }

  ensureVisible(index: number, viewportSize = this.fallbackViewportSize): boolean {
    if (index < 0) return false;
    const itemStart = this.getItemOffset(index);
    const itemEnd = this.itemSize !== null
      ? itemStart + this.itemSize
      : this.getItemOffset(index + 1);
    if (itemEnd <= itemStart) return false;
    let nextOffset = this.offset;
    if (itemStart < nextOffset) {
      nextOffset = itemStart;
    } else if (itemEnd > nextOffset + viewportSize) {
      nextOffset = itemEnd - viewportSize;
    }
    nextOffset = Math.max(0, nextOffset);
    if (nextOffset === this.offset) return false;
    this.offset = nextOffset;
    return true;
  }

  centerOn(index: number, viewportSize = this.fallbackViewportSize): void {
    const itemStart = this.getItemOffset(index);
    const itemEnd = this.itemSize !== null
      ? itemStart + this.itemSize
      : this.getItemOffset(index + 1);
    if (index < 0 || itemEnd <= itemStart) return;
    this.offset = Math.max(
      0,
      itemStart - (viewportSize - (itemEnd - itemStart)) / 2,
    );
  }

  private getVariableRange(itemCount: number, viewportSize: number): VirtualRange {
    const count = Math.min(Math.max(0, itemCount), this.offsets.length - 1);
    if (count === 0) return { start: 0, end: 0 };

    const first = this.itemAtOffset(Math.min(this.offset, this.offsets[count]), count);
    const visibleEnd = this.firstOffsetAtOrAfter(this.offset + viewportSize, count);
    return {
      start: Math.max(0, first - this.overscan),
      end: Math.min(count, Math.max(first + 1, visibleEnd) + this.overscan),
    };
  }

  private itemAtOffset(offset: number, count: number): number {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.offsets[middle + 1] <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, count - 1);
  }

  private firstOffsetAtOrAfter(offset: number, count: number): number {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.offsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private rebuildOffsets(): void {
    const offsets = new Float64Array(this.sizes.length + 1);
    for (let index = 0; index < this.sizes.length; index++) {
      offsets[index + 1] = offsets[index] + this.sizes[index];
    }
    this.offsets = offsets;
  }
}
