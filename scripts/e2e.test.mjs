import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { E2EError, eventually, IsolatedHarness, readBoundedText, redact } from '../tests/e2e/harness.mjs';
import { fixtureSql, makeFixtures, signedEvent } from '../tests/e2e/fixtures.mjs';

test('redacts overlapping generated secrets longest first', () => {
  assert.equal(redact('token123 token', new Set(['token', 'token123'])), '[redacted] [redacted]');
});
test('polls only an explicit read condition and preserves errors', async () => {
  let calls = 0;
  assert.equal(await eventually(async () => ++calls === 2 ? 'ready' : null, { interval: 1 }), 'ready');
  await assert.rejects(eventually(async () => { throw new E2EError('EXPECTED_FAILURE'); }), { code: 'EXPECTED_FAILURE' });
});
test('bounds unmet conditions', async () => {
  await assert.rejects(eventually(async () => null, { timeout: 1, interval: 1, label: 'fixture' }), { code: 'E2E_DEADLINE' });
});
test('bounds streamed API bodies and surfaces partial network failures', async () => {
  assert.equal(await readBoundedText(new Response('Fictional body'), 20), 'Fictional body');
  await assert.rejects(readBoundedText(new Response('too many bytes'), 3), { code: 'E2E_RESPONSE_TOO_LARGE' });
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); controller.error(new Error('fixture stream failure')); } });
  await assert.rejects(readBoundedText(new Response(body)), /fixture stream failure/);
});
test('fixtures are fictional, independently generated and signed without source credentials', () => {
  const first = makeFixtures(), second = makeFixtures();
  assert.notEqual(first.contentKey, second.contentKey);
  assert.notEqual(first.accounts.primary.inviteToken, second.accounts.primary.inviteToken);
  assert.match(fixtureSql(first), /INSERT INTO users/);
  const event = signedEvent(first, first.accounts.primary, 'Fictional test');
  assert.equal(typeof event.raw, 'string');
  assert.match(event.signature, /^t=\d+,v1=[0-9a-f]{64}$/);
});
test('requests reject external and protocol-relative URLs before network access', async () => {
  const harness = new IsolatedHarness(); harness.base = 'http://127.0.0.1:1';
  await assert.rejects(harness.request('https://example.invalid'), { code: 'E2E_UNSAFE_URL' });
  await assert.rejects(harness.request('//example.invalid'), { code: 'E2E_UNSAFE_URL' });
});
test('provider guard rejects a live model or provider key', () => {
  const harness = new IsolatedHarness();
  harness.workerVars = { APP_ENV: 'local', MODEL_PROVIDER: 'mock', MESSAGING_PROVIDER: 'mock', LIVE_MODEL_ENABLED: 'false',
    LIVE_SEARCH_ENABLED: 'false', SEARCH_PROVIDER: 'disabled', LIVE_GOOGLE_CALENDAR_ENABLED: 'false',
    AUTH_GOOGLE_ENABLED: 'false', AUTH_SIGNUP_ENABLED: 'false', LIVE_MESSAGING_ENABLED: 'false', APPLE_CHANNEL_APPROVED: 'false', APPLE_PROACTIVE_ENABLED: 'false',
    OPENAI_API_KEY: '', TAVILY_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', AUTH_GOOGLE_CLIENT_ID: '', AUTH_GOOGLE_CLIENT_SECRET: '' };
  harness.assertOfflineConfiguration();
  harness.workerVars.OPENAI_API_KEY = 'fictional';
  assert.throws(() => harness.assertOfflineConfiguration());
});
test('console literal DOM targets exist and static IDs are unique', async () => {
  const html = await readFile(new URL('../apps/api/public/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../apps/api/public/app.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const generated = [...js.matchAll(/\.id\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
  const available = new Set([...ids, ...generated]);
  for (const match of js.matchAll(/element\("([^"]+)"\)/g)) assert.ok(available.has(match[1]), `Missing DOM target ${match[1]}`);
  for (const match of html.matchAll(/\bfor="([^"]+)"/g)) assert.ok(available.has(match[1]), `Missing label target ${match[1]}`);
});
test('console renders API text safely without persisted credentials or HTML injection', async () => {
  const js = await readFile(new URL('../apps/api/public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage)\s*(?:\.|\(|=)/);
  assert.match(js, /textContent\s*=/);
  assert.match(js, /outcome\?\.pending/);
  assert.match(js, /credentials:\s*"same-origin"/);
});
test('console copy scopes simulated reminders and demo controls to the mock provider', async () => {
  const js = await readFile(new URL('../apps/api/public/app.js', import.meta.url), 'utf8');
  const source = js.match(/^function messagingCopy\(health\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(source);
  // Evaluate a pure copy function only. No browser, DOM or HTML rendering.
  const copy = vm.runInNewContext(`(${source})`);
  assert.equal(copy({ messaging: 'mock' }).demoEnabled, true);
  assert.match(copy({ messaging: 'mock' }).reminderDelivery, /simulated/);
  for (const messaging of ['web', 'sunshine']) {
    const cloud = copy({ messaging });
    assert.equal(cloud.demoEnabled, false);
    assert.doesNotMatch(cloud.reminderIntro + cloud.reminderDelivery, /simulat|durable local|not connected/i);
  }
  assert.equal(copy(null).demoEnabled, false);
  assert.match(js, /if \(copy\.demoEnabled\) \{/);
});
test('console self-resume requires a confirmed local environment and paused conversation', async () => {
  const js = await readFile(new URL('../apps/api/public/app.js', import.meta.url), 'utf8');
  const source = js.match(/^function handoffControls\(health, mode, busy = false\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(source);
  const controls = vm.runInNewContext(`(${source})`);
  assert.equal(controls({ environment: 'local' }, 'human').showResume, true);
  assert.equal(controls({ environment: 'local' }, 'human').resumeDisabled, false);
  assert.equal(controls({ environment: 'local' }, 'human', true).resumeDisabled, true);
  assert.equal(controls({ environment: 'local' }, 'bot').showResume, false);
  for (const environment of ['staging', 'production']) {
    const cloud = controls({ environment, model: 'mock', messaging: 'mock' }, 'human');
    assert.equal(cloud.showResume, false); assert.equal(cloud.resumeDisabled, true);
    assert.match(cloud.notice, /authorized staff member must resume/);
  }
  for (const health of [null, {}, { environment: 'LOCAL' }]) {
    const unknown = controls(health, 'human');
    assert.equal(unknown.showResume, false); assert.equal(unknown.resumeDisabled, true);
    assert.match(unknown.notice, /environment is confirmed/);
  }
});
test('console rejects stale self-resume actions before any cloud API request', async () => {
  const js = await readFile(new URL('../apps/api/public/app.js', import.meta.url), 'utf8');
  const policy = js.match(/^function handoffControls\(health, mode, busy = false\) \{[\s\S]*?^\}/m)?.[0];
  const action = js.match(/^async function setMode\(mode\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(policy && action);
  for (const health of [{ environment: 'staging' }, { environment: 'production' }, null]) {
    let requests = 0, notice = '';
    const state = { session: { conversationId: 'fictional-conversation' }, handoffBusy: false, health, conversation: { mode: 'human' } };
    // Execute the request guard only: no browser, DOM or HTML rendering.
    const setMode = vm.runInNewContext(`${policy}\n(${action})`, {
      state, feedback: (text) => { notice = text; }, api: () => { requests++; },
      element: () => { throw new Error('Blocked action must not touch UI controls.'); },
    });
    await setMode('bot');
    assert.equal(requests, 0); assert.equal(state.handoffBusy, false); assert.ok(notice);
  }
});
test('account confirmation follows the verified session method independently of environment', async () => {
  const js = await readFile(new URL('../apps/api/public/app.js', import.meta.url), 'utf8');
  const source = js.match(/^function invitationSession\(session\) \{[^\n]+\}/m)?.[0];
  assert.ok(source);
  const invitation = vm.runInNewContext(`(${source})`);
  assert.equal(invitation({ authentication: 'development_invitation' }), true);
  assert.equal(invitation({ authentication: 'google', environment: 'local' }), false);
  assert.equal(invitation({ environment: 'local' }), false);
  assert.equal(invitation(null), false);
});
test('Messages entry only navigates to account controls for the exact public intent', async () => {
  const js = await readFile(new URL('../apps/api/public/app.js', import.meta.url), 'utf8');
  const source = js.match(/^function messagesEntryContext\(search\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(source);
  const entry = vm.runInNewContext(`(${source})`, { URLSearchParams });
  assert.equal(entry('?onboarding=messages'), true);
  assert.equal(entry('?onboarding=messages&signin=complete'), true);
  for (const search of ['', '?onboarding=other', '?onboarding=messages&onboarding=other', '?next=https://untrusted.invalid', '?onboarding=messages%26next%3Dhttps://untrusted.invalid']) {
    assert.equal(entry(search), false);
  }
});
