// Every focus scope the app registers, with the modes of one whose root shows
// different surfaces by turns, a menu or picker that takes the keys inside it
// among them; such a scope reports its mode, marked `id:mode`. The navigation
// sweep and the focus fuzz each name the surfaces they cover or say why they
// don't, and fail on one left out, so a new scope or mode must be added here
// before it can register or report.
export const SCOPES = {
  'tabbar': ['tabs', 'search'],
  'tabbar.accounts': [],
  'live.channels': [
    'browse', 'edit', 'favorites', 'rename', 'group-picker', 'new-group',
    'guide-picker', 'guide-offset',
  ],
  'guide.grid': ['schedule', 'timeline'],
  'guide.groups': [],
  'movies.catalog': ['browse', 'grid', 'manage', 'detail', 'menu'],
  'series.catalog': ['browse', 'grid', 'manage', 'detail', 'menu'],
  'view.player': [],
  'view.settings': ['pane', 'menu'],
  'view.search': [],
  'view.parental-controls': [],
  'view.reminders': [],
  'search.history': [],
  'parental.account_menu': [],
  'player.menu': [
    'main', 'audio', 'subtitles', 'translate', 'speed', 'aspect', 'quality',
  ],
  'player.sidebar': [],
  'player.subtitle_offset': [],
  'player.subtitle_search': [],
  'prompt.epg': [],
  'prompt.search': [],
  'prompt.settings': [],
  'prompt.parental': [],
  'prompt.parental-review': [],
  'prompt.parental_pin': [],
  'prompt.reminder': [],
  'prompt.reminder_manager': [],
  'prompt.live_categories': [],
  'prompt.live_categories.accounts': [],
  'prompt.theme_editor': [],
  'prompt.theme_editor_view': ['view', 'menu'],
  'prompt.theme_color_picker': [],
  'prompt.movies.collection': [],
  'prompt.movies.trailer': [],
  'prompt.series.collection': [],
  'prompt.series.trailer': [],
} as const satisfies Record<string, readonly string[]>;

export type ScopeId = keyof typeof SCOPES;
export type ScopeMode<I extends ScopeId> = (typeof SCOPES)[I][number];
type SurfaceOf<I extends ScopeId> = I extends ScopeId
  ? [ScopeMode<I>] extends [never] ? I : `${I}:${ScopeMode<I>}`
  : never;
export type SurfaceId = SurfaceOf<ScopeId>;
