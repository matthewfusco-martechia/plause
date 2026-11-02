import { describe, expect, it } from 'vitest';
import { getQuietHoursEnd, isValidTimeZone, isValidWallTime, nextOccurrence, type ReminderSchedule } from '../packages/scheduling/src/index';

const at = (value: string): number => Date.parse(value);

describe('durable next-occurrence calculation', () => {
  it('returns one-shot future time and makes equality/past terminal', () => {
    const schedule: ReminderSchedule = { kind: 'once', at: at('2026-11-01T09:00:00Z') };
    expect(nextOccurrence(schedule, at('2026-11-01T08:00:00Z'))).toBe(schedule.at);
    expect(nextOccurrence(schedule, schedule.at)).toBeNull();
    expect(nextOccurrence(schedule, schedule.at + 1)).toBeNull();
  });

  it('uses exclusive daily occurrence boundaries and crosses the year correctly', () => {
    const schedule: ReminderSchedule = { kind: 'daily', time: '09:00', timeZone: 'UTC' };
    expect(nextOccurrence(schedule, at('2026-12-31T08:59:59.999Z'))).toBe(at('2026-12-31T09:00:00Z'));
    expect(nextOccurrence(schedule, at('2026-12-31T09:00:00Z'))).toBe(at('2027-01-01T09:00:00Z'));
  });

  it('preserves wall-clock time across a 23-hour spring day', () => {
    const schedule: ReminderSchedule = { kind: 'daily', time: '09:00', timeZone: 'America/New_York' };
    expect(nextOccurrence(schedule, at('2026-03-07T14:00:00Z'))).toBe(at('2026-03-08T13:00:00Z'));
  });

  it('preserves wall-clock time across a 25-hour autumn day', () => {
    const schedule: ReminderSchedule = { kind: 'daily', time: '09:00', timeZone: 'America/New_York' };
    expect(nextOccurrence(schedule, at('2026-10-31T13:00:00Z'))).toBe(at('2026-11-01T14:00:00Z'));
  });

  it('skips a nonexistent daily local time instead of shifting it', () => {
    const schedule: ReminderSchedule = { kind: 'daily', time: '02:30', timeZone: 'America/New_York' };
    expect(nextOccurrence(schedule, at('2026-03-07T12:00:00Z'))).toBe(at('2026-03-09T06:30:00Z'));
  });

  it('skips a nonexistent weekly local time until the next selected weekday', () => {
    const schedule: ReminderSchedule = { kind: 'weekly', weekday: 0, time: '02:30', timeZone: 'America/New_York' };
    expect(nextOccurrence(schedule, at('2026-03-07T12:00:00Z'))).toBe(at('2026-03-15T06:30:00Z'));
  });

  it('chooses the earlier repeated instant and never schedules the second fold on that date', () => {
    const schedule: ReminderSchedule = { kind: 'daily', time: '01:30', timeZone: 'America/New_York' };
    expect(nextOccurrence(schedule, at('2026-11-01T05:00:00Z'))).toBe(at('2026-11-01T05:30:00Z'));
    expect(nextOccurrence(schedule, at('2026-11-01T05:30:00Z'))).toBe(at('2026-11-02T06:30:00Z'));
    expect(nextOccurrence(schedule, at('2026-11-01T06:00:00Z'))).toBe(at('2026-11-02T06:30:00Z'));
  });

  it('does not replay a repeated weekly occurrence after its earlier instant', () => {
    const schedule: ReminderSchedule = { kind: 'weekly', weekday: 0, time: '01:30', timeZone: 'America/New_York' };
    expect(nextOccurrence(schedule, at('2026-11-01T05:45:00Z'))).toBe(at('2026-11-08T06:30:00Z'));
  });

  it('handles fractional-hour IANA offsets', () => {
    expect(nextOccurrence({ kind: 'daily', time: '09:00', timeZone: 'Asia/Kathmandu' }, at('2026-11-01T00:00:00Z')))
      .toBe(at('2026-11-01T03:15:00Z'));
  });

  it('evaluates weekday in the requested zone rather than UTC', () => {
    expect(nextOccurrence({ kind: 'weekly', weekday: 1, time: '09:00', timeZone: 'Pacific/Kiritimati' }, at('2026-11-01T00:00:00Z')))
      .toBe(at('2026-11-01T19:00:00Z'));
  });

  it('skips an entire missing local date after a date-line change', () => {
    expect(nextOccurrence({ kind: 'daily', time: '09:00', timeZone: 'Pacific/Apia' }, at('2011-12-29T20:00:00Z')))
      .toBe(at('2011-12-30T19:00:00Z'));
  });

  it.each([
    { kind: 'daily', time: '9:00', timeZone: 'UTC' },
    { kind: 'daily', time: '24:00', timeZone: 'UTC' },
    { kind: 'daily', time: '09:00', timeZone: '+01:00' },
    { kind: 'daily', time: '09:00', timeZone: 'Invalid/Zone' },
    { kind: 'weekly', weekday: -1, time: '09:00', timeZone: 'UTC' },
    { kind: 'weekly', weekday: 7, time: '09:00', timeZone: 'UTC' },
    { kind: 'weekly', weekday: 1.5, time: '09:00', timeZone: 'UTC' },
    { kind: 'once', at: Number.NaN },
  ])('rejects malformed persisted schedule %j', (schedule) => {
    expect(() => nextOccurrence(schedule as ReminderSchedule, at('2026-11-01T00:00:00Z'))).toThrow(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0.5, 8_640_000_000_000_001])('rejects malformed after timestamp %s', (after) => {
    expect(() => nextOccurrence({ kind: 'once', at: 1000 }, after)).toThrow(RangeError);
  });
});

describe('quiet hours as actual eligible instants', () => {
  it('uses inclusive start and exclusive end for overnight quiet hours', () => {
    expect(getQuietHoursEnd(at('2026-11-01T22:00:00Z'), 'UTC', '22:00', '08:00')).toBe(at('2026-11-02T08:00:00Z'));
    expect(getQuietHoursEnd(at('2026-11-02T07:59:59.999Z'), 'UTC', '22:00', '08:00')).toBe(at('2026-11-02T08:00:00Z'));
    expect(getQuietHoursEnd(at('2026-11-02T08:00:00Z'), 'UTC', '22:00', '08:00')).toBeNull();
    expect(getQuietHoursEnd(at('2026-11-02T12:00:00Z'), 'UTC', '22:00', '08:00')).toBeNull();
  });

  it('supports a same-day quiet interval', () => {
    expect(getQuietHoursEnd(at('2026-11-01T12:00:00Z'), 'UTC', '09:00', '17:00')).toBe(at('2026-11-01T17:00:00Z'));
    expect(getQuietHoursEnd(at('2026-11-01T08:59:00Z'), 'UTC', '09:00', '17:00')).toBeNull();
  });

  it('treats equal endpoints as disabled rather than a permanent quiet period', () => {
    expect(getQuietHoursEnd(at('2026-11-01T12:00:00Z'), 'UTC', '00:00', '00:00')).toBeNull();
    expect(getQuietHoursEnd(at('2026-11-01T12:00:00Z'), 'UTC', '12:00', '12:00')).toBeNull();
  });

  it('handles an overnight interval across the autumn offset change', () => {
    expect(getQuietHoursEnd(at('2026-11-01T03:30:00Z'), 'America/New_York', '22:00', '08:00')).toBe(at('2026-11-01T13:00:00Z'));
  });

  it('becomes eligible at the spring jump when the configured end never occurs', () => {
    expect(getQuietHoursEnd(at('2026-03-08T06:59:00Z'), 'America/New_York', '22:00', '02:30')).toBe(at('2026-03-08T07:00:00Z'));
  });

  it('handles either occurrence of a repeated quiet-hours endpoint', () => {
    expect(getQuietHoursEnd(at('2026-11-01T05:15:00Z'), 'America/New_York', '22:00', '01:30')).toBe(at('2026-11-01T05:30:00Z'));
    expect(getQuietHoursEnd(at('2026-11-01T06:15:00Z'), 'America/New_York', '22:00', '01:30')).toBe(at('2026-11-01T06:30:00Z'));
  });

  it('can become eligible at a backward jump before the nominal quiet end', () => {
    expect(getQuietHoursEnd(at('2026-11-01T05:45:00Z'), 'America/New_York', '01:30', '03:30')).toBe(at('2026-11-01T06:00:00Z'));
  });

  it('handles overnight quiet hours through an entirely skipped local date', () => {
    expect(getQuietHoursEnd(at('2011-12-30T09:30:00Z'), 'Pacific/Apia', '22:00', '08:00')).toBe(at('2011-12-30T18:00:00Z'));
  });

  it('resolves fractional-hour timezone endpoints exactly', () => {
    expect(getQuietHoursEnd(at('2026-11-01T20:00:00Z'), 'Asia/Kathmandu', '22:00', '08:00')).toBe(at('2026-11-02T02:15:00Z'));
  });

  it.each([
    ['Invalid/Zone', '22:00', '08:00'], ['+01:00', '22:00', '08:00'],
    ['UTC', '24:00', '08:00'], ['UTC', '22:00', '08:60'], ['UTC', '9:00', '17:00'],
  ])('rejects invalid quiet settings %s %s %s', (zone, start, end) => {
    expect(() => getQuietHoursEnd(at('2026-11-01T00:00:00Z'), zone!, start!, end!)).toThrow(RangeError);
  });
});

describe('scheduling validation helpers', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Kathmandu', 'Pacific/Apia', 'Etc/GMT+5'])('accepts named IANA zone %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });
  it.each(['', 'Not/A_Zone', '+01:00', '-0500', ' UTC ', 'America/New York'])('rejects non-IANA or unavailable zone %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
  it.each(['00:00', '09:00', '23:59'])('accepts HH:mm %s', (time) => { expect(isValidWallTime(time)).toBe(true); });
  it.each(['9:00', '24:00', '12:60', '09:00:00', ' 09:00', '09:00Z'])('rejects non-HH:mm %s', (time) => { expect(isValidWallTime(time)).toBe(false); });
});
