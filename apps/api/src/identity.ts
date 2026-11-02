import { createRemoteJWKSet, customFetch, jwtVerify, type RemoteJWKSet } from 'jose';
import type { Env } from '../../../packages/contracts/src/index';
import { decryptText, encryptText, randomToken, sha256, stableIdentityKeyMaterial } from '../../../packages/security/src/index';
import { getSessionProof, sessionCookie, type User } from './auth';
import { PipelineError } from './store';
import { assertOperational } from './runtime-operations';

const ISSUER = 'https://accounts.google.com';
const AUTHORIZE = `${ISSUER}/o/oauth2/v2/auth`;
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const COOKIE = 'plause_identity_flow';
const FLOW_MS = 5 * 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const operational = "NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')";
const resolvers = new WeakMap<typeof fetch, RemoteJWKSet>();
export interface IdentityOptions { fetchImpl?: typeof fetch }
interface LoginState {
  nonce_hash: string; verifier_ciphertext: string | null; intent: 'signin' | 'reauth'; user_id: string | null;
  original_session_hash: string | null; expected_identity_id: string | null; created_at: number;
}
const error = (code: string, status = 401) => new PipelineError('Account sign-in could not be completed. Start a new sign-in.', status, code);

export function identityPublicOrigin(env: Env): string {
  try {
    const url = new URL(env.PUBLIC_ORIGIN ?? '');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== env.PUBLIC_ORIGIN || url.username || url.password || (url.protocol !== 'https:'
      && !(env.APP_ENV === 'local' && loopback && url.protocol === 'http:')) || (env.APP_ENV !== 'local' && loopback)) throw new Error();
    return url.origin;
  } catch { throw error('identity_origin_invalid', 503); }
}

export function requireIdentityOrigin(env: Env, request: Request, write = true): void {
  const origin = identityPublicOrigin(env);
  if (new URL(request.url).origin !== origin || (write && request.headers.get('origin') !== origin)) throw error('origin_rejected', 403);
}

function config(env: Env) {
  const origin = identityPublicOrigin(env);
  if (env.AUTH_GOOGLE_ENABLED !== 'true') throw error('identity_disabled', 503);
  if (!env.AUTH_GOOGLE_CLIENT_ID || !/^[A-Za-z0-9._-]{1,256}$/.test(env.AUTH_GOOGLE_CLIENT_ID)
    || !env.AUTH_GOOGLE_CLIENT_SECRET || env.AUTH_GOOGLE_CLIENT_SECRET.length > 1024 || /\s|[\x00-\x1f\x7f]/.test(env.AUTH_GOOGLE_CLIENT_SECRET)) {
    throw error('identity_not_configured', 503);
  }
  const signupEnabled = env.AUTH_SIGNUP_ENABLED === 'true';
  let signupSubjects: string[] | null = null;
  if (signupEnabled && ['staging', 'production'].includes(env.APP_ENV)) {
    // Admission and operator privileges are separate. Only verified Google sub
    // claims are compared; neither email nor caller-provided identity is used.
    try {
      if (!env.AUTH_SIGNUP_SUBJECTS || env.AUTH_SIGNUP_SUBJECTS.length > 4096) throw new Error();
      const value: unknown = JSON.parse(env.AUTH_SIGNUP_SUBJECTS);
      if (!Array.isArray(value) || value.length < 1 || value.length > 5
        || value.some((subject) => typeof subject !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(subject))
        || new Set(value).size !== value.length) throw new Error();
      signupSubjects = value;
    } catch { throw error('identity_signup_configuration_invalid', 503); }
  }
  return { clientId: env.AUTH_GOOGLE_CLIENT_ID, clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET,
    redirectUri: `${origin}/api/auth/google/callback`, signupEnabled, signupSubjects };
}

