import { assertOperational } from './runtime-operations';
import { assertRuntimeProviders, publicOrigin } from '../../../packages/contracts/src/runtime-policy';
import type { Env } from '../../../packages/contracts/src/index';
import { GOOGLE_CALENDAR_SCOPE, GoogleOAuthClient } from '../../../packages/calendar-google/src/index';
import { decryptText, encryptText, randomToken, sha256 } from '../../../packages/security/src/index';
import { PipelineError } from './store';
import { contextRevocationStatements } from './context-revocation';

const notRestoring = "NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')";
const redirectUri = (env: Env): string => `${publicOrigin(env)}/api/calendar/google/callback`;
const COOKIE = 'plause_google_oauth';
const FLOW_MS = 10 * 60_000;
const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export interface GoogleOAuthRuntimeOptions { fetchImpl?: typeof fetch }
interface ConnectionRow {
  revision: number; connected: number; status: 'disconnected' | 'pending' | 'connected' | 'reauthorization_required';
  scope: string | null; access_token_ciphertext: string | null; refresh_token_ciphertext: string | null;
  expires_at: number | null; refresh_claim_token: string | null; refresh_started_at: number | null;
  revocation_claim_token: string | null; revocation_started_at: number | null;
}
interface PendingRow { user_id: string; session_hash: string; browser_hash: string; verifier_ciphertext: string | null; revision: number }

function fail(code: string, status = 409): PipelineError { return new PipelineError('Google calendar authorization is unavailable or changed. Reconnect explicitly if needed.', status, code); }
function client(env: Env, options: GoogleOAuthRuntimeOptions = {}): GoogleOAuthClient {
  try { assertRuntimeProviders(env); } catch { throw fail('google_calendar_disabled', 503); }
  if (env.LIVE_GOOGLE_CALENDAR_ENABLED !== 'true') throw fail('google_calendar_disabled', 503);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || env.GOOGLE_REDIRECT_URI !== redirectUri(env)) throw fail('google_calendar_not_configured', 503);
  try { return new GoogleOAuthClient({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: redirectUri(env), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }); }
  catch { throw fail('google_calendar_config_invalid', 503); }
}

function cookieValue(request: Request, name: string): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{32,200}$/.test(values[0]!) ? values[0]! : null;
}

export async function sessionCredentialHash(request: Request): Promise<string | null> {
  const token = cookieValue(request, 'plause_session');
  return token ? sha256(token) : null;
}

