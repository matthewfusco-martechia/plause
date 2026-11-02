import { assertOperational } from './runtime-operations';
import type { Env } from '../../../packages/contracts/src/index';
import { decryptText, randomToken, sha256 } from '../../../packages/security/src/index';
import { PipelineError } from './store';
import { listMemoriesForUser } from './memory-store';
import { listRemindersForUser } from './reminder-store';
import { listActionsForUser } from './action-store';
import { getGoogleConnection } from './google-oauth';
import { listGoogleCalendarActions } from './google-calendar';
import { requireRecentIdentitySession } from './auth';
import { requestErasure } from './privacy-ledger';

export async function getAccountSummary(env: Env, userId: string) {
  const row = await env.DB.prepare(`SELECT id,display_name,created_at,
    (SELECT COUNT(*) FROM conversations WHERE user_id=u.id) AS conversations,
    (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=u.id) AS messages,
    (SELECT COUNT(*) FROM memories WHERE user_id=u.id) AS memories,
    (SELECT COUNT(*) FROM reminders WHERE user_id=u.id AND status='active') AS active_reminders,
    ((SELECT COUNT(*) FROM action_approvals WHERE user_id=u.id AND state='pending' AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
      +(SELECT COUNT(*) FROM google_calendar_approvals WHERE user_id=u.id AND state='pending' AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) AS pending_approvals
    FROM users u WHERE id=? AND status='active'`).bind(userId)
    .first<{ id: string; display_name: string; created_at: number; conversations: number; messages: number; memories: number; active_reminders: number; pending_approvals: number }>();
  if (!row) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  return { user: { id: row.id, displayName: row.display_name, createdAt: row.created_at }, counts: {
    conversations: row.conversations, messages: row.messages, memories: row.memories,
    activeReminders: row.active_reminders, pendingApprovals: row.pending_approvals },
    environment: env.APP_ENV, authentication: await env.DB.prepare('SELECT 1 FROM external_identities WHERE user_id=?').bind(userId).first() ? 'google' : 'development_invitation',
    appleConnected: !!await env.DB.prepare("SELECT 1 FROM bindings WHERE user_id=? AND provider='sunshine' AND channel='apple_business' AND status='active'").bind(userId).first() };
}

/** Bounded transcript pages. A first page also contains current personal-control snapshots. */
export async function exportAccountPage(env: Env, userId: string, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0) throw new PipelineError('Invalid cursor.', 400, 'invalid_cursor');
  const revision = await env.DB.prepare("SELECT context_revision,google_calendar_revision FROM users WHERE id=? AND status='active'")
    .bind(userId).first<{ context_revision: number; google_calendar_revision: number }>();
  if (!revision) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  const account = await getAccountSummary(env, userId);
  const rows = await env.DB.prepare(`SELECT m.rowid AS cursor,m.id,m.conversation_id,m.role,m.body_ciphertext,m.status,m.created_at,m.model
    FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=c.user_id
    WHERE c.user_id=? AND u.status='active' AND m.rowid>? ORDER BY m.rowid LIMIT 101`).bind(userId, after)
    .all<{ cursor: number; id: string; conversation_id: string; role: string; body_ciphertext: string; status: string; created_at: number; model: string }>();
  const page = rows.results.slice(0, 100);
  const messages = await Promise.all(page.map(async (row) => ({ id: row.id, conversationId: row.conversation_id,
    role: row.role, text: await decryptText(row.body_ciphertext, env.CONTENT_ENCRYPTION_KEY), status: row.status, createdAt: row.created_at, model: row.model })));
  const controls = after === 0 ? { memory: await listMemoriesForUser(env, userId), reminders: await listRemindersForUser(env, userId), actions: await listActionsForUser(env, userId),
    googleCalendar: { connection: await getGoogleConnection(env, userId), ...await listGoogleCalendarActions(env, userId) } } : undefined;
  await assertOperational(env);
  const stillActive = await env.DB.prepare("SELECT context_revision,google_calendar_revision FROM users WHERE id=? AND status='active'")
    .bind(userId).first<{ context_revision: number; google_calendar_revision: number }>();
  if (!stillActive) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  if (stillActive.context_revision !== revision.context_revision || stillActive.google_calendar_revision !== revision.google_calendar_revision) {
    throw new PipelineError('Account privacy changed during export. Start a new export.', 409, 'account_export_changed');
  }
  return { version: 1, exportedAt: new Date().toISOString(), account, ...(controls ? { controls } : {}), messages,
    nextCursor: rows.results.length > 100 ? page.at(-1)!.cursor : null,
    snapshot: 'Paginated live export. Changes made during export can affect later pages. Credentials and billing tombstones are excluded.' };
}

/** Re-authentication and an exact destructive phrase precede the single-use erasure token. */
export async function createDeletionIntent(env: Env, userId: string, inviteToken: string, confirmation: string) {
  if (env.APP_ENV !== 'local') throw new PipelineError('Fresh verified sign-in required.', 401, 'reauthentication_required');
  if (confirmation !== 'DELETE MY PLAUSE ACCOUNT') throw new PipelineError('Exact confirmation required.', 400, 'deletion_confirmation_required');
  const invitation = await env.DB.prepare(`SELECT i.user_id FROM invitations i JOIN users u ON u.id=i.user_id
    WHERE i.token_hash=? AND i.user_id=? AND u.status='active'`).bind(await sha256(inviteToken), userId).first();
  if (!invitation) throw new PipelineError('Reauthentication failed.', 401, 'reauthentication_required');
  return issueDeletionIntent(env, userId);
}

export async function createSessionDeletionIntent(env: Env, request: Request, userId: string, confirmation: string) {
  if (confirmation !== 'DELETE MY PLAUSE ACCOUNT') throw new PipelineError('Exact confirmation required.', 400, 'deletion_confirmation_required');
  await requireRecentIdentitySession(env, request, userId);
  return issueDeletionIntent(env, userId);
}

async function issueDeletionIntent(env: Env, userId: string) {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + 5 * 60_000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_deletion_intents WHERE user_id=? OR expires_at<=?').bind(userId, now),
    env.DB.prepare(`INSERT INTO account_deletion_intents(token_hash,user_id,expires_at,created_at)
      SELECT ?,id,?,? FROM users WHERE id=? AND status='active'`).bind(await sha256(token), expiresAt, now, userId),
  ]);
  return { confirmationToken: token, expiresAt,
    effect: 'Permanently erase this account, transcripts, saved facts, reminders, simulated calendars, approvals, access credentials and messaging onboarding routing. Retain minimal messaging replay and uncertain-send records, billing and request quota metadata, possible-charge holds and an independent erasure record. Deletion cannot revoke a Google provider grant, erase real calendar events or recall delivered messages and exported files. Disconnect Google first or revoke its grant in Google settings.' };
}

export async function eraseAccount(env: Env, userId: string, token: string): Promise<boolean> {
  return (await requestErasure(env, userId, token)).deleted;
}
