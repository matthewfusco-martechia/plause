import type { Env, MessagingEvent } from '../../../packages/contracts/src/index';
import { assertRuntimeProviders } from '../../../packages/contracts/src/runtime-policy';
import type { SunshineEvent } from '../../../packages/messaging-sunshine/src/index';
import { sha256 } from '../../../packages/security/src/index';
import { parseChannelLinkCommand, recordVerifiedChannelLink } from './channel-linking';
import { ingestEvent } from './pipeline';
import { cancellationStatements, PipelineError, resolveBinding } from './store';
import { parseActionCommand } from '../../../packages/agent-core/src/action-commands';
import { parseGoogleCalendarCommand } from './google-calendar';
import { onboardingEventConflict, onboardingLifecycleStatements, recordOnboardingContact } from './messaging-onboarding';

/** Provider identity is scoped to the configured app and a web-confirmed binding. */
export async function ingestSunshineEvent(env: Env, event: SunshineEvent) {
  assertRuntimeProviders(env);
  if (env.MESSAGING_PROVIDER !== 'sunshine' || event.businessId !== env.SUNSHINE_APP_ID) {
    throw new PipelineError('Provider scope rejected.', 403, 'provider_scope_rejected');
  }
  const priorOtherKind = await env.DB.prepare(event.type === 'message.received' || event.type === 'delivery.updated'
    ? "SELECT 1 FROM provider_lifecycle_events WHERE provider='sunshine' AND business_id=? AND event_id=?"
    : "SELECT 1 FROM webhook_events WHERE provider='sunshine' AND business_id=? AND event_id=?")
    .bind(event.businessId, event.eventId).first();
  if (priorOtherKind) throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
  if (event.type === 'message.received') {
    const link = parseChannelLinkCommand(event.text);
    if (link) {
      if (link.type !== 'prove') return { recorded: false };
      try {
        return await recordVerifiedChannelLink(env, { ...event.subject, channel: event.channel,
          eventId: event.eventId, code: link.code, providerConversationId: event.providerConversationId, occurredAt: event.occurredAt,
          control: event.control });
      } catch (error) {
        // Expired/wrong codes cannot become AI input or cause repeated MSP
        // delivery attempts. Infrastructure and event-identity conflicts retry.
        if (error instanceof PipelineError && ['channel_link_expired', 'channel_proof_invalid',
          'channel_proof_conflict', 'channel_destination_in_use'].includes(error.code)) return { recorded: false };
        throw error;
      }
    }
  }
  // Public onboarding is isolated from account history and never creates a model
  // turn. Its journal also prevents a pre-link event replay after enrollment.
  const onboarding = await recordOnboardingContact(env, event);
  if (onboarding.handled) return onboarding;
  if (await onboardingEventConflict(env, event.businessId, event.eventId)) {
    throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
  }
  const hasSubject = 'subject' in event;
  if (await env.DB.prepare(`SELECT 1 FROM channel_link_challenges WHERE provider='sunshine' AND business_id=? AND provider_event_id=?`)
    .bind(event.businessId, event.eventId).first()) throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
  const binding = await env.DB.prepare(`SELECT b.conversation_id,b.subject_id,b.provider_conversation_id,COALESCE(b.provider_proved_at,b.verified_at) AS verified_at,b.revision FROM bindings b
    JOIN users u ON u.id=b.user_id WHERE b.provider='sunshine' AND b.business_id=? AND b.status='active'
    AND b.channel='apple_business' AND u.status='active' AND (? IS NULL OR b.subject_id=?)
    AND (? IS NULL OR b.provider_conversation_id=?)`)
    .bind(event.businessId, hasSubject ? event.subject.subjectId : null, hasSubject ? event.subject.subjectId : null,
      event.providerConversationId ?? null, event.providerConversationId ?? null)
    .all<{ conversation_id: string | null; subject_id: string; provider_conversation_id: string; verified_at: number | null; revision: number }>();
  // Unenrolled senders receive no model turn. A different provider thread must be
  // linked again through the signed-in account; it cannot redirect old replies.
  if (binding.results.length !== 1) return { ignored: true };
  const selected = binding.results[0]!;
  if (selected.verified_at !== null && Date.parse(event.occurredAt) < selected.verified_at) return { ignored: true };
  const bound = { ...selected, conversation_id: selected.conversation_id ?? (await resolveBinding(env,
    { provider: 'sunshine', businessId: env.SUNSHINE_APP_ID!, subjectId: selected.subject_id }, 'apple_business')).id };
  if (event.type === 'message.received') return ingestEvent(env, { schemaVersion: 1, type: event.type,
    eventId: event.eventId, occurredAt: event.occurredAt, subject: event.subject, channel: event.channel,
    messageId: event.messageId, text: event.selectionId ? selectionText(event.selectionId, event.text) : event.text },
    { providerConversationId: event.providerConversationId, control: event.control, bindingRevision: selected.revision });
  if (event.type === 'delivery.updated') {
    if (!bound.conversation_id) return { ignored: true };
    return ingestEvent(env, { schemaVersion: 1, type: event.type, eventId: event.eventId,
      occurredAt: event.occurredAt, subject: event.subject, channel: event.channel, messageId: event.messageId, state: event.state } satisfies MessagingEvent,
      undefined, event);
  }
  const now = Date.now(), token = crypto.randomUUID(), digest = await sha256(JSON.stringify(event));
  const gate = `EXISTS (SELECT 1 FROM provider_lifecycle_events WHERE provider='sunshine' AND business_id=? AND event_id=? AND mutation_token=?)`;
  const values = [event.businessId, event.eventId, token];
  const statements = [env.DB.prepare(`INSERT INTO provider_lifecycle_events(provider,business_id,event_id,conversation_id,payload_hash,mutation_token,received_at)
    SELECT 'sunshine',?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM bindings b JOIN users u ON u.id=b.user_id
      WHERE b.conversation_id=? AND b.status='active' AND u.status='active' AND b.revision=?)
    AND NOT EXISTS (SELECT 1 FROM webhook_events WHERE provider='sunshine' AND business_id=? AND event_id=?)
    AND NOT EXISTS (SELECT 1 FROM channel_link_challenges WHERE provider='sunshine' AND business_id=? AND provider_event_id=?)
    AND NOT EXISTS (SELECT 1 FROM messaging_onboarding_events WHERE provider='sunshine' AND business_id=? AND event_id=?)
    AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false') ON CONFLICT DO NOTHING`)
    .bind(event.businessId, event.eventId, bound.conversation_id, digest, token, now, bound.conversation_id, selected.revision,
      event.businessId, event.eventId, event.businessId, event.eventId, event.businessId, event.eventId)];
  const at = Date.parse(event.occurredAt);
  if (event.type === 'handoff.changed') statements.push(env.DB.prepare(`UPDATE conversations SET provider_control=?,provider_event_at=?,
    mode=CASE WHEN ?!='bot' THEN 'human' WHEN handoff_reason='provider' THEN 'bot' ELSE mode END,
    handoff_reason=CASE WHEN ?!='bot' AND (handoff_reason IS NULL OR handoff_reason='provider') THEN 'provider'
      WHEN ?='bot' AND handoff_reason='provider' THEN NULL ELSE handoff_reason END,
    ownership_version=ownership_version+1,lease_token=NULL,lease_until=0
    WHERE id=? AND (provider_event_at<? OR provider_event_at=? AND (?!='bot' OR provider_control='bot')) AND ${gate}`)
    .bind(event.control, at, event.control, event.control, event.control, bound.conversation_id, at, at, event.control, ...values));
  if (event.type === 'conversation.closed' || event.type === 'subject.revoked') {
    statements.push(env.DB.prepare(`UPDATE conversations SET status='closed',provider_event_at=MAX(provider_event_at,?),
      ownership_version=ownership_version+1,lease_token=NULL,lease_until=0 WHERE id=?
      AND (?='subject.revoked' OR provider_event_at<=?) AND ${gate}`)
      .bind(at, bound.conversation_id, event.type, at, ...values));
    if (event.type === 'subject.revoked') statements.push(env.DB.prepare(`UPDATE bindings SET status='revoked',revoked_at=?,revision=revision+1
      WHERE provider='sunshine' AND business_id=? AND subject_id=? AND ${gate}`).bind(now, event.businessId, bound.subject_id, ...values));
  }
  // client.active is informational and cannot restore enrollment or ownership.
  statements.push(...cancellationStatements(env, bound.conversation_id, now));
  statements.push(...await onboardingLifecycleStatements(env, event, { gate, gateBindings: values, now }));
  await env.DB.batch(statements);
  const stored = await env.DB.prepare(`SELECT payload_hash,mutation_token FROM provider_lifecycle_events
    WHERE provider='sunshine' AND business_id=? AND event_id=?`).bind(event.businessId, event.eventId)
    .first<{ payload_hash: string; mutation_token: string }>();
  if (stored && stored.payload_hash !== digest) throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
  if (event.type === 'handoff.changed' && event.control === 'bot') {
    try { await env.JOBS.send({ kind: 'conversation', conversationId: bound.conversation_id }); } catch { /* Scheduled recovery. */ }
  }
  return { accepted: true, duplicate: stored?.mutation_token !== token };
}


/** Only exact server-issued approval identifiers can become an action command. */
function selectionText(id: string, fallback: string): string {
  const action = parseActionCommand(id), google = parseGoogleCalendarCommand(id);
  return action && ['approve','reject'].includes(action.type) || google && ['approve','reject'].includes(google.type) ? id : fallback;
}
