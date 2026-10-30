import type { SeriesItem, VodItem } from '../types';

// A whole movie or series catalog stored by column: each text field is one
// string with the end offset of every value, and poster URLs share their
// directory. A large panel lists a few hundred thousand titles, which as one
// object per title take several times the memory and storage of this layout.

export const CATALOG_COLUMNS_FORMAT = 1;

export interface PackedText {
  text: string;
  ends: Uint32Array;
}

export interface CatalogColumns {
  format: number;
  kind: 'vod' | 'series';
  accountId: string;
  length: number;
  ids: PackedText;
  names: PackedText;
  categoryIds: PackedText;
  ratings: PackedText;
  /** Movies only. */
  extensions: PackedText | null;
  posterBases: string[];
  posterBase: Uint32Array;
  posterRest: PackedText;
  /** NaN when the panel sent none. */
  addedAt: Float64Array;
  /** 0 when the panel sent none. */
  years: Uint16Array;
}

export function packedValue(packed: PackedText, index: number): string {
  return packed.text.slice(index ? packed.ends[index - 1] : 0, packed.ends[index]);
}

class PackedTextBuilder {
  private readonly parts: string[] = [];
  private readonly ends: number[] = [];
  private end = 0;

  add(value: string): void {
    this.parts.push(value);
    this.end += value.length;
    this.ends.push(this.end);
  }

  build(): PackedText {
    return { text: this.parts.join(''), ends: new Uint32Array(this.ends) };
  }
}

export interface CatalogRow {
  id: string;
  name: string;
  poster: string;
  rating: string;
  categoryId: string;
  containerExtension?: string;
  addedAt?: number;
  year?: number;
}

// Rows are added as they are parsed, so no list of row objects ever exists.
// A repeated id keeps its first row, as the panel lists a title once per
// category it belongs to.
export class CatalogColumnsBuilder {
  private readonly ids = new PackedTextBuilder();
  private readonly names = new PackedTextBuilder();
  private readonly categoryIds = new PackedTextBuilder();
  private readonly ratings = new PackedTextBuilder();
  private readonly extensions: PackedTextBuilder | null;
  private readonly posterBases: string[] = [];
  private readonly posterBaseIndex = new Map<string, number>();
  private readonly posterBase: number[] = [];
  private readonly posterRest = new PackedTextBuilder();
  private readonly addedAt: number[] = [];
  private readonly years: number[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly kind: 'vod' | 'series', private readonly accountId: string) {
    this.extensions = kind === 'vod' ? new PackedTextBuilder() : null;
  }

  get length(): number {
    return this.addedAt.length;
  }

  add(row: CatalogRow): void {
    if (!row.id || this.seen.has(row.id)) return;
    this.seen.add(row.id);
    this.ids.add(row.id);
    this.names.add(row.name);
    this.categoryIds.add(row.categoryId);
    this.ratings.add(row.rating);
    if (this.extensions) this.extensions.add(row.containerExtension ?? '');
    const split = row.poster.lastIndexOf('/') + 1;
    const base = row.poster.slice(0, split);
    let baseIndex = this.posterBaseIndex.get(base);
    if (baseIndex === undefined) {
      baseIndex = this.posterBases.length;
      this.posterBases.push(base);
      this.posterBaseIndex.set(base, baseIndex);
    }
    this.posterBase.push(baseIndex);
    this.posterRest.add(row.poster.slice(split));
    this.addedAt.push(row.addedAt === undefined ? NaN : row.addedAt);
    this.years.push(row.year && row.year > 0 && row.year < 65536 ? row.year : 0);
  }

  build(): CatalogColumns {
    return {
      format: CATALOG_COLUMNS_FORMAT,
      kind: this.kind,
      accountId: this.accountId,
      length: this.length,
      ids: this.ids.build(),
      names: this.names.build(),
      categoryIds: this.categoryIds.build(),
      ratings: this.ratings.build(),
      extensions: this.extensions ? this.extensions.build() : null,
      posterBases: this.posterBases,
      posterBase: new Uint32Array(this.posterBase),
      posterRest: this.posterRest.build(),
      addedAt: new Float64Array(this.addedAt),
      years: new Uint16Array(this.years),
    };
  }
}

function validPacked(value: unknown, length: number): value is PackedText {
  const packed = value as PackedText | null;
  return !!packed && typeof packed.text === 'string' && packed.ends instanceof Uint32Array
    && packed.ends.length === length
    && (length ? packed.ends[length - 1] : 0) === packed.text.length;
}

