import { z } from 'zod';
import type { ChannelSubject, MessageContent, SendOutcome } from '../../contracts/src/index';
import { equalSecret, sha256 } from '../../security/src/index';

/** Sunshine Conversations v2, not Zendesk Support's separate webhook protocol. */
export interface SunshineEnvironment {
  SUNSHINE_SUBDOMAIN?: string;
  SUNSHINE_APP_ID?: string;
  SUNSHINE_APPLE_INTEGRATION_ID?: string;
  SUNSHINE_WEBHOOK_ID?: string;
  SUNSHINE_WEBHOOK_SECRET?: string;
  SUNSHINE_KEY_ID?: string;
  SUNSHINE_KEY_SECRET?: string;
  SUNSHINE_BOT_SWITCHBOARD_ID?: string;
  SUNSHINE_AGENT_SWITCHBOARD_ID?: string;
}

export class SunshineError extends Error {
  readonly retryable = false;
  constructor(public readonly code: string, public readonly outcomeUnknown = false) {
    super(code); this.name = 'SunshineError';
  }
}

type Control = 'bot' | 'human' | 'unknown';
interface EventBase { eventId: string; occurredAt: string; businessId: string; channel: 'apple_business' }
type Subject = ChannelSubject & { provider: 'sunshine' };
export type SunshineEvent =
  | (EventBase & { type: 'message.received'; subject: Subject; providerConversationId: string; messageId: string;
      text: string; control: Control; selectionId?: string })
  | (EventBase & { type: 'delivery.updated'; subject: Subject; providerConversationId: string; messageId: string;
      state: 'sent' | 'delivered' | 'failed' })
  | (EventBase & { type: 'conversation.closed' | 'subject.revoked' | 'client.active'; subject: Subject;
      providerConversationId?: string })
  | (EventBase & { type: 'handoff.changed'; providerConversationId: string; control: Control });

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const secret = z.string().min(16).max(1000).regex(/^[\x21-\x7e]+$/);
const payloadId = z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/).refine((value) => value.trim().length > 0);
const integration = z.object({ id: id.optional(), integrationId: id.optional(), integrationType: z.string().max(100).optional() });
const conversation = z.object({ id, type: z.literal('personal'), activeSwitchboardIntegration: integration.nullish() });
const user = z.object({ id });
const client = z.object({ id: id.optional(), type: z.string().max(100), integrationId: id,
  status: z.enum(['active', 'pending', 'blocked', 'inactive']).optional() });
const envelope = z.object({ app: z.object({ id }), webhook: z.object({ id, version: z.literal('v2') }),
  events: z.array(z.object({ id, type: z.string().min(1).max(100), createdAt: z.string().datetime(),
    payload: z.unknown() })).max(100) });
const messagePayload = z.object({ conversation, message: z.object({ id, author: z.object({
  type: z.enum(['user', 'business']), userId: id.optional(), user: user.optional() }),
  source: z.object({ type: z.string().max(100), integrationId: id.optional(), client: client.optional() }),
  content: z.object({ type: z.string().max(100), text: z.string().max(4000).optional(),
    payload: z.string().max(1000).optional() }) }) });
const deliveryPayload = z.object({ conversation, user, destination: z.object({ type: z.string().max(100), integrationId: id }),
  message: z.object({ id }), isFinalEvent: z.boolean() });
const clientPayload = z.object({ conversation: conversation.nullish(), user, client });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SunshineError('sunshine_payload_invalid');
  return result.data;
}

function webhookConfiguration(env: SunshineEnvironment) {
  return parse(z.object({ appId: id, integrationId: id, webhookId: id, webhookSecret: secret,
    botSwitchboardId: id }), { appId: env.SUNSHINE_APP_ID, integrationId: env.SUNSHINE_APPLE_INTEGRATION_ID,
    webhookId: env.SUNSHINE_WEBHOOK_ID, webhookSecret: env.SUNSHINE_WEBHOOK_SECRET,
    botSwitchboardId: env.SUNSHINE_BOT_SWITCHBOARD_ID });
}

