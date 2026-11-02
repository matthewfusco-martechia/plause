import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import { beginIdentityLogin, completeIdentityLogin, identityReadiness } from '../apps/api/src/identity';
import { currentUser, getSessionProof, login, requireRecentIdentitySession } from '../apps/api/src/auth';
import type { Env } from '../packages/contracts/src/index';
import { decryptText, rotateEncryptionKeyring, sha256 } from '../packages/security/src/index';
import { inviteAlex, testEnv } from './setup';

const origin = 'http://localhost:8787';
const clientId = 'synthetic-identity-client.apps.googleusercontent.com';
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwk: JWK;
beforeAll(async () => {
  const key = await generateKeyPair('RS256', { extractable: true });
  signingKey = key.privateKey; jwk = { ...await exportJWK(key.publicKey), kid: 'fixture-signing-key', alg: 'RS256', use: 'sig' };
  otherKey = (await generateKeyPair('RS256')).privateKey;
});
afterEach(() => vi.useRealTimers());
beforeEach(async () => { await testEnv.DB.prepare('DELETE FROM identity_erasures').run(); });
const envFor = (overrides: Partial<Env> = {}): Env => ({ ...testEnv, PUBLIC_ORIGIN: origin, AUTH_GOOGLE_ENABLED: 'true', AUTH_SIGNUP_ENABLED: 'true',
  AUTH_GOOGLE_CLIENT_ID: clientId, AUTH_GOOGLE_CLIENT_SECRET: 'synthetic-identity-client-secret', ...overrides });
async function start(env = envFor(), cookie?: string, intent: 'signin' | 'reauth' = 'signin') {
  const loginOrigin = env.PUBLIC_ORIGIN!;
  const request = new Request(`${loginOrigin}/api/auth/google/start`, { method: 'POST', headers: { origin: loginOrigin, ...(cookie ? { cookie } : {}) } });
  const flow = await beginIdentityLogin(env, request, intent);
  const url = new URL(flow.authorizationUrl);
  return { env, request, ...flow, nonce: url.searchParams.get('nonce')!, state: url.searchParams.get('state')!,
    returned: (signal?: AbortSignal) => new Request(`${loginOrigin}/api/auth/google/callback?state=${url.searchParams.get('state')}&code=synthetic-signin-code`,
      { headers: { cookie: flow.setCookie.split(';')[0]! }, ...(signal ? { signal } : {}) }) };
}
async function token(nonce: string, payload: JWTPayload = {}, key = signingKey, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: 'https://accounts.google.com', sub: 'google-subject-alex', aud: clientId, nonce,
    iat: now, exp: now + 3600, name: 'A synthetic member', ...payload })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-signing-key', ...header }).sign(key);
}
function fixture(idToken: string) {
  return vi.fn<typeof fetch>(async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: idToken, access_token: 'discarded-identity-access-token', token_type: 'Bearer' });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    throw new Error('Unexpected fixture endpoint.');
  });
}
async function signin(env = envFor(), payload: JWTPayload = {}) {
  const flow = await start(env); const fetchImpl = fixture(await token(flow.nonce, payload));
  return { flow, fetchImpl, result: await completeIdentityLogin(env, flow.returned(), { fetchImpl }) };
}
const cloudEnv = (environment: 'staging' | 'production' = 'staging', overrides: Partial<Env> = {}) => envFor({
  APP_ENV: environment, PUBLIC_ORIGIN: `https://${environment}.plause.invalid`, AUTH_SIGNUP_SUBJECTS: '["google-subject-alex"]', ...overrides,
});
const invalidAdmissionLists = [undefined, '', 'not-json', 'null', '{}', 'true', '[]', '[1]', '[""]', '["has space"]',
  '["member@example.invalid"]', '["duplicate","duplicate"]', JSON.stringify(['x'.repeat(256)]),
  JSON.stringify(Array.from({ length: 6 }, (_, index) => `subject-${index}`)), ' '.repeat(4097)];

