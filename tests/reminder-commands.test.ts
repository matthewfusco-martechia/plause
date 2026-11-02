import { describe, expect, it } from 'vitest';
import { MAX_REMINDERS, MAX_REMINDER_CHARACTERS, parseReminderCommand, REMINDER_HELP } from '../packages/agent-core/src/reminder-commands';

const now = Date.parse('2026-10-30T12:00:00.000Z');
const id = 'rem_12345678-1234-1234-1234-123456789abc';

describe('whole-message reminder commands', () => {
  it('publishes bounded reminder help and limits', () => {
    expect(MAX_REMINDERS).toBe(20);
    expect(MAX_REMINDER_CHARACTERS).toBe(300);
    expect(REMINDER_HELP.length).toBeLessThan(1500);
    expect(REMINDER_HELP).toContain('America/New_York');
  });

  it.each([
    ['remind me in 1 minute: call Alex', 60_000, 'call Alex'],
    ['remind me in 5 minutes: call Alex', 300_000, 'call Alex'],
    ['remind me in 2 hours: stretch', 7_200_000, 'stretch'],
    ['remind me in 1 day: check the draft', 86_400_000, 'check the draft'],
    ['REMIND ME IN 2 DAYS: Keep Original Case', 172_800_000, 'Keep Original Case'],
  ])('parses elapsed-duration command %s', (text, offset, instruction) => {
    expect(parseReminderCommand(text as string, now)).toEqual({ type: 'create', instruction,
      schedule: { kind: 'once', at: now + Number(offset) } });
  });

  it.each([
    '2026-11-02T09:00:00-05:00', '2026-11-02T09:00-05:00', '2026-11-02T14:00:00Z',
    '2026-11-02T14:00:00.123Z', '2028-02-29T09:00:00+05:45',
  ])('requires an explicit ISO offset and preserves its exact instant: %s', (time) => {
    expect(parseReminderCommand(`remind me at ${time}: call Alex: confirm the address`, now)).toEqual({
      type: 'create', instruction: 'call Alex: confirm the address', schedule: { kind: 'once', at: Date.parse(time) },
    });
  });

  it('parses a daily wall-clock schedule with an explicit zone', () => {
    expect(parseReminderCommand('remind me every day at 09:00 America/New_York: plan my day', now))
      .toEqual({ type: 'create', instruction: 'plan my day', schedule: { kind: 'daily', time: '09:00', timeZone: 'America/New_York' } });
  });

  it.each(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])('uses Sunday=0 weekday numbering: %s', (day) => {
    expect(parseReminderCommand(`remind me every ${day} at 09:00 UTC: plan`, now)).toEqual({ type: 'create', instruction: 'plan',
      schedule: { kind: 'weekly', weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(day), time: '09:00', timeZone: 'UTC' } });
  });

  it.each(['cancel', 'pause', 'resume'] as const)('parses %s with a stable normalized ID', (action) => {
    expect(parseReminderCommand(`${action.toUpperCase()} REMINDER ${id.toUpperCase()}`, now)).toEqual({ type: action, id });
  });

  it('reschedules an existing reminder to an absolute future time', () => {
    expect(parseReminderCommand(`reschedule reminder ${id} at 2026-11-03T09:00:00-05:00`, now)).toEqual({
      type: 'reschedule', id, schedule: { kind: 'once', at: Date.parse('2026-11-03T14:00:00Z') },
    });
  });

  it.each([
    ['every day at 11:15 Asia/Kathmandu', { kind: 'daily', time: '11:15', timeZone: 'Asia/Kathmandu' }],
    ['every Sunday at 01:30 America/New_York', { kind: 'weekly', weekday: 0, time: '01:30', timeZone: 'America/New_York' }],
  ])('reschedules a wall-clock cadence: %s', (schedule, expected) => {
    expect(parseReminderCommand(`reschedule reminder ${id} ${schedule}`, now)).toEqual({ type: 'reschedule', id, schedule: expected });
  });

  it.each([
    ['reminders', { type: 'list' }], ['Reminders?', { type: 'list' }], ['reminder help', { type: 'help' }],
    ['reminder timezone America/New_York', { type: 'settings', timeZone: 'America/New_York' }],
    ['reminder timezone UTC', { type: 'settings', timeZone: 'UTC' }],
    ['reminder quiet hours 22:00-08:00', { type: 'settings', quietStart: '22:00', quietEnd: '08:00' }],
    ['reminder quiet hours 00:00 - 00:00', { type: 'settings', quietStart: '00:00', quietEnd: '00:00' }],
    ['reminder notifications on', { type: 'settings', notifications: true }],
    ['reminder notifications OFF', { type: 'settings', notifications: false }],
  ])('parses control/settings command %s', (text, expected) => {
    expect(parseReminderCommand(text as string, now)).toEqual(expected);
  });

  it('accepts 300 UTF16 units and rejects 301 or 151 two-unit emoji', () => {
    expect(parseReminderCommand(`remind me in 1 minute: ${'x'.repeat(300)}`, now)?.type).toBe('create');
    expect(parseReminderCommand(`remind me in 1 minute: ${'x'.repeat(301)}`, now)?.type).toBe('invalid');
    expect(parseReminderCommand(`remind me in 1 minute: ${'🙂'.repeat(151)}`, now)?.type).toBe('invalid');
  });
});

