import { describe, expect, it } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { inviteAlex, testEnv } from './setup';

const origin = 'http://localhost:8787';
async function call(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(origin + path, init) as Request<unknown, IncomingRequestCfProperties>, testEnv, context);
  await waitOnExecutionContext(context);
  return response;
}
async function cookie() {
  const response = await call('/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ inviteToken: inviteAlex }) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

describe('Google connector route boundaries without live credentials', () => {
  it('shows disabled scoped metadata and cannot begin a grant without explicit configuration', async () => {
    const session = await cookie();
    const response = await call('/api/calendar/google', { headers: { cookie: session } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: 'google', configured: false, connected: false, status: 'disabled', scope: null });
    const start = await call('/api/calendar/google/connect', { method: 'POST', headers: { cookie: session, origin } });
    expect(start.status).toBe(503);
    expect(await start.text()).not.toContain('authorizationUrl');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires account authentication and exact same-origin consent requests', async () => {
    expect((await call('/api/calendar/google')).status).toBe(401);
    const session = await cookie();
    const response = await call('/api/calendar/google/connect', { method: 'POST', headers: { cookie: session, origin: 'https://outside.example' } });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('strips an invalid callback code from the redirect and clears its proof cookie without an exchange', async () => {
    const response = await call('/api/calendar/google/callback?state=invalid&code=fictional-private-code');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/?calendar=failed');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('fictional-private-code');
    expect(fetch).not.toHaveBeenCalled();
  });
});
