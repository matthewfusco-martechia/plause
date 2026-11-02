export const MAX_MEMORIES = 10;
export const MAX_MEMORY_CHARACTERS = 300;

export type MemoryCommand =
  | { type: 'save'; content: string }
  | { type: 'list' }
  | { type: 'forget'; id: string }
  | { type: 'forget_all' }
  | { type: 'update'; id: string; content: string }
  | { type: 'disable' }
  | { type: 'enable' }
  | { type: 'help' }
  | { type: 'invalid'; reason: string };

export const MEMORY_HELP = [
  'Memory commands:',
  'remember: <fact>',
  'remember that <fact>',
  'memories',
  'forget memory <mem_UUID>',
  'update memory <mem_UUID>: <fact>',
  'forget all memories',
  'disable memory',
  'enable memory',
  'memory help',
  `Save up to ${MAX_MEMORIES} facts, ${MAX_MEMORY_CHARACTERS} characters each. Use the ID from your memory list.`,
  'Send one unquoted command on one line. Credential-like content is blocked by a conservative guard, not a complete sensitive-data classifier. Do not save passwords, passcodes, API keys, tokens, private keys, SSNs, or card numbers.',
].join('\n');

// Only the canonical, hyphenated UUID spelling is accepted. The stored lookup
// form is lowercase; fact text is never case-normalized or interpreted as code.
const memoryId = 'mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const forgetPattern = new RegExp(`^forget[ \\t]+memory[ \\t]+(${memoryId})$`, 'i');
const updatePattern = new RegExp(`^update[ \\t]+memory[ \\t]+(${memoryId}):[ \\t]+(.+)$`, 'i');
const apparentCommand = /^(?:remember[ \t]*:|remember[ \t]+that\b|forget[ \t]+(?:memor(?:y|ies)\b|all[ \t]+memor(?:y|ies)\b)|update[ \t]+memory\b|(?:disable|enable)[ \t]+memory\b|memory(?:[ \t]+help\b|$)|memories\b|what[ \t]+do[ \t]+you[ \t]+remember[ \t]+about[ \t]+me\b)/i;
const invalidSyntax = 'Use one complete memory command. Send memory help for the supported commands and ID format.';
const sensitiveReason = 'Memory cannot save credential-like content such as passwords, passcodes, API keys, access tokens, private keys, SSNs, or card numbers. This is a conservative guard, not a complete sensitive-data classifier.';

/** Conservative rejection guard, not a promise to detect all sensitive data. */
function looksSensitive(content: string): boolean {
  const normalized = content.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
  if (/\b(?:password|passcode|api[ \t_-]*key|access[ \t_-]*token|private[ \t_-]*key|secret[ \t_-]*key|client[ \t_-]*secret|ssn|social[ \t_-]*security(?:[ \t_-]*number)?|(?:credit|debit)[ \t_-]*card|card[ \t_-]*number)\b/i.test(normalized)) return true;
  if (/\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,}|AKIA[0-9A-Z]{16})\b/i.test(normalized)) return true;
  if (/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i.test(normalized)) return true;
  if (/\b\d{3}[ -]?\d{2}[ -]?\d{4}\b/.test(normalized)) return true;
  return /(?:^|[^\d])(?:\d[ -]?){12,18}\d(?:$|[^\d])/.test(normalized);
}

function validatedContent(value: string): string | { type: 'invalid'; reason: string } {
  const content = value.trim();
  if (!content) return { type: 'invalid', reason: 'Include the fact to remember. Send memory help for examples.' };
  if (content.length > MAX_MEMORY_CHARACTERS) {
    return { type: 'invalid', reason: `Keep each memory to ${MAX_MEMORY_CHARACTERS} characters or fewer.` };
  }
  if (/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(content)) {
    return { type: 'invalid', reason: 'Use plain text on one line for a memory, without control characters.' };
  }
  if (looksSensitive(content)) return { type: 'invalid', reason: sensitiveReason };
  return content;
}

/**
 * Interpret only a user's whole-message explicit command. Do not run this on
 * model output, retrieved documents, or extracted lines from a larger message.
 * Quoted/code/embedded examples are not commands, and line breaks never mutate.
 */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const command = text.trim();
  if (!command || !apparentCommand.test(command)) return null;
  // Inspect the original text before trimming: even a trailing newline makes
  // this a multiline message and must not become a destructive command.
  if (/[\r\n\u0085\u2028\u2029]/.test(text)) {
    return { type: 'invalid', reason: 'Send one memory command on one line, without quoted examples or additional lines.' };
  }
  if (/^(?:memories|what[ \t]+do[ \t]+you[ \t]+remember[ \t]+about[ \t]+me)[.!?]?$/i.test(command)) return { type: 'list' };
  if (/^forget[ \t]+all[ \t]+memories$/i.test(command)) return { type: 'forget_all' };
  if (/^disable[ \t]+memory$/i.test(command)) return { type: 'disable' };
  if (/^enable[ \t]+memory$/i.test(command)) return { type: 'enable' };
  if (/^memory[ \t]+help$/i.test(command)) return { type: 'help' };
  const forget = forgetPattern.exec(command);
  if (forget?.[1]) return { type: 'forget', id: forget[1].toLowerCase() };
  const update = updatePattern.exec(command);
  if (update?.[1] && update[2] !== undefined) {
    const content = validatedContent(update[2]);
    return typeof content === 'string' ? { type: 'update', id: update[1].toLowerCase(), content } : content;
  }
  const save = /^(?:remember:[ \t]+|remember[ \t]+that[ \t]+)(.+)$/i.exec(command);
  if (save?.[1] !== undefined) {
    const content = validatedContent(save[1]);
    return typeof content === 'string' ? { type: 'save', content } : content;
  }
  return { type: 'invalid', reason: invalidSyntax };
}
