import type { Env } from './index';

export type RuntimeEnvironment = 'local' | 'staging' | 'production';
export class RuntimePolicyError extends Error {
  readonly status = 503;
  constructor(public readonly code: string) { super(code); }
}

/** Deployment configuration is trusted input, but must still fail closed. */
export function runtimeEnvironment(env: Env): RuntimeEnvironment {
  if (!['local', 'staging', 'production'].includes(env.APP_ENV)) throw new RuntimePolicyError('environment_not_configured');
  return env.APP_ENV as RuntimeEnvironment;
}
export function publicOrigin(env: Env): string {
  const mode = runtimeEnvironment(env);
  if (!env.PUBLIC_ORIGIN) {
    if (mode === 'local') return 'http://localhost:8787';
    throw new RuntimePolicyError('public_origin_missing');
  }
  let url: URL;
  try { url = new URL(env.PUBLIC_ORIGIN); } catch { throw new RuntimePolicyError('public_origin_invalid'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== env.PUBLIC_ORIGIN || url.username || url.password || url.search || url.hash
    || (mode === 'local' ? !loopback || !['http:', 'https:'].includes(url.protocol)
      : url.protocol !== 'https:' || loopback || !url.hostname.includes('.'))) throw new RuntimePolicyError('public_origin_invalid');
  return url.origin;
}
export function requestAllowed(env: Env, request: Request): boolean {
  const mode = runtimeEnvironment(env);
  const url = new URL(request.url);
  return mode === 'local' ? ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) : url.origin === publicOrigin(env);
}
export function assertRuntimeProviders(env: Env): void {
  const mode = runtimeEnvironment(env);
  if (!['mock', 'openai'].includes(env.MODEL_PROVIDER) || !['mock', 'web', 'sunshine'].includes(env.MESSAGING_PROVIDER)) {
    throw new RuntimePolicyError('provider_not_configured');
  }
  if (mode === 'production' && (env.MODEL_PROVIDER !== 'openai' || env.MESSAGING_PROVIDER === 'mock')) {
    throw new RuntimePolicyError('production_provider_required');
  }
  if (mode !== 'local') publicOrigin(env);
  if (env.MESSAGING_PROVIDER === 'sunshine' && (env.LIVE_MESSAGING_ENABLED !== 'true' || env.APPLE_CHANNEL_APPROVED !== 'true')) {
    throw new RuntimePolicyError('apple_channel_not_enabled');
  }
}
export function mockMessagingAllowed(env: Env): boolean {
  return ['local', 'staging'].includes(runtimeEnvironment(env)) && env.MESSAGING_PROVIDER === 'mock';
}
/** Customer consent and actual channel approval are additional dispatch gates. */
export function proactiveChannelAllowed(env: Env, channel: string): boolean {
  return channel === 'web' || channel === 'mock' && mockMessagingAllowed(env)
    || channel === 'apple_business' && env.MESSAGING_PROVIDER === 'sunshine' && env.LIVE_MESSAGING_ENABLED === 'true'
      && env.APPLE_CHANNEL_APPROVED === 'true' && env.APPLE_PROACTIVE_ENABLED === 'true';
}
export function replyChannelAllowed(env: Env, channel: string): boolean {
  return channel === 'web' || channel === 'mock' && mockMessagingAllowed(env)
    || channel === 'apple_business' && env.MESSAGING_PROVIDER === 'sunshine'
      && env.LIVE_MESSAGING_ENABLED === 'true' && env.APPLE_CHANNEL_APPROVED === 'true';
}
export function appleEntryUrl(env: Env): string | null {
  return replyChannelAllowed(env, 'apple_business') && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.APPLE_BUSINESS_ID ?? '')
    ? `https://bcrw.apple.com/urn:biz:${env.APPLE_BUSINESS_ID}` : null;
}
