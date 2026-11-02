import { z } from 'zod';
import { parseExplicitCalendarTime } from '../../agent-core/src/action-commands';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const MAX_BYTES = 128 * 1024;
const MAX_TIMEOUT = 10_000;

/** Content-free errors. Unknown writes must be reconciled, never blindly retried. */
export class GoogleCalendarError extends Error {
  readonly retryable = false;
  constructor(public readonly code: string, public readonly outcomeUnknown = false, public readonly status: number | undefined = undefined) {
    super(code); this.name = 'GoogleCalendarError';
  }
}

interface HttpOptions { fetchImpl?: typeof fetch; timeoutMs?: number }
interface HttpRequest { url: string; init: RequestInit; deadline: number; signal?: AbortSignal | undefined;
  write?: boolean; allowMissing?: boolean; empty?: boolean; maximumBytes?: number }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function secret(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value); }
function eventId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{5,1024}$/.test(value); }
function etag(value: unknown): value is string { return typeof value === 'string' && /^"[^"\x00-\x20\x7f]{1,196}"$/.test(value); }
function active(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted) throw new GoogleCalendarError('google_cancelled');
  if (Date.now() >= deadline) throw new GoogleCalendarError('google_timeout');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('aborted'));
    const clear = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { clear(); resolve(value); }, (error: unknown) => { clear(); reject(error); });
    if (signal.aborted) { clear(); abort(); }
  });
}
async function boundedJson(response: Response, signal: AbortSignal, maximum: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > maximum) {
    void response.body?.cancel().catch(() => {}); throw new GoogleCalendarError('google_response_too_large');
  }
  if (!response.body) throw new GoogleCalendarError('google_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0; let finished = false;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('aborted');
      const item = await abortable(reader.read(), signal);
      if (signal.aborted) throw new Error('aborted');
      if (item.done) { finished = true; break; }
      size += item.value.byteLength;
      if (size > maximum) throw new GoogleCalendarError('google_response_too_large');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new GoogleCalendarError('google_response_invalid'); }
  } finally { signal.removeEventListener('abort', cancel); if (!finished) cancel(); reader.releaseLock(); }
}

class BoundedGoogleHttp {
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  constructor(options: HttpOptions) {
    this.timeoutMs = options.timeoutMs ?? MAX_TIMEOUT;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > MAX_TIMEOUT) throw new GoogleCalendarError('google_config_invalid');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }
  async request(request: HttpRequest): Promise<unknown> {
    active(request.signal, request.deadline);
    const controller = new AbortController(); let timedOut = false; let started = false;
    const abort = (): void => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, request.deadline - Date.now()));
    try {
      if (request.signal?.aborted) controller.abort();
      if (controller.signal.aborted) throw new Error('aborted');
      started = true;
      const response = await abortable(this.fetchImpl(request.url, { ...request.init, redirect: 'manual', signal: controller.signal }), controller.signal);
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('aborted'); }
      if (request.allowMissing && (response.status === 404 || response.status === 410)) { void response.body?.cancel().catch(() => {}); return null; }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // Refuse redirects while retaining uncertainty for a mutation that may already have been accepted.
        const unknown = !!request.write && ((response.status >= 300 && response.status < 400)
          || response.status >= 500 || response.status === 408 || response.status === 429);
        throw new GoogleCalendarError(response.status === 401 || response.status === 403 ? 'google_authorization_failed'
          : response.status === 409 ? 'google_conflict' : response.status === 412 ? 'google_version_conflict'
          : response.status === 429 ? 'google_rate_limited' : 'google_request_rejected', unknown, response.status);
      }
      if (request.empty) { void response.body?.cancel().catch(() => {}); return null; }
      const result = await boundedJson(response, controller.signal, request.maximumBytes ?? MAX_BYTES);
      active(controller.signal, request.deadline);
      return result;
    } catch (cause) {
      const unknown = !!request.write && started;
      if (controller.signal.aborted || Date.now() >= request.deadline) throw new GoogleCalendarError(timedOut || Date.now() >= request.deadline ? 'google_timeout' : 'google_cancelled', unknown);
      if (cause instanceof GoogleCalendarError) throw new GoogleCalendarError(cause.code, cause.outcomeUnknown || (unknown && cause.status === undefined), cause.status);
      throw new GoogleCalendarError('google_network_error', unknown);
    } finally { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
  }
}

