import { describe, expect, it } from 'vitest';
import { MAX_MODEL_TOOL_ARGUMENT_CHARACTERS, MODEL_PROPOSAL_TOOLS, parseModelProposal, parseModelToolCall,
  planningContextSchema } from '../packages/agent-core/src/model-proposals';

const iso = '2030-06-01T10:00:00-04:00';
const calendar = { title: 'A simulated library visit', startsAt: iso, durationMinutes: 30 };
const reminder = { instruction: 'Bring the borrowed book', schedule: { kind: 'once', at: iso } };

describe('strict model proposal contracts', () => {
  it('normalizes an explicit one-shot reminder without executing a command', () => {
    expect(parseModelToolCall('propose_reminder', JSON.stringify(reminder))).toEqual({ type: 'reminder.create',
      instruction: reminder.instruction, schedule: { kind: 'once', at: Date.parse(iso) } });
  });
  it.each([
    { kind: 'daily', time: '09:00', timeZone: 'America/New_York' },
    { kind: 'weekly', weekday: 1, time: '09:00', timeZone: 'America/New_York' },
  ])('accepts a named-zone recurring draft %j', (schedule) => {
    expect(parseModelToolCall('propose_reminder', JSON.stringify({ ...reminder, schedule }))).toEqual({
      type: 'reminder.create', instruction: reminder.instruction, schedule,
    });
  });
  it('normalizes the exact calendar instant to UTC', () => {
    expect(parseModelToolCall('propose_calendar_event', JSON.stringify(calendar))).toEqual({ type: 'calendar.create',
      ...calendar, startsAt: '2030-06-01T14:00:00.000Z' });
  });
  it('keeps real Google drafts distinct from simulated calendar drafts', () => {
    expect(parseModelToolCall('propose_google_calendar_event', JSON.stringify(calendar))).toEqual({
      type: 'google_calendar.create', ...calendar, startsAt: '2030-06-01T14:00:00.000Z',
    });
    expect(parseModelToolCall('propose_google_calendar_event', JSON.stringify({ ...calendar, targetUser: 'u_sam' }))).toBeNull();
    expect(parseModelToolCall('propose_google_calendar_event', JSON.stringify({ ...calendar, startsAt: '2030-06-01T10:00:00-00:00' }))).toBeNull();
  });
  it('bounds read-only Google ranges and rejects extra authority before any executor', () => {
    const range = { timeMin: '2030-06-01T10:00:00-04:00', timeMax: '2030-06-02T10:00:00-04:00' };
    expect(parseModelToolCall('query_google_calendar', JSON.stringify(range))).toEqual({ type: 'google_calendar.list',
      timeMin: '2030-06-01T14:00:00.000Z', timeMax: '2030-06-02T14:00:00.000Z' });
    expect(parseModelToolCall('query_google_calendar', JSON.stringify({ ...range, type: 'approve' }))).toBeNull();
    expect(parseModelToolCall('query_google_calendar', JSON.stringify({ ...range, timeMax: '2030-08-01T10:00:00Z' }))).toBeNull();
    expect(parseModelToolCall('query_google_calendar', JSON.stringify({ ...range, timeMax: range.timeMin }))).toBeNull();
  });
  it.each(['2030-02-29T10:00:00Z', '2030-04-31T10:00:00Z', '2030-06-01T25:00:00Z', '2030-06-01T10:00:00',
    '2030-06-01T10:00:00-00:00', '2030-06-01T10:00:60Z', '2030-06-01T10:00:00+14:01', 'tomorrow at nine'])
    ('rejects invalid or ambiguous time %s for both draft types', (startsAt) => {
      expect(parseModelToolCall('propose_calendar_event', JSON.stringify({ ...calendar, startsAt }))).toBeNull();
      expect(parseModelToolCall('propose_reminder', JSON.stringify({ ...reminder, schedule: { kind: 'once', at: startsAt } }))).toBeNull();
    });
  it.each([
    { kind: 'once', at: Date.parse(iso) }, { kind: 'daily', time: '9:00', timeZone: 'America/New_York' },
    { kind: 'daily', time: '09:00', timeZone: 'User/Guessed' }, { kind: 'daily', time: '09:00', timeZone: '+05:00' },
    { kind: 'weekly', weekday: 7, time: '09:00', timeZone: 'UTC' }, { kind: 'weekly', weekday: 1.5, time: '09:00', timeZone: 'UTC' },
    { kind: 'once', at: iso, userId: 'private-tenant' },
  ])('rejects malformed raw schedule %j', (schedule) => {
    expect(parseModelToolCall('propose_reminder', JSON.stringify({ ...reminder, schedule }))).toBeNull();
  });
  it.each([{ ...calendar, userId: 'u_sam' }, { ...calendar, durationMinutes: 0 }, { ...calendar, durationMinutes: 481 },
    { ...calendar, durationMinutes: 30.5 }, { ...calendar, durationMinutes: '30' }, { ...calendar, title: 'x'.repeat(201) },
    { ...calendar, title: 'changed\ncommand' }, { ...calendar, title: ' ' }, { ...calendar, title: ' padded title' }])
    ('rejects extra authority or invalid calendar fields %j', (value) => expect(parseModelToolCall('propose_calendar_event', JSON.stringify(value))).toBeNull());
  it.each(['remember_fact', 'search', 'calendar.create', 'approve', 'send_email'])('does not recognize nonproposal tool %s', (name) => {
    expect(parseModelToolCall(name, JSON.stringify(calendar))).toBeNull();
  });
  it.each(['null', '[]', '{}', 'not-json', `{"title":"${'x'.repeat(MAX_MODEL_TOOL_ARGUMENT_CHARACTERS)}"}`])
    ('fails closed on malformed or excessive arguments', (args) => expect(parseModelToolCall('propose_calendar_event', args)).toBeNull());
  it('validates persisted drafts independently of the current clock', () => {
    const value = { type: 'reminder.create', instruction: 'A past cached draft', schedule: { kind: 'once', at: 1 } };
    expect(parseModelProposal(value)).toEqual(value);
    expect(parseModelProposal({ ...value, execute: true })).toBeNull();
    expect(parseModelProposal({ ...value, schedule: { kind: 'once', at: Number.NaN } })).toBeNull();
    expect(parseModelProposal({ ...value, schedule: { kind: 'once', at: 1, actor: 'admin' } })).toBeNull();
  });
  it('does not mutate an accepted cached draft', () => {
    const value = { type: 'calendar.create', ...calendar };
    const parsed = parseModelProposal(value);
    expect(value.startsAt).toBe(iso);
    expect(parsed).not.toBe(value);
    expect(parsed).toMatchObject({ startsAt: '2030-06-01T14:00:00.000Z' });
  });
  it.each([{ now: 0, timeZone: null }, { now: Date.parse(iso), timeZone: 'America/New_York' }])
    ('accepts only stable allowlisted planning data %j', (value) => expect(planningContextSchema.safeParse(value).success).toBe(true));
  it.each([{ now: -1, timeZone: null }, { now: 1.5, timeZone: null }, { now: 1, timeZone: 'Unknown/Zone' },
    { now: 1, timeZone: null, userId: 'private' }, { now: 1 }])
    ('rejects invalid planning data %j', (value) => expect(planningContextSchema.safeParse(value).success).toBe(false));
  it('makes every advertised object strict with all properties required', () => {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const item = value as Record<string, unknown>;
      if (item.type === 'object') {
        expect(item.additionalProperties).toBe(false);
        expect([...(item.required as string[])].sort()).toEqual(Object.keys(item.properties as object).sort());
      }
      Object.values(item).forEach(visit);
    };
    expect(MODEL_PROPOSAL_TOOLS.map((tool) => tool.name)).toEqual(['propose_reminder', 'propose_calendar_event', 'propose_google_calendar_event', 'query_google_calendar']);
    MODEL_PROPOSAL_TOOLS.forEach((tool) => { expect(tool.strict).toBe(true); visit(tool.parameters); });
  });
});
