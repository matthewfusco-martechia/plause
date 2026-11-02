import { describe, expect, it, vi } from 'vitest';
import { beginGoogleOAuth, completeGoogleOAuth, disconnectGoogleCalendar, getGoogleAccessToken, getGoogleConnection } from '../apps/api/src/google-oauth';
import { login } from '../apps/api/src/auth';
import { GOOGLE_CALENDAR_SCOPE } from '../packages/calendar-google/src/index';
import type { Env } from '../packages/contracts/src/index';
import { decryptText, encryptText, sha256 } from '../packages/security/src/index';
import { inviteAlex, inviteSam, testEnv } from './setup';

const origin = 'http://localhost:8787';
const callback = `${origin}/api/calendar/google/callback`;
const envFor = (overrides: Partial<Env> = {}): Env => ({ ...testEnv, LIVE_GOOGLE_CALENDAR_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
  GOOGLE_REDIRECT_URI: callback, ...overrides });
const tokenPayload = (overrides: Record<string, unknown> = {}) => ({ access_token: 'synthetic-access-token',
  refresh_token: 'synthetic-refresh-token', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPE, ...overrides });
const tokenFetch = () => vi.fn<typeof fetch>(async (url) => String(url).endsWith('/revoke')
  ? new Response(null, { status: 200 }) : Response.json(tokenPayload()));
async function flow(env = envFor(), userId = 'u_alex', options: { fetchImpl?: typeof fetch } = {}) {
  // Seed a session locally; production itself never accepts invitation login.
  const signedIn = await login({ ...env, APP_ENV: 'local' }, userId === 'u_alex' ? inviteAlex : inviteSam);
  expect(signedIn).not.toBeNull();
  const request = new Request(`${origin}/api/calendar/google/connect`, { method: 'POST',
    headers: { origin, cookie: `plause_session=${signedIn!.token}` } });
  const started = await beginGoogleOAuth(env, request, userId, options);
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  const browserCookie = started.setCookie.split(';')[0]!;
  const returned = (suffix = '') => new Request(`${callback}?state=${state}&code=synthetic-authorization-code${suffix}`, { headers: { cookie: browserCookie } });
  return { ...started, state, browserCookie, returned, sessionToken: signedIn!.token, request, env };
}
async function connect(env = envFor()) {
  const fetchImpl = tokenFetch();
  const started = await flow(env, 'u_alex', { fetchImpl });
  const result = await completeGoogleOAuth(env, started.returned(), { fetchImpl });
  return { ...started, fetchImpl, result };
}
async function stored(env: Env, userId = 'u_alex') {
  return env.DB.prepare('SELECT * FROM google_calendar_connections WHERE user_id=?').bind(userId)
    .first<{ connected: number; revision: number; status: string; access_token_ciphertext: string | null;
      refresh_token_ciphertext: string | null; expires_at: number | null; refresh_claim_token: string | null }>();
}

