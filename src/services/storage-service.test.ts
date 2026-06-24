// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { Channel } from '../types';
import { StorageService } from './storage-service';
import { channelKey } from '../utils/channel';

const ch = (over: Partial<Channel>): Channel => ({
  id: '', name: '', logo: '', group: '', url: '', extras: null,
  playlist: '', catchup: '', catchupSource: '', catchupDays: 0, ...over,
});

describe('StorageService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty playlist list by default', () => {
    expect(StorageService.getPlaylists()).toEqual([]);
  });

  it('round-trips playlists through localStorage', () => {
    const entries = [{ name: 'Test', url: 'http://example.com/p.m3u' }];
    StorageService.setPlaylists(entries);
    expect(StorageService.getPlaylists()).toEqual(entries);
  });

  it('defaults the EPG url to an empty string and round-trips it', () => {
    expect(StorageService.getEpgUrl()).toBe('');
    StorageService.setEpgUrl('http://epg/guide.xml');
    expect(StorageService.getEpgUrl()).toBe('http://epg/guide.xml');
  });

  it('toggles a favorite on and off, returning the new state', () => {
    expect(StorageService.getFavorites()).toEqual([]);
    expect(StorageService.toggleFavorite('chan-1')).toBe(true);
    expect(StorageService.getFavorites()).toContain('chan-1');
    expect(StorageService.toggleFavorite('chan-1')).toBe(false);
    expect(StorageService.getFavorites()).not.toContain('chan-1');
  });

  it('namespaces keys with the configured storage prefix', () => {
    StorageService.setEpgUrl('http://epg/x.xml');
    const prefixed = Object.keys(localStorage).filter(k => k.startsWith('iptv_'));
    expect(prefixed.length).toBeGreaterThan(0);
  });

  describe('favorite key migration', () => {
    it('re-keys legacy favorites (id||name) to channelKey, then is idempotent', () => {
      StorageService.setFavorites(['fav1', 'fav2']); // legacy keys
      const channels = [ch({ id: 'fav1', url: 'http://host/a' }), ch({ name: 'fav2', url: 'http://host/b' })];
      StorageService.migrateFavoriteKeys(channels);
      expect(StorageService.getFavorites()).toEqual([channelKey(channels[0]), channelKey(channels[1])]);

      // A second call must not touch favorites again (flag set).
      StorageService.setFavorites(['untouched']);
      StorageService.migrateFavoriteKeys(channels);
      expect(StorageService.getFavorites()).toEqual(['untouched']);
    });

    it('waits for channels before migrating (and does not set the flag)', () => {
      StorageService.setFavorites(['fav1']);
      StorageService.migrateFavoriteKeys([]); // no channels yet → no-op
      expect(StorageService.getFavorites()).toEqual(['fav1']);

      const channels = [ch({ id: 'fav1', url: 'http://host/a' })];
      StorageService.migrateFavoriteKeys(channels);
      expect(StorageService.getFavorites()).toEqual([channelKey(channels[0])]);
    });

    it('drops a legacy favorite whose channel is no longer present', () => {
      StorageService.setFavorites(['gone']);
      StorageService.migrateFavoriteKeys([ch({ id: 'fav1', url: 'http://host/a' })]);
      expect(StorageService.getFavorites()).toEqual([]);
    });
  });

  describe('audio preferences', () => {
    it('returns null when no choice is saved for a channel', () => {
      expect(StorageService.getAudioPref('ch1')).toBeNull();
    });

    it('remembers a choice per channel without bleeding across channels', () => {
      StorageService.setAudioPref('ch1', { name: 'Track 1', lang: 'l1' });
      StorageService.setAudioPref('ch2', { name: 'Track 2', lang: 'l2' });
      expect(StorageService.getAudioPref('ch1')).toEqual({ name: 'Track 1', lang: 'l1' });
      expect(StorageService.getAudioPref('ch2')).toEqual({ name: 'Track 2', lang: 'l2' });
      expect(StorageService.getAudioPref('ch3')).toBeNull();
    });

    it('persists through localStorage (survives a reload)', () => {
      StorageService.setAudioPref('ch1', { name: 'Track 2', lang: 'l1' });
      // A fresh read goes back to localStorage — no in-memory cache.
      expect(StorageService.getAudioPref('ch1')).toEqual({ name: 'Track 2', lang: 'l1' });
      expect(localStorage.getItem('iptv_audio_prefs')).toContain('Track 2');
    });

    it('ignores an empty channel id', () => {
      StorageService.setAudioPref('', { name: 'Track 1', lang: 'l1' });
      expect(StorageService.getAudioPref('')).toBeNull();
      expect(localStorage.getItem('iptv_audio_prefs')).toBeNull();
    });
  });
});
