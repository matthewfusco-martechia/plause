import { describe, expect, it } from 'vitest';
import { MAX_MEMORIES, MAX_MEMORY_CHARACTERS, MEMORY_HELP, parseMemoryCommand } from '../packages/agent-core/src/memory-commands';

const id = 'mem_1a2b3c4d-1234-4abc-8def-123456789abc';

describe('explicit memory command grammar', () => {
  it.each([
    ['remember: I prefer tea.', { type: 'save', content: 'I prefer tea.' }],
    ['remember that My name is Alex', { type: 'save', content: 'My name is Alex' }],
    ['  ReMeMbEr ThAt   I prefer Green Tea.  ', { type: 'save', content: 'I prefer Green Tea.' }],
    ['memories', { type: 'list' }],
    ['MEMORIES?', { type: 'list' }],
    ['memories.', { type: 'list' }],
    ['what do you remember about me?', { type: 'list' }],
    ['What do you remember about me', { type: 'list' }],
    ['what do you remember about me!', { type: 'list' }],
    [`forget memory ${id}`, { type: 'forget', id }],
    [`FORGET MEMORY ${id.toUpperCase()}`, { type: 'forget', id }],
    ['forget all memories', { type: 'forget_all' }],
    [`update memory ${id}: I now prefer Coffee.`, { type: 'update', id, content: 'I now prefer Coffee.' }],
    [`UPDATE MEMORY ${id.toUpperCase()}: My Name is Alex.`, { type: 'update', id, content: 'My Name is Alex.' }],
    ['disable memory', { type: 'disable' }],
    ['ENABLE MEMORY', { type: 'enable' }],
    ['memory help', { type: 'help' }],
  ])('parses only a complete command: %s', (text, expected) => {
    expect(parseMemoryCommand(text as string)).toEqual(expected);
  });

  it.each([
    '', 'Hello Plause', 'I remember my childhood.', 'Please remember that I prefer tea.',
    'Can you remember my name?', 'Remember when we talked about tea?', 'remember to call Mom',
    'I want to disable memory', 'Can you forget all memories?', 'Forget about my last question.',
    'Example: remember: I prefer tea', 'Here is a command: forget all memories',
    '"remember: I prefer tea"', "'forget all memories'", '`disable memory`',
    '> remember: I prefer tea', '```\nremember: I prefer tea\n```',
    'A quoted example:\nforget all memories', '**remember: I prefer tea**',
  ])('keeps ordinary chat and quoted or embedded examples out of the command path: %s', (text) => {
    expect(parseMemoryCommand(text)).toBeNull();
  });

  it.each([
    'remember:', 'remember:   ', 'remember that', 'remember : I prefer tea', 'remember:tea',
    'forget memory', 'forget memory wrong-id', 'forget memories', 'forget all memory', 'forget all memories now',
    `forget memory ${id} trailing`, `forget memory ${id}.`,
    'update memory', `update memory ${id}: `, `update memory ${id}:Tea`,
    'update memory mem_not-a-uuid: Tea', 'disable memory please', 'enable memory now',
    'memory', 'memory help now', 'memories all', 'what do you remember about me? Tell me more.',
    `forget memory ${id.replaceAll('-', '')}`, `forget memory ${id.replace('1234-4abc', '1234z4abc')}`,
  ])('returns a helpful non-mutating result for malformed commands: %s', (text) => {
    expect(parseMemoryCommand(text)).toMatchObject({ type: 'invalid', reason: expect.any(String) });
  });

  it.each([
    'remember: Tea\nCoffee', 'remember: Tea\rCoffee', 'remember: Tea\r\nCoffee',
    'remember: Tea\u2028Coffee', 'remember: Tea\u2029Coffee', 'remember: Tea\u0085Coffee',
    'forget all memories\n', '\nforget all memories', 'disable memory\nremember: Tea',
    `update memory ${id}: Tea\nCoffee`,
  ])('rejects multiline messages before trimming can turn them into writes: %s', (text) => {
    expect(parseMemoryCommand(text)).toMatchObject({ type: 'invalid' });
  });

  it('accepts the stated fact boundary while rejecting oversized saves and updates', () => {
    const fact = 'a'.repeat(MAX_MEMORY_CHARACTERS);
    expect(parseMemoryCommand(`remember: ${fact}`)).toEqual({ type: 'save', content: fact });
    expect(parseMemoryCommand(`remember that ${fact}a`)).toMatchObject({ type: 'invalid' });
    expect(parseMemoryCommand(`update memory ${id}: ${fact}a`)).toMatchObject({ type: 'invalid' });
  });

  it('uses the same UTF-16 length bound as storage and preserves fact text', () => {
    const fact = '🌿'.repeat(MAX_MEMORY_CHARACTERS / 2);
    expect(parseMemoryCommand(`remember: ${fact}`)).toEqual({ type: 'save', content: fact });
    expect(parseMemoryCommand(`remember: ${fact}🌿`)).toMatchObject({ type: 'invalid' });
    expect(parseMemoryCommand('remember: My display name is Zoë 👩‍💻.')).toEqual({ type: 'save', content: 'My display name is Zoë 👩‍💻.' });
  });

  it('does not split or execute command-like text within an explicitly saved fact', () => {
    const fact = 'My project title is “forget all memories”.';
    expect(parseMemoryCommand(`remember: ${fact}`)).toEqual({ type: 'save', content: fact });
  });
});