function transportConfiguration(env: SunshineEnvironment) {
  return parse(z.object({ subdomain: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    appId: id, integrationId: id, keyId: id, keySecret: secret, agentSwitchboardId: id.optional() }), {
    subdomain: env.SUNSHINE_SUBDOMAIN, appId: env.SUNSHINE_APP_ID,
    integrationId: env.SUNSHINE_APPLE_INTEGRATION_ID, keyId: env.SUNSHINE_KEY_ID,
    keySecret: env.SUNSHINE_KEY_SECRET,
    ...(env.SUNSHINE_AGENT_SWITCHBOARD_ID ? { agentSwitchboardId: env.SUNSHINE_AGENT_SWITCHBOARD_ID } : {}),
  });
}

/** Reports configuration only; it does not establish Apple approval or provider health. */
export function sunshineReadiness(env: SunshineEnvironment): { webhookConfigured: boolean; transportConfigured: boolean } {
  let webhookConfigured = false; let transportConfigured = false;
  try { webhookConfiguration(env); webhookConfigured = true; } catch { /* no secrets in diagnostics */ }
  try { transportConfiguration(env); transportConfigured = true; } catch { /* no secrets in diagnostics */ }
  return { webhookConfigured, transportConfigured };
}

function controlOf(value: z.infer<typeof conversation>, botId: string): Control {
  const active = value.activeSwitchboardIntegration;
  if (!active?.id) return 'unknown';
  return active.id === botId ? 'bot' : 'human';
}

/**
 * Authenticate before JSON parsing. Sunshine documents a shared X-API-Key, not a
 * signed body/timestamp. The caller must durably deduplicate event IDs and reject
 * conflicting replays before acknowledging the entire batch.
 */
export async function normalizeAuthenticatedWebhook(env: SunshineEnvironment, raw: string, headers: Headers): Promise<SunshineEvent[]> {
  let config: ReturnType<typeof webhookConfiguration>;
  try { config = webhookConfiguration(env); } catch { throw new SunshineError('sunshine_webhook_not_configured'); }
  const supplied = headers.get('x-api-key');
  if (!supplied || supplied.length > 1000 || !(await equalSecret(supplied, config.webhookSecret))) {
    throw new SunshineError('sunshine_webhook_unauthorized');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) throw new SunshineError('sunshine_content_type_invalid');
  if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) throw new SunshineError('sunshine_payload_too_large');
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new SunshineError('sunshine_payload_invalid'); }
  const body = parse(envelope, json);
  if (body.app.id !== config.appId || body.webhook.id !== config.webhookId) throw new SunshineError('sunshine_webhook_scope_invalid');
  const seen = new Map<string, string>();
  const results: SunshineEvent[] = [];
  const subject = (userId: string): Subject => ({ provider: 'sunshine', businessId: config.appId, subjectId: userId });
  for (const event of body.events) {
    const fingerprint = JSON.stringify(event);
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== fingerprint) throw new SunshineError('sunshine_event_conflict');
      continue;
    }
    seen.set(event.id, fingerprint);
    const base: EventBase = { eventId: event.id, occurredAt: event.createdAt, businessId: config.appId, channel: 'apple_business' };
    if (event.type === 'conversation:message') {
      const payload = parse(messagePayload, event.payload);
      const { message, conversation: thread } = payload;
      const control = controlOf(thread, config.botSwitchboardId);
      if (message.author.type === 'business') {
        // Agent Workspace/API replies have their own source, not source:apple.
        // An explicit different responder must still fence the existing Apple
        // conversation. Absence of responder data on our own API echo is not a
        // switchboard transition and cannot identify a different channel/user.
        if (control === 'human') results.push({ ...base, type: 'handoff.changed', providerConversationId: thread.id, control });
        continue;
      }
      if (message.source.type !== 'apple' || message.source.integrationId !== config.integrationId) continue;
      const userId = message.author.userId;
      if (!userId || (message.author.user && message.author.user.id !== userId)) throw new SunshineError('sunshine_author_invalid');
      if (message.source.client && (message.source.client.type !== 'apple' || message.source.client.integrationId !== config.integrationId)) {
        throw new SunshineError('sunshine_source_invalid');
      }
      if (message.source.client?.status === 'blocked') {
        results.push({ ...base, type: 'conversation.closed', subject: subject(userId), providerConversationId: thread.id });
        continue;
      }
      // Attachments, Apple passthroughs and postbacks are data, never text commands.
      if (message.content.type !== 'text' || !message.content.text?.trim()) {
        if (control !== 'bot') results.push({ ...base, type: 'handoff.changed', providerConversationId: thread.id, control });
        continue;
      }
      results.push({ ...base, type: 'message.received', subject: subject(userId), providerConversationId: thread.id,
        messageId: message.id, text: message.content.text, control,
        ...(message.content.payload ? { selectionId: message.content.payload } : {}) });
    } else if (/^conversation:message:delivery:(channel|user|failure)$/.test(event.type)) {
      const payload = parse(deliveryPayload, event.payload);
      if (payload.destination.type !== 'apple' || payload.destination.integrationId !== config.integrationId) continue;
      // Apple supports channel acceptance, not end-user/device confirmation.
      // Do not invent a delivered state from an unsupported user receipt.
      if (event.type.endsWith(':user')) continue;
      // Intermediate delivery failures are not an authoritative terminal failure.
      if (event.type.endsWith(':failure') && !payload.isFinalEvent) continue;
      results.push({ ...base, type: 'delivery.updated', subject: subject(payload.user.id),
        providerConversationId: payload.conversation.id, messageId: payload.message.id,
        state: event.type.endsWith(':failure') ? 'failed' : 'sent' });
    } else if (event.type === 'client:update' || event.type === 'client:remove') {
      const payload = parse(clientPayload, event.payload);
      if (payload.client.type !== 'apple' || payload.client.integrationId !== config.integrationId) continue;
      const type = event.type === 'client:remove' ? 'subject.revoked'
        : payload.client.status === 'blocked' ? 'conversation.closed' : payload.client.status === 'active' ? 'client.active' : null;
      if (type) results.push({ ...base, type, subject: subject(payload.user.id),
        ...(payload.conversation ? { providerConversationId: payload.conversation.id } : {}) });
    } else if (['switchboard:passControl', 'switchboard:acceptControl', 'switchboard:releaseControl'].includes(event.type)) {
      const payload = parse(z.object({ conversation }), event.payload);
      // No channel/user is supplied by these events. Resolve ONLY an existing,
      // same-app Apple conversation mapping; never create or relink an account.
      results.push({ ...base, type: 'handoff.changed', providerConversationId: payload.conversation.id,
        control: controlOf(payload.conversation, config.botSwitchboardId) });
    } else if (event.type === 'user:remove') {
      const payload = parse(z.object({ user }), event.payload);
      results.push({ ...base, type: 'subject.revoked', subject: subject(payload.user.id) });
    } else if (event.type === 'user:merge') {
      const payload = parse(z.object({ mergedUsers: z.object({ surviving: user, discarded: user }) }), event.payload);
      // Provider merges do not prove consent to merge Plause accounts. Revoke
      // both old bindings; linking must be explicitly proved again.
      for (const [side, mergedUser] of Object.entries(payload.mergedUsers)) {
        results.push({ ...base, eventId: await sha256(`${config.appId}:${event.id}:${side}`),
          type: 'subject.revoked', subject: subject(mergedUser.id) });
      }
    }
  }
  return results;
}

