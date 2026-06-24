export interface Channel {
  id: string;
  name: string;
  logo: string;
  group: string;
  url: string;
  extras: Record<string, string> | null;
  playlist: string;
  catchup: string;
  catchupSource: string;
  catchupDays: number;
}

export interface ParsedPlaylist {
  channels: Channel[];
  groups: string[];
  epgUrl: string;
}

export interface Programme {
  start: Date;
  stop: Date;
  title: string;
  description: string;
  category: string;
  icon: string;
}

export interface EpgChannel {
  name: string;
  icon: string;
}

export interface ParsedEpg {
  channels: Record<string, EpgChannel>;
  programmes: Record<string, Programme[]>;
  /** Minutes east of UTC declared by the feed's timestamps (e.g. +0100 -> 60), or null if none carry an offset. */
  tzOffsetMinutes?: number | null;
}

export interface PlaylistEntry {
  name: string;
  url: string;
  /** 'upload' entries are auto-managed by the local upload service; absent/'url' are user-entered. */
  source?: 'upload' | 'url';
  /** Channel count, populated for 'upload' entries by reconcile() from UploadMeta. */
  count?: number;
}

export interface CachedData<T> {
  data: T;
  timestamp: number;
}

export interface CatchupInfo {
  start: number;
  end: number;
  title: string;
  description: string;
  icon: string;
}

/** Which timezone EPG times are displayed in: the device's, or the feed's. */
export type TzMode = 'device' | 'feed';

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'select' | 'back'
  | 'red' | 'green' | 'yellow' | 'blue'
  | 'channel_up' | 'channel_down'
  | 'play' | 'pause' | 'stop'
  | 'number';

export interface NumberEvent {
  number: number;
}

/** A selectable audio track exposed by the active player (the picker's view model). */
export interface AudioTrackOption {
  index: number;
  label: string;
  active: boolean;
  /** False = shown but not switchable — a same-language rendition webOS collapsed
   *  out of the native list. Defaults to switchable when absent. */
  available?: boolean;
}

/** Normalized audio rendition, unified across the hls.js list and the native
 *  HTMLMediaElement.audioTracks list so one selection routine serves both. */
export interface AudioOption {
  index: number;
  name: string;
  lang: string;
  isDefault: boolean;
  active: boolean;
}

/** A remembered audio-track choice, matched against future streams by name then language. */
export interface AudioPref {
  name: string;
  lang: string;
}

/** An audio rendition declared in an HLS master playlist (EXT-X-MEDIA:TYPE=AUDIO). */
export interface ManifestAudio {
  name: string;
  lang: string;
  isDefault: boolean;
}

export interface ViewHandler {
  handleAction(action: Action, event?: NumberEvent): void;
}