export function identityReadiness(env: Env) {
  try { const value = config(env); return { provider: 'google' as const, enabled: true, configured: true, signupEnabled: value.signupEnabled }; }
  catch { return { provider: 'google' as const, enabled: env.AUTH_GOOGLE_ENABLED === 'true', configured: false, signupEnabled: false }; }
}

export function identityFlowCookie(request: Request, token: string, clear = false): string {
  if (!clear && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw error('identity_browser_proof_invalid');
  return `${COOKIE}=${clear ? '' : token}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : FLOW_MS / 1000}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

function browserToken(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';').map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${COOKIE}=`)).map((entry) => entry.slice(COOKIE.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!) ? values[0]! : null;
}

function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(error('identity_request_cancelled'));
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    value.then((result) => { cleanup(); resolve(result); }, () => { cleanup(); reject(error('identity_provider_unavailable', 502)); });
    if (signal.aborted) { cleanup(); abort(); }
  });
}

async function providerJson(fetchImpl: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  // Workers supports manual redirects; reject non-200 responses below rather
  // than following a Location with the authorization code or client secret.
  const response = await abortable(fetchImpl(url, { ...init, redirect: 'manual', signal }), signal);
  if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); throw error('identity_provider_unavailable', 502); }
  if (Number(response.headers.get('content-length')) > 65_536) { void response.body.cancel().catch(() => {}); throw error('identity_response_invalid'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0; let finished = false;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) { finished = true; break; }
      size += part.value.byteLength;
      if (size > 65_536) throw error('identity_response_invalid');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown; }
    catch { throw error('identity_response_invalid'); }
  } finally { if (!finished) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function keys(fetchImpl: typeof fetch): RemoteJWKSet {
  let resolver = resolvers.get(fetchImpl);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(JWKS), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
      [customFetch]: async (url, init) => {
        if (url !== JWKS) throw error('identity_keys_invalid');
        const value = await providerJson(fetchImpl, JWKS, { method: 'GET', headers: init.headers }, init.signal);
        return Response.json(value);
      } });
    resolvers.set(fetchImpl, resolver);
  }
  return resolver;
}

