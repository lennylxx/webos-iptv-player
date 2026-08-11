export interface Channel {
  id: string;
  name: string;
  logo: string;
  group: string;
  url: string;
  extras: Record<string, string> | null;
  /** Provider-specific EXTINF attributes not mapped to first-class fields. */
  sourceAttributes?: Record<string, string>;
  /** Headers declared by EXTHTTP, preserved for playback backends that support them. */
  httpHeaders?: Record<string, string>;
  /** Optional logical channel number declared by the source. */
  channelNumber?: number;
  /** EPG shift in hours declared by tvg-shift/timeshift. */
  tvgShift?: number;
  /** Source metadata explicitly identifies this entry as radio. */
  radio?: boolean;
  /** Every source group when group-title or EXTGRP declares multiple groups. */
  sourceGroups?: string[];
  /** The name as delivered by the source, kept when a rename overrides `name`. */
  sourceName?: string;
  /** The group as delivered by the source, kept when a customization changes `group`. */
  sourceGroup?: string;
  /** The customization key of the effective group, kept when a group rename makes
   *  the displayed `group` differ from the key user data is stored under. */
  groupKey?: string;
  /** The stable `id` of every configured playlist this channel appears in (dedup
   *  keeps one channel object, but it can belong to several overlapping playlists). */
  playlistIds: string[];
  catchup: string;
  catchupSource: string;
  /** Alternate legacy endpoint used when an Xtream path-form timeshift fails. */
  catchupFallbackSource?: string;
  /** Xtream account and stream identity used for program-level archive checks. */
  catchupAccountId?: string;
  catchupStreamId?: string;
  catchupDays: number;
  /** Provider timezone used to format Xtream's wall-clock timeshift path. */
  catchupTimeZone?: string;
  /** Fixed fallback when the provider timezone is absent or unsupported. */
  catchupTimeOffsetMinutes?: number;
}

/** One playlist tab. `id` is the configured playlist's stable id (so two
 *  playlists sharing a name stay distinct); `name` is the display label. */
export interface PlaylistTab {
  id: string;
  name: string;
}

export interface EpgSource {
  url: string;
  playlistIds: string[];
  kind: 'manual' | 'm3u' | 'xtream';
  /** User correction applied after parsing; cached source timestamps stay unchanged. */
  offsetMinutes?: number;
}

export interface ParsedPlaylist {
  channels: Channel[];
  groups: string[];
  /** First EPG URL retained for backward compatibility. */
  epgUrl: string;
  epgUrls: string[];
  headerAttributes: Record<string, string>;
  maxConnections?: number;
  name?: string;
  format: PlaylistFormat;
  issues: PlaylistParseIssue[];
}

export type PlaylistFormat =
  | 'extended-m3u'
  | 'hls-master'
  | 'hls-media'
  | 'simple-m3u'
  | 'xmltv'
  | 'json'
  | 'html'
  | 'unknown';

export interface PlaylistFormatDetection {
  format: PlaylistFormat;
  confidence: number;
  reason: string;
  hadBom: boolean;
}

export interface PlaylistParseIssue {
  level: 'warning' | 'error';
  code: string;
  message: string;
  line: number;
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
  /** Additional XMLTV display names used for playlist channel matching. */
  aliases?: string[];
}

export interface ParsedEpg {
  channels: Record<string, EpgChannel>;
  programmes: Record<string, Programme[]>;
  /** Optional human-readable feed name declared on the XMLTV root element. */
  sourceName?: string;
  /** Minutes east of UTC declared by the feed's timestamps (e.g. +0100 -> 60), or null if none carry an offset. */
  tzOffsetMinutes?: number | null;
}

export interface PlaylistEntry {
  /** Stable identity assigned once at creation. Keys channel membership and the
   *  playlist tabs, so deleting/reordering/renaming never shifts the others and
   *  two playlists sharing a URL or name stay independent. StorageService
   *  backfills it for any legacy entry read from storage. */
  id: string;
  name: string;
  /** For 'xtream' entries this is the normalized portal base (`http://host:port`);
   *  the get.php/xmltv.php URLs are derived from it + credentials at load time. */
  url: string;
  /** 'upload' entries are auto-managed by the local bundled service; 'xtream' is an
   *  Xtream Codes account; absent/'url' are user-entered M3U URLs. */
  source?: 'upload' | 'url' | 'xtream';
  /** False temporarily removes this source from every content surface without
   *  deleting its configuration or user data. Missing/true means enabled. */
  enabled?: boolean;
  /** Credentials and live output preference for an 'xtream' entry. */
  xtream?: {
    username: string;
    password: string;
    liveOutput?: import('./utils/xtream-url').XtreamLiveOutputPreference;
  };
  /** Channel count, populated for 'upload' entries by reconcile() from UploadMeta. */
  count?: number;
}

