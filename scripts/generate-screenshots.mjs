// Generates the README screenshots — one per major view of the app.
//
//   node scripts/generate-screenshots.mjs
//
// It drives the *real* app (built into dist/) in headless Chromium with demo
// fixtures and a frozen clock, then captures each view into screenshots/:
//
//   channel-list.png   channel list (the README hero)
//   recently-watched.png  mixed live and resumable catch-up history
//   epg-guide.png      three-pane program guide, with catch-up resume markers
//   epg-catchup-resume.png  the Resume / Start Over / Cancel resume prompt
//   settings.png       settings incl. the LAN-upload QR
//   themes.png         Settings Appearance section with the theme picker
//   player.png         playback overlays: channel switcher + action menu
//   channel-info.png   channel info bar (the OSD) — live DVR (timeshift) view
//   subtitles.png      self-rendered WebVTT cues — ::cue colors + positioning
//   subtitle-search.png  online subtitle search overlay — provider-labeled results
//                      with the right-aligned download-count badge
//   movies.png         Movies section — cinematic hero + content rails, with the
//                      account-switcher dropdown open (picks the active Xtream account)
//   movie-detail.png   Movie detail — plot/cast/rating + Resume / Play
//   series-detail.png  Series detail — season selector + episode list
//   search.png         unified Search — Channels · Movies · Series results
//
// Nothing here ships in the app or the .ipk; it is a dev-only tool.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SHOTS = join(ROOT, 'screenshots');
const SCALE = 1; // device pixel ratio — 1 = native 1920x1080 (no upsampling)

// Radial "video frame" backdrop for the player shots (the fake stream can't decode
// headless). One color pair, used as both a CSS gradient and a canvas gradient.
const FRAME_INNER = '#182942';
const FRAME_OUTER = '#0b0b12';
const frameGradient = (at) => `radial-gradient(125% 110% at ${at}, ${FRAME_INNER} 0%, ${FRAME_OUTER} 62%)`;

// Frozen clock: Friday 2026-06-12, 22:18 primetime (America/Los_Angeles).
const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-06-12T22:18:00-07:00').getTime();
const MID = new Date('2026-06-12T00:00:00-07:00').getTime(); // local midnight today
const HOUR = 3_600_000;
const UPLOAD_PORT = 8899;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

// group title -> [count, recognizable lead names]. Titles are chosen so the
// genre-icon lookup resolves a real icon for every category. News leads, so it
// fills the visible rows.
// All channel and program names below are fictional, to avoid using real
// broadcaster trademarks in marketing screenshots. Group titles stay generic
// (they also drive the genre-icon lookup in channel-list.ts).
const GROUPS = [
  ['News', 24, ['Metro One', 'Metro Two', 'Civic TV', 'Beacon TV', 'Globe News 24', 'Skyline News',
    'Vantage News', 'Continental 24', 'Northwind News', 'Ledger Business', 'Capital Markets TV',
    'Horizon News', 'Sentinel News', 'Meridian World', 'Atlas News', 'Frontier News',
    'Borealis News', 'Tribune 24']],
  ['Sports', 22, ['Apex Sports 1', 'Apex Sports 2', 'Tempo Sports', 'Stadium TV', 'Pitchside',
    'Overtime', 'Pole Position', 'Center Court', 'Endzone', 'Fastbreak', 'Matchday']],
  ['Movies', 32, ['Grand Cinema', 'Silver Screen', 'Reel One', 'Noir Classics', 'Indie Reel',
    'Big Screen', 'Matinee', "Director's Cut", 'Starlight Movies', 'Epic Films', 'Popcorn TV']],
  ['Series', 28, ['Binge TV', 'Primetime', 'Drama Lab', 'The Box Set', 'Serial', 'Marathon TV',
    'Replay TV', 'Pilot', 'Spotlight Series', 'Saga']],
  ['Documentary', 18, ['Terra Docs', 'Wildlife One', 'Deep Dive', 'Chronicle', 'Wild Earth',
    'True Story', 'Wayfarer', 'Frontier Science', 'Archive']],
  ['Kids', 14, ['Kids Planet', 'Toonbox', 'Doodle TV', 'Junior Plus', 'Funhouse', 'Sprig TV',
    'Cub Club', 'Playground']],
  ['Music', 18, ['PulseMusic', 'Vibe TV', 'Hitlist', 'Amplify', 'Soundwave', 'ClubFloor',
    'Indie Sounds', 'Maestro', 'Beatbox']],
];

// "Now playing" titles for the visible (leading) channels.
const NOW_TITLES = {
  'Metro Two': 'The Night Desk', 'Civic TV': 'Civic Debate', 'Beacon TV': 'Beacon Tonight',
  'Globe News 24': 'Worldwatch', 'Skyline News': 'Skyline Tonight', 'Vantage News': 'The Big Story',
  'Continental 24': 'Round Table', 'Northwind News': 'Northwind at Nine', 'Ledger Business': 'Market Wrap',
  'Capital Markets TV': 'Trading Floor', 'Horizon News': 'Horizon Tonight', 'Sentinel News': 'The Briefing',
  'Meridian World': 'Nightly World',
};

function buildChannels() {
  const channels = [];
  let i = 0;
  for (const [group, count, leads] of GROUPS) {
    for (let n = 0; n < count; n++) {
      const name = n < leads.length ? leads[n] : `${group} ${n + 1}`;
      channels.push({ id: `ch${i}`, name, group });
      i++;
    }
  }
  return channels;
}

const CHANNELS = buildChannels();
const TOTAL = CHANNELS.length;
const SPLIT = 78; // News+Sports+Movies in playlist 1, the rest in playlist 2
const FAVORITE_IDS = ['ch1', 'ch3', 'ch6', 'ch20', 'ch45', 'ch70', 'ch110', 'ch140'];
// The hero channel advertises catch-up (time-shift), so its already-aired
// programs can carry resume markers in the guide (epg-catchup-resume shot).
const CATCHUP_IDS = new Set(['ch0']);

function m3u(slice, withTvg) {
  const lines = [withTvg ? '#EXTM3U url-tvg="https://demo.local/epg.xml"' : '#EXTM3U'];
  for (const ch of slice) {
    const cu = CATCHUP_IDS.has(ch.id)
      ? ` catchup="default" catchup-source="https://demo.local/timeshift/${ch.id}.m3u8?start={utc}&end={utcend}" catchup-days="7"`
      : '';
    lines.push(`#EXTINF:-1 tvg-id="${ch.id}" group-title="${ch.group}"${cu},${ch.name}`);
    lines.push(`https://demo.local/stream/${ch.id}.m3u8`);
  }
  return lines.join('\n');
}