const plain = z.string().min(1).max(200).refine((value) => value === value.trim()
  && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value));
const explicitTime = z.string().min(17).max(35).refine((value) => !/-00:00$/i.test(value) && parseExplicitCalendarTime(value) !== null);
export const googleEventDraftSchema = z.object({ title: plain, startsAt: explicitTime, durationMinutes: z.number().int().min(1).max(480) }).strict();
export type GoogleEventDraft = z.infer<typeof googleEventDraftSchema>;
export type GoogleEventTime = { dateTime: string } | { date: string };
export interface GoogleCalendarEvent {
  id: string; title: string; start: GoogleEventTime; end: GoogleEventTime; etag: string;
  status: 'confirmed' | 'tentative'; managed: boolean;
}
export interface GoogleCalendarPage { events: GoogleCalendarEvent[]; nextPageToken: string | null }
export interface GoogleCalendarOptions extends HttpOptions {
  accessToken: string;
  /** Caller supplies the durable approval, tenant, connection and ownership fence. */
  beforeWrite?: () => Promise<void>;
  beforeRead?: () => Promise<void>;
}

function draft(value: GoogleEventDraft): GoogleEventDraft {
  const parsed = googleEventDraftSchema.safeParse(value);
  if (!parsed.success) throw new GoogleCalendarError('google_draft_invalid');
  const at = parseExplicitCalendarTime(parsed.data.startsAt)!;
  if (new Date(at + parsed.data.durationMinutes * 60_000).getUTCFullYear() > 9999) throw new GoogleCalendarError('google_draft_invalid');
  return { ...parsed.data, startsAt: new Date(at).toISOString() };
}
function parseTime(value: unknown): GoogleEventTime {
  if (!object(value)) throw new GoogleCalendarError('google_event_invalid');
  if (typeof value.dateTime === 'string' && explicitTime.safeParse(value.dateTime).success) return { dateTime: new Date(parseExplicitCalendarTime(value.dateTime)!).toISOString() };
  if (typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && parseExplicitCalendarTime(`${value.date}T00:00:00Z`) !== null) return { date: value.date };
  throw new GoogleCalendarError('google_event_invalid');
}
function timestamp(time: GoogleEventTime): number { return Date.parse('dateTime' in time ? time.dateTime : `${time.date}T00:00:00Z`); }
function parseEvent(value: unknown): GoogleCalendarEvent | null {
  if (!object(value) || !eventId(value.id)) throw new GoogleCalendarError('google_event_invalid');
  if (value.status === 'cancelled') return null;
  if ((value.status !== 'confirmed' && value.status !== 'tentative') || !etag(value.etag)
    || (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > 1000))) throw new GoogleCalendarError('google_event_invalid');
  const start = parseTime(value.start); const end = parseTime(value.end);
  if (('dateTime' in start) !== ('dateTime' in end) || timestamp(end) <= timestamp(start)) throw new GoogleCalendarError('google_event_invalid');
  const properties = object(value.extendedProperties) && object(value.extendedProperties.private) ? value.extendedProperties.private : {};
  const noGuests = value.attendees === undefined || Array.isArray(value.attendees) && value.attendees.length === 0;
  return { id: value.id, etag: value.etag, status: value.status, title: typeof value.summary === 'string'
    ? value.summary.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 200) : '(Untitled event)', start, end,
    managed: /^p[0-9a-f]{64}$/.test(value.id) && properties.plauseOperationId === value.id && object(value.organizer)
      && value.organizer.self === true && noGuests && value.recurrence === undefined && (value.eventType === undefined || value.eventType === 'default') };
}

