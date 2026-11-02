import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_SCOPE, GoogleCalendarClient, GoogleCalendarError, googleEventId, GoogleOAuthClient,
  type GoogleEventDraft } from '../packages/calendar-google/src/index';

const draft: GoogleEventDraft = { title: 'A fixture library visit', startsAt: '2030-06-01T10:00:00-04:00', durationMinutes: 30 };
const key = 'approval_00000000-0000-0000-0000-000000000001';
const canonicalStart = '2030-06-01T14:00:00.000Z';
async function event(overrides: Record<string, unknown> = {}) {
  const id = await googleEventId(key);
  return { kind: 'calendar#event', id, etag: '"fixture-version-1"', status: 'confirmed', summary: draft.title,
    start: { dateTime: canonicalStart }, end: { dateTime: '2030-06-01T14:30:00.000Z' }, organizer: { self: true },
    attendees: [], eventType: 'default', extendedProperties: { private: { plauseOperationId: id } }, ...overrides };
}
function client(fetchImpl: typeof fetch, options: { timeoutMs?: number; beforeWrite?: () => Promise<void> } = {}) {
  return new GoogleCalendarClient({ accessToken: 'synthetic-access-token', fetchImpl, ...options });
}

describe('Google Calendar fixed endpoint client', () => {
  it('derives a stable base32hex-compatible ID scoped to the durable operation key', async () => {
    const id = await googleEventId(key);
    expect(id).toMatch(/^p[0-9a-f]{64}$/);
    expect(await googleEventId(key)).toBe(id);
    expect(await googleEventId(`${key}:another`)).not.toBe(id);
  });
  it('creates exactly one private primary-calendar event with no guests or notifications', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(await event()));
    const beforeWrite = vi.fn(async () => {});
    const result = await client(fetchImpl, { beforeWrite }).createEvent(draft, { idempotencyKey: key });
    expect(result).toMatchObject({ reconciled: false, event: { title: draft.title, managed: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(beforeWrite).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { authorization: 'Bearer synthetic-access-token' } });
    expect(JSON.parse(init!.body as string)).toEqual({ id: await googleEventId(key), summary: draft.title,
      start: { dateTime: canonicalStart }, end: { dateTime: '2030-06-01T14:30:00.000Z' }, attendees: [],
      guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: false,
      reminders: { useDefault: false }, visibility: 'private', transparency: 'opaque', eventType: 'default',
      extendedProperties: { private: { plauseOperationId: await googleEventId(key) } } });
  });
  it.each(['network', 'server', 'conflict', 'malformed', 'redirect'] as const)('reconciles %s insert with one GET and no second POST', async (mode) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (mode === 'network') fetchImpl.mockRejectedValueOnce(new Error('SECRET_NETWORK_ERROR'));
    else fetchImpl.mockResolvedValueOnce(mode === 'malformed' ? Response.json({ secret: 'unusable' })
      : new Response('SECRET_PROVIDER_BODY', { status: mode === 'conflict' ? 409 : mode === 'redirect' ? 302 : 500 }));
    fetchImpl.mockResolvedValueOnce(Response.json(await event()));
    expect(await client(fetchImpl).createEvent(draft, { idempotencyKey: key })).toMatchObject({ reconciled: true });
    expect(fetchImpl.mock.calls.map(([, init]) => init!.method)).toEqual(['POST', 'GET']);
    expect(fetchImpl.mock.calls[1]![0]).toBe(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${await googleEventId(key)}`);
  });
  it('does not treat a reconciliation 404 as permission to send the insert again', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('unknown'))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(client(fetchImpl).createEvent(draft, { idempotencyKey: key })).rejects.toMatchObject({
      code: 'google_write_outcome_unknown', outcomeUnknown: true, retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects a redirected read without following it or marking a write uncertain', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302,
      headers: { location: 'https://redirect-target.invalid/do-not-follow' } }));
    await expect(client(fetchImpl).getEvent(await googleEventId(key)))
      .rejects.toMatchObject({ code: 'google_request_rejected', outcomeUnknown: false, status: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe('manual');
  });
  it('rejects an existing deterministic ID with different exact content', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(await event({ summary: 'Changed elsewhere' })));
    await expect(client(fetchImpl).reconcileCreate(draft, key)).rejects.toMatchObject({ code: 'google_reconciliation_conflict', outcomeUnknown: true });
    expect(fetchImpl.mock.calls[0]![1]!.method).toBe('GET');
  });
  it('reconciles explicitly with GET only', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(await event()));
    expect((await client(fetchImpl).reconcileCreate(draft, key))!.managed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fetchImpl.mock.calls[0]![1]!.method).toBe('GET');
  });
  it('requires the caller ownership fence after preparation and before any write', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(client(fetchImpl, { beforeWrite: async () => { throw new Error('SECRET_TENANT_STATE'); } })
      .createEvent(draft, { idempotencyKey: key })).rejects.toMatchObject({ code: 'google_authorization_changed', outcomeUnknown: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reserves part of one bounded deadline to reconcile a stalled insert', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(() => {}));
    fetchImpl.mockResolvedValueOnce(Response.json(await event()));
    expect(await client(fetchImpl, { timeoutMs: 50 }).createEvent(draft, { idempotencyKey: key })).toMatchObject({ reconciled: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it('does not reconcile or retry a definitive authorization rejection', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('SECRET', { status: 401 }));
    await expect(client(fetchImpl).createEvent(draft, { idempotencyKey: key }))
      .rejects.toMatchObject({ code: 'google_authorization_failed', outcomeUnknown: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...draft, startsAt: '2030-06-01T10:00:00' }, { ...draft, startsAt: '2030-02-30T10:00:00Z' },
    { ...draft, startsAt: '2030-06-01T10:00:00-00:00' }, { ...draft, durationMinutes: 481 }, { ...draft, title: 'x'.repeat(201) },
    { ...draft, attendees: [{ email: 'private@example.com' }] }, { ...draft, description: 'unapproved' }])
    ('rejects an ambiguous or overbroad write before HTTP %#', async (value) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(client(fetchImpl).createEvent(value, { idempotencyKey: key })).rejects.toMatchObject({ code: 'google_draft_invalid' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  it.each(['https://untrusted.example/steal', '../private', 'tiny', 'event?token=secret'])('rejects arbitrary event paths %s', async (id) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(client(fetchImpl).getEvent(id)).rejects.toBeInstanceOf(GoogleCalendarError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('lists one bounded page, including all-day events, without automatically fetching another page', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ items: [await event(), {
      id: 'ordinary123', etag: '"all-day-version"', status: 'confirmed', summary: 'All-day fixture',
      start: { date: '2030-06-02' }, end: { date: '2030-06-03' }, organizer: { self: true },
    }], nextPageToken: 'next_fixture_page' }));
    const page = await client(fetchImpl).listEvents({ timeMin: '2030-06-01T00:00:00Z', timeMax: '2030-06-10T00:00:00Z', maxResults: 2 });
    expect(page.events).toHaveLength(2); expect(page.nextPageToken).toBe('next_fixture_page');
    expect(page.events[1]).toMatchObject({ start: { date: '2030-06-02' }, managed: false });
    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(url.searchParams.get('maxResults')).toBe('2'); expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('showDeleted')).toBe('false'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([{ timeMin: '2030-06-01T00:00:00Z', timeMax: '2030-08-01T00:00:00Z' },
    { timeMin: '2030-06-02T00:00:00Z', timeMax: '2030-06-01T00:00:00Z' },
    { timeMin: '2030-06-01T00:00:00Z', timeMax: '2030-06-02T00:00:00Z', maxResults: 21 },
    { timeMin: '2030-06-01T00:00:00Z', timeMax: '2030-06-02T00:00:00Z', calendarId: 'another-user' }])
    ('rejects unbounded or unscoped lists before HTTP %#', async (value) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(client(fetchImpl).listEvents(value)).rejects.toMatchObject({ code: 'google_list_invalid' }); expect(fetchImpl).not.toHaveBeenCalled();
    });
  it('gets and conditionally updates only a current Plause-managed event', async () => {
    const initial = await event(); const updated = await event({ summary: 'An approved new title', etag: '"fixture-version-2"' });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(initial)).mockResolvedValueOnce(Response.json(updated));
    const beforeWrite = vi.fn(async () => {});
    const result = await client(fetchImpl, { beforeWrite }).updateEvent(initial.id as string, { ...draft, title: 'An approved new title' }, { etag: initial.etag as string });
    expect(result.etag).toBe('"fixture-version-2"'); expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.map(([, init]) => init!.method)).toEqual(['GET', 'PUT']);
    expect(fetchImpl.mock.calls[1]![1]!.headers).toMatchObject({ 'if-match': initial.etag });
    expect(fetchImpl.mock.calls[1]![0]).toContain('sendUpdates=none');
  });
  it.each([{ attendees: [{ email: 'never-invite@example.com' }] }, { description: 'User-authored information to retain' },
    { etag: '"changed-version"' }, { extendedProperties: { private: { plauseOperationId: 'foreign' } } }])
    ('refuses unsafe or stale update without a write %#', async (patch) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(await event(patch)));
      await expect(client(fetchImpl).updateEvent(await googleEventId(key), draft, { etag: '"fixture-version-1"' })).rejects.toBeInstanceOf(GoogleCalendarError);
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fetchImpl.mock.calls[0]![1]!.method).toBe('GET');
    });
  it('does not retry an etag conflict or a possibly applied update', async () => {
    for (const status of [302, 412, 500]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(await event())).mockResolvedValueOnce(new Response('SECRET', { status }));
      await expect(client(fetchImpl).updateEvent(await googleEventId(key), draft, { etag: '"fixture-version-1"' }))
        .rejects.toMatchObject({ outcomeUnknown: status !== 412, retryable: false });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });
  it('bounds read response streams and does not expose provider content', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('SECRET'.repeat(25_000)));
    await expect(client(fetchImpl).getEvent(await googleEventId(key))).rejects.toMatchObject({ code: 'google_response_too_large', outcomeUnknown: false });
  });
  it('aborts a stalled body under the same deadline, and respects prior cancellation', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start() {} })));
    await expect(client(fetchImpl, { timeoutMs: 10 }).getEvent(await googleEventId(key))).rejects.toMatchObject({ code: 'google_timeout' });
    const cancelled = new AbortController(); cancelled.abort('private reason');
    const untouched = vi.fn<typeof fetch>();
    await expect(client(untouched).getEvent(await googleEventId(key), cancelled.signal)).rejects.toMatchObject({ code: 'google_cancelled' });
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe('Google OAuth fixed-scope transport seam', () => {
  const oauthOptions = { clientId: 'synthetic-client.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret',
    redirectUri: 'http://localhost:8787/api/calendar/google/callback' };
  const tokenFixture = { access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600,
    scope: GOOGLE_CALENDAR_SCOPE, token_type: 'Bearer' };
  it('builds a fixed authorization URL with exact scope, state and S256 without exposing the secret', () => {
    const client = new GoogleOAuthClient(oauthOptions);
    const url = new URL(client.authorizationUrl({ state: 's'.repeat(43), codeChallenge: 'c'.repeat(43) }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPE);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false'); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('s'.repeat(43)); expect(url.href).not.toContain(oauthOptions.clientSecret);
  });
  it('exchanges codes and refreshes once against the fixed token endpoint, then revokes using a form body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(tokenFixture)).mockResolvedValueOnce(Response.json(tokenFixture))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new GoogleOAuthClient({ ...oauthOptions, fetchImpl });
    expect(await client.exchangeAuthorizationCode('synthetic-code', 'v'.repeat(43))).toEqual({ accessToken: tokenFixture.access_token,
      refreshToken: tokenFixture.refresh_token, scope: GOOGLE_CALENDAR_SCOPE, expiresIn: 3600 });
    await client.refreshAccessToken(tokenFixture.refresh_token); await client.revokeToken(tokenFixture.refresh_token);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/revoke']);
    const exchange = new URLSearchParams(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(exchange.get('code_verifier')).toBe('v'.repeat(43)); expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('redirect_uri')).toBe(oauthOptions.redirectUri);
    expect(new URLSearchParams(fetchImpl.mock.calls[1]![1]!.body as string).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(fetchImpl.mock.calls[2]![1]!.body as string).get('token')).toBe(tokenFixture.refresh_token);
    fetchImpl.mock.calls.forEach(([, init]) => expect(init).toMatchObject({ method: 'POST', redirect: 'manual' }));
  });
  it.each([{ ...tokenFixture, scope: `${GOOGLE_CALENDAR_SCOPE} https://www.googleapis.com/auth/drive` },
    { ...tokenFixture, scope: 'https://www.googleapis.com/auth/calendar' }, { ...tokenFixture, token_type: 'Other' },
    { ...tokenFixture, expires_in: 0 }, { ...tokenFixture, access_token: 'bad\nheader' }])
    ('rejects overbroad or malformed grants without another token request %#', async (value) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(value));
      await expect(new GoogleOAuthClient({ ...oauthOptions, fetchImpl }).exchangeAuthorizationCode('synthetic-code', 'v'.repeat(43)))
        .rejects.toMatchObject({ code: 'google_token_response_invalid' }); expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  it('never retries token errors or exposes provider bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('SECRET_REFRESH_TOKEN', { status: 400 }));
    const result = await new GoogleOAuthClient({ ...oauthOptions, fetchImpl }).refreshAccessToken('synthetic-refresh-token').catch((cause: unknown) => cause);
    expect(result).toBeInstanceOf(GoogleCalendarError); expect(String(result)).not.toContain('SECRET'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not follow or retry a redirected token exchange and preserves its unknown outcome', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302,
      headers: { location: 'https://redirect-target.invalid/do-not-follow' } }));
    await expect(new GoogleOAuthClient({ ...oauthOptions, fetchImpl }).exchangeAuthorizationCode('synthetic-code', 'v'.repeat(43)))
      .rejects.toMatchObject({ code: 'google_request_rejected', outcomeUnknown: true, status: 302, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe('manual');
  });
  it.each(['http://untrusted.example/callback', 'https://user:secret@example.com/callback', 'https://example.com/callback?token=secret'])
    ('rejects an unsafe configured redirect %s', (redirectUri) => expect(() => new GoogleOAuthClient({ ...oauthOptions, redirectUri })).toThrow(GoogleCalendarError));
});