const M3U_1 = m3u(CHANNELS.slice(0, SPLIT), true);
const M3U_2 = m3u(CHANNELS.slice(SPLIT), false);
// One flattened playlist for the Xtream get.php route (Live · Movies · Series shots).
const M3U_ALL = m3u(CHANNELS, true);

// Fake HLS master with alternate audio + subtitle renditions, served for the played
// channel so hls.js (the desktop preview path) exposes real tracks to the player
// menu — that's what makes renderMain emit the Audio Track / Subtitles rows. Only the
// master is served; the media playlists it points to are aborted (the menu needs just
// the track lists, which come from these EXT-X-MEDIA tags). Labels are illustrative.
const MASTER_HLS = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio-en.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English 5.1",LANGUAGE="en",CHANNELS="6",URI="audio-en51.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",LANGUAGE="es",URI="audio-es.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fr",URI="audio-fr.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",FORCED=YES,AUTOSELECT=YES,URI="sub-en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Español",LANGUAGE="es",URI="sub-es.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Français",LANGUAGE="fr",URI="sub-fr.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud",SUBTITLES="sub"',
  'video.m3u8',
].join('\n');

// Feature-rich variant for the channel-info OSD shot — 4K HDR Dolby Vision, Dolby
// Digital+ Atmos (default audio gets CHANNELS="16/JOC"), 60fps.
const MASTER_HLS_RICH = MASTER_HLS
  .replace('NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES',
    'NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="16/JOC"')
  .replace(/#EXT-X-STREAM-INF:.*\n[^\n]*$/,
    '#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,FRAME-RATE=60,VIDEO-RANGE=PQ,' +
    'CODECS="dvh1.05.06,ec-3",AUDIO="aud",SUBTITLES="sub"\nvideo.m3u8');

// Empty *live* media playlist (no ENDLIST, no segments) for the variant/audio/
// subtitle renditions hls.js loads after the master. It keeps polling for a live
// edge rather than fatally erroring — which would make the player flash "Stream
// error - trying next channel" and zap mid-screenshot.
const EMPTY_LIVE = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n';

// Subtitle cues — each carries its own positioning (the VTTCue props applyCueSettings
// sets; line is a % → snapToLines:false) and a <c.class> color, so one frame shows
// ::cue colors + positioning.
const SUBTITLE_CUES = [
  { text: '<c.cyan>Top center</c> · line:6%', line: 6, snapToLines: false, position: 50, align: 'center' },
  { text: '<c.yellow>Left</c> · position:5% align:start', line: 32, snapToLines: false, position: 5, align: 'start' },
  { text: '<c.green>Right</c> · position:95% align:end', line: 50, snapToLines: false, position: 95, align: 'end' },
  { text: '<c.magenta>Narrow box</c> · size:38%', line: 70, snapToLines: false, position: 50, align: 'center', size: 38 },
  { text: '<c.blue>竖排字幕</c>', vertical: 'rl', line: 12, snapToLines: false, position: 88 },
  { text: '<c.red>Default</c> — no settings (bottom center)' },
];

// Mocked provider search responses for the online-subtitle-search shot
// (subtitle-search.png). Each body mirrors that provider's real API shape, so the
// actual providers + aggregator + SubtitleSearchOverlay render them end to end.
// Only OpenSubtitles reports a download count (SubDL/Assrt don't), so the badge
// appears only on its rows — the real production behavior.
const SUB_TITLE = 'Silent Harbor';
const OS_SUBS_JSON = JSON.stringify({
  data: [
    { attributes: { language: 'en', release: `${SUB_TITLE} 2021 1080p BluRay x264`, hearing_impaired: false, download_count: 8432, files: [{ file_id: 101, file_name: 'a.srt' }] } },
    { attributes: { language: 'en', release: `${SUB_TITLE}.2021.720p.WEB-DL.AAC`, hearing_impaired: true, download_count: 1204, files: [{ file_id: 102, file_name: 'b.srt' }] } },
    { attributes: { language: 'es', release: `${SUB_TITLE}.2021.1080p.HDR.x265`, hearing_impaired: false, download_count: 517, files: [{ file_id: 103, file_name: 'c.srt' }] } },
  ],
});
const SUBDL_SUBS_JSON = JSON.stringify({
  subtitles: [
    { name: 'd.zip', url: '/subtitle/d.zip', language: 'EN', release_name: `${SUB_TITLE} 2021 WEBRip`, hi: false },
    { name: 'e.zip', url: '/subtitle/e.zip', language: 'FR', release_name: `${SUB_TITLE} 2021 FRENCH WEBRip`, hi: false },
  ],
});
const ASSRT_SUBS_JSON = JSON.stringify({
  status: 0,
  sub: { subs: [{ id: 715078, native_name: `${SUB_TITLE}.2021.BluRay.1080p`, videoname: `${SUB_TITLE} 2021`, lang: { desc: '简体中文' } }] },
});

// ---------------------------------------------------------------------------
// Xtream catalog (Movies / Series) — synthetic fixtures for the player_api.php
// route, so the Movies/Series/Search shots render real content. All titles are
// fictional (deterministic word-bank combos, no real brands); posters are
// generated SVG gradients keyed by a per-item hue.
// ---------------------------------------------------------------------------

const ADJ = ['Silent', 'Broken', 'Golden', 'Crimson', 'Hidden', 'Frozen', 'Electric', 'Wild',
  'Distant', 'Iron', 'Velvet', 'Neon', 'Midnight', 'Lost', 'Rising', 'Savage', 'Hollow',
  'Radiant', 'Shattered', 'Northern'];
const NOUN = ['Horizon', 'Empire', 'Harbor', 'Echo', 'Voyage', 'Circuit', 'Starfield', 'Verdict',
  'Signal', 'Legacy', 'Tide', 'Mirage', 'Stardust', 'Ember', 'Summit', 'Drift', 'Lantern',
  'Orbit', 'Ashes', 'Meridian'];
const catTitle = (i) => `${ADJ[i % ADJ.length]} ${NOUN[(i * 7 + 3 + Math.floor(i / NOUN.length)) % NOUN.length]}`;
const hueFor = (i) => (i * 47 + 200) % 360;
const XT_BASE = 'http://xtream.local:8080';
const poster = (hue) => `${XT_BASE}/img/p.svg?h=${hue}`;