export function googleOAuthCookie(request: Request, token: string, clear = false): string {
  if (!clear && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('google_browser_binding_invalid', 400);
  return `${COOKIE}=${clear ? '' : token}; Path=/api/calendar/google/callback; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : FLOW_MS / 1000}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

function requireBrowserOrigin(env: Env, request: Request): void {
  if (new URL(request.url).origin !== new URL(redirectUri(env)).origin) throw fail('google_local_origin_required', 400);
}

async function userRevision(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT google_calendar_revision FROM users WHERE id=? AND status='active'")
    .bind(userId).first<{ google_calendar_revision: number }>();
  if (!row) throw fail('account_unavailable', 403);
  return row.google_calendar_revision;
}

function revokeCachedGrantStatements(env: Env, userId: string, gate: string, gateValues: (string | number)[], now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare(`UPDATE google_calendar_requests SET result_ciphertext=NULL,query_digest='',
      state=CASE WHEN state='completed' THEN 'purged' ELSE state END,error_code='google_connection_revoked',updated_at=? WHERE user_id=? AND ${gate}`)
      .bind(now, userId, ...gateValues),
    env.DB.prepare(`UPDATE google_calendar_approvals SET arguments_ciphertext=NULL,arguments_digest='',
      state=CASE WHEN state='pending' THEN 'revoked' WHEN state='executing' THEN 'unknown' ELSE state END,
      error_code='google_connection_revoked',updated_at=? WHERE user_id=? AND ${gate}`).bind(now, userId, ...gateValues),
  ];
}

/** No network, token decryption, implicit refresh, or consent restoration on status reads. */
export async function getGoogleConnection(env: Env, userId: string) {
  const revision = await userRevision(env, userId);
  let configured = true;
  try { client(env); } catch { configured = false; }
  const row = await env.DB.prepare('SELECT * FROM google_calendar_connections WHERE user_id=? AND revision=?')
    .bind(userId, revision).first<ConnectionRow>();
  const pending = row?.status === 'pending' ? await env.DB.prepare(`SELECT 1 FROM google_oauth_pending p JOIN sessions s ON s.token_hash=p.session_hash
    WHERE p.user_id=? AND p.revision=? AND p.consumed_by IS NULL AND p.expires_at>${dbNow} AND s.expires_at>${dbNow}`).bind(userId, revision).first() : null;
  const staleRefresh = !!row?.refresh_claim_token && row.refresh_started_at !== null && row.refresh_started_at + 15_000 <= Date.now();
  const revocationPending = !!row?.revocation_claim_token;
  const connected = configured && !staleRefresh && row?.connected === 1 && row.status === 'connected' && row.scope === GOOGLE_CALENDAR_SCOPE
    && !!row.access_token_ciphertext && !!row.refresh_token_ciphertext;
  const status = !configured ? 'disabled' as const : connected ? 'connected' as const : pending ? 'pending' as const
    : row?.status === 'reauthorization_required' || staleRefresh || revocationPending ? 'reauthorization_required' as const : 'disconnected' as const;
  if (await userRevision(env, userId) !== revision) throw fail('google_connection_changed');
  return { provider: 'google' as const, configured, connected, revision, status, revocationPending,
    scope: connected ? GOOGLE_CALENDAR_SCOPE : null, expiresAt: connected ? row!.expires_at : null };
}

/** Explicit same-origin start, bound to the authenticated account's original session. */
export async function beginGoogleOAuth(env: Env, request: Request, userId: string, options: GoogleOAuthRuntimeOptions = {}) {
  await assertOperational(env);
  const provider = client(env, options);
  requireBrowserOrigin(env, request);
  if (request.method !== 'POST' || request.headers.get('origin') !== new URL(redirectUri(env)).origin) throw fail('same_origin_required', 403);
  const sessionHash = await sessionCredentialHash(request);
  if (!sessionHash || !await env.DB.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>${dbNow} AND u.status='active'`).bind(sessionHash, userId).first()) throw fail('reauthentication_required', 401);
  const revision = await userRevision(env, userId);
  if (await env.DB.prepare('SELECT 1 FROM google_calendar_connections WHERE user_id=? AND revocation_claim_token IS NOT NULL')
    .bind(userId).first()) throw fail('google_revocation_unresolved');
  if (await env.DB.prepare('SELECT 1 FROM google_calendar_connections WHERE user_id=? AND revision=? AND connected=1')
    .bind(userId, revision).first()) throw fail('google_already_connected');
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...challengeBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const stateHash = await sha256(state);
  const browserHash = await sha256(browser);
  const ciphertext = await encryptText(verifier, env.CONTENT_ENCRYPTION_KEY);
  const now = Date.now();
  const expiresAt = now + FLOW_MS;
  const own = `EXISTS (SELECT 1 FROM google_oauth_pending WHERE state_hash=? AND user_id=? AND revision=?)`;
  const ownValues = [stateHash, userId, revision + 1];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO google_oauth_pending(state_hash,user_id,session_hash,browser_hash,verifier_ciphertext,revision,expires_at,created_at)
      SELECT ?,u.id,?,?,?,?,?,? FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.status='active'
      AND u.google_calendar_revision=? AND s.token_hash=? AND s.expires_at>${dbNow} AND ${notRestoring}
      AND NOT EXISTS (SELECT 1 FROM google_calendar_connections WHERE user_id=u.id AND (connected=1 OR revocation_claim_token IS NOT NULL))`)
      .bind(stateHash, sessionHash, browserHash, ciphertext, revision + 1, expiresAt, now, userId, revision, sessionHash),
    env.DB.prepare(`UPDATE users SET google_calendar_revision=google_calendar_revision+1 WHERE id=? AND google_calendar_revision=? AND ${own}`)
      .bind(userId, revision, ...ownValues),
    env.DB.prepare(`INSERT INTO google_calendar_connections(user_id,revision,connected,status,created_at,updated_at)
      SELECT id,google_calendar_revision,0,'pending',?,? FROM users WHERE id=? AND google_calendar_revision=? AND ${own}
      ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,connected=0,status='pending',scope=NULL,
      access_token_ciphertext=NULL,refresh_token_ciphertext=NULL,expires_at=NULL,refresh_claim_token=NULL,refresh_started_at=NULL,
      revocation_claim_token=NULL,revocation_started_at=NULL,mutation_token=NULL,last_error=NULL,updated_at=excluded.updated_at`)
      .bind(now, now, userId, revision + 1, ...ownValues),
    ...revokeCachedGrantStatements(env, userId, own, ownValues, now),
    env.DB.prepare(`DELETE FROM google_oauth_pending WHERE user_id=? AND state_hash!=? AND ${own}`).bind(userId, stateHash, ...ownValues),
  ]);
  if (!await env.DB.prepare(`SELECT 1 FROM google_oauth_pending p JOIN users u ON u.id=p.user_id
    WHERE p.state_hash=? AND p.revision=u.google_calendar_revision AND u.status='active'`).bind(stateHash).first()) throw fail('google_connection_changed');
  return { authorizationUrl: provider.authorizationUrl({ state, codeChallenge: challenge }), setCookie: googleOAuthCookie(request, browser), expiresAt };
}

function singleParameter(url: URL, name: string, maximum: number): string | null {
  const values = url.searchParams.getAll(name);
  if (!values.length) return null;
  if (values.length !== 1 || !values[0] || values[0].length > maximum || /\s|[\x00-\x1f\x7f]/.test(values[0])) throw fail('google_callback_invalid', 400);
  return values[0];
}

async function revokeQuietly(provider: GoogleOAuthClient, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try { await provider.revokeToken(token); return true; } catch { return false; }
}

/** A Lax proof cookie handles the cross-origin return; the original Strict session is checked in D1. */
export async function completeGoogleOAuth(env: Env, request: Request, options: GoogleOAuthRuntimeOptions = {}) {
  await assertOperational(env);
  const provider = client(env, options);
  requireBrowserOrigin(env, request);
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== new URL(redirectUri(env)).pathname) throw fail('google_callback_invalid', 400);
  const state = singleParameter(url, 'state', 200);
  const code = singleParameter(url, 'code', 4096);
  const denied = singleParameter(url, 'error', 200);
  const browser = cookieValue(request, COOKIE);
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser || (!!code === !!denied)) throw fail('google_callback_invalid', 400);
  const stateHash = await sha256(state);
  const browserHash = await sha256(browser);
  const row = await env.DB.prepare(`SELECT p.* FROM google_oauth_pending p JOIN users u ON u.id=p.user_id
    JOIN sessions s ON s.token_hash=p.session_hash AND s.user_id=p.user_id
    JOIN google_calendar_connections g ON g.user_id=p.user_id AND g.revision=p.revision
    WHERE p.state_hash=? AND p.browser_hash=? AND p.consumed_by IS NULL AND p.expires_at>${dbNow}
    AND s.expires_at>${dbNow} AND u.status='active' AND u.google_calendar_revision=p.revision AND g.connected=0 AND ${notRestoring}`)
    .bind(stateHash, browserHash).first<PendingRow>();
  if (!row?.verifier_ciphertext) throw fail('google_callback_proof_invalid', 401);
  const operation = randomToken();
  const claimed = await env.DB.prepare(`UPDATE google_oauth_pending SET consumed_by=?,consumed_at=${dbNow},verifier_ciphertext=NULL
    WHERE state_hash=? AND browser_hash=? AND consumed_by IS NULL AND expires_at>${dbNow}
    AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id JOIN google_calendar_connections g ON g.user_id=u.id
      WHERE s.token_hash=google_oauth_pending.session_hash AND s.user_id=google_oauth_pending.user_id AND s.expires_at>${dbNow}
      AND u.status='active' AND u.google_calendar_revision=google_oauth_pending.revision AND g.revision=u.google_calendar_revision AND g.connected=0 AND ${notRestoring})`)
    .bind(operation, stateHash, browserHash).run();
  if (claimed.meta.changes !== 1) throw fail('google_callback_proof_invalid', 401);
  try {
    if (denied) throw fail('google_authorization_denied', 400);
    let verifier: string;
    try { verifier = await decryptText(row.verifier_ciphertext, env.CONTENT_ENCRYPTION_KEY); }
    catch { throw fail('google_callback_proof_invalid', 401); }
    // Crypto yields: recheck revocation and the original session immediately
    // before the one token exchange, rather than relying on the earlier claim.
    if (!await env.DB.prepare(`SELECT 1 FROM google_oauth_pending p JOIN sessions s ON s.token_hash=p.session_hash AND s.user_id=p.user_id
      JOIN users u ON u.id=p.user_id JOIN google_calendar_connections g ON g.user_id=u.id
      WHERE p.state_hash=? AND p.consumed_by=? AND s.expires_at>${dbNow} AND u.status='active'
      AND p.revision=u.google_calendar_revision AND g.revision=p.revision AND g.connected=0 AND ${notRestoring}`)
      .bind(stateHash, operation).first()) throw fail('google_connection_changed');
    let tokens;
    try { tokens = await provider.exchangeAuthorizationCode(code!, verifier, request.signal); }
    catch { throw fail('google_oauth_exchange_failed', 502); }
    if (!tokens.refreshToken) throw fail('google_offline_consent_required');
    const access = await encryptText(tokens.accessToken, env.CONTENT_ENCRYPTION_KEY);
    const refresh = await encryptText(tokens.refreshToken, env.CONTENT_ENCRYPTION_KEY);
    const stored = await env.DB.prepare(`UPDATE google_calendar_connections SET connected=1,status='connected',scope=?,access_token_ciphertext=?,
      refresh_token_ciphertext=?,expires_at=?,refresh_claim_token=NULL,refresh_started_at=NULL,last_error=NULL,updated_at=?
      WHERE user_id=? AND revision=? AND connected=0 AND ${notRestoring} AND EXISTS
      (SELECT 1 FROM google_oauth_pending p JOIN sessions s ON s.token_hash=p.session_hash AND s.user_id=p.user_id JOIN users u ON u.id=p.user_id
        WHERE p.state_hash=? AND p.consumed_by=? AND p.user_id=google_calendar_connections.user_id AND s.expires_at>${dbNow}
        AND u.status='active' AND u.google_calendar_revision=google_calendar_connections.revision)`)
      .bind(GOOGLE_CALENDAR_SCOPE, access, refresh, Date.now() + tokens.expiresIn * 1000, Date.now(), row.user_id, row.revision, stateHash, operation).run();
    if (stored.meta.changes !== 1) throw fail('google_connection_changed');
    return { userId: row.user_id, connected: true as const, revision: row.revision, setCookie: googleOAuthCookie(request, '', true) };
  } finally {
    await env.DB.prepare('DELETE FROM google_oauth_pending WHERE state_hash=? AND consumed_by=?').bind(stateHash, operation).run();
  }
}

async function activeGrant(env: Env, userId: string, expectedRevision: number): Promise<ConnectionRow> {
  const row = await env.DB.prepare(`SELECT g.* FROM google_calendar_connections g JOIN users u ON u.id=g.user_id
    WHERE g.user_id=? AND g.revision=? AND u.google_calendar_revision=g.revision AND g.connected=1 AND g.status='connected'
    AND g.scope=? AND u.status='active' AND ${notRestoring}`).bind(userId, expectedRevision, GOOGLE_CALENDAR_SCOPE).first<ConnectionRow>();
  if (!row || !row.access_token_ciphertext || !row.refresh_token_ciphertext) throw fail('google_connection_changed');
  return row;
}

async function invalidateRefresh(env: Env, userId: string, revision: number, claim: string): Promise<void> {
  const gate = 'EXISTS (SELECT 1 FROM google_calendar_connections WHERE user_id=? AND revision=? AND mutation_token=?)';
  const gateValues = [userId, revision + 1, claim];
  await env.DB.batch([
    env.DB.prepare(`UPDATE google_calendar_connections SET revision=revision+1,connected=0,status='reauthorization_required',scope=NULL,
      access_token_ciphertext=NULL,refresh_token_ciphertext=NULL,expires_at=NULL,refresh_claim_token=NULL,refresh_started_at=NULL,
      mutation_token=?,last_error='google_reauthorization_required',updated_at=? WHERE user_id=? AND revision=? AND refresh_claim_token=?
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND google_calendar_revision=?)`)
      .bind(claim, Date.now(), userId, revision, claim, userId, revision),
    env.DB.prepare(`UPDATE users SET google_calendar_revision=google_calendar_revision+1 WHERE id=? AND google_calendar_revision=?
      AND EXISTS (SELECT 1 FROM google_calendar_connections WHERE user_id=users.id AND revision=? AND mutation_token=?)`)
      .bind(userId, revision, revision + 1, claim),
    ...revokeCachedGrantStatements(env, userId, gate, gateValues, Date.now()),
    ...contextRevocationStatements(env, userId, gate, gateValues, Date.now(), 'google_reauthorization_required'),
  ]);
}

/** Only an explicit calendar operation may request a token/refresh. Unknown refreshes require new consent. */
export async function getGoogleAccessToken(env: Env, userId: string, expectedRevision: number, signal?: AbortSignal, options: GoogleOAuthRuntimeOptions = {}): Promise<string> {
  await assertOperational(env);
  const provider = client(env, options);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('google_connection_changed');
  if (signal?.aborted) throw fail('google_operation_cancelled');
  const row = await activeGrant(env, userId, expectedRevision);
  if (row.refresh_claim_token && row.refresh_started_at !== null && row.refresh_started_at + 15_000 <= Date.now()) {
    await invalidateRefresh(env, userId, expectedRevision, row.refresh_claim_token);
    throw fail('google_reauthorization_required');
  }
  if (row.expires_at !== null && row.expires_at > Date.now() + 60_000) {
    let token: string;
    try { token = await decryptText(row.access_token_ciphertext!, env.CONTENT_ENCRYPTION_KEY); }
    catch { throw fail('google_token_unavailable'); }
    await activeGrant(env, userId, expectedRevision);
    if (signal?.aborted) throw fail('google_operation_cancelled');
    return token;
  }
  const claim = randomToken();
  const claimed = await env.DB.prepare(`UPDATE google_calendar_connections SET refresh_claim_token=?,refresh_started_at=?,updated_at=?
    WHERE user_id=? AND revision=? AND connected=1 AND status='connected' AND refresh_claim_token IS NULL
    AND ${notRestoring} AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active' AND google_calendar_revision=?)`)
    .bind(claim, Date.now(), Date.now(), userId, expectedRevision, userId, expectedRevision).run();
  if (claimed.meta.changes !== 1) throw fail('google_refresh_in_progress');
  try {
    const refresh = await decryptText(row.refresh_token_ciphertext!, env.CONTENT_ENCRYPTION_KEY);
    await activeGrant(env, userId, expectedRevision);
    if (signal?.aborted) throw fail('google_operation_cancelled');
    const tokens = await provider.refreshAccessToken(refresh, signal);
    const access = await encryptText(tokens.accessToken, env.CONTENT_ENCRYPTION_KEY);
    const replacementRefresh = tokens.refreshToken ? await encryptText(tokens.refreshToken, env.CONTENT_ENCRYPTION_KEY) : row.refresh_token_ciphertext!;
    const stored = await env.DB.prepare(`UPDATE google_calendar_connections SET access_token_ciphertext=?,refresh_token_ciphertext=?,expires_at=?,
      refresh_claim_token=NULL,refresh_started_at=NULL,last_error=NULL,updated_at=? WHERE user_id=? AND revision=? AND connected=1
      AND refresh_claim_token=? AND ${notRestoring} AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active' AND google_calendar_revision=?)`)
      .bind(access, replacementRefresh, Date.now() + tokens.expiresIn * 1000, Date.now(), userId, expectedRevision, claim, userId, expectedRevision).run();
    if (stored.meta.changes !== 1) throw fail('google_connection_changed');
    await activeGrant(env, userId, expectedRevision);
    if (signal?.aborted) throw fail('google_operation_cancelled');
    return tokens.accessToken;
  } catch {
    await invalidateRefresh(env, userId, expectedRevision, claim);
    throw fail('google_reauthorization_required');
  }
}

