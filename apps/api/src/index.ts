import { z } from 'zod';
import { eventSchema, type Env, type QueueJob } from '../../../packages/contracts/src/index';
import { equalSecret, verifyWebhook } from '../../../packages/security/src/index';
import { currentUser, getSessionProof, login, logout, sessionCookie } from './auth';
import { getConversationView, getWebConversation, setConversationMode } from './store';
import { ingestEvent, processConversation, recoverPending } from './pipeline';
import { modelReadiness } from './model-config';
import { parseMemoryCommand } from '../../../packages/agent-core/src/memory-commands';
import { isSupportRequest } from '../../../packages/agent-core/src/index';
import { listMemoriesForUser } from './memory-store';
import { parseReminderCommand } from '../../../packages/agent-core/src/reminder-commands';
import { parseActionCommand } from '../../../packages/agent-core/src/action-commands';
import { listRemindersForUser } from './reminder-store';
import { listActionsForUser } from './action-store';
import { createDeletionIntent, createSessionDeletionIntent, exportAccountPage, getAccountSummary } from './account';
import { getOperatorStatus, getUserUsage } from './operations';
import { parseResearchCommand } from '../../../packages/research/src/index';
import { researchReadiness } from './research';
import { beginGoogleOAuth, completeGoogleOAuth, disconnectGoogleCalendar, getGoogleConnection, googleOAuthCookie } from './google-oauth';
import { listGoogleCalendarActions, parseGoogleCalendarCommand } from './google-calendar';
import { assertRuntimeProviders, requestAllowed, mockMessagingAllowed, appleEntryUrl } from '../../../packages/contracts/src/runtime-policy';
import { identityReadiness, beginIdentityLogin, completeIdentityLogin, identityFlowCookie } from './identity';
import { startChannelLink, parseChannelLinkCommand, recordVerifiedChannelLink, getChannelLink, confirmChannelLink,
  listChannelBindings, revokeChannelBinding } from './channel-linking';
import { acknowledgeWebDelivery } from '../../../packages/messaging-web/src/index';
import { requestErasure, recoverPrivacyOperations } from './privacy-ledger';
import { getOperatorCapabilities, requireOperatorActor, listOperatorGrants, setOperatorGrant,
  listSupportInbox, claimSupportConversation, getSupportConversation, renewSupportClaim, releaseSupportClaim,
  resumeSupportConversation, enqueueSupportReply, getSupportCoverage } from './operator-support';
import { normalizeAuthenticatedWebhook, sunshineReadiness } from '../../../packages/messaging-sunshine/src/index';
import { ingestSunshineEvent } from './sunshine-ingress';
import { onboardingReadiness, processOnboarding } from './messaging-onboarding';
import { assertOperational, maintenanceState, enforceAuthStartRateLimit, enforceAccountApiRateLimit,
  journalDeadLetter, recoverDeadLetters, runRetention, runtimeOperationsReadiness } from './runtime-operations';
import { stagingAccessResponse } from './staging-access';

const MAX_BODY = 20_000;
const loginSchema = z.object({ inviteToken: z.string().min(32).max(200) }).strict();
const messageSchema = z.object({ text: z.string().min(1).max(4000).refine((text) => text.trim().length > 0), clientMessageId: z.string().uuid() }).strict();
const handoffSchema = z.object({ mode: z.enum(['bot', 'human']) }).strict();
class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function readBody(request: Request, limit = MAX_BODY): Promise<string> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json_required');
  }
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, 'body_too_large');
  if (!request.body) throw new HttpError(400, 'empty_body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError(400, 'invalid_utf8'); }
}

async function jsonBody(request: Request): Promise<unknown> {
  try { return JSON.parse(await readBody(request)) as unknown; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json'); }
}

function requireSameOrigin(request: Request): void {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, 'origin_rejected');
}

