import { isValidTimeZone, isValidWallTime, type ReminderSchedule } from '../../scheduling/src/index';

export const MAX_REMINDERS = 20;
export const MAX_REMINDER_CHARACTERS = 300;

export type ReminderCommand =
  | { type: 'create'; instruction: string; schedule: ReminderSchedule }
  | { type: 'list' }
  | { type: 'cancel'; id: string }
  | { type: 'pause'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'reschedule'; id: string; schedule: ReminderSchedule }
  | { type: 'settings'; timeZone?: string; quietStart?: string; quietEnd?: string; notifications?: boolean }
  | { type: 'help' }
  | { type: 'invalid'; reason: string };

export const REMINDER_HELP = [
  'Reminder commands (one unquoted command per line):',
  'remind me in 5 minutes: call Alex',
  'remind me at 2026-11-02T09:00:00-05:00: call Alex',
  'remind me every day at 09:00 America/New_York: plan my day',
  'remind me every Monday at 09:00 America/New_York: plan my week',
  'reminders',
  'cancel reminder rem_UUID',
  'pause reminder rem_UUID',
  'resume reminder rem_UUID',
  'reschedule reminder rem_UUID at 2026-11-03T09:00:00-05:00',
  'Reschedule also accepts every day/every Monday at HH:mm IANA_zone.',
  'reminder timezone America/New_York',
  'reminder quiet hours 22:00-08:00 (equal times turn quiet hours off)',
  'reminder notifications on',
  'reminder notifications off',
  'reminder help',
  `Up to ${MAX_REMINDERS} reminders; instructions up to ${MAX_REMINDER_CHARACTERS} characters. Relative times support whole minutes, hours or days.`,
  'Use an explicit UTC offset or IANA zone; ambiguous dates are not scheduled. Recurrences skip missing DST times and use the earlier repeated time once per date.',
].join('\n');

const reminderId = 'rem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const actionPattern = new RegExp(`^(cancel|pause|resume)[ \\t]+reminder[ \\t]+(${reminderId})$`, 'i');
const reschedulePattern = new RegExp(`^reschedule[ \\t]+reminder[ \\t]+(${reminderId})[ \\t]+(.+)$`, 'i');
const apparentCommand = /^(?:remind[ \t]+me\b|reminders\b|(?:cancel|pause|resume|reschedule)[ \t]+reminder\b|reminder(?:[ \t]+(?:help|timezone|quiet|notifications)\b|$))/i;
const weekdayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const invalidSyntax = 'Use one complete reminder command with an explicit time. Send reminder help for examples.';
const invalidTime = 'Use a future ISO time with Z or a numeric UTC offset, or HH:mm with a valid IANA time zone for recurrences.';

function invalid(reason = invalidSyntax): ReminderCommand {
  return { type: 'invalid', reason };
}

function futureIso(text: string, now: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const offset = match[8]!;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59
    || (offset.toUpperCase() !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59 || offset === '-00:00'))) return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const at = Date.parse(text);
  return Number.isSafeInteger(at) && at > now ? at : null;
}

function recurrence(text: string): ReminderSchedule | null {
  const match = /^every[ \t]+(day|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)[ \t]+at[ \t]+([0-9]{2}:[0-9]{2})[ \t]+([^ \t]+)$/i.exec(text);
  if (!match || !isValidWallTime(match[2]!) || !isValidTimeZone(match[3]!)) return null;
  if (match[1]!.toLowerCase() === 'day') return { kind: 'daily', time: match[2]!, timeZone: match[3]! };
  return { kind: 'weekly', weekday: weekdayNames.indexOf(match[1]!.toLowerCase()), time: match[2]!, timeZone: match[3]! };
}

function scheduleWithoutInstruction(text: string, now: number): ReminderSchedule | null {
  const absolute = /^at[ \t]+(.+)$/i.exec(text);
  if (absolute) {
    const at = futureIso(absolute[1]!, now);
    return at === null ? null : { kind: 'once', at };
  }
  return recurrence(text);
}