describe('Google authorization consent and browser/session proofs', () => {
  it.each([{ LIVE_GOOGLE_CALENDAR_ENABLED: 'false' }, { GOOGLE_CLIENT_ID: '' }, { GOOGLE_CLIENT_SECRET: '' },
    { GOOGLE_REDIRECT_URI: 'https://attacker.invalid/callback' }, { GOOGLE_REDIRECT_URI: 'http://127.0.0.1:8787/api/calendar/google/callback' },
    { APP_ENV: 'production' }, { MESSAGING_PROVIDER: 'apple_business' }])('fails closed for unconfigured local consent %j', async (overrides) => {
    const env = envFor(overrides);
    expect(await getGoogleConnection(env, 'u_alex')).toMatchObject({ configured: false, connected: false, status: 'disabled' });
    await expect(flow(env)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM google_oauth_pending').first()).toEqual({ n: 0 });
  });

  it('creates narrow offline consent with fresh state, S256 PKCE and a private Lax proof cookie', async () => {
    const started = await flow();
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.setCookie).toContain('HttpOnly; SameSite=Lax; Max-Age=600');
    expect(started.setCookie).toContain('Path=/api/calendar/google/callback');
    expect(started.authorizationUrl).not.toContain('u_alex');
    expect(started.authorizationUrl).not.toContain('synthetic-client-secret');
    const pending = await started.env.DB.prepare('SELECT * FROM google_oauth_pending').first<{
      state_hash: string; browser_hash: string; verifier_ciphertext: string; session_hash: string; expires_at: number; created_at: number;
    }>();
    const verifier = await decryptText(pending!.verifier_ciphertext, started.env.CONTENT_ENCRYPTION_KEY);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(pending!.state_hash).toBe(await sha256(started.state));
    expect(pending!.session_hash).toBe(await sha256(started.sessionToken));
    expect(pending!.expires_at - pending!.created_at).toBe(600_000);
    expect(JSON.stringify(pending)).not.toContain(started.state);
    expect(JSON.stringify(pending)).not.toContain(verifier);
    expect(await getGoogleConnection(started.env, 'u_alex')).toMatchObject({ connected: false, status: 'pending', revision: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exchanges once without relying on the absent Strict main cookie and stores only encrypted tokens', async () => {
    const connected = await connect();
    expect(connected.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = connected.fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const payload = new URLSearchParams(String(init!.body));
    expect(payload.get('grant_type')).toBe('authorization_code');
    expect(payload.get('code')).toBe('synthetic-authorization-code');
    expect(payload.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.get('redirect_uri')).toBe(callback);
    expect(connected.result).toMatchObject({ userId: 'u_alex', connected: true, revision: 1 });
    expect(connected.result.setCookie).toContain('Max-Age=0');
    const saved = await stored(connected.env);
    expect(saved).toMatchObject({ connected: 1, status: 'connected', revision: 1 });
    expect(saved!.access_token_ciphertext).toMatch(/^v1:/);
    expect(saved!.refresh_token_ciphertext).toMatch(/^v1:/);
    expect(JSON.stringify(saved)).not.toContain('synthetic-access-token');
    expect(JSON.stringify(saved)).not.toContain('synthetic-refresh-token');
    expect(await connected.env.DB.prepare('SELECT COUNT(*) AS n FROM google_oauth_pending').first()).toEqual({ n: 0 });
    const status = await getGoogleConnection(connected.env, 'u_alex');
    expect(status).toMatchObject({ connected: true, configured: true, revision: 1, scope: GOOGLE_CALENDAR_SCOPE, status: 'connected' });
    expect(JSON.stringify(status)).not.toContain('token');
    await expect(completeGoogleOAuth(connected.env, connected.returned(), { fetchImpl: connected.fetchImpl }))
      .rejects.toMatchObject({ code: 'google_callback_proof_invalid' });
    expect(connected.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['wrong_browser', 'missing_browser', 'expired_state', 'expired_session', 'logged_out', 'deleted_account', 'duplicate_state', 'wrong_origin'] as const)
    ('rejects %s before exchanging a code', async (condition) => {
      const started = await flow();
      const fetchImpl = tokenFetch();
      let request = started.returned();
      if (condition === 'wrong_browser') request = new Request(request, { headers: { cookie: `plause_google_oauth=${'x'.repeat(43)}` } });
      if (condition === 'missing_browser') request = new Request(request, { headers: {} });
      if (condition === 'expired_state') await started.env.DB.prepare('UPDATE google_oauth_pending SET expires_at=0').run();
      if (condition === 'expired_session') await started.env.DB.prepare('UPDATE sessions SET expires_at=0').run();
      if (condition === 'logged_out') await started.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(started.sessionToken)).run();
      if (condition === 'deleted_account') await started.env.DB.prepare("DELETE FROM users WHERE id='u_alex'").run();
      if (condition === 'duplicate_state') request = started.returned(`&state=${started.state}`);
      if (condition === 'wrong_origin') request = new Request(request.url.replace('localhost', '127.0.0.1'), { headers: { cookie: started.browserCookie } });
      await expect(completeGoogleOAuth(started.env, request, { fetchImpl })).rejects.toMatchObject({ code: expect.stringMatching(/^google_/) });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

  it('does not start another account’s flow or accept an untrusted origin/session', async () => {
    const started = await flow();
    await expect(beginGoogleOAuth(started.env, started.request, 'u_sam')).rejects.toMatchObject({ code: 'reauthentication_required' });
    await expect(beginGoogleOAuth(started.env, new Request(started.request, { headers: { origin: 'https://attacker.invalid', cookie: `plause_session=${started.sessionToken}` } }), 'u_alex'))
      .rejects.toMatchObject({ code: 'same_origin_required' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('consumes an explicit provider denial without exchange and clears its private pending state', async () => {
    const started = await flow();
    const fetchImpl = tokenFetch();
    await expect(completeGoogleOAuth(started.env, new Request(`${callback}?state=${started.state}&error=access_denied`, { headers: { cookie: started.browserCookie } }), { fetchImpl }))
      .rejects.toMatchObject({ code: 'google_authorization_denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await started.env.DB.prepare('SELECT COUNT(*) AS n FROM google_oauth_pending').first()).toEqual({ n: 0 });
  });

  it('rechecks the original session after asynchronous PKCE decryption and before any exchange', async () => {
    const started = await flow();
    const fetchImpl = tokenFetch();
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (algorithm, key, data) => {
      const cleartext = await original(algorithm, key, data);
      await started.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(started.sessionToken)).run();
      return cleartext;
    });
    try {
      await expect(completeGoogleOAuth(started.env, started.returned(), { fetchImpl })).rejects.toMatchObject({ code: 'google_connection_changed' });
    } finally { decrypt.mockRestore(); }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await stored(started.env))!.connected).toBe(0);
  });

  it('allows only one concurrent callback exchange and invalidates an older browser flow', async () => {
    const started = await flow();
    const replacement = await beginGoogleOAuth(started.env, started.request, 'u_alex');
    const fetchImpl = tokenFetch();
    await expect(completeGoogleOAuth(started.env, started.returned(), { fetchImpl })).rejects.toMatchObject({ code: 'google_callback_proof_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = new URL(replacement.authorizationUrl).searchParams.get('state')!;
    const returned = new Request(`${callback}?state=${state}&code=synthetic-code`, { headers: { cookie: replacement.setCookie.split(';')[0]! } });
    const settled = await Promise.allSettled([
      completeGoogleOAuth(started.env, returned, { fetchImpl }), completeGoogleOAuth(started.env, returned, { fetchImpl }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['disconnect', 'account', 'logout'] as const)('cannot restore a grant after %s while exchange is inflight', async (action) => {
    const started = await flow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
      await gate; return Response.json(tokenPayload());
    });
    const pending = completeGoogleOAuth(started.env, started.returned(), { fetchImpl });
    const result = pending.catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      const proof = await started.env.DB.prepare('SELECT verifier_ciphertext,consumed_by FROM google_oauth_pending').first<{ verifier_ciphertext: string | null; consumed_by: string | null }>();
      expect(proof!.verifier_ciphertext).toBeNull();
      expect(proof!.consumed_by).toBeTruthy();
      if (action === 'disconnect') await disconnectGoogleCalendar(started.env, 'u_alex', { fetchImpl });
      if (action === 'account') await started.env.DB.prepare("DELETE FROM users WHERE id='u_alex'").run();
      if (action === 'logout') await started.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(started.sessionToken)).run();
    } finally { release(); }
    expect(await result).toMatchObject({ code: 'google_connection_changed' });
    expect((await stored(started.env))?.connected ?? 0).toBe(0);
    expect((await stored(started.env))?.access_token_ciphertext ?? null).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await started.env.DB.prepare('SELECT COUNT(*) AS n FROM google_oauth_pending').first()).toEqual({ n: 0 });
  });

  it.each(['scope', 'missing_refresh', 'provider_error'] as const)('fails closed for %s without exposing provider response contents', async (condition) => {
    const started = await flow();
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
      if (condition === 'provider_error') return new Response('SECRET_PROVIDER_ERROR_BODY', { status: 400 });
      const body = tokenPayload(condition === 'scope' ? { scope: 'https://www.googleapis.com/auth/calendar' } : {});
      if (condition === 'missing_refresh') delete (body as Partial<typeof body>).refresh_token;
      return Response.json(body);
    });
    const error = await completeGoogleOAuth(started.env, started.returned(), { fetchImpl }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: expect.stringMatching(/^google_/) });
    expect(String(error)).not.toContain('SECRET_PROVIDER');
    expect((await stored(started.env))!.connected).toBe(0);
    expect((await stored(started.env))!.access_token_ciphertext).toBeNull();
    expect(await started.env.DB.prepare('SELECT COUNT(*) AS n FROM google_oauth_pending').first()).toEqual({ n: 0 });
  });
});

describe('Google token refresh and local-first revocation', () => {
  it('never refreshes on status reads and returns a current token only to an explicit matching grant operation', async () => {
    const connected = await connect();
    connected.fetchImpl.mockClear();
    expect(await getGoogleConnection(connected.env, 'u_alex')).toMatchObject({ connected: true, revision: 1 });
    expect(connected.fetchImpl).not.toHaveBeenCalled();
    expect(await getGoogleAccessToken(connected.env, 'u_alex', 1, undefined, { fetchImpl: connected.fetchImpl })).toBe('synthetic-access-token');
    await expect(getGoogleAccessToken(connected.env, 'u_sam', 1, undefined, { fetchImpl: connected.fetchImpl })).rejects.toMatchObject({ code: 'google_connection_changed' });
    await expect(getGoogleAccessToken(connected.env, 'u_alex', 0, undefined, { fetchImpl: connected.fetchImpl })).rejects.toMatchObject({ code: 'google_connection_changed' });
    expect(connected.fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes once under a durable claim and preserves an unrotated encrypted refresh token', async () => {
    const connected = await connect();
    await connected.env.DB.prepare("UPDATE google_calendar_connections SET expires_at=0 WHERE user_id='u_alex'").run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async () => { await gate; const payload = tokenPayload({ access_token: 'synthetic-refreshed-access' }); delete (payload as Partial<typeof payload>).refresh_token; return Response.json(payload); });
    const first = getGoogleAccessToken(connected.env, 'u_alex', 1, undefined, { fetchImpl });
    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      await expect(getGoogleAccessToken(connected.env, 'u_alex', 1, undefined, { fetchImpl })).rejects.toMatchObject({ code: 'google_refresh_in_progress' });
    } finally { release(); }
    expect(await first).toBe('synthetic-refreshed-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(request.get('grant_type')).toBe('refresh_token');
    expect(request.get('refresh_token')).toBe('synthetic-refresh-token');
    const saved = await stored(connected.env);
    expect(saved!.refresh_claim_token).toBeNull();
    expect(await decryptText(saved!.refresh_token_ciphertext!, connected.env.CONTENT_ENCRYPTION_KEY)).toBe('synthetic-refresh-token');
  });

  it('requires new consent after an unknown refresh and never automatically retries it', async () => {
    const connected = await connect();
    await connected.env.DB.prepare("UPDATE google_calendar_connections SET expires_at=0 WHERE user_id='u_alex'").run();
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('SECRET_REFRESH_FAILURE'); });
    await expect(getGoogleAccessToken(connected.env, 'u_alex', 1, undefined, { fetchImpl })).rejects.toMatchObject({ code: 'google_reauthorization_required' });
    expect(await getGoogleConnection(connected.env, 'u_alex')).toMatchObject({ connected: false, revision: 2, status: 'reauthorization_required' });
    const saved = await stored(connected.env);
    expect(saved).toMatchObject({ connected: 0, access_token_ciphertext: null, refresh_token_ciphertext: null });
    await expect(getGoogleAccessToken(connected.env, 'u_alex', 1, undefined, { fetchImpl })).rejects.toMatchObject({ code: 'google_connection_changed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const reauth = await beginGoogleOAuth(connected.env, connected.request, 'u_alex', { fetchImpl });
    expect(reauth.authorizationUrl).toContain('accounts.google.com');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a crashed durable refresh claim as unknown instead of issuing another refresh', async () => {
    const connected = await connect();
    await connected.env.DB.prepare("UPDATE google_calendar_connections SET expires_at=0,refresh_claim_token='old-claim',refresh_started_at=? WHERE user_id='u_alex'")
      .bind(Date.now() - 20_000).run();
    const fetchImpl = tokenFetch();
    expect(await getGoogleConnection(connected.env, 'u_alex')).toMatchObject({ status: 'reauthorization_required', connected: false });
    await expect(getGoogleAccessToken(connected.env, 'u_alex', 1, undefined, { fetchImpl })).rejects.toMatchObject({ code: 'google_reauthorization_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await stored(connected.env))!.refresh_token_ciphertext).toBeNull();
  });

  it('clears local tokens and pending proof before a best-effort provider revoke, even when revoke fails', async () => {
    const connected = await connect();
    for (const [userId, state] of [['u_alex', 'completed'], ['u_alex', 'unknown'], ['u_sam', 'completed']] as const) {
      const id = crypto.randomUUID();
      await connected.env.DB.prepare(`INSERT INTO google_calendar_requests(message_id,user_id,conversation_id,context_revision,
        connection_revision,operation,day,counted,state,query_digest,result_ciphertext,attempt_token,created_at,updated_at)
        VALUES (?,?,?,0,1,'list','2030-01-01',1,?,?,?,?,0,0)`)
        .bind(`source_${id}`, userId, `conversation_${id}`, state, 'original-query-digest', await encryptText('Synthetic private calendar cache.', connected.env.CONTENT_ENCRYPTION_KEY), id).run();
    }
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      expect(url).toBe('https://oauth2.googleapis.com/revoke');
      expect(await stored(connected.env)).toMatchObject({ connected: 0, revision: 2, access_token_ciphertext: null, refresh_token_ciphertext: null });
      expect(await connected.env.DB.prepare('SELECT COUNT(*) AS n FROM google_oauth_pending').first()).toEqual({ n: 0 });
      expect((await connected.env.DB.prepare("SELECT state,result_ciphertext,query_digest FROM google_calendar_requests WHERE user_id='u_alex' ORDER BY state").all()).results)
        .toEqual([{ state: 'purged', result_ciphertext: null, query_digest: '' }, { state: 'unknown', result_ciphertext: null, query_digest: '' }]);
      throw new Error('SECRET_REVOKE_FAILURE');
    });
    expect(await disconnectGoogleCalendar(connected.env, 'u_alex', { fetchImpl })).toEqual({ disconnected: true, revision: 2, providerRevocation: 'unknown' });
    expect(await getGoogleConnection(connected.env, 'u_alex')).toMatchObject({ connected: false, status: 'reauthorization_required', revision: 2, revocationPending: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await connected.env.DB.prepare("SELECT COUNT(*) AS n FROM google_calendar_requests WHERE counted=1").first()).toEqual({ n: 3 });
    expect(await connected.env.DB.prepare("SELECT state,query_digest FROM google_calendar_requests WHERE user_id='u_sam'").first())
      .toEqual({ state: 'completed', query_digest: 'original-query-digest' });
  });

  it('does not restore rotated tokens when disconnect wins during a refresh', async () => {
    const connected = await connect();
    await connected.env.DB.prepare("UPDATE google_calendar_connections SET expires_at=0 WHERE user_id='u_alex'").run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
      await gate; return Response.json(tokenPayload({ access_token: 'late-access', refresh_token: 'late-rotated-refresh' }));
    });
    const pending = getGoogleAccessToken(connected.env, 'u_alex', 1, undefined, { fetchImpl });
    const result = pending.catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      await disconnectGoogleCalendar(connected.env, 'u_alex', { fetchImpl });
    } finally { release(); }
    expect(await result).toMatchObject({ code: 'google_reauthorization_required' });
    expect(await stored(connected.env)).toMatchObject({ connected: 0, revision: 2, access_token_ciphertext: null, refresh_token_ciphertext: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await getGoogleConnection(connected.env, 'u_alex')).connected).toBe(false);
  });

  it('keeps local disconnect available with corrupt ciphertext and disabled provider configuration', async () => {
    const connected = await connect();
    await connected.env.DB.prepare("UPDATE google_calendar_connections SET refresh_token_ciphertext='v1:corrupt' WHERE user_id='u_alex'").run();
    const fetchImpl = tokenFetch();
    expect(await disconnectGoogleCalendar({ ...connected.env, LIVE_GOOGLE_CALENDAR_ENABLED: 'false' }, 'u_alex', { fetchImpl }))
      .toEqual({ disconnected: true, revision: 2, providerRevocation: 'unknown' });
    expect(await stored(connected.env)).toMatchObject({ connected: 0, access_token_ciphertext: null, refresh_token_ciphertext: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('respects cancellation before any explicit refresh request', async () => {
    const connected = await connect();
    await connected.env.DB.prepare("UPDATE google_calendar_connections SET expires_at=0 WHERE user_id='u_alex'").run();
    const controller = new AbortController(); controller.abort();
    const fetchImpl = tokenFetch();
    await expect(getGoogleAccessToken(connected.env, 'u_alex', 1, controller.signal, { fetchImpl })).rejects.toMatchObject({ code: 'google_operation_cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await stored(connected.env))!.refresh_claim_token).toBeNull();
  });

  it('never revokes a late old callback token after a newer connection succeeds', async () => {
    const started = await flow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const code = new URLSearchParams(String(init!.body)).get('code');
      if (code === 'synthetic-authorization-code') { await gate; return Response.json(tokenPayload({ access_token: 'stale-access', refresh_token: 'stale-refresh' })); }
      return Response.json(tokenPayload({ access_token: 'new-current-access', refresh_token: 'new-current-refresh' }));
    });
    const old = completeGoogleOAuth(started.env, started.returned(), { fetchImpl }).catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      expect(await disconnectGoogleCalendar(started.env, 'u_alex', { fetchImpl })).toMatchObject({ providerRevocation: 'unknown' });
      const replacement = await beginGoogleOAuth(started.env, started.request, 'u_alex', { fetchImpl });
      const state = new URL(replacement.authorizationUrl).searchParams.get('state')!;
      await completeGoogleOAuth(started.env, new Request(`${callback}?state=${state}&code=new-code`, { headers: { cookie: replacement.setCookie.split(';')[0]! } }), { fetchImpl });
    } finally { release(); }
    expect(await old).toMatchObject({ code: 'google_connection_changed' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await getGoogleConnection(started.env, 'u_alex')).toMatchObject({ connected: true, revision: 3, revocationPending: false });
    expect(await getGoogleAccessToken(started.env, 'u_alex', 3, undefined, { fetchImpl })).toBe('new-current-access');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('blocks reconnect during an explicit revoke and clears its claim only on confirmed completion', async () => {
    const connected = await connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => { expect(url).toBe('https://oauth2.googleapis.com/revoke'); await gate; return new Response(null, { status: 200 }); });
    const pending = disconnectGoogleCalendar(connected.env, 'u_alex', { fetchImpl });
    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      expect(await getGoogleConnection(connected.env, 'u_alex')).toMatchObject({ connected: false, revocationPending: true });
      await expect(beginGoogleOAuth(connected.env, connected.request, 'u_alex', { fetchImpl })).rejects.toMatchObject({ code: 'google_revocation_unresolved' });
      // Repeating local disconnect preserves the unresolved claim instead of sending another revoke.
      expect(await disconnectGoogleCalendar(connected.env, 'u_alex', { fetchImpl })).toMatchObject({ providerRevocation: 'unknown', revision: 3 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect(await pending).toMatchObject({ providerRevocation: 'confirmed' });
    expect(await getGoogleConnection(connected.env, 'u_alex')).toMatchObject({ connected: false, revision: 3, revocationPending: false });
    expect((await beginGoogleOAuth(connected.env, connected.request, 'u_alex', { fetchImpl })).authorizationUrl).toContain('accounts.google.com');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown provider revoke durably fenced without another revoke or reconnect attempt', async () => {
    const connected = await connect();
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('synthetic uncertain revoke'); });
    expect(await disconnectGoogleCalendar(connected.env, 'u_alex', { fetchImpl })).toMatchObject({ providerRevocation: 'unknown' });
    await expect(beginGoogleOAuth(connected.env, connected.request, 'u_alex', { fetchImpl })).rejects.toMatchObject({ code: 'google_revocation_unresolved' });
    expect(await disconnectGoogleCalendar(connected.env, 'u_alex', { fetchImpl })).toMatchObject({ providerRevocation: 'unknown' });
    expect(await getGoogleConnection(connected.env, 'u_alex')).toMatchObject({ connected: false, revocationPending: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