/** A per-channel display customization, keyed by `channelKey(ch)`. */
export interface ChannelOverride {
  /** Display name replacing the source name. Absent = use the source name. */
  name?: string;
  /** Target group key. Absent = the source group. */
  group?: string;
  hidden?: boolean;
}

/** A per-group customization, keyed by the group's customization key. */
export interface GroupOverride {
  name?: string;
  hidden?: boolean;
}

/** The local channel customization record (reorder / hide / rename / regroup).
 *  Keyed by channelKey and group key, so it survives a provider
 *  reordering or renaming channels. */
export interface ChannelCustomization {
  version: number;
  overrides: Record<string, ChannelOverride>;
  /** Explicit channel order (channelKey list). Empty until the first move. */
  order: string[];
  /** Explicit group order (group keys). Empty until the first move. */
  groupOrder: string[];
  groupOverrides: Record<string, GroupOverride>;
  /** User-created groups, so an empty one still lists and keeps its position. */
  customGroups: string[];
}

export interface CatchupInfo {
  start: number;
  end: number;
  title: string;
  description: string;
  icon: string;
  /** EPG feed that supplied the corrected programme times. */
  epgSourceUrl?: string;
  /** If set, seek to this position (seconds) once metadata loads — set by resume callers. */
  resumeSecs?: number;
}

/** A user-set reminder for an upcoming program. Keyed by channelKey + startMs. */
export interface Reminder {
  channelKey: string;
  channelName: string;
  playlistIds?: string[];
  epgSourceUrl?: string;
  title: string;
  startMs: number;
  stopMs: number;
  /** Set once the user answers the in-app OK/Cancel prompt, so it isn't shown again. */
  answered?: boolean;
}

/** Which timezone EPG times are displayed in: the device's, or the feed's. */
export type TzMode = 'device' | 'feed';

export type BuiltinChannelGroup = 'all' | 'favorites' | 'recently-watched';
export type ChannelGroupId = `builtin:${BuiltinChannelGroup}` | `source:${string}`;

/** Group key for channels the playlist left ungrouped. A key, never a label —
 *  views translate it, so a provider group literally named "Uncategorized"
 *  stays its own group instead of merging into this bucket. */
export const UNCATEGORIZED_GROUP = 'builtin:uncategorized';

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'select' | 'back'
  | 'red' | 'green' | 'yellow' | 'blue'
  | 'channel_up' | 'channel_down'
  | 'play' | 'pause' | 'stop'
  | 'rewind' | 'fast_forward'
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

/** A selectable subtitle track for the picker. `index` -1 is the synthetic "Off"
 *  row the menu prepends; real tracks index into the player's track list. */
export interface SubtitleTrackOption {
  index: number;
  label: string;
  active: boolean;
  /** False = shown but not switchable — a rendition the platform didn't expose
   *  as a native textTrack. Defaults to switchable when absent. */
  available?: boolean;
}

/** Normalized subtitle rendition, unified across the hls.js list and the native
 *  HTMLMediaElement.textTracks list so one selection routine serves both. */
export interface SubtitleOption {
  index: number;
  name: string;
  lang: string;
  isDefault: boolean;
  isForced: boolean;
  active: boolean;
}

/** A remembered subtitle choice. `off` records an explicit "no subtitles" so it
 *  survives re-tunes; `cc` records the in-band CEA-608/708 toggle (drawn by the
 *  native compositor, not a track); otherwise matched against future streams by
 *  name then language. */
export interface SubtitlePref {
  off: boolean;
  name: string;
  lang: string;
  cc?: boolean;
}

/** A subtitle rendition declared in an HLS master playlist (EXT-X-MEDIA:TYPE=SUBTITLES). */
export interface ManifestSubtitle {
  name: string;
  lang: string;
  isDefault: boolean;
  isForced: boolean;
}

/** An in-band closed-caption track declared in an HLS master
 *  (EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS) — CEA-608 (INSTREAM-ID CC1-4) or
 *  CEA-708 (SERVICE1-63). These ride inside the video ES; webOS draws them via
 *  the native compositor (setSubtitleEnable), never as a textTrack. */