/** False for anything an older version stored, or a damaged record. */
export function isCatalogColumns(value: unknown, kind: 'vod' | 'series'): value is CatalogColumns {
  const columns = value as CatalogColumns | null;
  if (!columns || typeof columns !== 'object' || columns.format !== CATALOG_COLUMNS_FORMAT
      || columns.kind !== kind || typeof columns.accountId !== 'string'
      || typeof columns.length !== 'number') {
    return false;
  }
  const { length } = columns;
  return validPacked(columns.ids, length) && validPacked(columns.names, length)
    && validPacked(columns.categoryIds, length) && validPacked(columns.ratings, length)
    && (kind === 'vod' ? validPacked(columns.extensions, length) : columns.extensions === null)
    && Array.isArray(columns.posterBases)
    && columns.posterBase instanceof Uint32Array && columns.posterBase.length === length
    && validPacked(columns.posterRest, length)
    && columns.addedAt instanceof Float64Array && columns.addedAt.length === length
    && columns.years instanceof Uint16Array && columns.years.length === length;
}

function samePacked(left: PackedText | null, right: PackedText | null): boolean {
  if (!left || !right) return left === right;
  return left.text === right.text && sameNumbers(left.ends, right.ends);
}

function sameNumbers(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    // NaN marks an absent value, so two absent values match.
    if (left[i] !== right[i] && !(left[i] !== left[i] && right[i] !== right[i])) return false;
  }
  return true;
}

export function sameCatalogColumns(left: CatalogColumns, right: CatalogColumns): boolean {
  if (left.length !== right.length || left.kind !== right.kind || left.accountId !== right.accountId
      || left.posterBases.length !== right.posterBases.length) {
    return false;
  }
  for (let i = 0; i < left.posterBases.length; i++) {
    if (left.posterBases[i] !== right.posterBases[i]) return false;
  }
  return samePacked(left.ids, right.ids) && samePacked(left.names, right.names)
    && samePacked(left.categoryIds, right.categoryIds) && samePacked(left.ratings, right.ratings)
    && samePacked(left.extensions, right.extensions)
    && sameNumbers(left.posterBase, right.posterBase) && samePacked(left.posterRest, right.posterRest)
    && sameNumbers(left.addedAt, right.addedAt) && sameNumbers(left.years, right.years);
}

/**
 * A read-only view of a stored catalog, optionally narrowed to a selection.
 * Rows become item objects only when asked for, such as for the results
 * on screen.
 */
export class CatalogTable<T extends VodItem | SeriesItem> {
  readonly length: number;

  constructor(
    readonly columns: CatalogColumns | null,
    private readonly selection: Uint32Array | null = null,
  ) {
    this.length = selection ? selection.length : columns ? columns.length : 0;
  }

  /** Position in the stored columns of view row `index`. */
  rowOf(index: number): number {
    return this.selection ? this.selection[index] : index;
  }

  nameAt(index: number): string {
    return packedValue(this.columns!.names, this.rowOf(index));
  }

  idAt(index: number): string {
    return packedValue(this.columns!.ids, this.rowOf(index));
  }

  categoryIdAt(index: number): string {
    return packedValue(this.columns!.categoryIds, this.rowOf(index));
  }

  item(index: number): T | undefined {
    const columns = this.columns;
    if (!columns || index < 0 || index >= this.length) return undefined;
    const row = this.rowOf(index);
    const addedAt = columns.addedAt[row];
    const year = columns.years[row];
    const common = {
      accountId: columns.accountId,
      name: packedValue(columns.names, row),
      poster: columns.posterBases[columns.posterBase[row]] + packedValue(columns.posterRest, row),
      rating: packedValue(columns.ratings, row),
      categoryId: packedValue(columns.categoryIds, row),
      ...(addedAt === addedAt ? { addedAt } : {}),
      ...(year ? { year } : {}),
    };
    const id = packedValue(columns.ids, row);
    if (columns.kind === 'vod') {
      return {
        ...common,
        streamId: id,
        containerExtension: columns.extensions ? packedValue(columns.extensions, row) : '',
      } as T;
    }
    return { ...common, seriesId: id } as T;
  }

  /** The rows `keep` accepts, in order; every row stays when `keep` is null. */
  select(keep: ((item: T) => boolean) | null): CatalogTable<T> {
    if (!keep) return this;
    const selection = new Uint32Array(this.length);
    let count = 0;
    for (let i = 0; i < this.length; i++) {
      if (keep(this.item(i)!)) selection[count++] = this.rowOf(i);
    }
    return new CatalogTable<T>(this.columns, selection.slice(0, count));
  }

  /** The selection behind this view, or null when it shows every row. */
  rows(): Uint32Array | null {
    return this.selection;
  }
}

export function emptyCatalogTable<T extends VodItem | SeriesItem>(): CatalogTable<T> {
  return new CatalogTable<T>(null);
}