/** SHA-256 hex is a subset of Google's lowercase base32hex event-ID alphabet. */
export async function googleEventId(idempotencyKey: string): Promise<string> {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(idempotencyKey)) throw new GoogleCalendarError('google_idempotency_key_invalid');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`plause:calendar:v1:${idempotencyKey}`));
  return 'p' + [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function eventBody(id: string, value: GoogleEventDraft) {
  return { id, summary: value.title, start: { dateTime: value.startsAt },
    end: { dateTime: new Date(Date.parse(value.startsAt) + value.durationMinutes * 60_000).toISOString() },
    attendees: [], guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: false,
    reminders: { useDefault: false }, visibility: 'private', transparency: 'opaque', eventType: 'default',
    extendedProperties: { private: { plauseOperationId: id } } };
}
function matches(event: GoogleCalendarEvent | null, id: string, value: GoogleEventDraft): event is GoogleCalendarEvent {
  return !!event && event.id === id && event.managed && event.status === 'confirmed' && event.title === value.title
    && 'dateTime' in event.start && event.start.dateTime === value.startsAt && 'dateTime' in event.end
    && Date.parse(event.end.dateTime) === Date.parse(value.startsAt) + value.durationMinutes * 60_000;
}

/** Fixed primary-calendar endpoints. Every mutation needs a durable caller approval journal. */
export class GoogleCalendarClient {
  private readonly http: BoundedGoogleHttp;
  private readonly headers: Record<string, string>;
  constructor(private readonly options: GoogleCalendarOptions) {
    if (!secret(options.accessToken)) throw new GoogleCalendarError('google_config_invalid');
    this.http = new BoundedGoogleHttp(options);
    this.headers = { authorization: `Bearer ${options.accessToken}`, accept: 'application/json' };
  }
  private async fence(signal: AbortSignal | undefined, deadline: number, kind: 'read' | 'write' = 'write'): Promise<void> {
    active(signal, deadline);
    const authorize = kind === 'read' ? this.options.beforeRead : this.options.beforeWrite;
    if (authorize) {
      const controller = new AbortController(); const abort = (): void => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
      try { await abortable(authorize(), controller.signal); }
      catch { throw new GoogleCalendarError(signal?.aborted ? 'google_cancelled' : Date.now() >= deadline ? 'google_timeout' : 'google_authorization_changed'); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    active(signal, deadline);
  }
  private async get(id: string, deadline: number, signal?: AbortSignal): Promise<{ event: GoogleCalendarEvent | null; raw: unknown }> {
    if (!eventId(id)) throw new GoogleCalendarError('google_event_id_invalid');
    await this.fence(signal, deadline, 'read');
    const raw = await this.http.request({ url: `${EVENTS}/${encodeURIComponent(id)}`, init: { method: 'GET', headers: this.headers },
      deadline, signal, allowMissing: true });
    const event = raw === null ? null : parseEvent(raw);
    if (event && event.id !== id) throw new GoogleCalendarError('google_event_invalid');
    return { event, raw };
  }
  async getEvent(id: string, signal?: AbortSignal): Promise<GoogleCalendarEvent | null> {
    return (await this.get(id, Date.now() + this.http.timeoutMs, signal)).event;
  }
  async listEvents(input: { timeMin: string; timeMax: string; maxResults?: number; pageToken?: string }, signal?: AbortSignal): Promise<GoogleCalendarPage> {
    const schema = z.object({ timeMin: explicitTime, timeMax: explicitTime, maxResults: z.number().int().min(1).max(20).optional(),
      pageToken: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_+\/=.-]+$/).optional() }).strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success || parseExplicitCalendarTime(input.timeMax)! <= parseExplicitCalendarTime(input.timeMin)!
      || parseExplicitCalendarTime(input.timeMax)! - parseExplicitCalendarTime(input.timeMin)! > 31 * 86_400_000) throw new GoogleCalendarError('google_list_invalid');
    const url = new URL(EVENTS); const maximum = input.maxResults ?? 20;
    url.search = new URLSearchParams({ timeMin: new Date(parseExplicitCalendarTime(input.timeMin)!).toISOString(),
      timeMax: new Date(parseExplicitCalendarTime(input.timeMax)!).toISOString(), maxResults: String(maximum),
      singleEvents: 'true', showDeleted: 'false', orderBy: 'startTime', ...(input.pageToken ? { pageToken: input.pageToken } : {}) }).toString();
    const deadline = Date.now() + this.http.timeoutMs;
    await this.fence(signal, deadline, 'read');
    const result = await this.http.request({ url: url.href, init: { method: 'GET', headers: this.headers }, deadline, signal });
    if (!object(result) || !Array.isArray(result.items) || result.items.length > maximum
      || (result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || !/^[A-Za-z0-9_+\/=.-]{1,2048}$/.test(result.nextPageToken)))) {
      throw new GoogleCalendarError('google_list_invalid');
    }
    return { events: result.items.map(parseEvent).filter((item): item is GoogleCalendarEvent => item !== null), nextPageToken: result.nextPageToken as string | undefined ?? null };
  }
  async reconcileCreate(input: GoogleEventDraft, key: string, signal?: AbortSignal): Promise<GoogleCalendarEvent | null> {
    const value = draft(input); const id = await googleEventId(key);
    const { event } = await this.get(id, Date.now() + this.http.timeoutMs, signal);
    if (event && !matches(event, id, value)) throw new GoogleCalendarError('google_reconciliation_conflict', true);
    return event;
  }
  async createEvent(input: GoogleEventDraft, context: { idempotencyKey: string; signal?: AbortSignal }): Promise<{ event: GoogleCalendarEvent; reconciled: boolean }> {
    const deadline = Date.now() + this.http.timeoutMs;
    const value = draft(input); const id = await googleEventId(context.idempotencyKey);
    await this.fence(context.signal, deadline);
    try {
      // Reserve part of the same operation deadline for a single reconciliation GET.
      const writeDeadline = Math.min(deadline, Date.now() + Math.max(1, Math.floor((deadline - Date.now()) * 0.6)));
      const raw = await this.http.request({ url: `${EVENTS}?sendUpdates=none`, init: { method: 'POST', headers: { ...this.headers, 'content-type': 'application/json' },
        body: JSON.stringify(eventBody(id, value)) }, deadline: writeDeadline, signal: context.signal, write: true });
      const event = parseEvent(raw);
      if (!matches(event, id, value)) throw new GoogleCalendarError('google_write_response_invalid', true);
      return { event, reconciled: false };
    } catch (cause) {
      const error = cause instanceof GoogleCalendarError ? new GoogleCalendarError(cause.code,
        cause.outcomeUnknown || cause.status === undefined, cause.status) : new GoogleCalendarError('google_write_outcome_unknown', true);
      if (!error.outcomeUnknown && error.status !== 409) throw error;
      if (context.signal?.aborted || Date.now() >= deadline) throw new GoogleCalendarError('google_write_outcome_unknown', true);
      try {
        const { event } = await this.get(id, deadline, context.signal);
        if (matches(event, id, value)) return { event, reconciled: true };
      } catch { /* One failed read cannot prove whether the initial write happened. */ }
      throw new GoogleCalendarError('google_write_outcome_unknown', true);
    }
  }
  async updateEvent(id: string, input: GoogleEventDraft, context: { etag: string; signal?: AbortSignal }): Promise<GoogleCalendarEvent> {
    if (!/^p[0-9a-f]{64}$/.test(id) || !etag(context.etag)) throw new GoogleCalendarError('google_update_invalid');
    const value = draft(input); const deadline = Date.now() + this.http.timeoutMs;
    const current = await this.get(id, deadline, context.signal);
    if (!current.event?.managed || current.event.etag !== context.etag || !object(current.raw)) throw new GoogleCalendarError('google_update_requires_current_managed_event');
    const allowed = new Set(['kind', 'id', 'etag', 'status', 'htmlLink', 'created', 'updated', 'summary', 'creator', 'organizer', 'start', 'end',
      'endTimeUnspecified', 'iCalUID', 'sequence', 'attendees', 'guestsCanInviteOthers', 'guestsCanModify', 'guestsCanSeeOtherGuests',
      'reminders', 'visibility', 'transparency', 'eventType', 'extendedProperties']);
    const extensions = current.raw.extendedProperties;
    if (Object.keys(current.raw).some((key) => !allowed.has(key)) || !object(extensions) || Object.keys(extensions).some((key) => key !== 'private')
      || !object(extensions.private) || Object.keys(extensions.private).some((key) => key !== 'plauseOperationId')) {
      throw new GoogleCalendarError('google_update_would_overwrite_other_fields');
    }
    await this.fence(context.signal, deadline);
    const raw = await this.http.request({ url: `${EVENTS}/${id}?sendUpdates=none`, init: { method: 'PUT', headers: { ...this.headers,
      'content-type': 'application/json', 'if-match': context.etag }, body: JSON.stringify(eventBody(id, value)) }, deadline, signal: context.signal, write: true });
    try {
      const event = parseEvent(raw);
      if (!matches(event, id, value)) throw new Error('invalid');
      return event;
    } catch { throw new GoogleCalendarError('google_write_response_invalid', true); }
  }
}

