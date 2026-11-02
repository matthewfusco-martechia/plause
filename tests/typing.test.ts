import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTyping, type TypingContext } from '../apps/api/src/typing';
import { SunshineMessagingClient } from '../packages/messaging-sunshine/src/index';
import type { Env } from '../packages/contracts/src/index';
import { testEnv } from './setup';

const context: TypingContext = { conversationId: 'conv_typing_fixture', leaseToken: 'owned-typing-lease', ownershipVersion: 4 };
const base = (): Env & { TYPING_INDICATORS_ENABLED: string } => ({ ...testEnv, APP_ENV: 'staging', MESSAGING_PROVIDER: 'sunshine',
  LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true', TYPING_INDICATORS_ENABLED: 'true',
  SUNSHINE_SUBDOMAIN: 'plause-fixture', SUNSHINE_APP_ID: 'typing_app', SUNSHINE_APPLE_INTEGRATION_ID: 'typing_apple',
  SUNSHINE_KEY_ID: 'typing_key', SUNSHINE_KEY_SECRET: 'synthetic-typing-secret-never-used-live' });
async function fixture() {
  const env = base(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO conversations(id,user_id,channel,provider,business_id,subject_id,status,mode,provider_control,
      ownership_version,lease_token,lease_until,created_at,last_activity_at) VALUES(?,'u_alex','apple_business','sunshine','typing_app','typing_subject',
      'active','bot','bot',?,?,?,?,?)`).bind(context.conversationId, context.ownershipVersion, context.leaseToken, now + 60_000, now, now),
    env.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,status,conversation_id,reply_consent_at,provider_conversation_id)
      VALUES('sunshine','typing_app','typing_subject','u_alex','apple_business','active',?,?,'trusted_typing_thread')`).bind(context.conversationId, now),
  ]);
  return env;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('authorized ephemeral Apple typing indicators', () => {
  it('sends exactly one fixed-path start and stop using the binding destination without persisting content or timing', async () => {
    const env = await fixture(), fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchImpl);
    await setTyping(env, { ...context, providerConversationId: 'untrusted_override' } as TypingContext, true);
    await setTyping(env, context, false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [index, [url, init]] of fetchImpl.mock.calls.entries()) {
      expect(url).toBe('https://plause-fixture.zendesk.com/sc/v2/apps/typing_app/conversations/trusted_typing_thread/activity');
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('manual');
      expect(JSON.parse(String(init?.body))).toEqual({ author: { type: 'business' }, type: index === 0 ? 'typing:start' : 'typing:stop' });
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first()).toEqual({ n: 0 });
  });

  it.each([{ TYPING_INDICATORS_ENABLED: 'false' }, { LIVE_MESSAGING_ENABLED: 'false' }, { APPLE_CHANNEL_APPROVED: 'false' },
    { MESSAGING_PROVIDER: 'mock' }, { APP_ENV: 'local' }, { APP_ENV: 'unknown' }, { SUNSHINE_KEY_SECRET: '' },
    { SUNSHINE_SUBDOMAIN: 'https://attacker.invalid' }, { SUNSHINE_APP_ID: 'another_app' }])
    ('makes no request for disabled or invalid configuration %j', async (overrides) => {
      await setTyping({ ...await fixture(), ...overrides }, context, true); expect(fetch).not.toHaveBeenCalled();
    });

  it.each(['human_mode','provider_handoff','revoked_binding','disabled_account','missing_consent','expired_lease','wrong_owner','closed','pause','restore'] as const)
    ('suppresses both start and stop for %s', async (change) => {
      const env = await fixture();
      if (change === 'human_mode') await env.DB.prepare("UPDATE conversations SET mode='human'").run();
      if (change === 'provider_handoff') await env.DB.prepare("UPDATE conversations SET provider_control='human'").run();
      if (change === 'revoked_binding') await env.DB.prepare("UPDATE bindings SET status='revoked' WHERE provider='sunshine'").run();
      if (change === 'disabled_account') await env.DB.prepare("UPDATE users SET status='disabled' WHERE id='u_alex'").run();
      if (change === 'missing_consent') await env.DB.prepare("UPDATE bindings SET reply_consent_at=NULL WHERE provider='sunshine'").run();
      if (change === 'expired_lease') await env.DB.prepare('UPDATE conversations SET lease_until=0').run();
      if (change === 'wrong_owner') await env.DB.prepare("UPDATE bindings SET user_id='u_sam' WHERE provider='sunshine'").run();
      if (change === 'closed') await env.DB.prepare("UPDATE conversations SET status='closed'").run();
      if (change === 'pause' || change === 'restore') await env.DB.prepare('INSERT INTO system_settings(key,value) VALUES(?,?)')
        .bind(change === 'pause' ? 'outbound_paused' : 'restore_locked', 'true').run();
      await setTyping(env, context, true); await setTyping(env, context, false); expect(fetch).not.toHaveBeenCalled();
    });

  it('requires the current lease and ownership version', async () => {
    const env = await fixture();
    await setTyping(env, { ...context, leaseToken: 'another-lease' }, true);
    await setTyping(env, { ...context, ownershipVersion: 3 }, true);
    await setTyping(env, { ...context, ownershipVersion: -1 }, true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['restore','pause','handoff','relink','revoke','erase','epoch','expired_lease'] as const)
    ('rechecks authorization after the initial DB snapshot when %s arrives before the network call', async (change) => {
      const env = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void; const observed = new Promise<void>((resolve) => { entered = resolve; });
      const original = SunshineMessagingClient.prototype.typing;
      vi.spyOn(SunshineMessagingClient.prototype, 'typing').mockImplementation(async function (this: SunshineMessagingClient, ...args) {
        entered(); await gate; return original.apply(this, args);
      });
      const pending = setTyping(env, context, true);
      try {
        await observed;
        if (change === 'restore' || change === 'pause') await env.DB.prepare('INSERT INTO system_settings(key,value) VALUES(?,?)')
          .bind(change === 'restore' ? 'restore_locked' : 'outbound_paused', 'true').run();
        if (change === 'handoff') await env.DB.prepare("UPDATE conversations SET provider_control='human'").run();
        if (change === 'relink') await env.DB.prepare("UPDATE bindings SET provider_conversation_id='replacement_thread' WHERE provider='sunshine'").run();
        if (change === 'revoke') await env.DB.prepare("UPDATE bindings SET status='revoked' WHERE provider='sunshine'").run();
        if (change === 'erase') await env.DB.prepare("DELETE FROM users WHERE id='u_alex'").run();
        if (change === 'epoch') await env.DB.prepare('UPDATE conversations SET ownership_version=ownership_version+1').run();
        if (change === 'expired_lease') await env.DB.prepare('UPDATE conversations SET lease_until=0').run();
      } finally { release(); }
      await expect(pending).resolves.toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
      expect(warning.mock.calls.flat()).toEqual(['{"code":"typing_indicator_unavailable"}']);
    });

  it('makes no retries and does not disclose provider errors or private identifiers', async () => {
    const env = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('PRIVATE PROVIDER BODY synthetic-typing-secret-never-used-live', { status: 503 }));
    vi.stubGlobal('fetch', fetchImpl);
    await expect(setTyping(env, context, true)).resolves.toBeUndefined(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat()).toEqual(['{"code":"typing_indicator_unavailable"}']);
  });

  it('bounds a stalled request to one second without retrying it', async () => {
    const env = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetchImpl);
    const pending = setTyping(env, context, true);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(warning.mock.calls.flat()).toEqual(['{"code":"typing_indicator_unavailable"}']);
  });
});
