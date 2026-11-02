import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const probe = 'https://native-provider-fixture.invalid/ready';
const eventsPath = '/calendar/v3/calendars/primary/events';
const messagePath = '/sc/v2/apps/fixture_app/conversations/fixture_conversation/messages';
const fakeScope = 'https://www.googleapis.com/auth/calendar.events.owned';
const worker = await build({
  absWorkingDir: root,
  stdin: { resolveDir: root, sourcefile: 'native-provider-fetch-fixture.ts', contents: `
    import { TavilySearchProvider } from './packages/research/src/index.ts';
    import { SunshineMessagingClient } from './packages/messaging-sunshine/src/index.ts';
    import { GoogleCalendarClient, GoogleOAuthClient, googleEventId } from './packages/calendar-google/src/index.ts';
    const draft = { title: 'A fictional library visit', startsAt: '2030-06-01T14:00:00Z', durationMinutes: 30 };
    const key = 'approval_native_fixture';
    export default {
      async fetch(request) {
        const control = await fetch(${JSON.stringify(probe)}, { redirect: 'manual' });
        const nativeControlPassed = control.ok && (await control.json()).ready === true;
        const scenario = new URL(request.url).searchParams.get('scenario');
        try {
          let result;
          if (scenario.startsWith('tavily')) {
            result = await new TavilySearchProvider({ apiKey: 'fictional-tavily-key', timeoutMs: 2000 })
              .search('fictional public library query');
          } else if (scenario.startsWith('sunshine')) {
            const client = new SunshineMessagingClient({
              SUNSHINE_SUBDOMAIN: 'native-fixture', SUNSHINE_APP_ID: 'fixture_app',
              SUNSHINE_APPLE_INTEGRATION_ID: 'fixture_apple', SUNSHINE_KEY_ID: 'fixture_key',
              SUNSHINE_KEY_SECRET: 'fictional-sunshine-secret',
            }, { timeoutMs: 2000 });
            const input = { conversationId: 'fixture_conversation', idempotencyKey: 'fixture_outbox',
              content: { type: 'text', text: 'A fictional native fetch fixture.' } };
            const sent = await client.send(input);
            const reconciled = await client.reconcile(input);
            result = { sent, reconciled };
          } else if (scenario.startsWith('oauth')) {
            const client = new GoogleOAuthClient({ clientId: 'fixture-client', clientSecret: 'fictional-google-secret',
              redirectUri: 'http://localhost:8787/api/calendar/google/callback', timeoutMs: 2000 });
            const exchanged = await client.exchangeAuthorizationCode('fictional-code', 'v'.repeat(43));
            const refreshed = await client.refreshAccessToken('fictional-refresh-token');
            await client.revokeToken('fictional-refresh-token');
            result = { exchanged, refreshed, revoked: true };
          } else {
            const client = new GoogleCalendarClient({ accessToken: 'fictional-access-token', timeoutMs: 2000 });
            if (scenario.startsWith('google-create')) result = await client.createEvent(draft, { idempotencyKey: key });
            else if (scenario.startsWith('google-update')) result = await client.updateEvent(await googleEventId(key), draft, { etag: '"fixture-version"' });
            else result = await client.listEvents({ timeMin: '2030-06-01T00:00:00Z', timeMax: '2030-06-02T00:00:00Z', maxResults: 2 });
          }
          return Response.json({ nativeControlPassed, result });
        } catch (error) {
          return Response.json({ nativeControlPassed, code: error?.code ?? 'unexpected_error',
            chargePossible: error?.chargePossible, outcomeUnknown: error?.outcomeUnknown, status: error?.status }, { status: 500 });
        }
      },
    };
  ` },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function redirect() {
  return new Response(null, { status: 302, headers: { location: 'https://redirect-target.invalid/never-follow' } });
}
function managedEvent(body) {
  return { ...body, etag: '"fixture-version"', status: 'confirmed', organizer: { self: true } };
}

async function run(t, scenario) {
  const intercepted = [];
  let messageBody;
  let eventBody;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: worker.outputFiles[0].text, compatibilityDate: '2026-10-30', cf: false,
    // This intercepts ALL egress. Unknown origins/paths fail here, never on an external network.
    outboundService: async (request) => {
      const url = new URL(request.url);
      const body = request.method === 'GET' ? null : await request.text();
      intercepted.push({ url: url.href, method: request.method, body });
      if (url.href === probe) {
        assert.equal(request.method, 'GET');
        return json({ ready: true });
      }
      if (scenario.startsWith('tavily')) {
        assert.equal(url.href, 'https://api.tavily.com/search');
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.get('authorization'), 'Bearer fictional-tavily-key');
        assert.equal(JSON.parse(body).query, 'fictional public library query');
        return scenario.endsWith('redirect') ? redirect()
          : json({ results: [{ title: 'Fixture public source', url: 'https://www.loc.gov/visit/', content: 'A fictional source snippet.' }] });
      }
      if (scenario.startsWith('sunshine')) {
        assert.equal(url.origin, 'https://native-fixture.zendesk.com');
        assert.equal(url.pathname, messagePath);
        assert.equal(request.headers.get('authorization'), `Basic ${Buffer.from('fixture_key:fictional-sunshine-secret').toString('base64')}`);
        if (request.method === 'POST') {
          messageBody = JSON.parse(body);
          assert.deepEqual(messageBody.destination, { integrationId: 'fixture_apple' });
          return scenario === 'sunshine-send-redirect' ? redirect()
            : json({ messages: [{ id: 'fixture_message', author: { type: 'business' } }] }, 201);
        }
        assert.equal(request.method, 'GET');
        return scenario === 'sunshine-read-redirect' ? redirect()
          : json({ messages: [{ ...messageBody, id: 'fixture_message' }] });
      }
      if (scenario.startsWith('oauth')) {
        assert.equal(url.origin, 'https://oauth2.googleapis.com');
        assert.equal(request.method, 'POST');
        if (url.pathname === '/token') {
          assert.equal(new URLSearchParams(body).get('client_secret'), 'fictional-google-secret');
          return scenario === 'oauth-redirect' ? redirect()
            : json({ access_token: 'fictional-access-token', refresh_token: 'fictional-refresh-token',
              token_type: 'Bearer', expires_in: 3600, scope: fakeScope });
        }
        assert.equal(url.pathname, '/revoke');
        assert.equal(new URLSearchParams(body).get('token'), 'fictional-refresh-token');
        return new Response(null, { status: 200 });
      }
      assert.equal(url.origin, 'https://www.googleapis.com');
      assert.equal(request.headers.get('authorization'), 'Bearer fictional-access-token');
      assert.ok(url.pathname === eventsPath || new RegExp(`^${eventsPath}/p[0-9a-f]{64}$`).test(url.pathname));
      if (request.method === 'POST') {
        assert.equal(url.searchParams.get('sendUpdates'), 'none');
        eventBody = JSON.parse(body);
        return scenario === 'google-create-redirect' ? redirect() : json(managedEvent(eventBody));
      }
      if (request.method === 'PUT') {
        assert.equal(url.searchParams.get('sendUpdates'), 'none');
        assert.equal(request.headers.get('if-match'), '"fixture-version"');
        return redirect();
      }
      assert.equal(request.method, 'GET');
      if (scenario === 'google-read-redirect') return redirect();
      if (url.pathname === eventsPath) return json({ items: [] });
      if (!eventBody) {
        const id = url.pathname.split('/').at(-1);
        eventBody = { id, summary: 'A fictional library visit', start: { dateTime: '2030-06-01T14:00:00.000Z' },
          end: { dateTime: '2030-06-01T14:30:00.000Z' }, attendees: [], eventType: 'default',
          extendedProperties: { private: { plauseOperationId: id } } };
      }
      return json(managedEvent(eventBody));
    },
  }));
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch(`http://fixture.invalid/?scenario=${scenario}`);
  const body = await response.json();
  assert.equal(body.nativeControlPassed, true, 'Bare native fetch must reach the local interceptor first.');
  assert.equal(intercepted[0].url, probe);
  return { status: response.status, body, calls: intercepted.slice(1) };
}

