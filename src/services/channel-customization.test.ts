import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel, ChannelCustomization } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    getChannelCustomization: vi.fn(() => null as ChannelCustomization | null),
    setChannelCustomization: vi.fn(),
    clearChannelCustomization: vi.fn(),
  },
}));

vi.mock('./storage-service', () => ({ StorageService: storageMock }));

import { ChannelCustomizationService, groupKeyOf } from './channel-customization';
import { channelKey } from '../utils/channel';
import { CONFIG } from '../config';

function channel(name: string, url: string, group = ''): Channel {
  return {
    id: '', name, logo: '', group, url, extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0,
  };
}

function fixture(): Channel[] {
  return [
    channel('Alpha', 'http://host/a', 'News'),
    channel('Bravo', 'http://host/b', 'News'),
    channel('Charlie', 'http://host/c', 'Sports'),
  ];
}

const KEY_A = channelKey(channel('Alpha', 'http://host/a'));
const KEY_B = channelKey(channel('Bravo', 'http://host/b'));
const KEY_C = channelKey(channel('Charlie', 'http://host/c'));

function names(channels: Channel[]): string[] {
  return channels.map((ch) => ch.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getChannelCustomization.mockReturnValue(null);
  ChannelCustomizationService.reload();
});

describe('ChannelCustomizationService', () => {
  it('is a no-op on an untouched install', () => {
    const channels = fixture();
    expect(ChannelCustomizationService.customized).toBe(false);
    expect(names(ChannelCustomizationService.applyTo(channels))).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(channels[0].sourceName).toBeUndefined();
    expect(channels[0].sourceGroup).toBeUndefined();
  });

  it('moves a channel and keeps unlisted channels after the customized block', () => {
    ChannelCustomizationService.moveChannel([KEY_A, KEY_B, KEY_C], KEY_C, KEY_A, false);
    expect(ChannelCustomizationService.customized).toBe(true);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Charlie', 'Alpha', 'Bravo']);

    const withNew = fixture();
    withNew.push(channel('Delta', 'http://host/d', 'News'));
    expect(names(ChannelCustomizationService.applyTo(withNew)))
      .toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
  });

  it('drops a move whose target is gone', () => {
    ChannelCustomizationService.moveChannel([KEY_A, KEY_B], KEY_A, 'missing', true);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('hides a channel unless hidden entries are requested', () => {
    expect(ChannelCustomizationService.toggleHidden(KEY_B)).toBe(true);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Charlie']);
    expect(names(ChannelCustomizationService.applyTo(fixture(), true)))
      .toEqual(['Alpha', 'Bravo', 'Charlie']);

    expect(ChannelCustomizationService.toggleHidden(KEY_B)).toBe(false);
    expect(ChannelCustomizationService.isHidden(KEY_B)).toBe(false);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('hides every channel of a hidden group', () => {
    ChannelCustomizationService.toggleGroupHidden('News');
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Charlie']);
    expect(ChannelCustomizationService.isChannelHidden(fixture()[0])).toBe(true);
    expect(ChannelCustomizationService.isChannelHidden(fixture()[2])).toBe(false);
  });

  it('renames a channel while keeping the source name, and restores it when cleared', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    let channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].name).toBe('Alpha HD');
    expect(channels[0].sourceName).toBe('Alpha');

    ChannelCustomizationService.rename(KEY_A, '  ');
    channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].name).toBe('Alpha');
    expect(channels[0].sourceName).toBeUndefined();
  });

  it('is idempotent when applied repeatedly to the same channels', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    ChannelCustomizationService.setGroup(KEY_A, 'Custom');
    const channels = fixture();
    ChannelCustomizationService.applyTo(channels);
    ChannelCustomizationService.applyTo(channels);
    expect(channels[0].name).toBe('Alpha HD');
    expect(channels[0].sourceName).toBe('Alpha');
    expect(channels[0].group).toBe('Custom');
    expect(channels[0].sourceGroup).toBe('News');
  });

  it('regroups a channel and registers the custom group', () => {
    ChannelCustomizationService.setGroup(KEY_C, 'Custom');
    expect(ChannelCustomizationService.customGroups).toEqual(['Custom']);
    const channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[2].group).toBe('Custom');
    expect(channels[2].sourceGroup).toBe('Sports');
    expect(groupKeyOf(channels[2])).toBe('Custom');

    ChannelCustomizationService.setGroup(KEY_C, '');
    expect(ChannelCustomizationService.applyTo(fixture())[2].group).toBe('Sports');
  });

  it('sets and clears a manual EPG channel mapping', () => {
    ChannelCustomizationService.setEpgChannel(KEY_A, 'source::epg-a');
    expect(ChannelCustomizationService.overrideFor(KEY_A)?.epgChannelId).toBe('source::epg-a');
    expect(ChannelCustomizationService.epgChannelIds()).toEqual(['source::epg-a']);

    ChannelCustomizationService.setEpgChannel(KEY_A, '  ');
    expect(ChannelCustomizationService.overrideFor(KEY_A)).toBeNull();
    expect(ChannelCustomizationService.epgChannelIds()).toEqual([]);
  });

  it('sets, bounds, and clears a per-channel EPG offset delta', () => {
    ChannelCustomizationService.setEpgOffsetDelta(KEY_A, 15);
    expect(ChannelCustomizationService.overrideFor(KEY_A)?.epgOffsetDeltaMinutes).toBe(15);

    ChannelCustomizationService.setEpgOffsetDelta(
      KEY_A,
      CONFIG.EPG.OFFSET_MAX_MINUTES * 2 + 60,
    );
    expect(ChannelCustomizationService.overrideFor(KEY_A)?.epgOffsetDeltaMinutes)
      .toBe(CONFIG.EPG.OFFSET_MAX_MINUTES * 2);

    ChannelCustomizationService.setEpgOffsetDelta(KEY_A, null);
    expect(ChannelCustomizationService.overrideFor(KEY_A)).toBeNull();
  });

  it('renames a group without changing its key', () => {
    ChannelCustomizationService.renameGroup('News', 'Headlines');
    const channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].group).toBe('Headlines');
    expect(channels[0].sourceGroup).toBe('News');
    expect(groupKeyOf(channels[0])).toBe('News');
    expect(ChannelCustomizationService.groupLabel('News')).toBe('Headlines');
  });

  it('renames and hides the ungrouped bucket like any provider group', () => {
    const ungrouped = (): Channel[] => [channel('Alpha', 'http://host/a', UNCATEGORIZED_GROUP)];

    ChannelCustomizationService.renameGroup(UNCATEGORIZED_GROUP, 'Everything Else');
    const renamed = ChannelCustomizationService.applyTo(ungrouped());
    expect(renamed[0].group).toBe('Everything Else');
    expect(renamed[0].groupKey).toBe(UNCATEGORIZED_GROUP);
    expect(groupKeyOf(renamed[0])).toBe(UNCATEGORIZED_GROUP);

    ChannelCustomizationService.toggleGroupHidden(UNCATEGORIZED_GROUP);
    expect(ChannelCustomizationService.applyTo(ungrouped())).toHaveLength(0);
  });

  it('sorts group keys into the custom group order', () => {
    ChannelCustomizationService.moveGroup(['News', 'Sports'], 'Sports', 'News', false);
    expect(ChannelCustomizationService.sortGroupKeys(['News', 'Sports'])).toEqual(['Sports', 'News']);
    expect(ChannelCustomizationService.sortGroupKeys(['News', 'Sports', 'Music']))
      .toEqual(['Sports', 'News', 'Music']);
  });

  it('resets one channel and the whole record', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    ChannelCustomizationService.toggleHidden(KEY_B);
    ChannelCustomizationService.moveChannel([KEY_A, KEY_B, KEY_C], KEY_A, KEY_C, true);

    ChannelCustomizationService.resetChannel(KEY_A);
    expect(ChannelCustomizationService.overrideFor(KEY_A)).toBeNull();
    // Dropped from the order snapshot too, so it falls back behind the arranged block.
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Charlie', 'Alpha']);

    ChannelCustomizationService.reset();
    expect(storageMock.clearChannelCustomization).toHaveBeenCalled();
    expect(ChannelCustomizationService.customized).toBe(false);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('reloads the record from storage', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    const saved = storageMock.setChannelCustomization.mock.calls[0][0] as ChannelCustomization;
    storageMock.getChannelCustomization.mockReturnValue(saved);
    ChannelCustomizationService.reload();
    expect(ChannelCustomizationService.applyTo(fixture())[0].name).toBe('Alpha HD');
  });
});