describe('production-capable Google OIDC identity', () => {
  it.each([{ AUTH_GOOGLE_ENABLED: 'false' }, { AUTH_GOOGLE_CLIENT_ID: '' }, { AUTH_GOOGLE_CLIENT_SECRET: '' },
    { PUBLIC_ORIGIN: 'https://app.example.com/' }, { APP_ENV: 'production', PUBLIC_ORIGIN: origin },
    { APP_ENV: 'production', PUBLIC_ORIGIN: 'http://app.example.com' }])('fails closed for invalid identity configuration %j', async (overrides) => {
    const env = envFor(overrides);
    expect(identityReadiness(env).configured).toBe(false);
    await expect(start(env)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requests identity only, binds state/browser/nonce/PKCE, and never requests offline calendar access', async () => {
    const flow = await start(); const url = new URL(flow.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.setCookie).toContain('HttpOnly; SameSite=Lax; Max-Age=300');
    const row = await flow.env.DB.prepare('SELECT * FROM identity_login_states').first<{ state_hash: string; nonce_hash: string; verifier_ciphertext: string; created_at: number; expires_at: number }>();
    expect(row!.state_hash).toBe(await sha256(flow.state)); expect(row!.nonce_hash).toBe(await sha256(flow.nonce));
    expect(row!.expires_at - row!.created_at).toBe(300_000);
    const verifier = await decryptText(row!.verifier_ciphertext, flow.env.CONTENT_ENCRYPTION_KEY);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(url.searchParams.get('code_challenge')).toBe(btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    expect(JSON.stringify(row)).not.toContain(flow.nonce); expect(JSON.stringify(row)).not.toContain(verifier);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('verifies an RSA-signed token against fixed Google JWKS and creates a scoped session without retaining provider tokens', async () => {
    const signed = await signin();
    expect(signed.result.user.id).toMatch(/^usr_/);
    expect(signed.fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs']);
    const body = new URLSearchParams(String(signed.fetchImpl.mock.calls[0]![1]!.body));
    expect(body.get('grant_type')).toBe('authorization_code'); expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signed.result.setCookie).toContain('HttpOnly; SameSite=Strict'); expect(signed.result.flowCookie).toContain('Max-Age=0');
    const request = new Request(origin, { headers: { cookie: signed.result.setCookie.split(';')[0]! } });
    expect(await currentUser(signed.flow.env, request)).toEqual(signed.result.user);
    expect(await getSessionProof(signed.flow.env, request)).toMatchObject({ authMethod: 'google', identityId: signed.result.identityId,
      identity: { issuer: 'https://accounts.google.com', subject: 'google-subject-alex' } });
    expect(await requireRecentIdentitySession(signed.flow.env, request)).toMatchObject({ user: signed.result.user });
    expect(await signed.flow.env.DB.prepare('SELECT COUNT(*) AS n FROM identity_login_states WHERE state_hash=?').bind(await sha256(signed.flow.state)).first()).toEqual({ n: 0 });
    const identity = await signed.flow.env.DB.prepare('SELECT * FROM external_identities').first();
    expect(JSON.stringify(identity)).not.toContain('discarded-identity-access-token');
    await expect(completeIdentityLogin(signed.flow.env, signed.flow.returned(), { fetchImpl: signed.fetchImpl })).rejects.toMatchObject({ code: 'identity_callback_proof_invalid' });
    expect(signed.fetchImpl).toHaveBeenCalledTimes(2); expect(fetch).not.toHaveBeenCalled();
  });

  it('constructs native Worker requests for token exchange and JWKS using supported manual redirects', async () => {
    const flow = await start(), base = fixture(await token(flow.nonce));
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      // Native workerd Request construction rejects redirect:error before any
      // provider request; a fetch spy alone cannot detect this runtime failure.
      const request = new Request(url, init);
      expect(request.redirect).toBe('manual');
      expect(request.method).toBe(url === 'https://oauth2.googleapis.com/token' ? 'POST' : 'GET');
      return base(url, init);
    });
    const result = await completeIdentityLogin(flow.env, flow.returned(), { fetchImpl });
    expect(result.user.id).toMatch(/^usr_/);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['token', 'jwks'] as const)('rejects a 302 from %s without following Location, creating a session or retrying the code', async (stage) => {
    const flow = await start(), base = fixture(await token(flow.nonce));
    const target = stage === 'token' ? 'https://oauth2.googleapis.com/token' : 'https://www.googleapis.com/oauth2/v3/certs';
    const attacker = 'https://attacker.invalid/collect-credentials';
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const request = new Request(url, init); expect(request.redirect).toBe('manual');
      if (url === target) return new Response('UNTRUSTED_REDIRECT_BODY', { status: 302, headers: { location: attacker } });
      return base(url, init);
    });
    const failure = await completeIdentityLogin(flow.env, flow.returned(), { fetchImpl }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject(stage === 'token'
      ? { code: 'identity_provider_unavailable', status: 502 } : { code: 'identity_token_invalid', status: 401 });
    expect(String(failure)).not.toContain('UNTRUSTED_REDIRECT_BODY'); expect(String(failure)).not.toContain(attacker);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(stage === 'token'
      ? ['https://oauth2.googleapis.com/token'] : ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs']);
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 0 });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM identity_login_states WHERE state_hash=?')
      .bind(await sha256(flow.state)).first()).toEqual({ n: 0 });
    const attempts = fetchImpl.mock.calls.length;
    await expect(completeIdentityLogin(flow.env, flow.returned(), { fetchImpl })).rejects.toMatchObject({ code: 'identity_callback_proof_invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(attempts); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['issuer', { iss: 'https://attacker.invalid' }], ['audience', { aud: 'wrong-client' }], ['presenter', { azp: 'wrong-client' }],
    ['multi-audience presenter', { aud: [clientId, 'other-client'] }], ['nonce', { nonce: 'wrong-nonce' }],
    ['expired', { exp: 1 }], ['future issuance', { iat: 4_000_000_000, exp: 4_000_003_600 }], ['subject', { sub: '' }],
    ['long lifetime', { exp: 4_000_000_000 }], ['future nbf', { nbf: 4_000_000_000 }],
  ] as [string, JWTPayload][])('rejects invalid %s claims before user/session creation', async (_, payload) => {
    const flow = await start(); const fetchImpl = fixture(await token(flow.nonce, payload));
    await expect(completeIdentityLogin(flow.env, flow.returned(), { fetchImpl })).rejects.toMatchObject({ code: 'identity_token_invalid' });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 0 });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
  });

  it.each(['signature', 'kid', 'jku'] as const)('rejects a substituted %s without fetching attacker key URLs', async (change) => {
    const flow = await start();
    const jwt = await token(flow.nonce, {}, change === 'signature' ? otherKey : signingKey,
      change === 'kid' ? { kid: 'missing-key' } : change === 'jku' ? { jku: 'https://attacker.invalid/jwks' } : {});
    const fetchImpl = fixture(jwt);
    await expect(completeIdentityLogin(flow.env, flow.returned(), { fetchImpl })).rejects.toMatchObject({ code: 'identity_token_invalid' });
    expect(fetchImpl.mock.calls.every(([url]) => url === 'https://oauth2.googleapis.com/token' || url === 'https://www.googleapis.com/oauth2/v3/certs')).toBe(true);
  });

  it('uses issuer plus subject across changed emails and never merges two subjects sharing an email', async () => {
    const first = await signin(envFor(), { email: 'same@example.invalid' });
    const renamed = await signin(envFor(), { email: 'renamed@example.invalid' });
    const other = await signin(envFor(), { sub: 'different-google-subject', email: 'same@example.invalid' });
    expect(renamed.result.user.id).toBe(first.result.user.id); expect(other.result.user.id).not.toBe(first.result.user.id);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 2 });
  });

  it('keeps existing-account sign-in available while new-account signup is disabled', async () => {
    const original = await signin();
    const locked = envFor({ AUTH_SIGNUP_ENABLED: 'false' });
    const returning = await signin(locked);
    expect(returning.result.user.id).toBe(original.result.user.id);
    const flow = await start(locked);
    await expect(completeIdentityLogin(locked, flow.returned(), { fetchImpl: fixture(await token(flow.nonce, { sub: 'unregistered-subject' })) }))
      .rejects.toMatchObject({ code: 'identity_session_changed' });
    expect(await locked.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 1 });
    expect(await locked.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'usr_%'").first()).toEqual({ n: 1 });
  });

  it.each(['staging', 'production'] as const)('admits only an explicitly allowlisted verified Google subject on a fresh %s database', async (environment) => {
    const env = cloudEnv(environment), signed = await signin(env, { email: 'same@example.invalid' });
    expect(signed.result.user.id).toMatch(/^usr_/); expect(signed.result.setCookie).toContain('Secure');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'usr_%'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM operator_grants').first()).toEqual({ n: 0 });
    expect(identityReadiness(env)).toEqual({ provider: 'google', enabled: true, configured: true, signupEnabled: true });
    expect(JSON.stringify(identityReadiness(env))).not.toContain('google-subject-alex');
    const other = await start(env);
    await expect(completeIdentityLogin(env, other.returned(), { fetchImpl: fixture(await token(other.nonce,
      { sub: 'another-subject-with-same-email', email: 'same@example.invalid' })) })).rejects.toMatchObject({ code: 'identity_session_changed' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'usr_%'").first()).toEqual({ n: 1 });
  });

  it.each(['other-subject', 'Google-subject-alex', 'google-subject-alex_suffix'])('rejects nonmatching cloud subject %s despite email claims or operator bootstrap', async (subject) => {
    const env = cloudEnv('staging', { OPERATOR_BOOTSTRAP_SUBJECTS: JSON.stringify([subject]) });
    const flow = await start(env), fetchImpl = fixture(await token(flow.nonce, { sub: subject, email: 'same@example.invalid' }));
    const failure = await completeIdentityLogin(env, flow.returned(), { fetchImpl }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'identity_session_changed' });
    expect(String(failure)).not.toContain(subject); expect(String(failure)).not.toContain('google-subject-alex');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'usr_%'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IS NOT NULL').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM operator_grants').first()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(invalidAdmissionLists.map((value, index) => ({ value, index })))('fails closed before OAuth for invalid cloud admission list case $index', async ({ value }) => {
    const env = cloudEnv();
    if (value === undefined) delete env.AUTH_SIGNUP_SUBJECTS; else env.AUTH_SIGNUP_SUBJECTS = value;
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_login_states').first();
    expect(identityReadiness(env)).toEqual({ provider: 'google', enabled: true, configured: false, signupEnabled: false });
    await expect(start(env)).rejects.toMatchObject({ code: 'identity_signup_configuration_invalid', status: 503 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_login_states').first()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps cloud returning sign-in and reauthentication independent of a closed or removed admission list', async () => {
    const admitted = await signin(cloudEnv());
    const replacedList = cloudEnv('staging', { AUTH_SIGNUP_SUBJECTS: '["different-approved-subject"]' });
    expect((await signin(replacedList)).result.user.id).toBe(admitted.result.user.id);
    const closed = cloudEnv('staging', { AUTH_SIGNUP_ENABLED: 'false' }); delete closed.AUTH_SIGNUP_SUBJECTS;
    const returning = await signin(closed); expect(returning.result.user.id).toBe(admitted.result.user.id);
    const flow = await start(closed, returning.result.setCookie.split(';')[0]!, 'reauth');
    const confirmed = await completeIdentityLogin(closed, flow.returned(), { fetchImpl: fixture(await token(flow.nonce)) });
    expect(confirmed.user.id).toBe(admitted.result.user.id);
    const request = new Request(closed.PUBLIC_ORIGIN!, { headers: { cookie: confirmed.setCookie.split(';')[0]! } });
    expect(await requireRecentIdentitySession(closed, request)).toMatchObject({ user: admitted.result.user, authMethod: 'google' });
    expect(await closed.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 1 });
  });

  it('does not create a cloud account for an allowlisted subject when signup is false', async () => {
    const env = cloudEnv('staging', { AUTH_SIGNUP_ENABLED: 'false' });
    const flow = await start(env);
    await expect(completeIdentityLogin(env, flow.returned(), { fetchImpl: fixture(await token(flow.nonce)) }))
      .rejects.toMatchObject({ code: 'identity_session_changed' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'usr_%'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
  });

  it('retains explicit local development signup semantics independently of the cloud admission list', async () => {
    const signed = await signin(envFor({ AUTH_SIGNUP_SUBJECTS: 'not-a-cloud-list' }), { sub: 'local-development-subject' });
    expect(signed.result.user.id).toMatch(/^usr_/);
  });

  it('reauthenticates the original identity, rotates its session and rejects a different Google subject', async () => {
    const signed = await signin(); const cookie = signed.result.setCookie.split(';')[0]!;
    const wrong = await start(signed.flow.env, cookie, 'reauth');
    await expect(completeIdentityLogin(signed.flow.env, wrong.returned(), { fetchImpl: fixture(await token(wrong.nonce, { sub: 'another-subject' })) }))
      .rejects.toMatchObject({ code: 'identity_session_changed' });
    expect(await currentUser(signed.flow.env, new Request(origin, { headers: { cookie } }))).toEqual(signed.result.user);
    const flow = await start(signed.flow.env, cookie, 'reauth');
    const result = await completeIdentityLogin(signed.flow.env, flow.returned(), { fetchImpl: fixture(await token(flow.nonce)) });
    expect(result.user).toEqual(signed.result.user); expect(result.token).not.toBe(signed.result.token);
    expect(await currentUser(signed.flow.env, new Request(origin, { headers: { cookie } }))).toBeNull();
    expect(await requireRecentIdentitySession(signed.flow.env, new Request(origin, { headers: { cookie: result.setCookie.split(';')[0]! } }))).toMatchObject({ authMethod: 'google' });
  });

  it.each(['browser', 'expired', 'duplicate_state', 'origin'] as const)('rejects invalid callback %s before exchange', async (kind) => {
    const flow = await start(); const fetchImpl = fixture(await token(flow.nonce)); let returned = flow.returned();
    if (kind === 'browser') returned = new Request(returned.url, { headers: { cookie: `plause_identity_flow=${'x'.repeat(43)}` } });
    if (kind === 'expired') await flow.env.DB.prepare('UPDATE identity_login_states SET expires_at=0').run();
    if (kind === 'duplicate_state') returned = new Request(`${returned.url}&state=${flow.state}`, { headers: returned.headers });
    if (kind === 'origin') returned = new Request(returned.url.replace('localhost', '127.0.0.1'), { headers: returned.headers });
    await expect(completeIdentityLogin(flow.env, returned, { fetchImpl })).rejects.toMatchObject({ code: expect.stringMatching(/^(identity_|origin_)/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rechecks original session revocation after PKCE decryption and before exchange', async () => {
    const signed = await signin(); const flow = await start(signed.flow.env, signed.result.setCookie.split(';')[0]!, 'reauth');
    const fetchImpl = fixture(await token(flow.nonce)); const original = crypto.subtle.decrypt.bind(crypto.subtle);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (algorithm, key, data) => {
      const value = await original(algorithm, key, data);
      await flow.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(signed.result.token)).run(); return value;
    });
    try { await expect(completeIdentityLogin(flow.env, flow.returned(), { fetchImpl })).rejects.toMatchObject({ code: 'identity_session_changed' }); }
    finally { decrypt.mockRestore(); }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not recreate an erased account through an older anonymous callback, including active-key rotation=%s', async (rotated) => {
    const signed = await signin(); const flow = await start(); const jwt = await token(flow.nonce);
    const callbackEnv = rotated ? { ...flow.env, CONTENT_ENCRYPTION_KEY: rotateEncryptionKeyring(flow.env.CONTENT_ENCRYPTION_KEY,
      btoa(String.fromCharCode(...new Uint8Array(32).fill(93))), 'new-content-key') } : flow.env;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = fixture(jwt); const fetchImpl = vi.fn<typeof fetch>(async (url, init) => { if (url === 'https://oauth2.googleapis.com/token') await gate; return base(url, init); });
    const pending = completeIdentityLogin(callbackEnv, flow.returned(), { fetchImpl }).catch((cause: unknown) => cause);
    try { await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1)); await flow.env.DB.prepare('DELETE FROM users WHERE id=?').bind(signed.result.user.id).run(); }
    finally { release(); }
    expect(await pending).toMatchObject({ code: 'identity_session_changed' });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 0 });
    const tombstone = await flow.env.DB.prepare('SELECT * FROM identity_erasures').first(); expect(tombstone).not.toBeNull();
    expect(JSON.stringify(tombstone)).not.toContain('google-subject-alex');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1000);
    const recreated = await signin(callbackEnv); expect(recreated.result.user.id).not.toBe(signed.result.user.id);
  });

  it('fails safely on provider error/oversized bodies, and respects caller cancellation across a stalled body', async () => {
    for (const response of [new Response('SECRET_PROVIDER_BODY', { status: 500 }), new Response('x'.repeat(65_537))]) {
      const flow = await start(); const fetchImpl = vi.fn<typeof fetch>(async () => response);
      const failure = await completeIdentityLogin(flow.env, flow.returned(), { fetchImpl }).catch((cause: unknown) => cause);
      expect(String(failure)).not.toContain('SECRET_PROVIDER'); expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const flow = await start(); const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start() {} })));
    const pending = completeIdentityLogin(flow.env, flow.returned(controller.signal), { fetchImpl }).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1)); controller.abort();
    expect(await pending).toMatchObject({ code: 'identity_request_cancelled' });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 0 });
  });

  it.each(['local', 'staging'] as const)('fences an admitted %s sign-in awaiting provider verification when a restore lock is activated', async (environment) => {
    const flow = await start(environment === 'local' ? envFor() : cloudEnv()); const base = fixture(await token(flow.nonce));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => { if (url === 'https://oauth2.googleapis.com/token') await gate; return base(url, init); });
    const pending = completeIdentityLogin(flow.env, flow.returned(), { fetchImpl }).catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      await flow.env.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','true')").run();
    } finally { release(); }
    expect(await pending).toMatchObject({ code: 'identity_session_changed' });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM external_identities').first()).toEqual({ n: 0 });
    expect(await flow.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
    expect(await flow.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'usr_%'").first()).toEqual({ n: 0 });
    expect(await login(flow.env, inviteAlex)).toBeNull();
    await expect(start(flow.env)).rejects.toMatchObject({ code: 'restore_locked', status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disables invitation authentication outside local mode and refuses ambiguous session cookies', async () => {
    expect(await login(envFor({ APP_ENV: 'production', PUBLIC_ORIGIN: 'https://app.example.com' }), inviteAlex)).toBeNull();
    const local = await login(envFor(), inviteAlex); expect(local).not.toBeNull();
    const request = new Request(origin, { headers: { cookie: `plause_session=${local!.token}` } });
    expect(await currentUser(envFor({ APP_ENV: 'production' }), request)).toBeNull();
    expect(await currentUser(envFor(), new Request(origin, { headers: { cookie: `plause_session=${local!.token}; plause_session=${local!.token}` } }))).toBeNull();
    await envFor().DB.prepare('UPDATE sessions SET authenticated_at=0').run();
    await expect(requireRecentIdentitySession(envFor(), request)).rejects.toMatchObject({ code: 'identity_reauthentication_required' });
  });
});