const plainText = z.string().min(1).max(4000).refine((value) => value.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const contentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: plainText }).strict(),
  z.object({ type: z.literal('rich_link'), title: z.string().min(1).max(200).refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value)), url: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal('quick_replies'), text: plainText,
    options: z.array(z.object({ id: payloadId, label: z.string().min(1).max(40).refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value)) }).strict()).min(2).max(5)
      .refine((options) => new Set(options.map((option) => option.id)).size === options.length) }).strict(),
]);

function publicHttps(value: string): string {
  if (/[\s\x00-\x1f\x7f]/.test(value)) throw new SunshineError('sunshine_content_invalid');
  try {
    const url = new URL(value); const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !host.includes('.')
      || /[:\[\]]/.test(host) || /^[0-9.]+$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan|corp)$/.test(host)
      || /(?:^|\.)(?:localtest\.me|lvh\.me)$/.test(host)) throw new Error('url');
    if (url.href.length > 500) throw new Error('url');
    return url.href;
  } catch { throw new SunshineError('sunshine_content_invalid'); }
}

export function serializeSunshineContent(content: MessageContent): Record<string, unknown> {
  let valid: z.infer<typeof contentSchema>;
  try { valid = parse(contentSchema, content); } catch { throw new SunshineError('sunshine_content_invalid'); }
  if (valid.type === 'text') return { type: 'text', text: valid.text };
  if (valid.type === 'rich_link') {
    // Apple creates its native URL preview for a text message containing a single
    // URL. No arbitrary overrides, embedded images, or result URL fetches.
    return { type: 'text', text: `${valid.title}\n${publicHttps(valid.url)}` };
  }
  return { type: 'text', text: valid.text,
    actions: valid.options.map((option) => ({ type: 'reply', text: option.label, payload: option.id })) };
}