async function subjectDigest(env: Env, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(stableIdentityKeyMaterial(env.CONTENT_ENCRYPTION_KEY)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ISSUER}\u0000${subject}`)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** A new code flow confirms account possession; it does not claim a password/MFA challenge occurred. */
export async function beginIdentityLogin(env: Env, request: Request, intent: 'signin' | 'reauth' = 'signin', _options: IdentityOptions = {}) {
  const settings = config(env); requireIdentityOrigin(env, request);
  await assertOperational(env);
  if (request.method !== 'POST' || !['signin', 'reauth'].includes(intent)) throw error('identity_request_invalid', 400);
  const current = await getSessionProof(env, request);
  if (intent === 'reauth' && (!current || current.authMethod !== 'google' || !current.identityId)) throw error('identity_reauthentication_required');
  const state = randomToken(); const nonce = randomToken(); const verifier = randomToken();
  const browser = browserToken(request) ?? randomToken();
  const stateHash = await sha256(state); const nonceHash = await sha256(nonce); const browserHash = await sha256(browser);
  const ciphertext = await encryptText(verifier, env.CONTENT_ENCRYPTION_KEY);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Date.now(); const expiresAt = now + FLOW_MS;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM identity_login_states WHERE expires_at<=? OR browser_hash=?').bind(now, browserHash),
    env.DB.prepare(`INSERT INTO identity_login_states(state_hash,browser_hash,nonce_hash,verifier_ciphertext,intent,user_id,original_session_hash,expected_identity_id,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>${dbNow} AND u.status='active')) AND ${operational}`)
      .bind(stateHash, browserHash, nonceHash, ciphertext, intent, intent === 'reauth' ? current!.user.id : null,
        current?.tokenHash ?? null, intent === 'reauth' ? current!.identityId : null, expiresAt, now, current?.tokenHash ?? null, current?.tokenHash ?? null),
  ]);
  if (!await env.DB.prepare('SELECT 1 FROM identity_login_states WHERE state_hash=?').bind(stateHash).first()) throw error('identity_session_changed');
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code',
    scope: 'openid profile', access_type: 'online', include_granted_scopes: 'false', prompt: 'select_account',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return { authorizationUrl: url.href, setCookie: identityFlowCookie(request, browser), expiresAt };
}

function parameter(url: URL, name: string, maximum: number): string | null {
  const values = url.searchParams.getAll(name);
  if (!values.length) return null;
  if (values.length !== 1 || !values[0] || values[0].length > maximum || /\s|[\x00-\x1f\x7f]/.test(values[0])) throw error('identity_callback_invalid', 400);
  return values[0];
}

export async function completeIdentityLogin(env: Env, request: Request, options: IdentityOptions = {}) {
  const settings = config(env); requireIdentityOrigin(env, request, false);
  await assertOperational(env);
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/auth/google/callback') throw error('identity_callback_invalid', 400);
  const state = parameter(url, 'state', 200); const code = parameter(url, 'code', 4096); const denied = parameter(url, 'error', 200);
  const browser = browserToken(request);
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser || (!!code === !!denied)) throw error('identity_callback_invalid', 400);
  const stateHash = await sha256(state); const browserHash = await sha256(browser);
  const row = await env.DB.prepare(`SELECT * FROM identity_login_states WHERE state_hash=? AND browser_hash=? AND consumed_by IS NULL AND expires_at>${dbNow}`)
    .bind(stateHash, browserHash).first<LoginState>();
  if (!row?.verifier_ciphertext) throw error('identity_callback_proof_invalid');
  const operation = randomToken();
  const sessionValid = `(original_session_hash IS NULL OR EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=identity_login_states.original_session_hash AND s.expires_at>${dbNow} AND u.status='active'
      AND (identity_login_states.intent='signin' OR (s.user_id=identity_login_states.user_id AND s.identity_id=identity_login_states.expected_identity_id))))`;
  const consumed = await env.DB.prepare(`UPDATE identity_login_states SET consumed_by=?,verifier_ciphertext=NULL
    WHERE state_hash=? AND browser_hash=? AND consumed_by IS NULL AND expires_at>${dbNow} AND ${sessionValid} AND ${operational}`)
    .bind(operation, stateHash, browserHash).run();
  if (consumed.meta.changes !== 1) throw error('identity_callback_proof_invalid');
  const controller = new AbortController(); const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) controller.abort();
  const timer = setTimeout(abort, 10_000);
  try {
    if (denied) throw error('identity_authorization_denied');
    const verifier = await decryptText(row.verifier_ciphertext, env.CONTENT_ENCRYPTION_KEY);
    const proof = await env.DB.prepare(`SELECT 1 FROM identity_login_states WHERE state_hash=? AND consumed_by=? AND ${sessionValid} AND ${operational}`)
      .bind(stateHash, operation).first();
    if (!proof || controller.signal.aborted) throw error('identity_session_changed');
    const fetchImpl = options.fetchImpl ?? fetch;
    const value = await providerJson(fetchImpl, TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, redirect_uri: settings.redirectUri,
        code: code!, code_verifier: verifier, grant_type: 'authorization_code' }).toString() }, controller.signal);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('id_token' in value)
      || typeof value.id_token !== 'string' || value.id_token.length > 16_384) throw error('identity_token_invalid');
    let claims;
    try {
      claims = await abortable(jwtVerify(value.id_token, keys(fetchImpl), { algorithms: ['RS256'], issuer: [ISSUER, 'accounts.google.com'], audience: settings.clientId,
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'nonce'], maxTokenAge: '10m', clockTolerance: 0 }), controller.signal);
    } catch { throw error('identity_token_invalid'); }
    const { payload, protectedHeader } = claims;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (protectedHeader.jku !== undefined || protectedHeader.x5u !== undefined || typeof protectedHeader.kid !== 'string' || protectedHeader.kid.length > 200
      || typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)
      || typeof payload.nonce !== 'string' || await sha256(payload.nonce) !== row.nonce_hash
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > nowSeconds + 30
      || payload.exp! <= nowSeconds || payload.exp! > payload.iat! + 7200
      || (payload.azp !== undefined && payload.azp !== settings.clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== settings.clientId)) throw error('identity_token_invalid');
    const digest = await subjectDigest(env, payload.sub);
    const now = Date.now(); const token = randomToken(); const tokenHash = await sha256(token);
    const userId = `usr_${crypto.randomUUID()}`; const identityId = `identity_${crypto.randomUUID()}`;
    const displayName = typeof payload.name === 'string' ? payload.name.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) || 'Plause member' : 'Plause member';
    const gate = `EXISTS (SELECT 1 FROM identity_login_states WHERE state_hash=? AND consumed_by=? AND expires_at>${dbNow} AND ${sessionValid})
      AND NOT EXISTS (SELECT 1 FROM identity_erasures WHERE subject_digest=? AND erased_at>=?) AND ${operational}`;
    const gateValues = [stateHash, operation, digest, row.created_at];
    const enrollmentAllowed = settings.signupEnabled && (settings.signupSubjects === null || settings.signupSubjects.includes(payload.sub));
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users(id,display_name,created_at) SELECT ?,?,? WHERE ?=1 AND ?='signin' AND ${gate}
        AND NOT EXISTS (SELECT 1 FROM external_identities WHERE issuer=? AND subject=?)`)
        .bind(userId, displayName, now, enrollmentAllowed ? 1 : 0, row.intent, ...gateValues, ISSUER, payload.sub),
      env.DB.prepare(`INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at)
        SELECT ?,id,?,?,?,? FROM users WHERE id=? AND status='active' AND ${gate}`)
        .bind(identityId, ISSUER, payload.sub, digest, now, userId, ...gateValues),
      env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,authenticated_at,identity_id)
        SELECT ?,e.user_id,?,'google',?,e.id FROM external_identities e JOIN users u ON u.id=e.user_id
        WHERE e.issuer=? AND e.subject=? AND u.status='active' AND ${gate}
        AND (?='signin' OR (e.id=? AND e.user_id=?))`)
        .bind(tokenHash, now + SESSION_MS, now, ISSUER, payload.sub, ...gateValues, row.intent, row.expected_identity_id, row.user_id),
      env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,action,outcome,created_at)
        SELECT ?,user_id,'identity.google_signin','authenticated',? FROM sessions WHERE token_hash=?`).bind(crypto.randomUUID(), now, tokenHash),
      env.DB.prepare('DELETE FROM sessions WHERE token_hash=? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash=?)')
        .bind(row.original_session_hash, tokenHash),
    ]);
    const signedIn = await env.DB.prepare(`SELECT u.id,u.display_name,s.identity_id FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND u.status='active' AND ${operational}`).bind(tokenHash).first<{ id: string; display_name: string; identity_id: string }>();
    if (!signedIn || controller.signal.aborted) throw error('identity_session_changed');
    return { user: { id: signedIn.id, displayName: signedIn.display_name } satisfies User, token, identityId: signedIn.identity_id,
      setCookie: sessionCookie(request, token), flowCookie: identityFlowCookie(request, '', true) };
  } catch (cause) {
    if (cause instanceof PipelineError) throw cause;
    throw error('identity_signin_failed');
  } finally {
    clearTimeout(timer); request.signal.removeEventListener('abort', abort);
    await env.DB.prepare('DELETE FROM identity_login_states WHERE state_hash=? AND consumed_by=?').bind(stateHash, operation).run();
  }
}

// Primary contracts reviewed 2026-10-31:
// https://developers.google.com/identity/openid-connect/openid-connect
// https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md
// https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md
