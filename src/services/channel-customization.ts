import type { Channel, ChannelCustomization, ChannelOverride, GroupOverride } from '../types';
import { channelCustomizationKey } from '../utils/channel';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { StorageService } from './storage-service';

const log = createLogger('ChannelCustom');

function emptyRecord(): ChannelCustomization {
  return {
    version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
    overrides: {},
    order: [],
    groupOrder: [],
    groupOverrides: {},
    customGroups: [],
  };
}

/**
 * Local channel customization: reorder, hide, rename, and regroup channels and
 * groups without touching the source playlists.
 *
 * Everything is keyed by `channelCustomizationKey(ch)` (per stream) and by a
 * group key (the source group name, or a user-created one), so a provider
 * reordering or renaming channels never re-points a customization.
 */
class ChannelCustomizationServiceImpl {
  private data: ChannelCustomization | null = null;

  private get record(): ChannelCustomization {
    if (!this.data) this.data = StorageService.getChannelCustomization() ?? emptyRecord();
    return this.data;
  }

  private persist(): void {
    if (this.data) StorageService.setChannelCustomization(this.data);
  }

  /** Drop the memoized record so the next read comes from storage. */
  reload(): void {
    this.data = null;
  }

  /** False when nothing has been customized — the untouched-install fast path. */
  get customized(): boolean {
    const d = this.record;
    return d.order.length > 0
      || d.groupOrder.length > 0
      || d.customGroups.length > 0
      || Object.keys(d.overrides).length > 0
      || Object.keys(d.groupOverrides).length > 0;
  }

  reset(): void {
    this.data = emptyRecord();
    StorageService.clearChannelCustomization();
    log.info('Customization reset');
  }

  // --- Per-channel state

  overrideFor(key: string): ChannelOverride | null {
    return this.record.overrides[key] ?? null;
  }

  isHidden(key: string): boolean {
    return this.record.overrides[key]?.hidden === true;
  }

  /** True when the channel is hidden itself or sits in a hidden group. */
  isChannelHidden(ch: Channel): boolean {
    return this.isHidden(channelCustomizationKey(ch)) || this.isGroupHidden(groupKeyOf(ch));
  }

  toggleHidden(key: string): boolean {
    const hidden = !this.isHidden(key);
    this.mutate(key, (ov) => { ov.hidden = hidden; });
    return hidden;
  }

  /** An empty name clears the rename and restores the source name. */
  rename(key: string, name: string): void {
    const trimmed = name.trim();
    this.mutate(key, (ov) => {
      if (trimmed) ov.name = trimmed;
      else delete ov.name;
    });
  }

  /** An empty group key clears the assignment and restores the source group. */
  setGroup(key: string, groupKey: string): void {
    const trimmed = groupKey.trim();
    this.mutate(key, (ov) => {
      if (trimmed) ov.group = trimmed;
      else delete ov.group;
    });
    if (trimmed) this.addCustomGroup(trimmed);
  }

  /** Clear every customization of one channel. */
  resetChannel(key: string): void {
    delete this.record.overrides[key];
    this.record.order = this.record.order.filter((k) => k !== key);
    this.persist();
  }

  // --- Group state

  isGroupHidden(groupKey: string): boolean {
    return this.record.groupOverrides[groupKey]?.hidden === true;
  }

  groupLabel(groupKey: string): string {
    return this.record.groupOverrides[groupKey]?.name || groupKey;
  }

  toggleGroupHidden(groupKey: string): boolean {
    const hidden = !this.isGroupHidden(groupKey);
    this.mutateGroup(groupKey, (ov) => { ov.hidden = hidden; });
    return hidden;
  }

  renameGroup(groupKey: string, name: string): void {
    const trimmed = name.trim();
    this.mutateGroup(groupKey, (ov) => {
      if (trimmed && trimmed !== groupKey) ov.name = trimmed;
      else delete ov.name;
    });
  }

  get customGroups(): string[] {
    return this.record.customGroups.slice();
  }