/** Explicit disconnect: revoke local eligibility first, then attempt provider revocation without restoring state. */
export async function disconnectGoogleCalendar(env: Env, userId: string, options: GoogleOAuthRuntimeOptions = {}) {
  for (let retry = 0; retry < 4; retry++) {
    const revision = await userRevision(env, userId);
    const previous = await env.DB.prepare('SELECT * FROM google_calendar_connections WHERE user_id=? AND revision=?')
      .bind(userId, revision).first<ConnectionRow>();
    const pendingExchange = await env.DB.prepare('SELECT 1 FROM google_oauth_pending WHERE user_id=? AND consumed_by IS NOT NULL')
      .bind(userId).first();
    const operation = randomToken();
    const now = Date.now();
    const encrypted = previous?.refresh_token_ciphertext ?? previous?.access_token_ciphertext;
    let provider: GoogleOAuthClient | null = null;
    try { provider = client(env, options); } catch { /* Local disconnection does not depend on provider configuration. */ }
    const willRevoke = !!encrypted && !!provider && !previous?.revocation_claim_token;
    const revocationClaim = previous?.revocation_claim_token ?? (willRevoke ? operation : null);
    const revocationStarted = previous?.revocation_started_at ?? (willRevoke ? now : null);
    const gate = 'EXISTS (SELECT 1 FROM google_calendar_connections WHERE user_id=? AND revision=? AND mutation_token=?)';
    const gateValues = [userId, revision + 1, operation];
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO google_calendar_connections(user_id,revision,connected,status,mutation_token,revocation_claim_token,revocation_started_at,created_at,updated_at)
        SELECT id,google_calendar_revision+1,0,'disconnected',?,?,?,?,? FROM users WHERE id=? AND status='active' AND google_calendar_revision=?
        ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,connected=0,status='disconnected',scope=NULL,
        access_token_ciphertext=NULL,refresh_token_ciphertext=NULL,expires_at=NULL,refresh_claim_token=NULL,refresh_started_at=NULL,
        mutation_token=excluded.mutation_token,revocation_claim_token=excluded.revocation_claim_token,
        revocation_started_at=excluded.revocation_started_at,last_error=NULL,updated_at=excluded.updated_at WHERE google_calendar_connections.revision=?`)
        .bind(operation, revocationClaim, revocationStarted, now, now, userId, revision, revision),
      env.DB.prepare(`UPDATE users SET google_calendar_revision=google_calendar_revision+1 WHERE id=? AND google_calendar_revision=?
        AND EXISTS (SELECT 1 FROM google_calendar_connections WHERE user_id=users.id AND revision=? AND mutation_token=?)`)
        .bind(userId, revision, revision + 1, operation),
      ...revokeCachedGrantStatements(env, userId, gate, gateValues, now),
      ...contextRevocationStatements(env, userId, gate, gateValues, now, 'google_disconnected'),
      env.DB.prepare(`DELETE FROM google_oauth_pending WHERE user_id=? AND EXISTS
        (SELECT 1 FROM google_calendar_connections WHERE user_id=? AND revision=? AND mutation_token=?)`).bind(userId, userId, revision + 1, operation),
    ]);
    if ((result[0]?.meta.changes ?? 0) !== 1) continue;
    let providerRevocation: 'not_needed' | 'confirmed' | 'unknown' = encrypted || revocationClaim || pendingExchange ? 'unknown' : 'not_needed';
    if (willRevoke) {
      let token: string;
      try {
        token = await decryptText(encrypted!, env.CONTENT_ENCRYPTION_KEY);
      } catch {
        // No HTTP request began; this claim cannot affect a later connection.
        await env.DB.prepare('UPDATE google_calendar_connections SET revocation_claim_token=NULL,revocation_started_at=NULL WHERE user_id=? AND revocation_claim_token=?')
          .bind(userId, revocationClaim).run();
        return { disconnected: true as const, revision: revision + 1, providerRevocation };
      }
      if (await revokeQuietly(provider!, token)) {
        providerRevocation = 'confirmed';
        await env.DB.prepare('UPDATE google_calendar_connections SET revocation_claim_token=NULL,revocation_started_at=NULL WHERE user_id=? AND revocation_claim_token=?')
          .bind(userId, revocationClaim).run();
      }
    }
    return { disconnected: true as const, revision: revision + 1, providerRevocation };
  }
  throw fail('google_connection_changed');
}

// Primary contracts reviewed 2026-10-30:
// https://developers.google.com/identity/protocols/oauth2/web-server
// https://developers.google.com/identity/protocols/oauth2/resources/best-practices
// https://developers.google.com/workspace/calendar/api/auth
