export const MAX_CALENDAR_TITLE_CHARACTERS = 200;
export const APPROVAL_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_DEMO_CALENDAR_EVENTS = 20;
export const MAX_PENDING_ACTION_APPROVALS = 20;
export const MAX_EVENT_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

export type ActionCommand =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'list_events' }
  | { type: 'list_approvals' }
  | { type: 'propose'; startsAt: string; durationMinutes: number; title: string }
  | { type: 'approve'; id: string }
  | { type: 'reject'; id: string }
  | { type: 'cancel_event'; id: string }
  | { type: 'help' }
  | { type: 'invalid'; reason: string };

export const ACTION_HELP = [
  'Simulated calendar commands (no real calendar is connected):',
  'connect demo calendar',
  'disconnect demo calendar',
  'calendar events',
  'propose calendar event at <ISO time with offset> for <1-480> minutes: <title>',
  'approvals',
  'approve <approval_UUID>',
  'reject <approval_UUID>',
  'cancel demo event <event_UUID>',
  'action help',
  'Example time: 2030-06-01T10:00:00-04:00. Choose a future time within 365 days.',
  'Titles are limited to 200 characters. Proposals expire after 10 minutes and need their exact approval ID; a bare yes does nothing. All events and writes are simulated.',
].join('\n');

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const approvalCommand = new RegExp(`^(approve|reject)[ \\t]+(approval_${uuid})$`, 'i');
const cancelCommand = new RegExp(`^cancel[ \\t]+demo[ \\t]+event[ \\t]+(event_${uuid})$`, 'i');
const apparentCommand = /^(?:(?:connect|disconnect)[ \t]+demo[ \t]+calendar\b|calendar[ \t]+events\b|propose[ \t]+calendar[ \t]+event\b|approvals\b|(?:approve|reject)[ \t]+approval(?:_|\b)|cancel[ \t]+demo[ \t]+event\b|action(?:[ \t]+help\b|$))/i;

/** Parse a calendar time without Date.parse's invalid-date normalization. */
export function parseExplicitCalendarTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4], match[5], match[6] ?? '0'].map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined
    || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, milliseconds);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
  const offset = match[8]!;
  let offsetMinutes = 0;
  if (offset.toUpperCase() !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetRemainder = Number(offset.slice(4, 6));
    if (offset === '-00:00' || offsetHours > 14 || offsetRemainder > 59 || (offsetHours === 14 && offsetRemainder !== 0)) return null;
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (offset.startsWith('-') ? -1 : 1);
  }
  const timestamp = local.valueOf() - offsetMinutes * 60_000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseActionCommand(text: string, now = Date.now()): ActionCommand | null {
  const command = text.trim();
  if (!command || !apparentCommand.test(command)) return null;
  if (/[\r\n\u0085\u2028\u2029]/.test(text)) return { type: 'invalid', reason: 'Send one complete action command on one line; quoted examples do not execute actions.' };
  if (/^connect[ \t]+demo[ \t]+calendar$/i.test(command)) return { type: 'connect' };
  if (/^disconnect[ \t]+demo[ \t]+calendar$/i.test(command)) return { type: 'disconnect' };
  if (/^calendar[ \t]+events$/i.test(command)) return { type: 'list_events' };
  if (/^approvals$/i.test(command)) return { type: 'list_approvals' };
  if (/^action[ \t]+help$/i.test(command)) return { type: 'help' };
  const decision = approvalCommand.exec(command);
  if (decision?.[1] && decision[2]) return { type: decision[1].toLowerCase() === 'approve' ? 'approve' : 'reject', id: decision[2].toLowerCase() };
  const cancel = cancelCommand.exec(command);
  if (cancel?.[1]) return { type: 'cancel_event', id: cancel[1].toLowerCase() };
  const proposal = /^propose[ \t]+calendar[ \t]+event[ \t]+at[ \t]+([^ \t]+)[ \t]+for[ \t]+([1-9]\d{0,2})[ \t]+minutes:[ \t]+(.+)$/i.exec(command);
  if (proposal?.[1] && proposal[2] && proposal[3] !== undefined) {
    const startsAt = parseExplicitCalendarTime(proposal[1]);
    if (startsAt === null) return { type: 'invalid', reason: 'Use a valid ISO date and time with an explicit offset, such as 2030-06-01T10:00:00-04:00.' };
    if (!Number.isFinite(now) || startsAt <= now || startsAt - now > MAX_EVENT_FUTURE_MS) {
      return { type: 'invalid', reason: 'Choose a future calendar start within 365 days.' };
    }
    const durationMinutes = Number(proposal[2]);
    if (durationMinutes > 480) return { type: 'invalid', reason: 'Choose a duration from 1 through 480 whole minutes.' };
    const title = proposal[3].trim();
    if (!title || title.length > MAX_CALENDAR_TITLE_CHARACTERS || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(title)) {
      return { type: 'invalid', reason: 'Use a plain-text event title of 1 through 200 characters on one line.' };
    }
    return { type: 'propose', startsAt: new Date(startsAt).toISOString(), durationMinutes, title };
  }
  return { type: 'invalid', reason: 'Use one exact action command. Send action help for the command forms, explicit time format, and approval IDs.' };
}
