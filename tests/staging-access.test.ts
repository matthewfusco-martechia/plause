import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import type { Env } from '../packages/contracts/src/index';
import { sha256 } from '../packages/security/src/index';
import { testEnv } from './setup';

const origin = 'https://staging.plause.example.com';
const fixturePassword = 'synthetic-staging-access-password-fixture-only-1234567890';
const basic = (password = fixturePassword, username = 'plause'): string => `Basic ${btoa(
  Array.from(new TextEncoder().encode(`${username}:${password}`), (byte) => String.fromCharCode(byte)).join(''),
)}`;

type FixturePatch = { [Key in keyof Env]?: Env[Key] | undefined };
async function runtime(patch: FixturePatch = {}): Promise<Env> {
  const value: Env = { ...testEnv, APP_ENV: 'staging', PUBLIC_ORIGIN: origin, MESSAGING_PROVIDER: 'web',
    STAGING_ACCESS_ENABLED: 'true', STAGING_ACCESS_PASSWORD_SHA256: await sha256(fixturePassword),
    ASSETS: { fetch: vi.fn(async () => new Response('fixture asset', { headers: { 'cache-control': 'public,max-age=3600' } })) } as unknown as Env['ASSETS'],
    JOBS: { send: vi.fn(async () => {}) } as unknown as Env['JOBS'] };
  // Explicit undefined fixtures exercise missing optional bindings.
  Object.assign(value, patch);
  return value;
}

async function request(env: Env, path = '/', init: RequestInit = {}, base = origin): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(base + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function poisonDatabase(env: Env): ReturnType<typeof vi.fn> {
  const reached = vi.fn(() => { throw new Error('Protected route must not run'); });
  env.DB = { prepare: reached, batch: reached, exec: reached } as unknown as D1Database;
  return reached;
}

describe('origin-wide staging password wall', () => {
  it.each(['/', '/app.js', '/style.css', '/favicon.ico', '/health', '/ready', '/api/auth/status',
    '/api/auth/google/callback?code=fixture&state=fixture', '/api/calendar/google/callback?code=fixture',
    '/api/account/export', '/api/webhooks/sunshine', '/unknown-path'])('challenges %s before routes, assets, cookies or provider calls', async (path) => {
    const env = await runtime(), reached = poisonDatabase(env);
    const response = await request(env, path, { headers: { cookie: 'plause_session=synthetic-session-cannot-bypass-wall' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Plause staging", charset="UTF-8"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ error: 'staging_access_required' });
    expect(reached).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(env.JOBS.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])('gates %s before reading or handling a request body', async (method) => {
    const env = await runtime(), reached = poisonDatabase(env);
    expect((await request(env, '/api/auth/google/start', { method })).status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['Bearer fixture', 'Basic', 'Basic !!!', `Basic ${btoa('plause')}`, basic('', 'plause'),
    basic(fixturePassword, 'other-user'), basic('incorrect-password'), 'Basic /w==', 'Basic cGxhdXNlOnBhc3N3b3Jk===',
    `Basic ${'A'.repeat(1024)}`])('rejects malformed or incorrect credentials without exposing configuration (%#)', async (authorization) => {
    const env = await runtime(), reached = poisonDatabase(env), log = vi.spyOn(console, 'error');
    try {
      const response = await request(env, '/api/auth/status', { headers: { authorization } });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"staging_access_required"}');
      expect(reached).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it.each([undefined, '', 'x'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), ` ${'a'.repeat(64)}`])('fails closed for missing or malformed enabled hash (%#)', async (STAGING_ACCESS_PASSWORD_SHA256) => {
    const env = await runtime({ STAGING_ACCESS_PASSWORD_SHA256 }), reached = poisonDatabase(env);
    const response = await request(env, '/health', { headers: { authorization: basic() } });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'staging_access_unavailable' });
    expect(reached).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(['', 'TRUE', '1', 'yes'])('fails closed for malformed gate flag %s', async (STAGING_ACCESS_ENABLED) => {
    const env = await runtime({ STAGING_ACCESS_ENABLED }), reached = poisonDatabase(env);
    expect((await request(env, '/ready', { headers: { authorization: basic() } })).status).toBe(503);
    expect(reached).not.toHaveBeenCalled();
  });

  it.each(['local', 'production'])('refuses enabling the staging-only wall in %s', async (APP_ENV) => {
    const env = await runtime({ APP_ENV }), reached = poisonDatabase(env);
    expect((await request(env, '/health', { headers: { authorization: basic() } })).status).toBe(503);
    expect(reached).not.toHaveBeenCalled();
  });

  it('does not challenge or accept credentials over HTTP', async () => {
    const env = await runtime(), reached = poisonDatabase(env);
    const response = await request(env, '/', { headers: { authorization: basic() } }, 'http://staging.plause.example.com');
    expect(response.status).toBe(503);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(reached).not.toHaveBeenCalled();
  });

  it('admits correct credentials while preventing authorized asset caching', async () => {
    const env = await runtime();
    const response = await request(env, '/app.js', { headers: { authorization: basic() } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fixture asset');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes a hexadecimal digest and accepts case-insensitive Basic scheme', async () => {
    const env = await runtime({ STAGING_ACCESS_PASSWORD_SHA256: (await sha256(fixturePassword)).toUpperCase() });
    const response = await request(env, '/health', { headers: { authorization: basic().replace('Basic', 'bAsIc') } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ product: 'Plause', environment: 'staging' });
  });

  it('preserves Google/account session authorization behind a successful wall', async () => {
    const env = await runtime();
    const response = await request(env, '/api/account', { headers: { authorization: basic() } });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets a password-authorized OAuth callback reach the existing flow without treating the password as a Google session', async () => {
    const env = await runtime();
    const response = await request(env, '/api/auth/google/callback', { headers: { authorization: basic() } });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/?signin=failed');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'false'])('keeps the existing local preview unchanged with gate flag %s', async (STAGING_ACCESS_ENABLED) => {
    const env = await runtime({ APP_ENV: 'local', STAGING_ACCESS_ENABLED, STAGING_ACCESS_PASSWORD_SHA256: undefined });
    const response = await request(env, '/health', {}, 'http://localhost:8787');
    expect(response.status).toBe(200);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
  });

  it('fails closed if native hashing fails, without route calls or credential logging', async () => {
    const env = await runtime(), reached = poisonDatabase(env), log = vi.spyOn(console, 'error');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('fixture crypto failure'));
    try {
      expect((await request(env, '/', { headers: { authorization: basic() } })).status).toBe(503);
      expect(reached).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally { digest.mockRestore(); log.mockRestore(); }
  });
});