export interface GoogleOAuthOptions extends HttpOptions { clientId: string; clientSecret: string; redirectUri: string }
export interface GoogleOAuthTokens { accessToken: string; expiresIn: number; scope: typeof GOOGLE_CALENDAR_SCOPE; refreshToken?: string }

function oauthTokens(value: unknown): GoogleOAuthTokens {
  if (!object(value) || !secret(value.access_token) || value.token_type !== 'Bearer' || value.scope !== GOOGLE_CALENDAR_SCOPE
    || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86_400
    || (value.refresh_token !== undefined && !secret(value.refresh_token))) throw new GoogleCalendarError('google_token_response_invalid');
  return { accessToken: value.access_token, expiresIn: value.expires_in, scope: GOOGLE_CALENDAR_SCOPE,
    ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}) };
}

/** Transport seam only. The application must bind state+PKCE to a user/session and encrypt tokens. */
export class GoogleOAuthClient {
  private readonly http: BoundedGoogleHttp;
  constructor(private readonly options: GoogleOAuthOptions) {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(options.clientId) || !secret(options.clientSecret)) throw new GoogleCalendarError('google_oauth_config_invalid');
    try {
      const uri = new URL(options.redirectUri);
      if (uri.username || uri.password || uri.search || uri.hash || (uri.protocol !== 'https:'
        && !(uri.protocol === 'http:' && (uri.hostname === 'localhost' || uri.hostname === '127.0.0.1')))) throw new Error('invalid');
    } catch { throw new GoogleCalendarError('google_redirect_invalid'); }
    this.http = new BoundedGoogleHttp(options);
  }
  authorizationUrl(input: { state: string; codeChallenge: string }): string {
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(input.state) || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) throw new GoogleCalendarError('google_authorization_request_invalid');
    const url = new URL(AUTH);
    url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri, response_type: 'code',
      scope: GOOGLE_CALENDAR_SCOPE, state: input.state, code_challenge: input.codeChallenge, code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' }).toString();
    return url.href;
  }
  async exchangeAuthorizationCode(code: string, codeVerifier: string, signal?: AbortSignal): Promise<GoogleOAuthTokens> {
    if (!secret(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new GoogleCalendarError('google_authorization_code_invalid');
    return this.tokens({ code, code_verifier: codeVerifier, redirect_uri: this.options.redirectUri, grant_type: 'authorization_code' }, signal);
  }
  async refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<GoogleOAuthTokens> {
    if (!secret(refreshToken)) throw new GoogleCalendarError('google_refresh_token_invalid');
    return this.tokens({ refresh_token: refreshToken, grant_type: 'refresh_token' }, signal);
  }
  private async tokens(fields: Record<string, string>, signal?: AbortSignal): Promise<GoogleOAuthTokens> {
    const value = await this.http.request({ url: TOKEN, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, ...fields }).toString() },
      deadline: Date.now() + this.http.timeoutMs, signal, write: true, maximumBytes: 16 * 1024 });
    return oauthTokens(value);
  }
  async revokeToken(token: string, signal?: AbortSignal): Promise<void> {
    if (!secret(token)) throw new GoogleCalendarError('google_token_invalid');
    await this.http.request({ url: REVOKE, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString() }, deadline: Date.now() + this.http.timeoutMs, signal, write: true, empty: true });
  }
}

// Primary contracts reviewed 2026-10-30:
// https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
// https://developers.google.com/workspace/calendar/api/v3/reference/events/list
// https://developers.google.com/workspace/calendar/api/v3/reference/events/get
// https://developers.google.com/workspace/calendar/api/v3/reference/events/update
// https://developers.google.com/workspace/calendar/api/guides/version-resources
// https://developers.google.com/identity/protocols/oauth2/web-server
// https://developers.google.com/identity/protocols/oauth2/native-app (PKCE)