function validInstruction(text: string): boolean {
  return text.length > 0 && text.length <= MAX_REMINDER_CHARACTERS && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text);
}

/** Parse only a user's whole single-line command, preserving raw newline rejection. */
export function parseReminderCommand(text: string, now = Date.now(), options: { naturalLanguageFallback?: boolean } = {}): ReminderCommand | null {
  const command = text.trim();
  if (!command || !apparentCommand.test(command)) return null;
  if (/[\r\n\u0085\u2028\u2029]/.test(text)) return invalid('Send one reminder command on one line, without quoted examples or additional lines.');
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8_640_000_000_000_000) return invalid('The current time is unavailable. Please retry.');
  if (/^reminders[.!?]?$/i.test(command)) return { type: 'list' };
  if (/^reminder[ \t]+help$/i.test(command)) return { type: 'help' };
  const action = actionPattern.exec(command);
  if (action) return { type: action[1]!.toLowerCase() as 'cancel' | 'pause' | 'resume', id: action[2]!.toLowerCase() };
  const reschedule = reschedulePattern.exec(command);
  if (reschedule) {
    const schedule = scheduleWithoutInstruction(reschedule[2]!, now);
    return schedule ? { type: 'reschedule', id: reschedule[1]!.toLowerCase(), schedule } : invalid(invalidTime);
  }
  const zone = /^reminder[ \t]+timezone[ \t]+([^ \t]+)$/i.exec(command);
  if (zone) return isValidTimeZone(zone[1]!) ? { type: 'settings', timeZone: zone[1]! } : invalid('Use a valid IANA time zone, such as America/New_York or UTC.');
  const quiet = /^reminder[ \t]+quiet[ \t]+hours[ \t]+([0-9]{2}:[0-9]{2})[ \t]*-[ \t]*([0-9]{2}:[0-9]{2})$/i.exec(command);
  if (quiet) return isValidWallTime(quiet[1]!) && isValidWallTime(quiet[2]!)
    ? { type: 'settings', quietStart: quiet[1]!, quietEnd: quiet[2]! } : invalid('Use quiet hours as HH:mm-HH:mm in 24-hour time.');
  const notifications = /^reminder[ \t]+notifications[ \t]+(on|off)$/i.exec(command);
  if (notifications) return { type: 'settings', notifications: notifications[1]!.toLowerCase() === 'on' };
  const relative = /^remind[ \t]+me[ \t]+in[ \t]+([1-9][0-9]*)[ \t]+(minutes?|hours?|days?):[ \t]+(.+)$/i.exec(command);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const multiplier = unit.startsWith('minute') ? 60_000 : unit.startsWith('hour') ? 3_600_000 : 86_400_000;
    const at = now + amount * multiplier;
    const instruction = relative[3]!.trim();
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(at) || Math.abs(at) > 8_640_000_000_000_000 || at <= now) return invalid(invalidTime);
    if (!validInstruction(instruction)) return invalid(`Use a plain-text reminder of 1-${MAX_REMINDER_CHARACTERS} characters.`);
    return { type: 'create', instruction, schedule: { kind: 'once', at } };
  }
  // Parse recurrence/ISO schedule before the delimiter. ISO's own time colons
  // are preserved because only a colon followed by whitespace splits the text.
  const create = /^remind[ \t]+me[ \t]+(.+?):[ \t]+(.+)$/i.exec(command);
  if (create) {
    const schedule = scheduleWithoutInstruction(create[1]!, now);
    const instruction = create[2]!.trim();
    if (!schedule) return invalid(invalidTime);
    if (!validInstruction(instruction)) return invalid(`Use a plain-text reminder of 1-${MAX_REMINDER_CHARACTERS} characters.`);
    return { type: 'create', instruction, schedule };
  }
  // A conversational request without the reserved schedule/instruction delimiter
  // belongs to the model's draft/clarification path. It cannot create a reminder.
  // Malformed explicit controls and multiline inputs still fail closed above.
  if (options.naturalLanguageFallback && /^remind[ \t]+me\b/i.test(command) && !/:[ \t]/.test(command)) return null;
  return invalid();
}