async function operator(request: Request, env: Env): Promise<void> {
  const authorization = request.headers.get('authorization');
  if (env.APP_ENV === 'local' && env.OPERATOR_TOKEN && authorization?.startsWith('Bearer ')
      && await equalSecret(authorization.slice(7), env.OPERATOR_TOKEN)) return;
  const actor = await requireOperatorActor(env, await getSessionProof(env, request));
  if (actor.role !== 'admin') throw new HttpError(403, 'operator_role_required');
  if (!['GET','HEAD'].includes(request.method)) requireSameOrigin(request);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return Response.json({ product: 'Plause', environment: env.APP_ENV,
      ...modelReadiness(env), research: researchReadiness(env), messaging: env.MESSAGING_PROVIDER,
      apple: { ...sunshineReadiness(env), enabled: env.LIVE_MESSAGING_ENABLED === 'true' && env.APPLE_CHANNEL_APPROVED === 'true',
        onboarding: onboardingReadiness(env) } });
  }
  if (url.pathname === '/ready' && request.method === 'GET') {
    const state = await maintenanceState(env), operations = await runtimeOperationsReadiness(env);
    let providers = true; try { assertRuntimeProviders(env); } catch { providers = false; }
    const identity = identityReadiness(env), model = modelReadiness(env), messaging = sunshineReadiness(env), onboarding = onboardingReadiness(env);
    const ready = providers && operations.encryption.configured && !state.locked && !state.outboundPaused && model.modelReady
      && (env.APP_ENV === 'local' || !!env.PRIVACY_LEDGER && identity.configured)
      && (env.MESSAGING_PROVIDER !== 'sunshine' || messaging.webhookConfigured && messaging.transportConfigured && !!appleEntryUrl(env))
      && (!onboarding.enabled || onboarding.configured);
    return Response.json({ ready, environment: env.APP_ENV, maintenance: state, identityConfigured: identity.configured,
      modelConfigured: model.modelReady, messagingConfigured: env.MESSAGING_PROVIDER !== 'sunshine' || messaging.webhookConfigured && messaging.transportConfigured,
      encryptionConfigured: operations.encryption.configured, privacyLedgerConfigured: !!env.PRIVACY_LEDGER,
      onboarding, liveAcceptanceVerified: false }, { status: ready ? 200 : 503 });
  }
  if (!requestAllowed(env, request)) throw new HttpError(503, 'origin_not_configured');
  assertRuntimeProviders(env);
  if (!env.CONTENT_ENCRYPTION_KEY || env.APP_ENV === 'local' && (!env.MOCK_WEBHOOK_SECRET || !env.OPERATOR_TOKEN)) {
    throw new HttpError(503, 'runtime_secrets_missing');
  }
  if (url.pathname === '/api/auth/status' && request.method === 'GET') {
    return Response.json({ ...identityReadiness(env), invitationLoginAllowed: env.APP_ENV === 'local', appleEntryUrl: appleEntryUrl(env),
      messagesOnboarding: onboardingReadiness(env) });
  }
  if (url.pathname === '/api/support/coverage' && request.method === 'GET') return Response.json(getSupportCoverage(env));
  if (url.pathname === '/api/auth/google/start' && request.method === 'POST') {
    requireSameOrigin(request);
    await enforceAuthStartRateLimit(env, request, { localKey: 'loopback' });
    const { intent } = z.object({ intent: z.enum(['signin','reauth']).default('signin') }).strict().parse(await jsonBody(request));
    const flow = await beginIdentityLogin(env, request, intent);
    return Response.json({ authorizationUrl: flow.authorizationUrl, expiresAt: flow.expiresAt }, { headers: { 'set-cookie': flow.setCookie } });
  }
  if (url.pathname === '/api/auth/google/callback' && request.method === 'GET') {
    try {
      const result = await completeIdentityLogin(env, request);
      await getWebConversation(env, result.user.id);
      // Account controls are the landing surface for finishing Messages linking.
      const headers = new Headers({ location: '/?signin=complete&onboarding=messages' });
      headers.append('set-cookie', result.setCookie);
      headers.append('set-cookie', result.flowCookie);
      return new Response(null, { status: 303, headers });
    } catch {
      return new Response(null, { status: 303, headers: { location: '/?signin=failed', 'set-cookie': identityFlowCookie(request, '', true) } });
    }
  }

  if (url.pathname === '/api/calendar/google/callback' && request.method === 'GET') {
    // The short-lived Lax proof cookie and stored original session authorize this
    // cross-site callback; the ordinary account cookie deliberately stays Strict.
    try {
      const result = await completeGoogleOAuth(env, request);
      return new Response(null, { status: 303, headers: { location: '/?calendar=connected',
        'set-cookie': result.setCookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    } catch {
      return new Response(null, { status: 303, headers: { location: '/?calendar=failed',
        'set-cookie': googleOAuthCookie(request, '', true), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
  }

  if (url.pathname === '/webhooks/messaging/mock' && request.method === 'POST') {
    if (!mockMessagingAllowed(env)) throw new HttpError(404, 'not_found');
    await assertOperational(env);
    const raw = await readBody(request);
    if (!await verifyWebhook(raw, request.headers.get('x-plause-signature'), env.MOCK_WEBHOOK_SECRET)) {
      throw new HttpError(401, 'invalid_webhook_signature');
    }
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { throw new HttpError(400, 'invalid_json'); }
    const event = eventSchema.parse(value);
    if (event.subject.provider !== 'mock' || event.channel !== 'mock') throw new HttpError(422, 'unsupported_provider');
    const link = event.type === 'message.received' ? parseChannelLinkCommand(event.text) : null;
    if (link) {
      const result = link.type === 'prove' ? await recordVerifiedChannelLink(env, { ...event.subject, channel: event.channel,
        eventId: event.eventId, code: link.code, occurredAt: event.occurredAt }) : { recorded: false };
      return Response.json(result, { status: 202 });
    }
    if (event.type === 'message.received' && !isLocalControl(event.text)) requireModelReady(env);
    const accepted = await ingestEvent(env, event);
    return Response.json(accepted, { status: 202 });
  }

  if (url.pathname === '/webhooks/messaging/sunshine' && request.method === 'POST') {
    if (env.MESSAGING_PROVIDER !== 'sunshine') throw new HttpError(404, 'not_found');
    await assertOperational(env);
    let events;
    try { events = await normalizeAuthenticatedWebhook(env, await readBody(request, 256 * 1024), request.headers); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'sunshine_webhook_unauthorized') throw new HttpError(401, String(error.code));
      if (error instanceof Error && 'code' in error && String(error.code).startsWith('sunshine_')) throw new HttpError(400, String(error.code));
      throw error;
    }
    // Partial acceptance is safe: every event commits with a stable provider ID.
    // A failed batch is retried by the provider and already accepted events dedupe.
    for (const event of events) await ingestSunshineEvent(env, event);
    ctx.waitUntil(wakeOnboarding(env));
    return Response.json({ accepted: events.length }, { status: 202 });
  }

  if (url.pathname === '/api/operator/capabilities' && request.method === 'GET') {
    return Response.json(await getOperatorCapabilities(env, await getSessionProof(env, request)));
  }
  if (url.pathname === '/api/operator/grants' || url.pathname === '/api/operator/support' || url.pathname.startsWith('/api/operator/support/')) {
    await assertOperational(env);
    const actor = await requireOperatorActor(env, await getSessionProof(env, request));
    if (!['GET','HEAD'].includes(request.method)) requireSameOrigin(request);
    await enforceAccountApiRateLimit(env, actor.userId, request);
    if (url.pathname === '/api/operator/grants') {
      if (request.method === 'GET') return Response.json(await listOperatorGrants(env, actor));
      if (request.method === 'POST') return Response.json(await setOperatorGrant(env, actor,
        z.object({ userId: z.string().min(1).max(200), role: z.enum(['admin','support']).nullable() }).strict().parse(await jsonBody(request))));
    }
    if (url.pathname === '/api/operator/support' && request.method === 'GET') return Response.json(await listSupportInbox(env, actor));
    const supportMatch = /^\/api\/operator\/support\/([^/]+)(?:\/(claim|renew|release|resume|reply))?$/.exec(url.pathname);
    if (supportMatch) {
      const id = supportMatch[1]!, action = supportMatch[2];
      if (!action && request.method === 'GET') {
        const before = url.searchParams.get('before');
        if (before !== null && !/^[0-9]{1,16}$/.test(before)) throw new HttpError(400, 'invalid_cursor');
        return Response.json(await getSupportConversation(env, actor, id, before === null ? undefined : Number(before)));
      }
      if (request.method === 'POST') {
        if (action === 'claim') { z.object({}).strict().parse(await jsonBody(request)); return Response.json(await claimSupportConversation(env, actor, id)); }
        if (action === 'reply') {
          const input = z.object({ text: z.string().min(1).max(4000), clientMessageId: z.string().uuid(), claimVersion: z.number().int().positive() }).strict().parse(await jsonBody(request));
          const result = await enqueueSupportReply(env, actor, id, input);
          ctx.waitUntil(wake(env, id));
          return Response.json(result, { status: 202 });
        }
        const { claimVersion } = z.object({ claimVersion: z.number().int().positive() }).strict().parse(await jsonBody(request));
        if (action === 'renew') return Response.json(await renewSupportClaim(env, actor, id, claimVersion));
        if (action === 'release') return Response.json(await releaseSupportClaim(env, actor, id, claimVersion));
        if (action === 'resume') { const result = await resumeSupportConversation(env, actor, id, claimVersion); ctx.waitUntil(wake(env, id)); return Response.json(result); }
      }
    }
    throw new HttpError(404, 'not_found');
  }
  if (url.pathname === '/api/operator/status' && request.method === 'GET') {
    await operator(request, env);
    return Response.json({ ...await getOperatorStatus(env), operations: await runtimeOperationsReadiness(env) });
  }
  if (url.pathname.startsWith('/api/operator/') && request.method === 'POST') {
    await operator(request, env);
    if (url.pathname === '/api/operator/recover') {
      const dispatched = await recoverPending(env);
      ctx.waitUntil(wakeOnboarding(env));
      return Response.json({ dispatched });
    }
    if (url.pathname === '/api/operator/pause') {
      const { paused } = z.object({ paused: z.boolean() }).strict().parse(await jsonBody(request));
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO system_settings(key,value) VALUES ('outbound_paused',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(String(paused)),
        env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
          VALUES (?,NULL,NULL,'outbound.pause_changed',?,?)`).bind(crypto.randomUUID(), String(paused), Date.now()),
      ]);
      if (!paused) {
        ctx.waitUntil(recoverPending(env));
        ctx.waitUntil(wakeOnboarding(env));
      }
      return Response.json({ paused });
    }
    throw new HttpError(404, 'not_found');
  }

  if (url.pathname === '/api/session' && request.method === 'POST') {
    if (env.APP_ENV !== 'local') throw new HttpError(404, 'not_found');
    requireSameOrigin(request);
    const { inviteToken } = loginSchema.parse(await jsonBody(request));
    const signedIn = await login(env, inviteToken);
    if (!signedIn) throw new HttpError(401, 'invalid_invitation');
    const conversationId = await getWebConversation(env, signedIn.user.id);
    return Response.json({ user: signedIn.user, conversationId, authentication: 'development_invitation' }, {
      headers: { 'set-cookie': sessionCookie(request, signedIn.token) },
    });
  }

  if (url.pathname.startsWith('/api/')) {
    const proof = await getSessionProof(env, request);
    const user = proof?.user;
    if (!user) throw new HttpError(401, 'sign_in_required');
    if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);
    if (!(url.pathname === '/api/session' && request.method === 'DELETE')
      && !(url.pathname === '/api/account' && request.method === 'DELETE') && url.pathname !== '/api/account/deletion-intent') await assertOperational(env);
    if (!/\/conversations\/[^/]+\/messages$/.test(url.pathname)) await enforceAccountApiRateLimit(env, user.id, request);
    if (url.pathname === '/api/me' && request.method === 'GET') {
      return Response.json({ user, authentication: proof!.authMethod, conversationId: await getWebConversation(env, user.id) });
    }
    if (url.pathname === '/api/channel-bindings' && request.method === 'GET') return Response.json(await listChannelBindings(env, user.id));
    if (url.pathname === '/api/channel-links' && request.method === 'POST') {
      const consent = z.object({ replyConsent: z.literal(true), proactiveConsent: z.boolean() }).strict().parse(await jsonBody(request));
      return Response.json(await startChannelLink(env, request, user.id, consent), { status: 201 });
    }
    const linkMatch = /^\/api\/channel-links\/([A-Za-z0-9_-]+)(?:\/(confirm))?$/.exec(url.pathname);
    if (linkMatch && request.method === 'GET' && !linkMatch[2]) return Response.json(await getChannelLink(env, request, user.id, linkMatch[1]!));
    if (linkMatch && request.method === 'POST' && linkMatch[2]) {
      const result = await confirmChannelLink(env, request, user.id, linkMatch[1]!);
      ctx.waitUntil(wakeOnboarding(env));
      return Response.json(result);
    }
    const bindingMatch = /^\/api\/channel-bindings\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (bindingMatch && request.method === 'DELETE') return Response.json(await revokeChannelBinding(env, request, user.id, bindingMatch[1]!));
    if (url.pathname === '/api/session' && request.method === 'DELETE') {
      await logout(env, request);
      return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(request, '', true) } });
    }
    if (url.pathname === '/api/calendar/google' && request.method === 'GET') return Response.json(await getGoogleConnection(env, user.id));
    if (url.pathname === '/api/calendar/google/actions' && request.method === 'GET') return Response.json(await listGoogleCalendarActions(env, user.id));
    if (url.pathname === '/api/calendar/google/connect' && request.method === 'POST') {
      const result = await beginGoogleOAuth(env, request, user.id);
      return Response.json({ authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt },
        { headers: { 'set-cookie': result.setCookie, 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/api/calendar/google' && request.method === 'DELETE') {
      return Response.json(await disconnectGoogleCalendar(env, user.id));
    }
    if (request.method === 'GET' && (url.pathname === '/api/memories' || url.pathname === '/api/memories/export')) {
      const state = await listMemoriesForUser(env, user.id);
      if (url.pathname.endsWith('/export')) return Response.json(
        { version: 1, enabled: state.enabled, memories: state.memories },
        { headers: { 'content-disposition': 'attachment; filename="plause-memory.json"' } });
      return Response.json(state);
    }
    if (url.pathname === '/api/usage' && request.method === 'GET') return Response.json(await getUserUsage(env, user.id));
    if (url.pathname === '/api/account' && request.method === 'GET') return Response.json({ ...await getAccountSummary(env, user.id), authentication: proof!.authMethod });
    if (url.pathname === '/api/account/export' && request.method === 'GET') {
      const cursor = url.searchParams.get('after') ?? '0';
      if (!/^[0-9]{1,16}$/.test(cursor)) throw new HttpError(400, 'invalid_cursor');
      return Response.json(await exportAccountPage(env, user.id, Number(cursor)),
        { headers: { 'content-disposition': 'attachment; filename="plause-account.json"' } });
    }
    if (url.pathname === '/api/account/deletion-intent' && request.method === 'POST') {
      const input = z.object({ inviteToken: z.string().min(32).max(200).optional(), confirmation: z.literal('DELETE MY PLAUSE ACCOUNT') }).strict().parse(await jsonBody(request));
      return Response.json(input.inviteToken && env.APP_ENV === 'local'
        ? await createDeletionIntent(env, user.id, input.inviteToken, input.confirmation)
        : await createSessionDeletionIntent(env, request, user.id, input.confirmation));
    }
    if (url.pathname === '/api/account' && request.method === 'DELETE') {
      const input = z.object({ confirmationToken: z.string().min(32).max(200) }).strict().parse(await jsonBody(request));
      const outcome = await requestErasure(env, user.id, input.confirmationToken);
      if (!outcome.deleted && !outcome.pending) throw new HttpError(409, 'deletion_intent_invalid');
      return Response.json(outcome, { status: outcome.pending ? 202 : 200,
        headers: { 'set-cookie': sessionCookie(request, '', true) } });
    }
    if (request.method === 'GET' && url.pathname === '/api/reminders') return Response.json(await listRemindersForUser(env, user.id));
    if (request.method === 'GET' && url.pathname === '/api/actions') return Response.json(await listActionsForUser(env, user.id));
    const match = /^\/api\/conversations\/([^/]+)(?:\/(messages|handoff|receipts))?$/.exec(url.pathname);
    if (match) {
      const id = match[1]!;
      const conversation = await getConversationView(env, user.id, id);
      if (!conversation) throw new HttpError(404, 'conversation_not_found');
      if (!match[2] && request.method === 'GET') return Response.json(conversation);
      if (match[2] === 'receipts' && request.method === 'POST') {
        const { messageIds } = z.object({ messageIds: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict().parse(await jsonBody(request));
        if (conversation.channel !== 'web') throw new HttpError(404, 'conversation_not_found');
        await acknowledgeWebDelivery(env, user.id, id, messageIds);
        return Response.json({ accepted: true });
      }
      if (match[2] === 'messages' && request.method === 'POST') {
        const { text, clientMessageId } = messageSchema.parse(await jsonBody(request));
        await enforceAccountApiRateLimit(env, user.id, request, { privacyControl: !!parseMemoryCommand(text) });
        if (id !== await getWebConversation(env, user.id)) throw new HttpError(404, 'conversation_not_found');
        if (!isLocalControl(text)) requireModelReady(env);
        const accepted = await ingestEvent(env, {
          schemaVersion: 1, type: 'message.received', eventId: `web:${clientMessageId}`,
          messageId: `web:${clientMessageId}`, channel: 'web', occurredAt: new Date().toISOString(),
          subject: { provider: 'web', businessId: 'plause-local', subjectId: user.id }, text,
        });
        return Response.json(accepted, { status: 202 });
      }
      if (match[2] === 'handoff' && request.method === 'POST') {
        const { mode } = handoffSchema.parse(await jsonBody(request));
        if (mode === 'bot' && env.APP_ENV !== 'local') throw new HttpError(403, 'operator_resume_required');
        if (!await setConversationMode(env, user.id, id, mode)) throw new HttpError(409, 'handoff_unavailable');
        if (mode === 'bot') ctx.waitUntil(wake(env, id));
        return Response.json({ ok: true });
      }
    }
    throw new HttpError(404, 'not_found');
  }

  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
  return env.ASSETS.fetch(request);
}

function isLocalControl(text: string): boolean {
  return !!(parseMemoryCommand(text) || parseReminderCommand(text, Date.now(), { naturalLanguageFallback: true })
    || parseGoogleCalendarCommand(text) || parseActionCommand(text) || parseResearchCommand(text) || isSupportRequest(text));
}

function requireModelReady(env: Env): void {
  const readiness = modelReadiness(env);
  if (!readiness.modelReady) throw new HttpError(503, readiness.readinessError ?? 'model_not_configured');
}

async function wake(env: Env, conversationId: string): Promise<void> {
  try { await env.JOBS.send({ kind: 'conversation', conversationId }); }
  catch { /* Accepted work remains in D1 for the scheduled recovery sweep. */ }
}

async function wakeOnboarding(env: Env): Promise<void> {
  if (!onboardingReadiness(env).configured) return;
  try { await env.JOBS.send({ kind: 'messages_onboarding' }); }
  catch { /* Public notices remain durable for scheduled recovery. */ }
}

export default {
  async fetch(request, env, ctx) {
    let response: Response;
    try { response = await stagingAccessResponse(request, env) ?? await route(request, env, ctx); }
    catch (error) {
      if (error instanceof z.ZodError) response = Response.json({ error: 'invalid_request' }, { status: 400 });
      else if (error instanceof Error && 'status' in error && 'code' in error) {
        response = Response.json({ error: String(error.code) }, { status: Number(error.status) });
      } else {
        // Never log raw events, tokens, user text, or exception contents.
        console.error(JSON.stringify({ code: 'internal_error', name: error instanceof Error ? error.name : 'unknown' }));
        response = Response.json({ error: 'internal_error' }, { status: 500 });
      }
    }
    const headers = new Headers(response.headers);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('x-frame-options', 'DENY');
    headers.set('cache-control', 'no-store');
    if (env.STAGING_ACCESS_ENABLED !== undefined && env.STAGING_ACCESS_ENABLED !== 'false'
        && !headers.get('vary')?.split(',').some((value) => ['authorization', '*'].includes(value.trim().toLowerCase()))) {
      headers.append('vary', 'Authorization');
    }
    headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch, env) {
    // Only opaque work references enter the queue. D1 is authoritative.
    for (const message of batch.messages) {
      try {
        await assertOperational(env);
        if (message.body?.kind === 'messages_onboarding') {
          if (Object.keys(message.body).length !== 1) { message.ack(); continue; }
          await processOnboarding(env); message.ack(); continue;
        }
        if (env.JOBS_DLQ_NAME && batch.queue === env.JOBS_DLQ_NAME) {
          await journalDeadLetter(env, message.body, message.id); message.ack(); continue;
        }
        if (message.body?.kind !== 'conversation' || typeof message.body.conversationId !== 'string') { message.ack(); continue; }
        await processConversation(env, message.body.conversationId);
        message.ack();
      } catch { message.retry({ delaySeconds: 5 }); }
    }
  },
  async scheduled(_controller, env) {
    await recoverPrivacyOperations(env);
    if ((await maintenanceState(env)).locked) return;
    await recoverPending(env); await recoverDeadLetters(env); await runRetention(env);
    await processOnboarding(env);
  },
} satisfies ExportedHandler<Env, QueueJob>;
