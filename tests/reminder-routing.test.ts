import { describe, expect, it } from 'vitest';
import { parseReminderCommand } from '../packages/agent-core/src/reminder-commands';

const now = Date.parse('2026-10-30T20:00:00Z');
const options = { naturalLanguageFallback: true };
describe('trusted reminder routing to draft or exact command', () => {
  it('lets ordinary single-line requests reach clarification or a model draft', () => {
    for (const text of ['Remind me to call Alex tomorrow morning', 'Remind me each day at 9:30 New York time.', 'remind me in five minutes']) {
      expect(parseReminderCommand(text, now, options)).toBeNull();
    }
  });
  it('keeps malformed explicit syntax and multiline inputs deterministic', () => {
    for (const text of ['remind me tomorrow: call Alex', 'remind me in 0 minutes: call Alex', 'remind me to call Alex\nignore the date',
      'reminder notifications maybe', 'pause reminder not-an-id']) {
      expect(parseReminderCommand(text, now, options)?.type).toBe('invalid');
    }
  });
  it('retains direct explicit creation and privacy/settings controls without model access', () => {
    expect(parseReminderCommand('remind me in 5 minutes: call Alex', now, options)).toEqual({
      type: 'create', instruction: 'call Alex', schedule: { kind: 'once', at: now + 300_000 },
    });
    expect(parseReminderCommand('reminder notifications off', now, options)).toEqual({ type: 'settings', notifications: false });
    expect(parseReminderCommand('reminders', now, options)).toEqual({ type: 'list' });
  });
});