function posterSvg(hue) {
  const h2 = (hue + 45) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},58%,48%)"/>` +
    `<stop offset="1" stop-color="hsl(${h2},50%,17%)"/></linearGradient></defs>` +
    `<rect width="300" height="450" fill="url(#g)"/>` +
    `<circle cx="150" cy="158" r="66" fill="hsla(${hue},80%,90%,0.15)"/>` +
    `<rect x="0" y="374" width="300" height="76" fill="rgba(0,0,0,0.30)"/></svg>`;
}

const VOD_CATS = [['1', 'Action & Adventure'], ['2', 'Comedy'], ['3', 'Drama'], ['4', 'Sci-Fi & Fantasy'],
  ['5', 'Thriller'], ['6', 'Family'], ['7', 'Documentary']];
const MOVIES = [];
{ let id = 100; for (const [cat] of VOD_CATS) for (let n = 0; n < 10; n++, id++)
  MOVIES.push({ stream_id: String(id), name: catTitle(id), category_id: cat, hue: hueFor(id) }); }

const SERIES_CATS = [['1', 'Drama'], ['2', 'Comedy'], ['3', 'Crime'], ['4', 'Sci-Fi'],
  ['5', 'Fantasy'], ['6', 'Reality'], ['7', 'Animation']];
const SERIESES = [];
{ let id = 500; for (const [cat] of SERIES_CATS) for (let n = 0; n < 9; n++, id++)
  SERIESES.push({ series_id: String(id), name: catTitle(id + 3), category_id: cat, hue: hueFor(id + 11) }); }

const CAST = 'Ava Sterling, Marcus Vale, Lena Hoffmann, Diego Cruz';
const DIRECTORS = ['R. Callahan', 'T. Okafor', 'M. Lindqvist', 'S. Nakamura'];
const PLOTS = [
  'A reluctant courier is pulled into a citywide conspiracy after a routine drop goes wrong.',
  'Two estranged siblings reunite for one impossible summer that changes everything.',
  'On the edge of a dying colony, an engineer bets everything on a signal from deep space.',
  'A small-town detective unravels a decades-old secret buried beneath a quiet harbor.',
];
const catName = (cats, id) => (cats.find(([c]) => c === id) || [, ''])[1];

function playerApiJson(url) {
  const action = new URL(url).searchParams.get('action') || '';
  const catId = new URL(url).searchParams.get('category_id');
  switch (action) {
    case 'get_vod_categories':
      return VOD_CATS.map(([id, name]) => ({ category_id: id, category_name: name }));
    case 'get_vod_streams':
      return MOVIES.filter((m) => !catId || m.category_id === catId).map((m) => ({
        stream_id: m.stream_id, name: m.name, category_id: m.category_id, stream_icon: poster(m.hue),
        rating: `${6 + (Number(m.stream_id) % 4)}.5`, container_extension: 'mp4',
      }));
    case 'get_vod_info': {
      const id = new URL(url).searchParams.get('vod_id');
      const m = MOVIES.find((x) => x.stream_id === id) || MOVIES[0];
      const n = Number(m.stream_id);
      return { info: {
        plot: PLOTS[n % PLOTS.length], cast: CAST, director: DIRECTORS[n % DIRECTORS.length],
        genre: catName(VOD_CATS, m.category_id), releasedate: `${2014 + (n % 11)}-06-12`,
        duration_secs: 5400 + (n % 4) * 900, movie_image: poster(m.hue), cover_big: poster(m.hue),
      } };
    }
    case 'get_series_categories':
      return SERIES_CATS.map(([id, name]) => ({ category_id: id, category_name: name }));
    case 'get_series':
      return SERIESES.filter((s) => !catId || s.category_id === catId).map((s) => ({
        series_id: s.series_id, name: s.name, category_id: s.category_id, cover: poster(s.hue),
        rating: `${7 + (Number(s.series_id) % 3)}.0`,
      }));
    case 'get_series_info': {
      const id = new URL(url).searchParams.get('series_id');
      const s = SERIESES.find((x) => x.series_id === id) || SERIESES[0];
      const mkEps = (season, count) => Array.from({ length: count }, (_, k) => ({
        id: `${id}${season}${k + 1}`, title: `Chapter ${k + 1}: ${NOUN[(Number(id) + season + k) % NOUN.length]}`,
        season, episode_num: k + 1, container_extension: 'mp4',
        info: { plot: PLOTS[(Number(id) + k) % PLOTS.length], duration_secs: 2400 + (k % 3) * 600, movie_image: poster(s.hue) },
      }));
      return { episodes: { 1: mkEps(1, 8), 2: mkEps(2, 6) } };
    }
    default:
      return { user_info: { auth: 1, status: 'Active' } };
  }
}

// A few resume points so the Movies/Series "Continue Watching" rails and the
// detail "Resume" action render. Keyed by accountId (the demo account's stable id).
const RESUME_SEED = {
  'demo-xtream|vod|100': { accountId: 'demo-xtream', kind: 'vod', itemId: '100', name: MOVIES[0].name, poster: poster(MOVIES[0].hue), ext: 'mp4', position: 1830, duration: 5400, updatedAt: NOW - 3 * HOUR },
  'demo-xtream|vod|101': { accountId: 'demo-xtream', kind: 'vod', itemId: '101', name: MOVIES[1].name, poster: poster(MOVIES[1].hue), ext: 'mp4', position: 900, duration: 6300, updatedAt: NOW - 26 * HOUR },
  'demo-xtream|episode|50011': { accountId: 'demo-xtream', kind: 'episode', itemId: '50011', name: `${SERIESES[0].name} — S1E1`, poster: poster(SERIESES[0].hue), ext: 'mp4', position: 600, duration: 2700, updatedAt: NOW - 5 * HOUR },
};

// ---------------------------------------------------------------------------
// EPG (XMLTV)
// ---------------------------------------------------------------------------

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}
const at = (hoursFromMidnight) => MID + Math.round(hoursFromMidnight * HOUR);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Metro One's full schedule for today — drives the program-guide pane and the
// channel-list/OSD "now/next". The 22:00 slot straddles the frozen clock.
const HERO_SCHEDULE = [
  [16.0, 17.25, 'Country Escapes', 'A couple search for their dream rural home with a generous budget and a long wish list.'],
  [17.25, 18.0, 'Brain Game', 'Quiz show in which contestants try to find the most obscure correct answers.'],
  [18.0, 19.0, 'Evening News', 'The latest national and international news, plus sport and weather.'],
  [19.0, 19.5, 'Tonight', 'Topical magazine show with celebrity guests and the stories of the day.'],
  [19.5, 20.0, 'Riverside', 'Drama in a close-knit neighborhood as tensions rise at the local pub.'],
  [20.0, 21.0, 'The Garden Show', 'Seasonal advice and inspiration from the team and their gardens.'],
  [21.0, 22.0, 'The Evening Debate', 'Topical debate from a different town each week with a panel of guests.'],
  [22.0, 22.5, 'Metro News at Ten', "The day's top stories with the latest analysis, plus sport and the weather forecast for the week ahead."],
  [22.5, 23.25, "Tomorrow's Papers", "A lively look at the next day's front pages with guests from across the press."],
  [23.25, 24.5, 'Feature Film: Midnight Protocol', 'An intelligence operative crosses continents to uncover the truth about his past. Action thriller.'],
];

