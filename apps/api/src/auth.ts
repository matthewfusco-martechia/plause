import type { Env } from '../../../packages/contracts/src/index';
import { randomToken, sha256 } from '../../../packages/security/src/index';

export type User = { id: string; displayName: string };
export interface SessionProof {
  user: User; tokenHash: string; authMethod: 'development_invitation' | 'google';
  authenticatedAt: number; identityId: string | null; expiresAt: number;
  identity: { issuer: string; subject: string } | null;
}
const COOKIE = 'plause_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const operational = "NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')";

export async function login(env: Env, inviteToken: string): Promise<{ user: User; token: string } | null> {
  if (env.APP_ENV !== 'local') return null;
  const hash = await sha256(inviteToken);
  const row = await env.DB.prepare(`SELECT u.id, u.display_name FROM invitations i
    JOIN users u ON u.id = i.user_id WHERE i.token_hash = ? AND u.status = 'active'`)
    .bind(hash).first<{ id: string; display_name: string }>();
  if (!row) return null;
  const token = randomToken();
  const inserted = await env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,authenticated_at)
    SELECT ?,id,?,'development_invitation',? FROM users WHERE id=? AND status='active' AND ${operational}`)
    .bind(await sha256(token), Date.now() + SESSION_MS, Date.now(), row.id).run();
  return inserted.meta.changes === 1 ? { user: { id: row.id, displayName: row.display_name }, token } : null;
}

export function sessionToken(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';').map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${COOKIE}=`)).map((entry) => entry.slice(COOKIE.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{32,200}$/.test(values[0]!) ? values[0]! : null;
}

export async function getSessionProof(env: Env, request: Request): Promise<SessionProof | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(`SELECT u.id,u.display_name,s.auth_method,s.authenticated_at,s.identity_id,s.expires_at,e.issuer,e.subject FROM sessions s
    JOIN users u ON u.id=s.user_id LEFT JOIN external_identities e ON e.id=s.identity_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
    AND ((s.auth_method='development_invitation' AND ?='local') OR (s.auth_method='google' AND e.user_id=u.id))`)
    .bind(hash, Date.now(), env.APP_ENV).first<{ id: string; display_name: string; auth_method: SessionProof['authMethod']; authenticated_at: number; identity_id: string | null; expires_at: number; issuer: string | null; subject: string | null }>();
  return row ? { user: { id: row.id, displayName: row.display_name }, tokenHash: hash, authMethod: row.auth_method,
    authenticatedAt: row.authenticated_at, identityId: row.identity_id, expiresAt: row.expires_at,
    identity: row.issuer && row.subject ? { issuer: row.issuer, subject: row.subject } : null } : null;
}

export async function currentUser(env: Env, request: Request): Promise<User | null> {
  return (await getSessionProof(env, request))?.user ?? null;
}

export async function requireRecentIdentitySession(env: Env, request: Request, userId?: string): Promise<SessionProof> {
  const proof = await getSessionProof(env, request);
  const identityConfirmed = proof?.authMethod === 'google' && !!proof.identityId;
  const localFixture = env.APP_ENV === 'local' && proof?.authMethod === 'development_invitation';
  if (!proof || (!identityConfirmed && !localFixture) || (userId !== undefined && proof.user.id !== userId)
    || proof.authenticatedAt > Date.now() + 30_000 || proof.authenticatedAt < Date.now() - 5 * 60_000) {
    const error = new Error('Recent account confirmation required.') as Error & { status: number; code: string };
    error.status = 401; error.code = 'identity_reauthentication_required'; throw error;
  }
  return proof;
}

export async function logout(env: Env, request: Request): Promise<void> {
  const token = sessionToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export function sessionCookie(request: Request, token: string, clear = false): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure}`;
}
