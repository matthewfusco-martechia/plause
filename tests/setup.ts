import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import type { Env } from '../packages/contracts/src/index';
import { sha256 } from '../packages/security/src/index';

export const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
export const inviteAlex = 'alex-test-invitation-with-at-least-32-characters';
export const inviteSam = 'sam-test-invitation-with-at-least-32-characters';

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network access is disabled in automated tests.'); }));
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM model_attempts'),
    testEnv.DB.prepare('DELETE FROM search_attempts'),
    testEnv.DB.prepare('DELETE FROM google_calendar_requests'),
    testEnv.DB.prepare('DELETE FROM privacy_operations'),
    testEnv.DB.prepare('DELETE FROM messaging_onboarding_notices'),
    testEnv.DB.prepare('DELETE FROM messaging_onboarding_events'),
    testEnv.DB.prepare('DELETE FROM messaging_onboarding_contacts'),
    testEnv.DB.prepare('DELETE FROM messaging_onboarding_subjects'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare('DELETE FROM identity_erasures'),
    testEnv.DB.prepare('DELETE FROM mock_receipts'),
    testEnv.DB.prepare('DELETE FROM system_settings'),
    testEnv.DB.prepare('DELETE FROM runtime_rate_buckets'),
    testEnv.DB.prepare('DELETE FROM provider_circuits'),
  ]);
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT OR IGNORE INTO users(id,display_name,status,created_at) VALUES ('u_alex','Alex','active',0),('u_sam','Sam','active',0)"),
    testEnv.DB.prepare("INSERT OR IGNORE INTO bindings(provider,business_id,subject_id,user_id,channel) VALUES ('mock','plause-local','mock-alex','u_alex','mock'),('mock','plause-local','mock-sam','u_sam','mock')"),
    testEnv.DB.prepare("INSERT OR IGNORE INTO invitations(token_hash,user_id) VALUES (?,'u_alex'),(?,'u_sam')").bind(await sha256(inviteAlex), await sha256(inviteSam)),
  ]);
});
afterEach(() => { vi.unstubAllGlobals(); });