// Pre-set a reminder on one upcoming hero program (22:30 "Tomorrow's Papers", after
// the 22:18 frozen clock) so the EPG shows the accent "set" bell on it — the other
// future programs keep the dim "unset" bell.
const REMINDER = {
  url: `https://demo.local/stream/${CHANNELS[0].id}.m3u8`,
  channelName: CHANNELS[0].name,
  title: "Tomorrow's Papers",
  startMs: at(22.5),
  stopMs: at(23.25),
};

// Catch-up progress on two of the hero channel's already-aired programs so the
// guide renders the resume markers: a finished show (Watched) and a partly
// watched one (Resume + progress bar). Keyed like the app: FNV-1a of the
// stripped stream URL + programme start (ms).
const CATCHUP_URL = `https://demo.local/stream/${CHANNELS[0].id}.m3u8`;
const CATCHUP_PROGRESS = [
  // "The Garden Show" 20:00–21:00 — watched to the end.
  { progStart: at(20), progEnd: at(21), position: 3600, duration: 3600, completed: true, updatedAt: NOW - 80 * 60_000 },
  // "The Evening Debate" 21:00–22:00 — ~25 min in (42%).
  { progStart: at(21), progEnd: at(22), position: 1500, duration: 3600, completed: false, updatedAt: NOW - 40 * 60_000 },
];

function epgXml() {
  const epgChannels = CHANNELS.slice(0, 14);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const ch of epgChannels) {
    parts.push(`<channel id="${ch.id}"><display-name>${esc(ch.name)}</display-name></channel>`);
  }
  const prog = (id, start, stop, title, desc) =>
    `<programme channel="${id}" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">` +
    `<title>${esc(title)}</title>${desc ? `<desc>${esc(desc)}</desc>` : ''}</programme>`;

  // Hero channel: full day + neighboring-day stubs so the date bar spans a week.
  for (const [s, e, title, desc] of HERO_SCHEDULE) {
    parts.push(prog('ch0', at(s), at(e), title, desc));
  }
  for (const d of [-2, -1, 1, 2, 3]) {
    parts.push(prog('ch0', at(d * 24 + 20), at(d * 24 + 21), d < 0 ? 'Highlights' : 'Coverage', ''));
  }
  // Every other visible channel: a current program so the list shows a "now" line.
  for (const ch of epgChannels.slice(1)) {
    parts.push(prog(ch.id, at(22), at(22.5), NOW_TITLES[ch.name] || `${ch.name} Live`, ''));
  }
  parts.push('</tv>');
  return parts.join('\n');
}

const EPG_XML = epgXml();

// Two demo uploaded playlists for the settings screenshot.
const UPLOADS = [
  { id: 'living-room', name: 'Living Room', count: 84, createdAt: NOW - 3_600_000, url: `http://127.0.0.1:${UPLOAD_PORT}/uploads/living-room.m3u` },
  { id: 'sports-pack', name: 'Sports Pack', count: 36, createdAt: NOW - 7_200_000, url: `http://127.0.0.1:${UPLOAD_PORT}/uploads/sports-pack.m3u` },
];
const SERVICE_INFO = { ip: '192.168.1.42', port: UPLOAD_PORT, uploadUrl: `http://192.168.1.42:${UPLOAD_PORT}/upload` };

// ---------------------------------------------------------------------------
// Static file server for dist/
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};

