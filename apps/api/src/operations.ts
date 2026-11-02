import type { Env } from '../../../packages/contracts/src/index';
import { hostedPolicy } from './model-runtime';
import { PipelineError } from './store';
import { researchDailyLimit } from './research';

export async function getUserUsage(env: Env, userId: string) {
  if (!await env.DB.prepare("SELECT id FROM users WHERE id=? AND status='active'").bind(userId).first()) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  const now = Date.now();
  const month = new Date(now).toISOString().slice(0, 7);
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const [model, totals, chat, search, calendar] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS attempts,COALESCE(SUM(budget_debit_micro_usd),0) AS debited,
      COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched','unknown') THEN budget_debit_micro_usd ELSE 0 END),0) AS held,
      COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens
      FROM model_attempts WHERE user_id=? AND budget_month=?`).bind(userId, month)
      .first<{ attempts: number; debited: number; held: number; input_tokens: number; output_tokens: number }>(),
    env.DB.prepare('SELECT COALESCE(SUM(budget_debit_micro_usd),0) AS debited FROM model_attempts WHERE budget_month=?').bind(month).first<{ debited: number }>(),
    env.DB.prepare(`SELECT daily_message_limit,(SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.user_id=u.id AND m.role='user' AND m.is_memory_control=0 AND m.created_at>=?) AS accepted FROM users u WHERE id=?`)
      .bind(dayStart, userId).first<{ daily_message_limit: number; accepted: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM search_attempts WHERE user_id=? AND day=?')
      .bind(userId, new Date(now).toISOString().slice(0, 10)).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM google_calendar_requests WHERE user_id=? AND day=? AND counted=1')
      .bind(userId, new Date(now).toISOString().slice(0, 10)).first<{ n: number }>(),
  ]);
  let policy;
  try { policy = hostedPolicy(env); } catch { policy = null; }
  let searchLimit: number | null;
  try { searchLimit = researchDailyLimit(env); } catch { searchLimit = null; }
  return { period: month, currency: 'USD', estimateOnly: true, providerBillingAuthoritative: true,
    model: { attempts: model!.attempts, inputTokens: model!.input_tokens, outputTokens: model!.output_tokens,
      debitedMicroUsd: model!.debited, heldMicroUsd: model!.held,
      userBudgetMicroUsd: policy?.userMonthlyBudgetMicroUsd ?? null,
      remainingMicroUsd: policy ? Math.max(0, policy.userMonthlyBudgetMicroUsd - model!.debited) : null,
      serviceBudgetAvailable: !!policy && totals!.debited < policy.globalMonthlyBudgetMicroUsd },
    chat: { acceptedToday: chat!.accepted, dailyLimit: chat!.daily_message_limit, controlsExcluded: true },
    search: { attemptsToday: search!.n, dailyLimit: searchLimit },
    googleCalendar: { attemptsToday: calendar!.n, dailyLimit: 20 },
    note: 'Unknown provider acceptance retains its reservation. This ledger is an application estimate, not an invoice.' };
}

/** Content-free counters for the separately authenticated local operator. */
export async function getOperatorStatus(env: Env) {
  const now = Date.now();
  const [inbox, outbox, models, reminders, pause, searches, calendar, onboarding] = await Promise.all([
    env.DB.prepare(`SELECT status,COUNT(*) AS count,MIN(accepted_at) AS oldest FROM inbox GROUP BY status`).all<{ status: string; count: number; oldest: number }>(),
    env.DB.prepare(`SELECT status,COUNT(*) AS count,MIN(created_at) AS oldest FROM outbound_jobs GROUP BY status`).all<{ status: string; count: number; oldest: number }>(),
    env.DB.prepare(`SELECT state,COUNT(*) AS count,COALESCE(SUM(budget_debit_micro_usd),0) AS debitedMicroUsd FROM model_attempts GROUP BY state`)
      .all<{ state: string; count: number; debitedMicroUsd: number }>(),
    env.DB.prepare('SELECT status,COUNT(*) AS count FROM reminders GROUP BY status').all<{ status: string; count: number }>(),
    env.DB.prepare("SELECT value FROM system_settings WHERE key='outbound_paused'").first<{ value: string }>(),
    env.DB.prepare('SELECT state,COUNT(*) AS count FROM search_attempts GROUP BY state').all(),
    env.DB.prepare('SELECT state,COUNT(*) AS count FROM google_calendar_requests WHERE counted=1 GROUP BY state').all(),
    env.DB.prepare('SELECT status,COUNT(*) AS count FROM messaging_onboarding_notices GROUP BY status').all(),
  ]);
  const pending = inbox.results.filter((row) => row.status === 'pending' || row.status === 'processing');
  const oldest = pending.length ? Math.min(...pending.map((row) => row.oldest)) : null;
  return { environment: env.APP_ENV, outboundPaused: pause?.value === 'true', generatedAt: new Date(now).toISOString(),
    inbox: inbox.results, outbox: outbox.results, modelAttempts: models.results, reminders: reminders.results,
    searchAttempts: searches.results, googleCalendarRequests: calendar.results,
    messagesOnboarding: onboarding.results,
    oldestPendingAgeMs: oldest === null ? null : Math.max(0, now - oldest),
    liveAcceptanceVerified: false, note: 'Local counters do not establish provider delivery, billing accuracy, or production readiness.' };
}
