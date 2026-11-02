import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const fakeKey = 'sk-fictional-native-fetch-fixture-not-real';

for (const redirectPath of [null, '/v1/responses/input_tokens', '/v1/responses']) {
test(redirectPath ? `native Workers rejects ${redirectPath} redirects without following them`
  : 'default OpenAI fetch uses the native Workers receiver and only intercepted endpoints', { timeout: 60_000 }, async (t) => {
  const bundled = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, sourcefile: 'native-fetch-fixture.ts', contents: `
      import { OpenAIModelProvider } from './packages/models-openai/src/index.ts';
      export default {
        async fetch() {
          let nativeControlPassed = false;
          const control = await fetch('https://api.openai.com/v1/responses/input_tokens', {
            method: 'POST', headers: { authorization: ${JSON.stringify(`Bearer ${fakeKey}`)}, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-6-luna', input: 'Native fetch positive control.' }),
          });
          nativeControlPassed = control.status === 200 && (await control.json()).input_tokens === 100;
          try {
            const provider = new OpenAIModelProvider({
              apiKey: ${JSON.stringify(fakeKey)}, model: 'gpt-6-luna',
              maxInputTokens: 4096, maxOutputTokens: 600, timeoutMs: 2000,
            });
            const result = await provider.generate({ text: 'Acknowledge this fictional fixture briefly.', history: [] });
            return Response.json({ result, nativeControlPassed });
          } catch (error) {
            return Response.json({ code: error?.code ?? 'unexpected_error', chargePossible: error?.chargePossible,
              nativeControlPassed }, { status: 500 });
          }
        },
      };
    ` },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  const intercepted = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-10-30',
    cf: false,
    // All outbound traffic terminates here; unmatched traffic never reaches a network.
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://api.openai.com');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('authorization'), `Bearer ${fakeKey}`);
      const body = await request.json();
      intercepted.push({ path: url.pathname, body });
      if (url.pathname === redirectPath && body.input !== 'Native fetch positive control.') {
        return new Response(null, { status: 302, headers: { location: 'https://redirect-target.invalid/do-not-follow' } });
      }
      const value = url.pathname === '/v1/responses/input_tokens'
        ? { object: 'response.input_tokens', input_tokens: 100 }
        : url.pathname === '/v1/responses'
          ? { object: 'response', id: 'resp_native_fixture', model: 'gpt-6-luna', status: 'completed', service_tier: 'default',
            error: null, incomplete_details: null,
            output: [{ type: 'message', id: 'msg_native_fixture', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'Fixture acknowledged.', annotations: [] }] }],
            usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 } }
          : assert.fail('Unexpected outbound endpoint.');
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    },
  }));
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch('http://fixture.invalid/');
  const body = await response.json();
  assert.equal(body.nativeControlPassed, true, 'Bare native fetch must reach the local outbound interceptor.');
  if (redirectPath) {
    assert.equal(response.status, 500);
    assert.equal(body.code, 'model_request_rejected');
    assert.equal(body.chargePossible, redirectPath === '/v1/responses');
    assert.deepEqual(intercepted.map(({ path }) => path), redirectPath.endsWith('/input_tokens')
      ? ['/v1/responses/input_tokens', '/v1/responses/input_tokens']
      : ['/v1/responses/input_tokens', '/v1/responses/input_tokens', '/v1/responses']);
    return;
  }
  assert.equal(response.status, 200, JSON.stringify({ status: response.status, code: body.code, intercepted: intercepted.length,
    nativeControlPassed: body.nativeControlPassed }));
  assert.deepEqual(body.result, { text: 'Fixture acknowledged.', inputTokens: 100, outputTokens: 7,
    model: 'gpt-6-luna', responseId: 'resp_native_fixture' });
  assert.deepEqual(intercepted.map(({ path }) => path), ['/v1/responses/input_tokens', '/v1/responses/input_tokens', '/v1/responses']);
  assert.deepEqual(intercepted[2].body, { ...intercepted[1].body, store: false, stream: false,
    service_tier: 'default', max_output_tokens: 600 });
});
}
