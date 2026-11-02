import { z } from 'zod';

export const channelSchema = z.enum(['apple_business', 'web', 'mock']);
const opaque = z.string().min(1).max(200);
export const subjectSchema = z.object({
  provider: z.enum(['mock', 'web', 'sunshine']),
  businessId: opaque,
  subjectId: opaque,
}).strict();

const base = {
  schemaVersion: z.literal(1),
  eventId: opaque,
  subject: subjectSchema,
  channel: channelSchema,
  occurredAt: z.string().datetime(),
};

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message.received'), messageId: opaque, text: z.string().min(1).max(4000).refine((text) => text.trim().length > 0) }).strict(),
  z.object({ ...base, type: z.literal('delivery.updated'), messageId: opaque, state: z.enum(['sent', 'delivered', 'failed']) }).strict(),
  z.object({ ...base, type: z.literal('conversation.closed') }).strict(),
  z.object({ ...base, type: z.literal('handoff.requested') }).strict(),
]);

export type MessagingEvent = z.infer<typeof eventSchema>;
export type ChannelSubject = z.infer<typeof subjectSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type QueueJob = { kind: 'conversation'; conversationId: string } | { kind: 'messages_onboarding' };
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'rich_link'; url: string; title: string }
  | { type: 'quick_replies'; text: string; options: { id: string; label: string }[] };
export type SendOutcome =
  | { state: 'sent' | 'delivered'; providerMessageId: string }
  | { state: 'retryable_failed' | 'failed'; code: string }
  | { state: 'delivery_unknown'; code: string };

export interface Env {
  DB: D1Database;
  JOBS: Queue<QueueJob>;
  ASSETS: Fetcher;
  APP_ENV: string;
  MODEL_PROVIDER: string;
  MESSAGING_PROVIDER: string;
  CONTENT_ENCRYPTION_KEY: string;
  MOCK_WEBHOOK_SECRET: string;
  OPERATOR_TOKEN: string;
  PUBLIC_ORIGIN?: string;
  LIVE_MESSAGING_ENABLED?: string;
  APPLE_CHANNEL_APPROVED?: string;
  APPLE_PROACTIVE_ENABLED?: string;
  ONBOARDING_MESSAGES_ENABLED?: string;
  ONBOARDING_GLOBAL_DAILY_LIMIT?: string;
  APPLE_BUSINESS_ID?: string;
  TYPING_INDICATORS_ENABLED?: string;
  AUTH_GOOGLE_ENABLED?: string;
  AUTH_SIGNUP_ENABLED?: string;
  AUTH_SIGNUP_SUBJECTS?: string;
  AUTH_GOOGLE_CLIENT_ID?: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;
  STAGING_ACCESS_ENABLED?: string;
  STAGING_ACCESS_PASSWORD_SHA256?: string;
  OPERATOR_BOOTSTRAP_SUBJECTS?: string;
  SUPPORT_COVERAGE_ENABLED?: string;
  SUPPORT_HOURS?: string;
  SUPPORT_TIME_ZONE?: string;
  SUPPORT_CONTACT?: string;
  PRIVACY_LEDGER?: R2Bucket;
  JOBS_DLQ_NAME?: string;
  SUNSHINE_SUBDOMAIN?: string;
  SUNSHINE_APP_ID?: string;
  SUNSHINE_APPLE_INTEGRATION_ID?: string;
  SUNSHINE_WEBHOOK_ID?: string;
  SUNSHINE_WEBHOOK_SECRET?: string;
  SUNSHINE_KEY_ID?: string;
  SUNSHINE_KEY_SECRET?: string;
  SUNSHINE_BOT_SWITCHBOARD_ID?: string;
  SUNSHINE_AGENT_SWITCHBOARD_ID?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  LIVE_MODEL_ENABLED?: string;
  MODEL_MAX_INPUT_TOKENS?: string;
  MODEL_MAX_OUTPUT_TOKENS?: string;
  MODEL_TIMEOUT_MS?: string;
  MODEL_USER_MONTHLY_BUDGET_MICRO_USD?: string;
  MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD?: string;
  SEARCH_PROVIDER?: string;
  LIVE_SEARCH_ENABLED?: string;
  TAVILY_API_KEY?: string;
  SEARCH_USER_DAILY_LIMIT?: string;
  SEARCH_GLOBAL_DAILY_LIMIT?: string;
  LIVE_GOOGLE_CALENDAR_ENABLED?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

export interface ModelRequest {
  text: string;
  history: { role: 'user' | 'assistant'; text: string }[];
  /** User-selected facts are data, never executable instructions or permissions. */
  memories?: { id: string; text: string }[];
  contextRevision?: number;
  /** Stable source time and account-selected zone, never a model-selected identity. */
  planningContext?: { now: number; timeZone: string | null; realGoogleCalendarConnected?: boolean };
  signal?: AbortSignal;
}
export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  responseId?: string;
  /** A validated draft. Only the server may turn this into an expiring approval. */
  proposal?: import('../../agent-core/src/model-proposals').ModelProposal;
}
export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

/** Safe, content-free classification. Unknown billing must never be auto-retried. */
export class ModelCallError extends Error {
  constructor(public readonly code: string, public readonly chargePossible = false,
    public readonly retryable = false) { super(code); this.name = 'ModelCallError'; }
}
