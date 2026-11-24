import type { TzMode } from '../types';
import { t } from '../i18n';

const WEEKDAY_KEYS = [
  'weekday.0', 'weekday.1', 'weekday.2', 'weekday.3',
  'weekday.4', 'weekday.5', 'weekday.6',
] as const;

// Display-only timezone state. Every absolute instant (Programme.start/stop,
// Date.now(), catch-up seconds) is stored and compared in real UTC; this state
// changes ONLY how those instants are rendered as wall-clock labels. It never
// feeds back into isNow/getProgress or the catch-up {utc} substitution.
//   device — device timezone (DST-aware native getters; the original behavior)
//   feed   — the fixed offset declared in the EPG feed (e.g. +0100)
// 'feed' falls back to 'device' when no offset is known (before the EPG has
// loaded, or for a feed whose timestamps carry none).
let tzMode: TzMode = 'device';
let feedOffsetMin: number | null = null;
let tzRevision = 0;

export function setDisplayTz(mode: TzMode, offsetMin: number | null): void {
  if (mode === tzMode && offsetMin === feedOffsetMin) return;
  tzMode = mode;
  feedOffsetMin = offsetMin;
  tzRevision++;
}

// Changes whenever the display time zone does, so cached labels can tell.
export function displayTzRevision(): number {
  return tzRevision;
}

// Resolved mode after the feed→device fallback.
function activeMode(): TzMode {
  return tzMode === 'feed' && feedOffsetMin == null ? 'device' : tzMode;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

interface DisplayParts {
  year: number;
  month: number; // 0-based
  day: number; // day of month
  weekday: number; // 0=Sun
  hours: number;
  minutes: number;
}

// Wall-clock fields for `date` in the active display timezone.
function displayParts(date: Date): DisplayParts {
  if (activeMode() === 'feed') {
    const s = new Date(date.getTime() + feedOffsetMin! * 60000);
    return {
      year: s.getUTCFullYear(),
      month: s.getUTCMonth(),
      day: s.getUTCDate(),
      weekday: s.getUTCDay(),
      hours: s.getUTCHours(),
      minutes: s.getUTCMinutes(),
    };
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    weekday: date.getDay(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
  };
}

export function parseXmltvDate(str: string | null): Date | null {
  if (!str) return null;
  const match = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, tz] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz ? tz.slice(0, 3) + ':' + tz.slice(3) : 'Z'}`;
  return new Date(iso);
}

// Minutes east of UTC declared by an XMLTV timestamp's offset (`+0100` -> 60),
// or null when the stamp carries no offset.
export function parseXmltvOffsetMinutes(str: string | null): number | null {
  if (!str) return null;
  const m = str.match(/([+-])(\d{2})(\d{2})\s*$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

export function formatTime(date: Date): string {
  const p = displayParts(date);
  return `${pad2(p.hours)}:${pad2(p.minutes)}`;
}

// Weekday + MM/DD label for a day, in the active display timezone.
export function formatDayLabel(date: Date): { weekday: string; date: string } {
  const p = displayParts(date);
  return {
    weekday: t(WEEKDAY_KEYS[p.weekday]),
    date: t('date.monthDay', { month: pad2(p.month + 1), day: pad2(p.day) }),
  };
}

// The given hour of a display day; 24 and past run into the next day. Device
// time sets the wall clock, so a day with a DST change keeps its hours.
export function atDisplayHour(day: Date, hour: number): Date {
  const start = startOfDisplayDay(day);
  if (hour >= 24) return atDisplayHour(addDisplayDays(start, 1), hour - 24);
  if (activeMode() === 'feed') return new Date(start.getTime() + hour * 3600000);
  start.setHours(hour, 0, 0, 0);
  return start;
}

// 0 = Sunday, in the active display timezone.
export function displayWeekday(date: Date): number {
  return displayParts(date).weekday;
}

// Stable YYYY-MM-DD key for a day, in the active display timezone.
export function displayDayKey(date: Date): string {
  const p = displayParts(date);
  return `${p.year}-${pad2(p.month + 1)}-${pad2(p.day)}`;
}

// Start of the display-day containing `date`, as an absolute Date.
export function startOfDisplayDay(date: Date): Date {
  if (activeMode() === 'feed') {
    const s = new Date(date.getTime() + feedOffsetMin! * 60000);
    s.setUTCHours(0, 0, 0, 0);
    return new Date(s.getTime() - feedOffsetMin! * 60000);
  }
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

// Start of the display half-hour containing `ms` (a +5:45 zone still lands on :00/:30).
export function startOfDisplayHalfHour(ms: number): number {
  if (activeMode() === 'feed') {
    const shifted = ms + feedOffsetMin! * 60000;
    return shifted - (((shifted % 1800000) + 1800000) % 1800000) - feedOffsetMin! * 60000;
  }
  // Floors with the instant's own offset: setMinutes would resolve a repeated
  // DST hour to its first occurrence.
  const local = ms - new Date(ms).getTimezoneOffset() * 60000;
  return ms - (((local % 1800000) + 1800000) % 1800000);
}

// `date` shifted by `n` display-days (n may be negative), as an absolute Date.
export function addDisplayDays(date: Date, n: number): Date {
  // The feed offset is fixed (no DST), so display-days are exactly 24h apart.
  if (activeMode() === 'feed') {
    return new Date(date.getTime() + n * 86400000);
  }
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

// Playback position as "m:ss" (or "h:mm:ss" past an hour).
export function formatPosition(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return t('duration.hoursMinutes', { hours: h, minutes: m });
  return t('duration.minutes', { minutes: m });
}

export function getTimeSlots(startTime: Date, hours: number, slotMinutes = 30): Date[] {
  const slots: Date[] = [];
  const start = new Date(startTime);
  start.setMinutes(Math.floor(start.getMinutes() / slotMinutes) * slotMinutes, 0, 0);
  const totalSlots = (hours * 60) / slotMinutes;
  for (let i = 0; i < totalSlots; i++) {
    slots.push(new Date(start.getTime() + i * slotMinutes * 60000));
  }
  return slots;
}

export function isNow(start: Date, stop: Date): boolean {
  const now = Date.now();
  return start.getTime() <= now && stop.getTime() > now;
}

export function getProgress(start: Date, stop: Date): number {
  const now = Date.now();
  const total = stop.getTime() - start.getTime();
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, (now - start.getTime()) / total));
}