export interface SunshineSendRequest { conversationId: string; idempotencyKey: string; content: MessageContent; authorType?: 'ai' | 'human' }
export interface SunshineReconcileRequest extends SunshineSendRequest { providerMessageId?: string }
export interface SunshineClientOptions { fetchImpl?: typeof fetch; timeoutMs?: number; beforeSend?: () => Promise<void>; beforeRead?: () => Promise<void> }
export type SunshineOperationOutcome = { state: 'accepted' } | { state: 'failed' | 'unknown'; code: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new SunshineError('sunshine_aborted'));
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) { cleanup(); abort(); }
  });
}

async function limitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && /^[0-9]+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {}); throw new SunshineError('sunshine_response_too_large', true);
  }
  if (!response.body) throw new SunshineError('sunshine_response_invalid', true);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; let finished = false;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (signal.aborted) throw new SunshineError('sunshine_aborted', true);
      if (chunk.done) { finished = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SunshineError('sunshine_response_too_large', true);
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new SunshineError('sunshine_response_invalid', true); }
  } finally { signal.removeEventListener('abort', cancel); if (!finished) cancel(); reader.releaseLock(); }
}

/** Fixed endpoints and no retries. A durable caller journal is required. */
export class SunshineMessagingClient {
  readonly supportsIdempotentRetry = false;
  private readonly config: ReturnType<typeof transportConfiguration>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  constructor(env: SunshineEnvironment, private readonly options: SunshineClientOptions = {}) {
    try { this.config = transportConfiguration(env); } catch { throw new SunshineError('sunshine_transport_not_configured'); }
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10_000) throw new SunshineError('sunshine_config_invalid');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = `https://${this.config.subdomain}.zendesk.com/sc/v2/apps/${this.config.appId}`;
  }

  private async request(path: string, body: Record<string, unknown> | null, upstream?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(); const abort = (): void => controller.abort();
    upstream?.addEventListener('abort', abort, { once: true }); if (upstream?.aborted) controller.abort();
    const deadline = Date.now() + this.timeoutMs; let started = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const active = (): void => {
      if (Date.now() >= deadline) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) throw new SunshineError(timedOut ? 'sunshine_timeout' : 'sunshine_aborted', started);
    };
    try {
      active();
      if (body && this.options.beforeSend) {
        try { await abortable(this.options.beforeSend(), controller.signal); }
        catch { active(); throw new SunshineError('sunshine_dispatch_blocked'); }
      }
      if (!body && this.options.beforeRead) {
        try { await abortable(this.options.beforeRead(), controller.signal); }
        catch { active(); throw new SunshineError('sunshine_read_blocked'); }
      }
      active();
      started = true;
      const response = await abortable(this.fetchImpl(`${this.baseUrl}${path}`, { method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: { authorization: `Basic ${btoa(`${this.config.keyId}:${this.config.keySecret}`)}`,
          accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal }), controller.signal);
      active();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // Manual redirects prevent credential forwarding without treating a possibly accepted POST as failed.
        const unknown = (!!body && response.status >= 300 && response.status < 400)
          || response.status >= 500 || [408, 409, 429].includes(response.status);
        throw new SunshineError(response.status === 401 || response.status === 403 ? 'sunshine_auth_failed'
          : response.status === 429 ? 'sunshine_rate_limited' : response.status >= 500 ? 'sunshine_unavailable' : 'sunshine_request_rejected', unknown);
      }
      const result = response.status === 204 ? {} : await limitedJson(response, controller.signal);
      active(); return result;
    } catch (error) {
      if (controller.signal.aborted) throw new SunshineError(timedOut ? 'sunshine_timeout' : 'sunshine_aborted', started);
      if (error instanceof SunshineError) throw error;
      throw new SunshineError('sunshine_network_error', started);
    } finally { clearTimeout(timer); upstream?.removeEventListener('abort', abort); }
  }

  private async metadata(request: SunshineSendRequest, content: Record<string, unknown>): Promise<{ plauseDispatchId: string; plauseContentDigest: string }> {
    if (!id.safeParse(request.conversationId).success || !request.idempotencyKey || request.idempotencyKey.length > 500 || !['ai','human'].includes(request.authorType ?? 'ai')) {
      throw new SunshineError('sunshine_request_invalid');
    }
    return { plauseDispatchId: await sha256(`${this.config.appId}:${request.conversationId}:${request.idempotencyKey}:${request.authorType ?? 'ai'}`),
      plauseContentDigest: await sha256(stableJson(content)) };
  }

  async send(request: SunshineSendRequest, signal?: AbortSignal): Promise<SendOutcome> {
    try {
      const snapshot = { conversationId: request.conversationId, idempotencyKey: request.idempotencyKey, content: request.content, authorType: request.authorType ?? 'ai' as const };
      const content = serializeSunshineContent(snapshot.content); const metadata = await this.metadata(snapshot, content);
      const response = await this.request(`/conversations/${snapshot.conversationId}/messages`, {
        author: { type: 'business', ...(snapshot.authorType === 'human' ? {} : { subtypes: ['AI'] }) }, content, destination: { integrationId: this.config.integrationId }, metadata,
      }, signal);
      const result = z.object({ messages: z.array(z.object({ id, author: z.object({ type: z.literal('business') }) })).length(1) }).safeParse(response);
      if (!result.success) return { state: 'delivery_unknown', code: 'sunshine_response_invalid' };
      // This is API acceptance, not proof Apple or its user received the message.
      return { state: 'sent', providerMessageId: result.data.messages[0]!.id };
    } catch (error) {
      const safe = error instanceof SunshineError ? error : new SunshineError('sunshine_send_failed');
      return safe.outcomeUnknown ? { state: 'delivery_unknown', code: safe.code } : { state: 'failed', code: safe.code };
    }
  }

  async reconcile(request: SunshineReconcileRequest, signal?: AbortSignal): Promise<SendOutcome | null> {
    try {
      const snapshot = { conversationId: request.conversationId, idempotencyKey: request.idempotencyKey, content: request.content, authorType: request.authorType ?? 'ai' as const,
        providerMessageId: request.providerMessageId };
      const metadata = await this.metadata(snapshot, serializeSunshineContent(snapshot.content));
      if (snapshot.providerMessageId && !id.safeParse(snapshot.providerMessageId).success) return null;
      // One latest-page GET, never follow returned URLs/cursors or repeat POST.
      const response = await this.request(`/conversations/${snapshot.conversationId}/messages`, null, signal);
      const result = z.object({ messages: z.array(z.object({ id, author: z.object({ type: z.string() }),
        content: z.unknown(), metadata: z.object({ plauseDispatchId: z.string(), plauseContentDigest: z.string() }).optional() })).max(100) }).safeParse(response);
      if (!result.success) return null;
      const matches = result.data.messages.filter((message) => message.author.type === 'business'
        && message.metadata?.plauseDispatchId === metadata.plauseDispatchId
        && message.metadata.plauseContentDigest === metadata.plauseContentDigest
        && (!snapshot.providerMessageId || message.id === snapshot.providerMessageId));
      if (matches.length !== 1 || await sha256(stableJson(matches[0]!.content)) !== metadata.plauseContentDigest) return null;
      return { state: 'sent', providerMessageId: matches[0]!.id };
    } catch { return null; }
  }

  async typing(conversationId: string, state: 'start' | 'stop', signal?: AbortSignal): Promise<SunshineOperationOutcome> {
    if (!id.safeParse(conversationId).success || !['start', 'stop'].includes(state)) return { state: 'failed', code: 'sunshine_request_invalid' };
    return this.operation(`/conversations/${conversationId}/activity`, { author: { type: 'business' }, type: `typing:${state}` }, signal);
  }

  async handoff(conversationId: string, signal?: AbortSignal): Promise<SunshineOperationOutcome> {
    if (!id.safeParse(conversationId).success || !this.config.agentSwitchboardId) return { state: 'failed', code: 'sunshine_handoff_not_configured' };
    return this.operation(`/conversations/${conversationId}/passControl`, { switchboardIntegration: this.config.agentSwitchboardId }, signal);
  }

  private async operation(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<SunshineOperationOutcome> {
    try { await this.request(path, body, signal); return { state: 'accepted' }; }
    catch (error) { const safe = error instanceof SunshineError ? error : new SunshineError('sunshine_operation_failed');
      return { state: safe.outcomeUnknown ? 'unknown' : 'failed', code: safe.code }; }
  }
}