describe('invalid, ambiguous and quoted reminder inputs', () => {
  it.each([
    'remind me tomorrow at 9: call Alex', 'remind me at 2026-11-02T09:00:00: call Alex',
    'remind me at 2026-11-02: call Alex', 'remind me at 2026-11-02 09:00:00-05:00: call Alex',
    'remind me at 2026-10-30T12:00:00Z: already now', 'remind me at 2020-01-01T00:00:00Z: past',
    'remind me at 2027-02-29T09:00:00Z: invalid date', 'remind me at 2026-11-31T09:00:00Z: invalid date',
    'remind me at 2026-13-01T09:00:00Z: invalid month', 'remind me at 2026-11-02T24:00:00Z: invalid hour',
    'remind me at 2026-11-02T09:60:00Z: invalid minute', 'remind me at 2026-11-02T09:00:60Z: leap second unsupported',
    'remind me at 2026-11-02T09:00:00+24:00: invalid offset', 'remind me at 2026-11-02T09:00:00+01:60: invalid offset',
    'remind me at 2026-11-02T09:00:00-00:00: unknown offset',
    'remind me in 0 minutes: no', 'remind me in -5 minutes: no', 'remind me in 1.5 hours: no',
    'remind me in 5 seconds: unsupported', 'remind me in 9999999999999999999999999 days: overflow',
    'remind me every day at 9:00 America/New_York: bad time', 'remind me every day at 24:00 UTC: bad time',
    'remind me every day at 09:00: missing zone', 'remind me every day at 09:00 Not/A_Zone: bad zone',
    'remind me every day at 09:00 +01:00: offset is not an IANA zone',
    'remind me every weekday at 09:00 UTC: unsupported cadence', 'remind me every 2 days at 09:00 UTC: unsupported cadence',
    'remind me in 5 minutes:   ', 'remind me in 5 minutes: a\u0000b',
    'cancel reminder 1', 'pause reminder rem_bad', 'resume reminder mem_12345678-1234-1234-1234-123456789abc',
    `reschedule reminder ${id} at tomorrow`, `reschedule reminder ${id} in 5 minutes`,
    'reminder timezone +02:00', 'reminder timezone Not/A_Zone', 'reminder quiet hours 25:00-08:00',
    'reminder quiet hours 22:00-08:60', 'reminder notifications maybe', 'reminder timezone', 'reminder',
  ])('does not execute invalid command: %s', (text) => {
    expect(parseReminderCommand(text, now)?.type).toBe('invalid');
  });

  it.each(['\n', '\r', '\r\n', '\u0085', '\u2028', '\u2029'])('preserves raw trailing newline rejection %j', (newline) => {
    expect(parseReminderCommand(`cancel reminder ${id}${newline}`, now)?.type).toBe('invalid');
    expect(parseReminderCommand(`remind me in 5 minutes: call Alex${newline}another line`, now)?.type).toBe('invalid');
  });

  it.each([
    'Hello', 'Please remind me tomorrow', 'I am discussing reminders, not creating one.',
    '"remind me in 5 minutes: call Alex"', "'cancel reminder rem_12345678-1234-1234-1234-123456789abc'",
    '`remind me in 5 minutes: call Alex`', '```\nremind me in 5 minutes: call Alex\n```',
    `The example says: cancel reminder ${id}`, '', '   ',
  ])('does not treat quoted or embedded text as a command: %s', (text) => {
    expect(parseReminderCommand(text, now)).toBeNull();
  });

  it('rejects an unavailable clock without generating a schedule', () => {
    expect(parseReminderCommand('remind me in 5 minutes: call Alex', Number.NaN)?.type).toBe('invalid');
  });
});