test('Tavily default native Workers fetch reaches the fixed endpoint', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'tavily-success');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.result, [{ title: 'Fixture public source', url: 'https://www.loc.gov/visit/', snippet: 'A fictional source snippet.' }]);
  assert.deepEqual(calls.map(({ method }) => method), ['POST']);
});
test('Tavily native POST redirect is not followed and retains possible-charge uncertainty', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'tavily-redirect');
  assert.equal(status, 500);
  assert.equal(body.code, 'research_request_rejected');
  assert.equal(body.chargePossible, true);
  assert.equal(calls.length, 1);
});

for (const scenario of ['sunshine-success', 'sunshine-send-redirect', 'sunshine-read-redirect']) {
  test(`Sunshine native fetch ${scenario} sends once and reconciles with GET only`, { timeout: 60_000 }, async (t) => {
    const { status, body, calls } = await run(t, scenario);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.result.sent, scenario === 'sunshine-send-redirect'
      ? { state: 'delivery_unknown', code: 'sunshine_request_rejected' } : { state: 'sent', providerMessageId: 'fixture_message' });
    assert.deepEqual(body.result.reconciled, scenario === 'sunshine-read-redirect' ? null : { state: 'sent', providerMessageId: 'fixture_message' });
    assert.deepEqual(calls.map(({ method }) => method), ['POST', 'GET']);
  });
}

test('Google Calendar default native fetch lists one fixed page', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'google-list-success');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.result, { events: [], nextPageToken: null });
  assert.deepEqual(calls.map(({ method }) => method), ['GET']);
});
test('Google Calendar native redirected insert reconciles once without another POST', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'google-create-redirect');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.result.reconciled, true);
  assert.equal(body.result.event.managed, true);
  assert.deepEqual(calls.map(({ method }) => method), ['POST', 'GET']);
});
test('Google Calendar native redirected update remains uncertain without retry', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'google-update-redirect');
  assert.equal(status, 500);
  assert.equal(body.code, 'google_request_rejected');
  assert.equal(body.outcomeUnknown, true);
  assert.equal(body.status, 302);
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'PUT']);
});
test('Google Calendar native read redirect is rejected without following', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'google-read-redirect');
  assert.equal(status, 500);
  assert.equal(body.code, 'google_request_rejected');
  assert.equal(body.outcomeUnknown, false);
  assert.equal(calls.length, 1);
});
test('Google OAuth default native fetch exchanges, refreshes and revokes at fixed endpoints', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'oauth-success');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.result.exchanged.accessToken, 'fictional-access-token');
  assert.equal(body.result.refreshed.scope, fakeScope);
  assert.equal(body.result.revoked, true);
  assert.deepEqual(calls.map(({ url }) => url), ['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/revoke']);
});
test('Google OAuth native token redirect is not followed or retried and remains uncertain', { timeout: 60_000 }, async (t) => {
  const { status, body, calls } = await run(t, 'oauth-redirect');
  assert.equal(status, 500);
  assert.equal(body.code, 'google_request_rejected');
  assert.equal(body.outcomeUnknown, true);
  assert.equal(calls.length, 1);
});