export interface ManifestClosedCaption {
  name: string;
  lang: string;
  instreamId: string;
  isDefault: boolean;
}

// --- Xtream Codes catalog (Movies & Series).
// Kept separate from Channel. Every item carries accountId (the PlaylistEntry.id
// of its Xtream account) so per-account scoping and resume keys stay unambiguous.

export interface VodCategory {
  id: string;
  name: string;
}

export interface VodItem {
  accountId: string;
  streamId: string;
  name: string;
  poster: string;
  rating: string;
  categoryId: string;
  containerExtension: string;
}

// A sidecar subtitle file (SRT or WebVTT) delivered alongside an Xtream VOD
// stream, listed in get_vod_info / get_series_info. Loaded on demand and drawn
// as a native text track, not muxed into the video.
export interface SidecarSubtitle {
  id: string;
  name: string;
  lang: string;
  url: string;
  text?: string;
}

export interface VodInfo {
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  durationSecs: number;
  poster: string;
  subtitles: SidecarSubtitle[];
  imdbId: string;
  tmdbId: string;
  year: number;
}

export interface SeriesCategory {
  id: string;
  name: string;
}

export interface SeriesItem {
  accountId: string;
  seriesId: string;
  name: string;
  poster: string;
  rating: string;
  categoryId: string;
}

export interface Episode {
  id: string;
  title: string;
  season: number;
  episode: number;
  containerExtension: string;
  durationSecs: number;
  plot: string;
  poster: string;
  subtitles: SidecarSubtitle[];
}

export interface SeriesInfo {
  seasons: number[];
  episodesBySeason: Record<number, Episode[]>;
}

export type WatchlistKind = 'vod' | 'series';

export interface WatchlistEntry {
  accountId: string;
  kind: WatchlistKind;
  itemId: string;
  name: string;
  poster: string;
  rating: string;
  categoryId: string;
  containerExtension?: string;
  addedAt: number;
}

// Local resume store: last playback position per catalog item. Persisted in
// IndexedDB (Xtream doesn't persist third-party resume). `kind` lets Movies and
// Series share one store. name/poster are denormalized so the
// "Continue watching" rail renders without a catalog round-trip.
export type ResumeKind = 'vod' | 'episode';

export interface ResumeEntry {
  accountId: string;
  kind: ResumeKind;
  itemId: string;
  name: string;
  poster: string;
  ext: string;        // container extension, to rebuild the stream URL when resuming from the Continue rail
  position: number;   // seconds into the stream
  duration: number;   // total seconds, or 0 if unknown
  updatedAt: number;  // epoch ms, for recency ordering
  episodeQueue?: VodQueueItem[];
  watchlistOwner?: WatchlistOwner;
}

// Structured metadata for online subtitle search (passed from Xtream catalog to player).
export interface SearchMeta {
  imdbId?: string;
  tmdbId?: string;
  year?: number;
  season?: number;
  episode?: number;
}

/** Resume/history entry for a catch-up programme playback session.
 *  Keyed by channelKey + progStart; stored per-programme so the EPG can
 *  surface watched/in-progress status and the player can resume mid-programme. */
export interface CatchupProgressEntry {
  channelKey: string;
  progStart: number;   // programme start epoch ms
  progEnd: number;     // programme end epoch ms
  epgSourceUrl?: string;
  title?: string;      // display snapshot for Recently Watched; absent on legacy entries
  description?: string;
  icon?: string;
  position: number;    // playback position seconds
  duration: number;    // media duration seconds (0 = unknown)
  updatedAt: number;   // epoch ms of last checkpoint
  completed: boolean;  // true once the programme has been watched to the end
}

export interface RecentlyWatchedLiveEntry {
  channelKey: string;
  updatedAt: number;
}

export interface VodQueueItem {
  url: string;
  title: string;
  poster: string;
  accountId: string;
  itemId: string;
  kind: ResumeKind;
  subtitles: SidecarSubtitle[];
  searchMeta?: SearchMeta;
  watchlistOwner?: WatchlistOwner;
}

export interface WatchlistOwner {
  kind: 'series';
  itemId: string;
}

// A VOD playback request handed to the player's VOD mode. The player derives no
// channel context from this; onBack returns the UI to the originating screen.
export interface VodPlayback extends VodQueueItem {
  resumeSecs: number;
  episodeQueue?: VodQueueItem[];
  /** Transient movie queue created only when playback starts from Watchlist. */
  watchlistQueue?: VodQueueItem[];
  onBack: () => void;
}