  addCustomGroup(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || this.record.customGroups.includes(trimmed)) return;
    this.record.customGroups.push(trimmed);
    this.persist();
  }

  /** Rank of a group key in the custom order; unlisted groups keep discovery order. */
  groupRank(groupKey: string, discoveryIndex: number): number {
    const at = this.record.groupOrder.indexOf(groupKey);
    return at >= 0 ? at : this.record.groupOrder.length + discoveryIndex;
  }

  // --- Reordering
  //
  // `order` is a snapshot list written on the first move: it holds the effective
  // order at that moment. Anything not listed keeps its relative source order
  // after the customized block, so channels appearing in a later refresh never
  // displace what the user arranged.

  moveChannel(effectiveOrder: string[], key: string, targetKey: string, after: boolean): void {
    this.record.order = reorder(effectiveOrder, key, targetKey, after);
    this.persist();
  }

  moveGroup(effectiveOrder: string[], groupKey: string, targetKey: string, after: boolean): void {
    this.record.groupOrder = reorder(effectiveOrder, groupKey, targetKey, after);
    this.persist();
  }

  // --- Application

  /**
   * Apply the customization to parsed channels, returning the visible list in
   * effective order. Mutates each channel's display fields in place and keeps
   * the source values on `sourceName` / `sourceGroup`, so repeated calls are
   * idempotent and clearing an override restores the source value.
   */
  applyTo(channels: Channel[], includeHidden = false): Channel[] {
    const d = this.record;
    const rank = new Map<string, number>();
    for (let i = 0; i < d.order.length; i++) rank.set(d.order[i], i);

    const kept: { ch: Channel; rank: number; index: number }[] = [];
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      const key = channelCustomizationKey(ch);
      const ov = d.overrides[key];

      const srcName = ch.sourceName ?? ch.name;
      const srcGroup = ch.sourceGroup ?? ch.group;
      const gKey = ov?.group ?? srcGroup;
      const label = d.groupOverrides[gKey]?.name || gKey;

      ch.name = ov?.name || srcName;
      if (ch.name !== srcName) ch.sourceName = srcName; else delete ch.sourceName;
      ch.group = label;
      if (label !== srcGroup) ch.sourceGroup = srcGroup; else delete ch.sourceGroup;
      if (label !== gKey) ch.groupKey = gKey; else delete ch.groupKey;

      const hidden = ov?.hidden === true || d.groupOverrides[gKey]?.hidden === true;
      if (hidden && !includeHidden) continue;
      kept.push({ ch, rank: rank.get(key) ?? d.order.length + i, index: i });
    }

    // Chrome 68's sort is not stable — the index tiebreak keeps it deterministic.
    kept.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return kept.map((entry) => entry.ch);
  }

  /** Sort group keys into the effective group order. */
  sortGroupKeys(groupKeys: string[]): string[] {
    return groupKeys
      .map((key, index) => ({ key, rank: this.groupRank(key, index), index }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.key);
  }

  private mutate(key: string, fn: (ov: ChannelOverride) => void): void {
    if (!key) return;
    const ov = this.record.overrides[key] ?? {};
    fn(ov);
    if (isEmpty(ov)) delete this.record.overrides[key];
    else this.record.overrides[key] = ov;
    this.persist();
  }

  private mutateGroup(groupKey: string, fn: (ov: GroupOverride) => void): void {
    if (!groupKey) return;
    const ov = this.record.groupOverrides[groupKey] ?? {};
    fn(ov);
    if (isEmpty(ov)) delete this.record.groupOverrides[groupKey];
    else this.record.groupOverrides[groupKey] = ov;
    this.persist();
  }
}

function isEmpty(ov: ChannelOverride | GroupOverride): boolean {
  for (const k in ov) {
    const value = (ov as Record<string, unknown>)[k];
    if (value !== undefined && value !== false) return false;
  }
  return true;
}

/** Move `key` next to `targetKey` inside `list`, returning a new snapshot. */
function reorder(list: string[], key: string, targetKey: string, after: boolean): string[] {
  const next = list.filter((k) => k !== key);
  const at = next.indexOf(targetKey);
  if (at < 0) return list.slice();
  next.splice(after ? at + 1 : at, 0, key);
  return next;
}

/** The customization key of a channel's effective group. */
export function groupKeyOf(ch: Channel): string {
  return ch.groupKey ?? ch.group;
}

export const ChannelCustomizationService = new ChannelCustomizationServiceImpl();
