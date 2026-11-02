export type ReminderSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; weekday: number; time: string; timeZone: string };

const MINUTE = 60_000;
const DAY = 86_400_000;
const DATE_LIMIT = 8_640_000_000_000_000;
const MAX_SEARCH_DAYS = 370;
const MAX_QUIET_SEARCH_MINUTES = 3 * 24 * 60;
const formatters = new Map<string, Intl.DateTimeFormat>();

interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function isValidWallTime(time: string): boolean {
  return typeof time === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time);
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  // Offset identifiers accepted by newer Intl engines are deliberately excluded:
  // recurring schedules require a named IANA zone with its transition rules.
  if (typeof timeZone !== 'string' || timeZone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timeZone)) {
    throw new RangeError('Use a supported IANA time zone.');
  }
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-CA', { timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  // Validation is performed by Intl even for aliases. Bound the process-local cache.
  if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
  formatters.set(timeZone, created);
  return created;
}

export function isValidTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true; } catch { return false; }
}

function assertInstant(value: number): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > DATE_LIMIT) throw new RangeError('Use an integer epoch timestamp in the supported Date range.');
}

function asUtc(wall: Pick<WallTime, 'year' | 'month' | 'day'> & Partial<Pick<WallTime, 'hour' | 'minute' | 'second'>>): number {
  // Date.UTC treats years 0..99 as 1900..1999; setUTCFullYear preserves the actual year.
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0, 0);
  return date.getTime();
}

function localParts(instant: number, timeZone: string): WallTime {
  const values = new Map(formatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  const displayedYear = Number(values.get('year'));
  return { year: values.get('era') === 'BC' ? 1 - displayedYear : displayedYear,
    month: Number(values.get('month')), day: Number(values.get('day')), hour: Number(values.get('hour')),
    minute: Number(values.get('minute')), second: Number(values.get('second')) };
}

function sameWallTime(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * Invert Intl's instant->wall-clock mapping using the nearby actual offsets,
 * then round-trip each candidate. A gap yields none; a fold yields both.
 * ECMA-402 h23/formatToParts: https://tc39.es/ecma402/#datetimeformat-objects
 * Gap/fold semantics: https://tc39.es/proposal-temporal/docs/timezone.html
 */
function possibleInstants(wall: WallTime, timeZone: string): number[] {
  const naive = asUtc(wall);
  if (!Number.isSafeInteger(naive) || Math.abs(naive) > DATE_LIMIT) return [];
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = naive + hours * 60 * MINUTE;
    if (Math.abs(probe) > DATE_LIMIT) continue;
    offsets.add(asUtc(localParts(probe, timeZone)) - probe);
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (Number.isSafeInteger(candidate) && Math.abs(candidate) <= DATE_LIMIT && sameWallTime(localParts(candidate, timeZone), wall)) matches.push(candidate);
  }
  return matches.sort((a, b) => a - b);
}

/**
 * The next occurrence strictly after `after`. Missing wall-clock times are
 * skipped. For a repeated wall-clock time only the earlier instant is eligible,
 * including when `after` falls between its first and second occurrence.
 */
export function nextOccurrence(schedule: ReminderSchedule, after: number): number | null {
  assertInstant(after);
  if (!schedule || typeof schedule !== 'object') throw new RangeError('Invalid reminder schedule.');
  if (schedule.kind === 'once') {
    assertInstant(schedule.at);
    return schedule.at > after ? schedule.at : null;
  }
  if ((schedule.kind !== 'daily' && schedule.kind !== 'weekly') || !isValidWallTime(schedule.time)
    || (schedule.kind === 'weekly' && (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6))) {
    throw new RangeError('Invalid recurring reminder schedule.');
  }
  formatter(schedule.timeZone);
  const start = localParts(after, schedule.timeZone);
  const startDate = asUtc({ year: start.year, month: start.month, day: start.day });
  if (!Number.isFinite(startDate)) return null;
  const [hour, minute] = schedule.time.split(':').map(Number) as [number, number];
  for (let days = 0; days <= MAX_SEARCH_DAYS; days++) {
    const calendarDate = startDate + days * DAY;
    if (Math.abs(calendarDate) > DATE_LIMIT) return null;
    const date = new Date(calendarDate);
    if (schedule.kind === 'weekly' && date.getUTCDay() !== schedule.weekday) continue;
    const wall = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 };
    const earliest = possibleInstants(wall, schedule.timeZone)[0];
    if (earliest !== undefined && earliest > after) return earliest;
  }
  return null;
}

function inQuietHours(instant: number, timeZone: string, start: number, end: number): boolean {
  const local = localParts(instant, timeZone);
  const minute = local.hour * 60 + local.minute;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * Quiet hours start inclusively and end exclusively. Equal endpoints disable
 * them. Search actual instants so gaps, folds and skipped dates do not delay an
 * eligible send unnecessarily. Millisecond bisection also handles historical
 * offsets with second precision. The search is bounded to three actual days.
 */
export function getQuietHoursEnd(now: number, timeZone: string, start: string, end: string): number | null {
  assertInstant(now);
  formatter(timeZone);
  if (!isValidWallTime(start) || !isValidWallTime(end)) throw new RangeError('Quiet hours require HH:mm wall-clock times.');
  const minutes = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const startMinute = minutes(start);
  const endMinute = minutes(end);
  if (startMinute === endMinute || !inQuietHours(now, timeZone, startMinute, endMinute)) return null;
  let previous = now;
  const firstMinute = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  for (let step = 0; step < MAX_QUIET_SEARCH_MINUTES; step++) {
    const candidate = firstMinute + step * MINUTE;
    if (candidate > DATE_LIMIT) return null;
    if (!inQuietHours(candidate, timeZone, startMinute, endMinute)) {
      let low = previous + 1;
      let high = candidate;
      while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        if (inQuietHours(mid, timeZone, startMinute, endMinute)) low = mid + 1;
        else high = mid;
      }
      return high;
    }
    previous = candidate;
  }
  throw new RangeError('Could not resolve quiet hours within the bounded search.');
}