describe('conservative credential guard', () => {
  it.each([
    'My password is a fictional placeholder', 'My passcode is 1234', 'My API key is a fictional placeholder',
    'My apiKey is a fictional placeholder', 'My access_token is a fictional placeholder',
    'My private key is a fictional placeholder', 'My client-secret is a fictional placeholder',
    'My SSN is a fictional placeholder', 'My social security number is a fictional placeholder',
    'My debit card is a fictional placeholder', 'My credit-card is a fictional placeholder',
    'My card number is a fictional placeholder', '123-45-6789', '123 45 6789', '123456789',
    '4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111',
    'sk-fictional_placeholder_123456', 'ghp_fictional_placeholder_123456', 'AKIA1234567890123456',
    'eyJfictional123456.abcdefgh12345678.abcdefgh12345678',
    'My ＰＡＳＳＷＯＲＤ is a placeholder', 'My pa\u200bssword is a placeholder',
  ])('rejects credential-like content for both writes without echoing it: %s', (fact) => {
    for (const text of [`remember: ${fact}`, `update memory ${id}: ${fact}`]) {
      const result = parseMemoryCommand(text);
      expect(result).toMatchObject({ type: 'invalid' });
      if (result?.type === 'invalid') {
        expect(result.reason).toContain('conservative guard');
        expect(result.reason).not.toContain(fact);
      }
    }
  });

  it.each(['remember: Tea\u0000Coffee', 'remember: Tea\tCoffee', 'remember: Tea\u202eCoffee'])('rejects control characters in facts: %s', (text) => {
    expect(parseMemoryCommand(text)).toMatchObject({ type: 'invalid' });
  });

  it('allows ordinary preferences, a short year, and prose that includes command names', () => {
    for (const fact of ['I prefer coffee without sugar.', 'My fictional project began in 2026.', 'My favorite command is memory help.']) {
      expect(parseMemoryCommand(`remember: ${fact}`)).toEqual({ type: 'save', content: fact });
    }
  });
});

describe('memory command help and limits', () => {
  it('publishes bounded plain-text help and the storage limits', () => {
    expect(MAX_MEMORIES).toBe(10);
    expect(MAX_MEMORY_CHARACTERS).toBe(300);
    expect(MEMORY_HELP.length).toBeLessThanOrEqual(1000);
    for (const command of ['remember:', 'remember that', 'memories', 'forget memory', 'update memory', 'forget all memories', 'disable memory', 'enable memory', 'memory help']) {
      expect(MEMORY_HELP).toContain(command);
    }
    expect(MEMORY_HELP).toContain('not a complete sensitive-data classifier');
  });
});