function startServer() {
  const dist = join(ROOT, 'dist');
  const server = createServer(async (req, res) => {
    const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const data = await readFile(join(dist, url));
      res.writeHead(200, { 'Content-Type': MIME[extname(url)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// Page setup shared by every view
// ---------------------------------------------------------------------------

const fulfill = (body, type) => (route) =>
  route.fulfill({ status: 200, contentType: type, headers: { 'access-control-allow-origin': '*' }, body });

async function setupPage(page, {
  upload = false,
  fakeStream = false,
  xtream = false,
  subs = false,
  catchup = false,
  recently = false,
} = {}) {
  // Freeze the clock before any app code runs (real timers keep working).
  await page.addInitScript((fixed) => {
    const RealDate = Date;
    function FakeDate(...args) {
      if (!(this instanceof FakeDate)) return RealDate(...args);
      return args.length ? new RealDate(...args) : new RealDate(fixed);
    }
    FakeDate.now = () => fixed;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    window.Date = FakeDate;
  }, NOW);

  // Seed configured playlists, EPG URL and favorites. The Xtream shots swap the
  // two plain-M3U playlists for two Xtream accounts — that enables the
  // Live · Movies · Series tab bar and the account switcher (its avatar dropdown
  // picks which account drives Movies / Series / Search). Their get.php resolves
  // to the full channel set; the first account (My Xtream) is the active one.
  await page.addInitScript(({ favs, playlists }) => {
    localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
    localStorage.setItem('iptv_epg_url', JSON.stringify('https://demo.local/epg.xml'));
    localStorage.setItem('iptv_favorites', JSON.stringify(favs));
  }, {
    favs: FAVORITE_IDS,
    playlists: xtream
      ? [
          { id: 'demo-xtream', name: 'My Xtream', url: 'http://xtream.local:8080', source: 'xtream', xtream: { username: 'demo', password: 'demo' } },
          { id: 'demo-xtream-2', name: 'Backup Xtream', url: 'http://backup.xtream.local:8080', source: 'xtream', xtream: { username: 'demo2', password: 'demo2' } },
        ]
      : [
          { name: 'Playlist 1', url: 'https://demo.local/playlist1.m3u' },
          { name: 'Playlist 2', url: 'https://demo.local/playlist2.m3u' },
        ],
  });

  // Pre-set one reminder so the EPG shows the "set" bell. The program starts after
  // the frozen clock, so it's a future reminder (no due prompt fires). Compute the
  // channel key with the same FNV-1a the app derives from the stripped stream URL.
  await page.addInitScript((r) => {
    let h = 0x811c9dc5;
    const stable = r.url.split('#')[0].split('?')[0];
    for (let i = 0; i < stable.length; i++) { h ^= stable.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    const channelKey = (h >>> 0).toString(16).padStart(8, '0');
    localStorage.setItem('iptv_reminders', JSON.stringify([
      { channelKey, channelName: r.channelName, title: r.title, startMs: r.startMs, stopMs: r.stopMs },
    ]));
  }, REMINDER);

  // Seed catch-up progress on the hero channel so its already-aired programs show
  // the Resume/Watched markers in the guide. Same FNV-1a key the app derives.
  if (catchup || recently) {
    await page.addInitScript(({ url, entries }) => {
      let h = 0x811c9dc5;
      const stable = url.split('#')[0].split('?')[0];
      for (let i = 0; i < stable.length; i++) { h ^= stable.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      const channelKey = (h >>> 0).toString(16).padStart(8, '0');
      const map = {};
      for (const e of entries) {
        map[`${channelKey}|${e.progStart}`] = { ...e, channelKey, expiresAt: e.progEnd + 7 * 86400 * 1000 };
      }
      localStorage.setItem('iptv_catchup_progress', JSON.stringify(map));
    }, {
      url: CATCHUP_URL,
      entries: recently
        ? CATCHUP_PROGRESS.map(entry => entry.completed ? entry : { ...entry, updatedAt: NOW - 60_000 })
        : CATCHUP_PROGRESS,
    });
  }

  if (recently) {
    await page.addInitScript(({ urls, now }) => {
      const channelKey = (url) => {
        let h = 0x811c9dc5;
        const stable = url.split('#')[0].split('?')[0];
        for (let i = 0; i < stable.length; i++) { h ^= stable.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(16).padStart(8, '0');
      };
      localStorage.setItem('iptv_recently_watched_live', JSON.stringify(
        urls.map((url, index) => ({ channelKey: channelKey(url), updatedAt: now - (index + 1) * 5 * 60_000 })),
      ));
    }, {
      urls: [1, 3, 6, 9, 12].map(index => `https://demo.local/stream/${CHANNELS[index].id}.m3u8`),
      now: NOW,
    });
  }

  // Seed a few resume points so the Movies/Series "Continue Watching" rails and
  // the detail "Resume" action render (Xtream shots only).
  if (xtream) {
    await page.addInitScript((seed) => localStorage.setItem('iptv_resume', JSON.stringify(seed)), RESUME_SEED);
  }

  // Configure the online-subtitle providers (keys/creds so all three are enabled)
  // and mock their search endpoints so the real providers + aggregator run against
  // deterministic data. The shapes mirror each provider's API.
  if (subs) {
    await page.addInitScript(() => {
      localStorage.setItem('iptv_online_subtitles', JSON.stringify({
        preferredLanguage: 'en',
        subdl: { apiKey: 'demo' },
        assrt: { apiKey: '' },
        opensubtitles: { apiKey: 'demo', username: 'demo', password: 'demo', token: '', tokenTs: 0 },
      }));
    });
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    };
    const json = (body) => (route) => route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body });
    await page.route('https://api.opensubtitles.com/**', json(OS_SUBS_JSON));
    await page.route('https://api.subdl.com/**', json(SUBDL_SUBS_JSON));
    await page.route('https://api.assrt.net/**', json(ASSRT_SUBS_JSON));
  }

  // Fake the Luna service bus so the upload service "runs" (settings QR).
  if (upload) {
    await page.addInitScript((port) => {
      window.webOS = {
        service: {
          request(_uri, opts) {
            const m = opts && opts.method;
            if (m === 'start') setTimeout(() => opts.onSuccess && opts.onSuccess({ running: true, port }), 0);
            else if (m === 'uploadEvents') setTimeout(() => opts.onSuccess && opts.onSuccess({ subscribed: true }), 0);
            else if (m === 'stop') setTimeout(() => opts.onSuccess && opts.onSuccess({ stopped: true }), 0);
            else setTimeout(() => opts.onFailure && opts.onFailure({ errorText: 'unmocked: ' + m }), 0);
            return { cancel() { /* no-op */ } };
          },
        },
      };
    }, UPLOAD_PORT);
  }

  await page.route('**/playlist1.m3u', fulfill(M3U_1, 'application/x-mpegurl'));
  await page.route('**/playlist2.m3u', fulfill(M3U_2, 'application/x-mpegurl'));
  await page.route('**/epg.xml', fulfill(EPG_XML, 'application/xml'));
  // Xtream account: get.php is the flattened M3U, xmltv.php the EPG. player_api.php
  // serves the synthetic VOD/series catalog JSON, and /img/*.svg the generated posters.
  if (xtream) {
    await page.route('**/get.php**', fulfill(M3U_ALL, 'application/x-mpegurl'));
    await page.route('**/xmltv.php**', fulfill(EPG_XML, 'application/xml'));
    await page.route('**/player_api.php**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(playerApiJson(route.request().url())) }));
    await page.route('**/img/**', (route) => {
      const hue = Number(new URL(route.request().url()).searchParams.get('h') || '210');
      route.fulfill({ status: 200, contentType: 'image/svg+xml',
        headers: { 'access-control-allow-origin': '*' }, body: posterSvg(hue) });
    });
  }
  // By default abort the played channel's stream — the list/OSD shots don't need
  // video and are captured before hls.js's error escalates. The menu collage opts in
  // (fakeStream) to a fake master with audio/subtitle renditions so hls.js surfaces
  // real tracks; the rest of its (empty) playlists keep it from erroring instantly.
  if (fakeStream) {
    await page.route('**/stream/**', (route) => {
      const url = route.request().url();
      if (/\/stream\/ch\d+\.m3u8(?:[?#]|$)/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl',
          headers: { 'access-control-allow-origin': '*' }, body: MASTER_HLS });
      }
      if (/\.m3u8(?:[?#]|$)/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl',
          headers: { 'access-control-allow-origin': '*' }, body: EMPTY_LIVE });
      }
      return route.abort();
    });
  } else {
    await page.route('**/stream/**', (r) => r.abort());
  }
  await page.route('http://127.0.0.1:8890/**', (r) => r.abort());

  if (upload) {
    await page.route(`http://127.0.0.1:${UPLOAD_PORT}/info`, fulfill(JSON.stringify(SERVICE_INFO), 'application/json'));
    await page.route(`http://127.0.0.1:${UPLOAD_PORT}/uploads`, fulfill(JSON.stringify(UPLOADS), 'application/json'));
    await page.route(`http://127.0.0.1:${UPLOAD_PORT}/uploads/**`, (r) => r.abort());
  }
}

// Dispatch a webOS remote keycode (colored buttons aren't real keyboard keys).
const KEY = { RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406 };
async function remote(page, keyCode) {
  await page.evaluate((kc) => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: kc, bubbles: true })), keyCode);
}

const clearToasts = (page) =>
  page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

// Enter a docked tab-bar section (or expand Search) via a coordinate mouseup —
// the bar activates on a mouseup hit-test (Magic Remote OK fires no click).
async function enterTab(page, section) {
  const tab = page.locator(`.tab-bar-item[data-section="${section}"]`);
  await tab.waitFor({ state: 'visible' });
  const box = await tab.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  // The mouseup focuses the tab <button>; drop it so no UA focus ring shows in
  // the shot (the app draws its own active/focus states; keys go through the
  // global handler, not button focus).
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

// Capture to screenshots/<name>. Disabling animations freezes the infinite
// CSS loops (the playing-indicator pulse, sidebar marquee) that otherwise keep
// the compositor busy and intermittently fail Page.captureScreenshot.
async function shoot(page, name) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.screenshot({ path: join(SHOTS, name), animations: 'disabled', caret: 'hide' });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await page.waitForTimeout(300);
    }
  }
}

async function gotoChannels(page, base) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#view-channels').waitFor({ state: 'visible' });
  await page.locator('.channel-main .channel-now').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.group-icon .group-logo').first().waitFor({ state: 'visible' });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('Building app (esbuild)...');
execSync('node esbuild.config.mjs --preview', { cwd: ROOT, stdio: 'inherit' });
await mkdir(SHOTS, { recursive: true });

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
console.log('Serving dist/ at', base);

const browser = await chromium.launch();
const newPage = async (opts) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE, timezoneId: TZ });
  const page = await context.newPage();
  await setupPage(page, opts);
  return { context, page };
};

