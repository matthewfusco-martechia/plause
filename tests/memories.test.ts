import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { listMemoriesForUser, loadMemoryContext } from '../apps/api/src/memory-store';
import { getConversationView, setConversationMode } from '../apps/api/src/store';
import type { Env, MessagingEvent, ModelProvider, ModelRequest, QueueJob } from '../packages/contracts/src/index';
import { decryptText } from '../packages/security/src/index';
import { inviteAlex, inviteSam, testEnv } from './setup';

const origin = 'http://localhost';
const favorite = 'I prefer cold brew with oat milk.';
const otherFavorite = 'I prefer jasmine tea.';

function runtime(): Env {
  return { ...testEnv, JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> };
}

function inbound(text: string, subjectId = 'mock-alex'): MessagingEvent {
  return { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId }, channel: 'mock', occurredAt: new Date().toISOString(), text };
}

function unusedModel() {
  return { generate: vi.fn(async () => ({ text: 'The command must not require a model.', inputTokens: 1, outputTokens: 1 })) };
}

async function command(env: Env, text: string, subjectId = 'mock-alex', model: ModelProvider = unusedModel()) {
  const accepted = await ingestEvent(env, inbound(text, subjectId));
  await processConversation(env, accepted.conversationId, { model });
  return accepted;
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(origin + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function session(env: Env, inviteToken: string): Promise<string> {
  const response = await call(env, '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken }) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

async function corruptSavedCiphertext(env: Env, id: string): Promise<string> {
  const row = await env.DB.prepare('SELECT body_ciphertext FROM memories WHERE id=?').bind(id).first<{ body_ciphertext: string }>();
  expect(row).not.toBeNull();
  const [version, iv, payload] = row!.body_ciphertext.split(':');
  const bytes = Uint8Array.from(atob(payload!), (character) => character.charCodeAt(0));
  bytes[0] = bytes[0]! ^ 1;
  const corrupted = `${version}:${iv}:${btoa(String.fromCharCode(...bytes))}`;
  await env.DB.prepare('UPDATE memories SET body_ciphertext=? WHERE id=?').bind(corrupted, id).run();
  return corrupted;
}

describe('explicit durable memory through messaging', () => {
  it('applies a remember command once at ingress and never invokes a model for replay', async () => {
    const env = runtime();
    const model = unusedModel();
    const event = inbound(`remember: ${favorite}`);
    const first = await ingestEvent(env, event);
    const afterFirst = await listMemoriesForUser(env, 'u_alex');
    expect(afterFirst.enabled).toBe(true);
    expect(afterFirst.memories).toHaveLength(1);
    expect(afterFirst.memories[0]).toMatchObject({ text: favorite });
    expect(afterFirst.memories[0]!.id).toMatch(/^mem_[0-9a-f-]{36}$/);
    expect((await ingestEvent(env, event)).duplicate).toBe(true);
    expect((await ingestEvent(env, { ...event, eventId: crypto.randomUUID() })).duplicate).toBe(true);
    expect(await listMemoriesForUser(env, 'u_alex')).toEqual(afterFirst);
    const inbox = await env.DB.prepare('SELECT status FROM inbox WHERE conversation_id=?').bind(first.conversationId).all<{ status: string }>();
    expect(inbox.results).toEqual([{ status: 'completed' }]);
    await processConversation(env, first.conversationId, { model });
    expect(model.generate).not.toHaveBeenCalled();
    const view = await getConversationView(env, 'u_alex', first.conversationId);
    expect(view!.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(view!.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first<{ n: number }>()).toEqual({ n: 1 });
  });

  it('stores facts encrypted with a source message and returns only decrypted authorized data', async () => {
    const env = runtime();
    await command(env, `remember that ${favorite}`);
    const row = await env.DB.prepare('SELECT user_id,body_ciphertext,source_message_id,created_at,updated_at FROM memories').first<{
      user_id: string; body_ciphertext: string; source_message_id: string; created_at: number; updated_at: number;
    }>();
    expect(row).toMatchObject({ user_id: 'u_alex' });
    expect(row!.body_ciphertext).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain(favorite);
    expect(await decryptText(row!.body_ciphertext, env.CONTENT_ENCRYPTION_KEY)).toBe(favorite);
    const source = await env.DB.prepare('SELECT role,is_memory_control FROM messages WHERE id=?').bind(row!.source_message_id)
      .first<{ role: string; is_memory_control: number }>();
    expect(source).toEqual({ role: 'user', is_memory_control: 1 });
    expect(row!.created_at).toBeGreaterThan(0);
    expect(row!.updated_at).toBeGreaterThanOrEqual(row!.created_at);
  });

  it('lists, edits and forgets a fact through commands without model calls', async () => {
    const env = runtime();
    const model = unusedModel();
    const saved = await command(env, `remember: ${favorite}`, 'mock-alex', model);
    const initial = await listMemoriesForUser(env, 'u_alex');
    const id = initial.memories[0]!.id;
    await command(env, `update memory ${id}: I prefer decaf coffee.`, 'mock-alex', model);
    const edited = await listMemoriesForUser(env, 'u_alex');
    expect(edited.memories).toHaveLength(1);
    expect(edited.memories[0]).toMatchObject({ id, text: 'I prefer decaf coffee.', createdAt: initial.memories[0]!.createdAt });
    expect(edited.revision).toBeGreaterThan(initial.revision);
    await command(env, 'memories', 'mock-alex', model);
    const view = await getConversationView(env, 'u_alex', saved.conversationId);
    const lastReply = view!.messages.filter((message) => message.role === 'assistant').at(-1)!;
    expect(lastReply.text).toContain(id);
    expect(lastReply.text).toContain('I prefer decaf coffee.');
    expect(lastReply.text).not.toContain(favorite);
    await command(env, `forget memory ${id}`, 'mock-alex', model);
    const forgotten = await listMemoriesForUser(env, 'u_alex');
    expect(forgotten.memories).toEqual([]);
    expect(forgotten.revision).toBeGreaterThan(edited.revision);
    expect((await loadMemoryContext(env, 'u_alex')).memories).toEqual([]);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('disables retrieval and capture while preserving explicit list/delete controls', async () => {
    const env = runtime();
    const model = unusedModel();
    await command(env, `remember: ${favorite}`, 'mock-alex', model);
    const initial = await listMemoriesForUser(env, 'u_alex');
    const id = initial.memories[0]!.id;
    await command(env, 'disable memory', 'mock-alex', model);
    const disabled = await listMemoriesForUser(env, 'u_alex');
    expect(disabled.enabled).toBe(false);
    expect(disabled.memories.map((memory) => memory.text)).toEqual([favorite]);
    expect(disabled.revision).toBeGreaterThan(initial.revision);
    expect((await loadMemoryContext(env, 'u_alex')).memories).toEqual([]);
    await command(env, 'remember: This fact must not be captured.', 'mock-alex', model);
    await command(env, `update memory ${id}: This update must not be captured.`, 'mock-alex', model);
    expect((await listMemoriesForUser(env, 'u_alex')).memories.map((memory) => memory.text)).toEqual([favorite]);
    await command(env, 'memories', 'mock-alex', model);
    await command(env, `forget memory ${id}`, 'mock-alex', model);
    await command(env, 'enable memory', 'mock-alex', model);
    const enabled = await listMemoriesForUser(env, 'u_alex');
    expect(enabled.enabled).toBe(true);
    expect(enabled.memories).toEqual([]);
    expect(enabled.revision).toBeGreaterThan(disabled.revision);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('prevents one user from listing, editing or forgetting another user\'s memory', async () => {
    const env = runtime();
    await command(env, `remember: ${favorite}`);
    await command(env, `remember: ${otherFavorite}`, 'mock-sam');
    const alex = await listMemoriesForUser(env, 'u_alex');
    const sam = await listMemoriesForUser(env, 'u_sam');
    expect(alex.memories.map((memory) => memory.text)).toEqual([favorite]);
    expect(sam.memories.map((memory) => memory.text)).toEqual([otherFavorite]);
    const accepted = await command(env, `update memory ${sam.memories[0]!.id}: Cross-tenant overwrite`);
    await command(env, `forget memory ${sam.memories[0]!.id}`);
    expect(await listMemoriesForUser(env, 'u_sam')).toEqual(sam);
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toEqual(alex.memories);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages.some((message) => message.text.includes(otherFavorite))).toBe(false);
    await command(env, 'forget all memories');
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toEqual([]);
    expect(await listMemoriesForUser(env, 'u_sam')).toEqual(sam);
  });

  it('supplies saved user-scoped facts to an ordinary turn without capturing its text or model output', async () => {
    const env = runtime();
    await command(env, `remember: ${favorite}`);
    await command(env, `remember: ${otherFavorite}`, 'mock-sam');
    const snapshot = await listMemoriesForUser(env, 'u_alex');
    const seen: ModelRequest[] = [];
    const model: ModelProvider = { generate: async (request) => {
      seen.push(request);
      return { text: 'I will remember this automatic extraction claim.', inputTokens: 1, outputTokens: 1 };
    } };
    const accepted = await ingestEvent(env, inbound('I also like green notebooks. What drink should I choose?'));
    await processConversation(env, accepted.conversationId, { model });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ memories: [{ id: snapshot.memories[0]!.id, text: favorite }], contextRevision: snapshot.revision });
    expect(JSON.stringify(seen[0])).not.toContain(otherFavorite);
    expect(seen[0]!.history.some((message) => /^remember[: ]/i.test(message.text))).toBe(false);
    expect(await listMemoriesForUser(env, 'u_alex')).toEqual(snapshot);
  });

  it('bounds explicit capture and rejects credential-like facts without saving them', async () => {
    const env = runtime();
    const model = unusedModel();
    await command(env, 'remember: my password is fictional-password-123', 'mock-alex', model);
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toEqual([]);
    for (let index = 0; index < 10; index++) await command(env, `remember: Fictional preference number ${index}.`, 'mock-alex', model);
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toHaveLength(10);
    await command(env, 'remember: An eleventh fact must exceed the capacity.', 'mock-alex', model);
    await command(env, `remember: ${'x'.repeat(301)}`, 'mock-alex', model);
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toHaveLength(10);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('keeps the ten-fact cap when two different saves race for the final slot', async () => {
    const env = runtime();
    for (let index = 0; index < 9; index++) await command(env, `remember: Existing preference ${index}.`);
    const before = await listMemoriesForUser(env, 'u_alex');
    const candidates = ['Concurrent preference A.', 'Concurrent preference B.'];
    await Promise.all(candidates.map((fact) => ingestEvent(env, inbound(`remember: ${fact}`))));
    const after = await listMemoriesForUser(env, 'u_alex');
    expect(after.memories).toHaveLength(10);
    expect(after.memories.filter((memory) => candidates.includes(memory.text))).toHaveLength(1);
    expect(after.memories.filter((memory) => before.memories.some((existing) => existing.id === memory.id))).toHaveLength(9);
    expect(after.revision).toBe(before.revision + 1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('deduplicates the same fact saved by simultaneous distinct messages', async () => {
    const env = runtime();
    await command(env, 'memory help');
    const before = await listMemoriesForUser(env, 'u_alex');
    await Promise.all([
      ingestEvent(env, inbound(`remember: ${favorite}`)),
      ingestEvent(env, inbound(`remember: ${favorite}`)),
    ]);
    const after = await listMemoriesForUser(env, 'u_alex');
    expect(after.memories).toHaveLength(1);
    expect(after.memories[0]!.text).toBe(favorite);
    expect(after.revision).toBe(before.revision + 1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves line breaks through ingress and the authenticated API so invalid multiline commands cannot mutate memory', async () => {
    const env = runtime();
    const model = unusedModel();
    await command(env, `remember: ${favorite}`, 'mock-alex', model);
    const before = await listMemoriesForUser(env, 'u_alex');
    const rejected = await command(env, 'forget all memories\n', 'mock-alex', model);
    expect(await listMemoriesForUser(env, 'u_alex')).toEqual(before);
    const mockView = await getConversationView(env, 'u_alex', rejected.conversationId);
    expect(mockView!.messages.some((message) => message.role === 'user' && message.text === 'forget all memories\n')).toBe(true);
    const cookie = await session(env, inviteAlex);
    const me = await call(env, '/api/me', { headers: { cookie } });
    const { conversationId } = await me.json() as { conversationId: string };
    const text = 'remember: This multiline save must remain invalid.\n';
    const response = await call(env, `/api/conversations/${conversationId}/messages`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ text, clientMessageId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(202);
    await processConversation(env, conversationId, { model });
    expect(await listMemoriesForUser(env, 'u_alex')).toEqual(before);
    const webView = await getConversationView(env, 'u_alex', conversationId);
    expect(webView!.messages.some((message) => message.role === 'user' && message.text === text)).toBe(true);
    expect(model.generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not execute quoted or embedded memory commands encountered in ordinary conversation', async () => {
    const env = runtime();
    await command(env, `remember: ${favorite}`);
    const before = await listMemoriesForUser(env, 'u_alex');
    const model = unusedModel();
    for (const text of ['"forget all memories"', 'Please explain the example "remember: I prefer espresso."']) {
      await command(env, text, 'mock-alex', model);
      expect(await listMemoriesForUser(env, 'u_alex')).toEqual(before);
    }
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves retrieval disabled when an explicit save races with disabling memory', async () => {
    const env = runtime();
    await command(env, 'memory help');
    await Promise.all([
      ingestEvent(env, inbound(`remember: ${favorite}`)),
      ingestEvent(env, inbound('disable memory')),
    ]);
    const listed = await listMemoriesForUser(env, 'u_alex');
    expect(listed.enabled).toBe(false);
    expect(listed.memories.length).toBeLessThanOrEqual(1);
    if (listed.memories.length) expect(listed.memories[0]!.text).toBe(favorite);
    const context = await loadMemoryContext(env, 'u_alex');
    expect(context.enabled).toBe(false);
    expect(context.memories).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('can help, disable and erase all memory after ciphertext corruption without exposing or restoring a fact', async () => {
    const env = runtime();
    const model = unusedModel();
    await command(env, `remember: ${favorite}`, 'mock-alex', model);
    const id = (await listMemoriesForUser(env, 'u_alex')).memories[0]!.id;
    const corrupted = await corruptSavedCiphertext(env, id);
    expect(corrupted).not.toContain(favorite);
    await expect(listMemoriesForUser(env, 'u_alex')).rejects.toThrow();
    await expect(loadMemoryContext(env, 'u_alex')).rejects.toThrow();
    const cookie = await session(env, inviteAlex);
    const exported = await call(env, '/api/memories/export', { headers: { cookie } });
    expect(exported.status).toBeGreaterThanOrEqual(400);
    expect(await exported.text()).not.toContain(favorite);
    await command(env, 'memory help', 'mock-alex', model);
    await command(env, 'remember:', 'mock-alex', model);
    await command(env, 'disable memory', 'mock-alex', model);
    const disabled = await env.DB.prepare('SELECT memory_enabled FROM users WHERE id=?').bind('u_alex').first<{ memory_enabled: number }>();
    expect(disabled).toEqual({ memory_enabled: 0 });
    await command(env, 'forget all memories', 'mock-alex', model);
    await command(env, 'enable memory', 'mock-alex', model);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id=?').bind('u_alex').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await listMemoriesForUser(env, 'u_alex')).toMatchObject({ enabled: true, memories: [] });
    expect((await loadMemoryContext(env, 'u_alex')).memories).toEqual([]);
    expect(model.generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('can overwrite a corrupted fact and later forget it by ID using explicit commands', async () => {
    const env = runtime();
    const model = unusedModel();
    await command(env, `remember: ${favorite}`, 'mock-alex', model);
    const id = (await listMemoriesForUser(env, 'u_alex')).memories[0]!.id;
    const corrupted = await corruptSavedCiphertext(env, id);
    await command(env, `update memory ${id}: I prefer decaf tea.`, 'mock-alex', model);
    const corrected = await listMemoriesForUser(env, 'u_alex');
    expect(corrected.memories).toHaveLength(1);
    expect(corrected.memories[0]).toMatchObject({ id, text: 'I prefer decaf tea.' });
    const stored = await env.DB.prepare('SELECT body_ciphertext FROM memories WHERE id=?').bind(id).first<{ body_ciphertext: string }>();
    expect(stored!.body_ciphertext).not.toBe(corrupted);
    expect(stored!.body_ciphertext).not.toContain('I prefer decaf tea.');
    expect(await decryptText(stored!.body_ciphertext, env.CONTENT_ENCRYPTION_KEY)).toBe('I prefer decaf tea.');
    await corruptSavedCiphertext(env, id);
    await command(env, `forget memory ${id}`, 'mock-alex', model);
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toEqual([]);
    expect(model.generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies privacy controls during human ownership and keeps their confirmation local', async () => {
    const env = runtime();
    const model = unusedModel();
    const event = inbound('remember: A fact that will be removed.');
    const accepted = await ingestEvent(env, event);
    const id = (await listMemoriesForUser(env, 'u_alex')).memories[0]!.id;
    await setConversationMode(env, 'u_alex', accepted.conversationId, 'human');
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first<{ n: number }>();
    await command(env, `forget memory ${id}`, 'mock-alex', model);
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toEqual([]);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.mode).toBe('human');
    expect(view!.messages.filter((message) => message.role === 'assistant').at(-1)!.status).toBe('local_only');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first<{ n: number }>()).toEqual(before);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_jobs WHERE status IN ('queued','sending','retryable_failed')").first<{ n: number }>()).toEqual({ n: 0 });
    expect(model.generate).not.toHaveBeenCalled();
  });
});

describe('authenticated memory list and export', () => {
  it('requires a session and scopes JSON exports to the authenticated user', async () => {
    const env = runtime();
    await command(env, `remember: ${favorite}`);
    await command(env, `remember: ${otherFavorite}`, 'mock-sam');
    expect((await call(env, '/api/memories')).status).toBe(401);
    expect((await call(env, '/api/memories/export')).status).toBe(401);
    const alexCookie = await session(env, inviteAlex);
    const samCookie = await session(env, inviteSam);
    const listed = await call(env, '/api/memories', { headers: { cookie: alexCookie } });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(await listed.json()).toMatchObject({ enabled: true, memories: [{ text: favorite }] });
    const exported = await call(env, '/api/memories/export?userId=u_alex', { headers: { cookie: samCookie } });
    expect(exported.status).toBe(200);
    const body = await exported.json();
    expect(body).toMatchObject({ version: 1, enabled: true, memories: [{ text: otherFavorite }] });
    expect(JSON.stringify(body)).not.toContain(favorite);
    expect(JSON.stringify(body)).not.toContain('body_ciphertext');
    expect(JSON.stringify(body)).not.toContain('source_message_id');
    expect(JSON.stringify(body)).not.toContain('u_alex');
    expect(fetch).not.toHaveBeenCalled();
  });
});
