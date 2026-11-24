import { addDisplayDays, atDisplayHour, displayWeekday, startOfDisplayDay } from '../../utils/time';

export const ASK_TIMES = [
  'any', 'now', 'today', 'tonight', 'tomorrow', 'yesterday', 'weekend', 'this_week',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

export type AskTime = typeof ASK_TIMES[number];

export type TimeWindow = [number, number];

const WEEKDAYS: AskTime[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TONIGHT_FROM_HOUR = 18;
// Until this hour, tonight is still the night under way.
const TONIGHT_LATE_HOUR = 4;

export function askWeekday(time: AskTime): number {
  return WEEKDAYS.indexOf(time);
}

// [first day, day count] a time names, in display days from today.
function days(time: AskTime, weekday: number): [number, number] | null {
  switch (time) {
    case 'today':
    case 'tonight':
      return [0, 1];
    case 'tomorrow':
      return [1, 1];
    case 'yesterday':
      return [-1, 1];
    case 'this_week':
      return [0, 7];
    case 'weekend':
      return weekday === 0 ? [0, 1] : [6 - weekday, 2];
    default: {
      const target = askWeekday(time);
      return target < 0 ? null : [(target - weekday + 7) % 7, 1];
    }
  }
}

export function validHour(hour: number): boolean {
  return hour >= 0 && hour <= 24;
}

/**
 * The hour range a reply names, or null for none: a missing start is
 * midnight, a missing end is the day's end, and a single hour is that hour.
 */
export function askHours(time: AskTime, fromHour: number, toHour: number): [number, number] | null {
  const hasFrom = validHour(fromHour);
  const hasTo = validHour(toHour);
  if (!hasFrom && !hasTo) return time === 'tonight' ? [TONIGHT_FROM_HOUR, 24] : null;
  // A start of 24 is the next day's midnight.
  const from = hasFrom ? fromHour : time === 'tonight' ? TONIGHT_FROM_HOUR : 0;
  // An end of 0 alone is the day's end, not its first hour.
  const to = !hasTo || (!hasFrom && toHour === 0) ? 24 : toHour;
  if (to === from) return [from, from + 1];
  return [from, to > from ? to : to + 24];
}

/** Which display days a reply names, from today, and its hours on each. */
export interface AskPlan {
  span: [number, number];
  hours: [number, number];
}

/** The days and hours a reply names as of `now`, or null for no time filter. */
export function askPlan(time: AskTime, fromHour: number, toHour: number, now: number): AskPlan | null {
  const today = startOfDisplayDay(new Date(now));
  const yesterday = addDisplayDays(today, -1);
  const named = askHours(time, fromHour, toHour);
  const hours = named ?? [0, 24];
  const span = days(time, displayWeekday(today));
  if (time === 'tonight' && now < atDisplayHour(today, TONIGHT_LATE_HOUR).getTime()) {
    // Before the small hours end, tonight is the night under way, as long as
    // the hours it names have not passed.
    const late: [number, number] = validHour(toHour) ? hours : [hours[0], 24 + TONIGHT_LATE_HOUR];
    const open = !validHour(fromHour) && !validHour(toHour);
    if (open || atDisplayHour(yesterday, late[1]).getTime() > now) return { span: [-1, 1], hours: late };
    return { span: [0, 1], hours };
  }
  if (span) return { span, hours };
  if (!named) return null;
  // Hours without a day are the next time they come round, or the night
  // under way when they run past midnight.
  const underWay = atDisplayHour(yesterday, hours[0]).getTime() <= now
    && now < atDisplayHour(yesterday, hours[1]).getTime();
  const ends = atDisplayHour(today, hours[1]).getTime();
  return { span: [underWay ? -1 : ends <= now ? 1 : 0, 1], hours };
}

/**
 * The time windows a reply names, in the guide's display days, or null for no
 * time filter. Hours narrow each day; a range that ends before it starts runs
 * past midnight. A range a clock change skips has no window.
 */
export function askWindows(time: AskTime, fromHour: number, toHour: number, now: number): TimeWindow[] | null {
  if (time === 'now') return [[now, now + 1]];
  const plan = askPlan(time, fromHour, toHour, now);
  if (!plan) return null;
  const today = startOfDisplayDay(new Date(now));
  const windows: TimeWindow[] = [];
  for (let offset = plan.span[0]; offset < plan.span[0] + plan.span[1]; offset++) {
    const day = addDisplayDays(today, offset);
    const start = atDisplayHour(day, plan.hours[0]).getTime();
    const end = atDisplayHour(day, plan.hours[1]).getTime();
    if (end > start) windows.push([start, end]);
  }
  return windows;
}

/** Whether a program running from `start` to `stop` overlaps any window. */
export function inWindows(windows: TimeWindow[], start: number, stop: number): boolean {
  for (const [from, to] of windows) {
    if (start < to && stop > from) return true;
  }
  return false;
}