try {
  // 1) Channel list (the hero) — first channel playing + focused, no OSD.
  {
    const { context, page } = await newPage({ recently: true });
    await gotoChannels(page, base);
    await page.keyboard.press('Enter');     // play the focused (first) channel...
    await page.locator('#player-osd .osd-programme-title').waitFor({ state: 'visible' });
    await remote(page, 27);                 // ...then Back, so the list marks it playing (▶) — no OSD
    await page.locator('.channel-main [data-channel-index="0"].playing').waitFor({ state: 'visible' });
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'channel-list.png');
    console.log('  channel-list.png');
    await context.close();
  }

  // 1b) Recently Watched — resumable catch-up mixed with recently played live channels.
  {
    const { context, page } = await newPage({ recently: true });
    await gotoChannels(page, base);
    await page.locator('[data-group="builtin:recently-watched"]').click();
    await page.locator('.channel-main .recent-catchup').waitFor({ state: 'visible' });
    await page.locator('.channel-main .recent-live').first().waitFor({ state: 'visible' });
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'recently-watched.png');
    console.log('  recently-watched.png');
    await context.close();
  }

  // 2) Program guide (EPG) — the three panes, with catch-up resume markers on the
  //    hero channel's already-aired programs: a "Watched" badge on a finished show
  //    and a "Resume" badge + progress bar on a partly-watched one. Focus the
  //    partly-watched row so the markers and the live row below are centered.
  {
    const { context, page } = await newPage({ catchup: true });
    await gotoChannels(page, base);
    await remote(page, KEY.RED); // open EPG
    await page.locator('#view-epg').waitFor({ state: 'visible' });
    await page.locator('.epg-now-badge').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.epg-catchup-badge').first().waitFor({ state: 'visible', timeout: 10_000 });
    await remote(page, 39); // RIGHT → focus the programmes column (first row)
    for (let n = 0; n < 6; n++) await remote(page, 40); // DOWN → "The Evening Debate" (21:00, Resume)
    await page.waitForTimeout(300);
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'epg-guide.png');
    console.log('  epg-guide.png');
    await context.close();
  }

  // 2b) EPG catch-up resume prompt — selecting a partly-watched past program opens
  //     the Resume / Start Over / Cancel dialog at the saved position.
  {
    const { context, page } = await newPage({ catchup: true });
    await gotoChannels(page, base);
    await remote(page, KEY.RED); // open EPG
    await page.locator('#view-epg').waitFor({ state: 'visible' });
    await page.locator('.epg-catchup-badge').first().waitFor({ state: 'visible', timeout: 10_000 });
    await remote(page, 39); // RIGHT → focus the programmes column
    for (let n = 0; n < 6; n++) await remote(page, 40); // DOWN → "The Evening Debate" (21:00, Resume)
    await remote(page, 13); // ENTER → open the resume prompt
    await page.locator('.catchup-resume-prompt').waitFor({ state: 'visible' });
    await page.locator('.catchup-resume-btn').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'epg-catchup-resume.png');
    console.log('  epg-catchup-resume.png');
    await context.close();
  }

  // 3) Settings (incl. LAN-upload QR + uploaded playlists).
  {
    const { context, page } = await newPage({ upload: true });
    await gotoChannels(page, base);
    await remote(page, KEY.BLUE); // open settings
    await page.locator('#view-settings').waitFor({ state: 'visible' });
    await page.locator('.upload-qr').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#upload-entries .settings-row').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#playlist-entries .settings-row:not(.playlist-header-row)').nth(1).evaluate((el) => el.remove());
    await page.locator('.settings-main').evaluate((el) => {
      const sources = el.querySelector('#settings-sources');
      if (!(sources instanceof HTMLElement)) return;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = sources.offsetTop + 30;
    });
    await clearToasts(page);
    await page.waitForTimeout(300);
    await shoot(page, 'settings.png');
    console.log('  settings.png');
    await context.close();
  }

  // 3b) Theme picker — scroll Settings to Appearance and select a preview swatch.
  {
    const { context, page } = await newPage();
    await gotoChannels(page, base);
    await remote(page, KEY.BLUE);
    await page.locator('#view-settings').waitFor({ state: 'visible' });
    const picker = page.locator('.theme-swatch-grid');
    await picker.waitFor({ state: 'attached' });
    await picker.evaluate((el) => el.parentElement?.scrollIntoView({ block: 'start' }));
    await page.locator('.theme-swatch[data-theme-id="midnight"]').click();
    await picker.waitFor({ state: 'visible' });
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'themes.png');
    console.log('  themes.png');
    await context.close();
  }

  // 4) Playback overlays — grouped channel switcher (left) + action menu (right), no OSD.
  {
    const { context, page } = await newPage({ fakeStream: true, recently: true });
    await gotoChannels(page, base);
    // hls.js requests the (aborted) media playlists only after parsing the master, so
    // this confirms the audio/subtitle track lists are populated before the menu opens
    // — it renders once, on open, and isn't re-rendered when tracks arrive later.
    const tracksReady = page.waitForRequest(/\/stream\/(?:video|audio-|sub-)/, { timeout: 10_000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await page.locator('#player-osd .osd-programme-title').waitFor({ state: 'visible' });
    await tracksReady;
    // The app shows these one at a time. Open the menu so it renders (with the real
    // Audio Track / Subtitles rows), then open the sidebar; the menu's content
    // persists and is forced back on below.
    await page.keyboard.press('ArrowRight'); // open menu (renders content)
    await page.locator('#player-menu.visible').waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowLeft');  // hide menu...
    await page.keyboard.press('ArrowLeft');  // ...open the channel switcher
    await page.locator('#player-sidebar.visible').waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowDown');  // highlight the playing channel
    await page.keyboard.press('ArrowLeft');  // expand and focus the group panel
    await page.locator('#player-sidebar.groups-expanded').waitFor({ state: 'visible' });
    await page.evaluate((bg) => {
      const v = document.getElementById('video-player');
      if (v) { v.classList.remove('active'); try { v.pause(); } catch { /* ignore */ } }
      // hls.js can't play the fake stream, so onError() re-shows #player-osd with a
      // "Stream error" message shortly after a plain hide. An !important rule beats
      // that show(), keeping the OSD out of this collage (channelUp won't fire in time).
      const hideOsd = document.createElement('style');
      hideOsd.textContent = '#player-osd{display:none !important}';
      document.head.appendChild(hideOsd);
      // Force the menu back alongside the sidebar (collage of both overlays).
      // Inline !important beats both the .hidden rule and the pending hide
      // transition's transitionend, which would otherwise re-add .hidden.
      const menu = document.getElementById('player-menu');
      if (menu) {
        menu.classList.remove('hidden');
        menu.classList.add('visible');
        menu.style.setProperty('display', 'flex', 'important');
        menu.style.setProperty('transform', 'translateX(0)', 'important');
      }
      const vp = document.getElementById('view-player');
      if (vp) vp.style.background = bg;
    }, frameGradient('50% 28%'));
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'player.png');
    console.log('  player.png');
    await context.close();
  }

  // 5) Channel info bar (the OSD) — the live DVR (timeshift) view: rewound ~2 min
  //    behind the live edge (scrubber, "behind live" offset, LIVE control), driven
  //    by the feature-rich master so the stream-info pills all show.
  {
    const { context, page } = await newPage({ fakeStream: true });
    // (screenshot-only) A live stream reports duration Infinity; give it a large
    // seekable window so the DVR bar renders. Fake a 4K frame for the resolution
    // badge and keep hls.js on the Dolby Vision / E-AC-3 level (nothing decodes).
    await page.addInitScript(() => {
      if (window.MediaSource) MediaSource.isTypeSupported = () => true;
      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 3840 });
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 2160 });
      Object.defineProperty(HTMLVideoElement.prototype, 'duration', { configurable: true, get: () => Infinity });
      Object.defineProperty(HTMLVideoElement.prototype, 'seekable', {
        configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 600 }),
      });
    });
    await page.route(/\/stream\/ch\d+\.m3u8(?:[?#]|$)/, fulfill(MASTER_HLS_RICH, 'application/vnd.apple.mpegurl'));
    await gotoChannels(page, base);
    await page.keyboard.press('Enter');
    await page.locator('#player-osd .osd-programme-title').waitFor({ state: 'visible' });
    await page.waitForTimeout(1500);
    await page.evaluate((bg) => {
      const v = document.getElementById('video-player');
      if (v) {
        // Pin the playhead ~2 min behind the 10-min live edge, then refresh the
        // DVR bar in place (scrubber → 80%, "-2:00 behind live", LIVE not lit).
        Object.defineProperty(v, 'currentTime', { configurable: true, get: () => 480 });
        v.classList.remove('active');
        v.dispatchEvent(new Event('timeupdate'));
      }
      const vp = document.getElementById('view-player');
      if (vp) vp.style.background = bg;
    }, frameGradient('60% 32%'));
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'channel-info.png');
    console.log('  channel-info.png');
    await context.close();
  }

  // 6) Subtitles — self-rendered WebVTT cues drawn by Blink's `::cue` (see hls-subtitles.md):
  //    <c.class> colors + positioning. Feed the <video> a canvas frame (can't decode headless),
  //    then inject `showing` cues like HlsSubtitles does.
  {
    const { context, page } = await newPage({ fakeStream: true });
    await gotoChannels(page, base);
    await page.keyboard.press('Enter');
    await page.locator('#player-osd .osd-programme-title').waitFor({ state: 'visible' });
    // Clear the OSD for a clean frame, and keep the fake-stream error path from
    // re-showing it (!important beats that show(), as in the player.png collage).
    await page.evaluate(() => {
      const hide = document.createElement('style');
      hide.textContent = '#player-osd{display:none !important}';
      document.head.appendChild(hide);
    });
    await page.evaluate(async ({ cues, inner, outer }) => {
      const v = document.getElementById('video-player');
      if (!v) return;
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const c = canvas.getContext('2d');
      const g = c.createRadialGradient(960, 302, 80, 960, 540, 1200);
      g.addColorStop(0, inner); g.addColorStop(1, outer);
      c.fillStyle = g; c.fillRect(0, 0, 1920, 1080);
      const stream = canvas.captureStream(8);
      v.srcObject = stream;
      v.muted = true;
      v.classList.add('active');
      await v.play().catch(() => { /* ignore */ });
      await new Promise((r) => setTimeout(r, 500)); // let a few frames flow (readyState↑)
      const track = v.addTextTrack('subtitles', 'Subtitles', 'en');
      track.mode = 'showing';
      for (const cue of cues) {
        const x = new VTTCue(0, 1e6, cue.text);
        for (const k of ['vertical', 'line', 'snapToLines', 'position', 'size', 'align']) {
          if (cue[k] !== undefined) x[k] = cue[k];
        }
        track.addCue(x);
      }
      v.pause();
      stream.getTracks().forEach((tr) => tr.stop()); // freeze the canvas frame for capture
    }, { cues: SUBTITLE_CUES, inner: FRAME_INNER, outer: FRAME_OUTER });
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'subtitles.png');
    console.log('  subtitles.png');
    await context.close();
  }

  // 7) Online subtitle search — the REAL SubtitleSearchOverlay, driven end to end:
  //     play a movie, open the VOD player menu, pick Subtitles → "Search online…",
  //     and let the actual providers (network-mocked) + aggregator feed the overlay.
  //     Only OpenSubtitles reports a download count, so the badge shows on its rows
  //     and is absent on the SubDL / Assrt ones.
  {
    const { context, page } = await newPage({ xtream: true, subs: true });
    await gotoChannels(page, base);
    await enterTab(page, 'movies');
    // The first Continue-Watching tile — guaranteed visible; its detail has a Play button.
    const movieTile = page.locator('#view-movies .catalog-tile[data-item-id="100"]').first();
    await movieTile.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(600);
    await movieTile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter'); // open detail
    await page.locator('#view-movies .movies-detail .detail-plot').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(600); // let get_vod_info settle (populates searchMeta)
    // Play the movie → enter the VOD player.
    const play = page.locator('#view-movies .movies-detail [data-action="play"]').first();
    await play.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter');
    await page.locator('#view-player').waitFor({ state: 'visible' });
    // Freeze a video frame behind the modal (headless can't decode the VOD stream).
    await page.evaluate(async ({ inner, outer }) => {
      const v = document.getElementById('video-player');
      if (!v) return;
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const c = canvas.getContext('2d');
      const g = c.createRadialGradient(960, 302, 80, 960, 540, 1200);
      g.addColorStop(0, inner); g.addColorStop(1, outer);
      c.fillStyle = g; c.fillRect(0, 0, 1920, 1080);
      const stream = canvas.captureStream(8);
      v.srcObject = stream; v.muted = true; v.classList.add('active');
      await v.play().catch(() => { /* ignore */ });
      await new Promise((r) => setTimeout(r, 300));
      v.pause();
      stream.getTracks().forEach((tr) => tr.stop());
    }, { inner: FRAME_INNER, outer: FRAME_OUTER });
    // Open the VOD menu (pointer to the right edge), then select Subtitles →
    // "Search online…" by dispatching real clicks (no mouse move, so the pointer
    // handler doesn't dismiss the menu). SEARCH_ONLINE_INDEX is -3.
    await page.mouse.move(1900, 540);
    await page.locator('#player-menu.visible').waitFor({ state: 'visible' });
    await page.locator('#player-menu .menu-item[data-menu-action="__subs_open__"]').dispatchEvent('click');
    await page.locator('#player-menu .menu-item[data-track-index="-3"]').waitFor({ state: 'visible' });
    await page.locator('#player-menu .menu-item[data-track-index="-3"]').dispatchEvent('click');
    // The real providers resolve and SubtitleSearchOverlay renders the ranked rows.
    await page.locator('#subtitle-search .subs-row').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#subtitle-search .subs-count').first().waitFor({ state: 'visible', timeout: 10_000 });
    // Hide the menu + OSD behind the modal for a clean frame.
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = '#player-menu,#player-osd{display:none !important}';
      document.head.appendChild(s);
    });
    await clearToasts(page);
    await page.waitForTimeout(400);
    await shoot(page, 'subtitle-search.png');
    console.log('  subtitle-search.png');
    await context.close();
  }

  // 8) Movies — the cinematic hero + content rails (Continue Watching +
  //    per-category rails), with the account-switcher dropdown open (the avatar in
  //    the tab bar picks which Xtream account drives Movies / Series / Search).
  {
    const { context, page } = await newPage({ xtream: true });
    await gotoChannels(page, base);
    await enterTab(page, 'movies');
    await page.locator('#view-movies .catalog-browse').waitFor({ state: 'visible' });
    await page.locator('#view-movies .catalog-tile').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(800); // let the poster SVGs paint
    // Open the account-switcher dropdown via a coordinate mouseup (Magic Remote OK
    // fires no click); its circular avatar sits at the right end of the tab bar.
    const avatar = page.locator('.account-avatar');
    const box = await avatar.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.locator('.account-menu').waitFor({ state: 'visible' });
    // Drop UA focus so no button focus ring shows in the shot.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await clearToasts(page);
    await shoot(page, 'movies.png');
    console.log('  movies.png');
    await context.close();
  }

  // 9) Movie detail — plot/cast/genre/duration + Resume / Play, opened from the
  //    first (Continue Watching) poster, which carries a seeded resume point.
  {
    const { context, page } = await newPage({ xtream: true });
    await gotoChannels(page, base);
    await enterTab(page, 'movies');
    const movieTile = page.locator('#view-movies .catalog-tile[data-item-id="100"]').first();
    await movieTile.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(600); // let the section's async catalog load settle before opening detail
    await movieTile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter'); // open the focused movie's detail
    await page.locator('#view-movies .movies-detail .detail-plot').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(600);
    await clearToasts(page);
    await shoot(page, 'movie-detail.png');
    console.log('  movie-detail.png');
    await context.close();
  }

  // 10) Series detail — the season selector over the episode list, opened from the
  //     first series poster.
  {
    const { context, page } = await newPage({ xtream: true });
    await gotoChannels(page, base);
    await enterTab(page, 'series');
    // The first focusable is a Continue-Watching tile (resumes an episode directly),
    // so target a real series poster to open its season/episode detail.
    const seriesTile = page.locator('#view-series .catalog-tile[data-item-id]').first();
    await seriesTile.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(600); // let the section's async catalog load settle
    await seriesTile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter'); // open the focused series' detail
    await page.locator('#view-series .series-detail .episode-row').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(600);
    await clearToasts(page);
    await shoot(page, 'series-detail.png');
    console.log('  series-detail.png');
    await context.close();
  }

  // 11) Search — one query across Channels · Movies · Series. The Search tab
  //     expands an inline input in the tab bar that drives the results view.
  {
    const { context, page } = await newPage({ xtream: true });
    await gotoChannels(page, base);
    await enterTab(page, 'search');
    await page.locator('.tab-bar-search-input').waitFor({ state: 'visible' });
    await page.locator('.tab-bar-search-input').fill('or'); // matches channels, movies, series
    await page.locator('#view-search .catalog-rail-title').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#view-search .catalog-tile[data-stream-id]').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#view-search .search-program-row', { hasText: 'Reminder set' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#view-search .search-program-row').evaluateAll((rows) => {
      const reminder = rows.find((row) => row.querySelector('.search-program-action')?.textContent === 'Reminder set');
      if (!reminder) throw new Error('Search screenshot reminder result is missing');
      const keep = [reminder];
      for (const row of rows) {
        if (row !== reminder && keep.length < 3) keep.push(row);
        row.style.display = 'none';
      }
      for (const row of keep) row.style.display = '';
    });
    await page.waitForTimeout(800);
    await clearToasts(page);
    await shoot(page, 'search.png');
    console.log('  search.png');
    await context.close();
  }

  console.log(`Done — ${TOTAL} channels, scale ${SCALE}x.`);
} finally {
  await browser.close();
  server.close();
}
