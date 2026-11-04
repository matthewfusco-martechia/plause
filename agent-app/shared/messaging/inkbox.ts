import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const apiOrigin = "https://inkbox.ai";
const imessagePath = "/api/v1/imessage";
export const INKBOX_MAX_WEBHOOK_BYTES = 262_144;
const maximumMediaBytes = 10 * 1024 * 1024;
const maximumResponseBytes = 262_144;
const freshnessMs = 300_000;
const jsonValueSchema = z.json();

export const inkboxIdentityIdSchema = z.uuid();
// Deliberately support a conservative, canonical subset of provider handles.
export const inkboxAgentHandleSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
export const inkboxWebhookSigningKeySchema = z.string().refine((value) => {
  const key = value.startsWith("whsec_") ? value.slice(6) : value;
  return /^[\x21-\x7e]{32,512}$/u.test(key);
});
const phoneSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/u);
const datetimeSchema = z.iso.datetime({ offset: true });
const mediaUrlSchema = z.string().max(4096).refine(publicHttpsUrl);
const mediaSchema = z.object({
  url: mediaUrlSchema,
  content_type: z.string().min(1).max(128),
  size: z.number().int().min(0).max(maximumMediaBytes),
});

const inkboxInboundEnvelopeSchema = z.object({
  eventId: z.string().regex(/^evt_[A-Za-z0-9_-]{1,196}$/u),
  messageId: z.uuid(),
  conversationId: z.uuid(),
  assignmentId: z.uuid(),
  identityId: inkboxIdentityIdSchema,
  senderPhoneNumber: phoneSchema,
  timestamp: z.number().int().nonnegative(),
  text: z.string().max(18_995).nullable(),
  media: z
    .array(
      z.object({
        url: mediaUrlSchema,
        contentType: z.string().min(1).max(128),
        size: z.number().int().min(0).max(maximumMediaBytes),
      })
    )
    .max(8),
  replyToMessageId: z.uuid().nullable(),
});
export type InkboxInboundEnvelope = z.infer<typeof inkboxInboundEnvelopeSchema>;

const inboundBodySchema = z.object({
  id: inkboxInboundEnvelopeSchema.shape.eventId,
  event_type: z.literal("imessage.received"),
  timestamp: datetimeSchema,
  agent_identity_id: inkboxIdentityIdSchema.optional(),
  companion: z.null().optional(),
  reconciled_at: z.null().optional(),
  data: z.object({
    agent_identity_id: inkboxIdentityIdSchema.optional(),
    message: z.object({
      id: z.uuid(),
      conversation_id: z.uuid(),
      assignment_id: z.uuid(),
      agent_identity_id: inkboxIdentityIdSchema.optional(),
      direction: z.literal("inbound"),
      remote_number: phoneSchema,
      sender_number: z.null().optional(),
      participants: z.null().optional(),
      is_group: z.literal(false),
      content: z.string().max(18_995).nullable(),
      message_type: z.literal("message"),
      service: z.literal("imessage"),
      status: z.literal("received"),
      is_blocked: z.literal(false).optional(),
      media: z.array(mediaSchema).max(8).nullable(),
      reply_to_message_id: z.uuid().nullable().optional(),
      created_at: datetimeSchema,
      reconciled_at: z.null().optional(),
    }),
  }),
});

export interface InkboxWebhookConfiguration {
  identityId: string;
  signingKey: string;
}

/** Revalidates already-authenticated retained JSON; this is not authentication. */
export function parseInkboxInboundBody(
  body: string,
  identityId: string,
  nowMs = Date.now()
): InkboxInboundEnvelope | null {
  if (
    !inkboxIdentityIdSchema.safeParse(identityId).success ||
    !Number.isFinite(nowMs) ||
    Buffer.byteLength(body) > INKBOX_MAX_WEBHOOK_BYTES
  )
    return null;
  try {
    const parsed = inboundBodySchema.safeParse(JSON.parse(body));
    if (!parsed.success) return null;
    const event = parsed.data;
    const message = event.data.message;
    const timestamp = Date.parse(event.timestamp);
    const createdAt = Date.parse(message.created_at);
    if (
      Math.abs(nowMs - timestamp) > freshnessMs ||
      Math.abs(nowMs - createdAt) > freshnessMs ||
      [
        event.agent_identity_id,
        event.data.agent_identity_id,
        message.agent_identity_id,
      ].some(
        (assertion) => assertion !== undefined && assertion !== identityId
      ) ||
      (!message.content?.trim() && !message.media?.length)
    )
      return null;
    return inkboxInboundEnvelopeSchema.parse({
      eventId: event.id,
      messageId: message.id,
      conversationId: message.conversation_id,
      assignmentId: message.assignment_id,
      identityId,
      senderPhoneNumber: message.remote_number,
      timestamp,
      text: message.content,
      media: (message.media ?? []).map((item) => ({
        url: item.url,
        contentType: item.content_type,
        size: item.size,
      })),
      replyToMessageId: message.reply_to_message_id ?? null,
    });
  } catch {
    return null;
  }
}

/** Per-identity key binding is required because vendor envelopes may omit identity IDs. */
export function verifyInkboxWebhook(
  request: Request,
  rawBody: Uint8Array,
  configuration: InkboxWebhookConfiguration,
  nowMs = Date.now()
): InkboxInboundEnvelope | null {
  const signingKey = inkboxWebhookSigningKeySchema.safeParse(
    configuration.signingKey
  );
  if (!signingKey.success) return null;
  const requestId = request.headers.get("x-inkbox-request-id") ?? "";
  const timestamp = request.headers.get("x-inkbox-timestamp") ?? "";
  const signature = request.headers.get("x-inkbox-signature") ?? "";
  const key = signingKey.data.startsWith("whsec_")
    ? signingKey.data.slice(6)
    : signingKey.data;
  if (
    request.method !== "POST" ||
    rawBody.byteLength > INKBOX_MAX_WEBHOOK_BYTES ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(requestId) ||
    !/^[1-9][0-9]{0,10}$/u.test(timestamp) ||
    !/^sha256=[a-f0-9]{64}$/u.test(signature) ||
    !Number.isFinite(nowMs) ||
    Math.abs(nowMs - Number(timestamp) * 1000) > freshnessMs
  )
    return null;
  const expected = createHmac("sha256", key)
    .update(`${requestId}.${timestamp}.`)
    .update(rawBody)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
    return null;
  try {
    return parseInkboxInboundBody(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
      configuration.identityId,
      nowMs
    );
  } catch {
    return null;
  }
}

export function inkboxDigest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

const conversationSchema = z.object({
  id: z.uuid(),
  assignment_id: z.uuid(),
  assignment_status: z.literal("active"),
  remote_number: phoneSchema,
  is_group: z.literal(false),
  participants: z.array(phoneSchema).max(1),
  agent_identity_id: inkboxIdentityIdSchema.optional(),
});
export interface InkboxConversation {
  conversationId: string;
  assignmentId: string;
  identityId: string;
  remotePhoneNumber: string;
  assignmentStatus: "active";
}
const messageStatusSchema = z.enum([
  "registered",
  "pending",
  "queued",
  "accepted",
  "sent",
  "delivered",
  "declined",
  "error",
  "received",
]);
const messageSchema = z.object({
  id: z.uuid(),
  conversation_id: z.uuid(),
  assignment_id: z.uuid(),
  remote_number: phoneSchema,
  is_group: z.literal(false),
  direction: z.enum(["inbound", "outbound"]),
  status: messageStatusSchema,
  error_code: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,128}$/u)
    .nullable()
    .optional(),
  error_reason: z.string().max(512).nullable().optional(),
  agent_identity_id: inkboxIdentityIdSchema.optional(),
});
export interface InkboxMessage {
  messageId: string;
  conversationId: string;
  assignmentId: string;
  recipientPhoneNumber: string;
  status: z.infer<typeof messageStatusSchema>;
  errorCode: string | null;
}
const messageInputSchema = z
  .object({
    conversationId: z.uuid(),
    text: z.string().min(1).max(18_995).optional(),
    mediaUrl: mediaUrlSchema.optional(),
    replyToMessageId: z.uuid().optional(),
  })
  .refine(
    (input) =>
      (input.text?.trim().length ?? 0) > 0 || input.mediaUrl !== undefined
  );
export type InkboxMessageInput = z.infer<typeof messageInputSchema>;
export type InkboxSendInput = InkboxMessageInput & {
  recipientPhoneNumber: string;
  expectedAssignmentId?: string;
  idempotencyKey: string;
  beforeSend: () => Promise<void>;
};

export function serializeInkboxMessage(input: InkboxMessageInput): string {
  const parsed = messageInputSchema.safeParse(input);
  if (!parsed.success) throw new InkboxError("inkbox_invalid_message");
  const value = parsed.data;
  return JSON.stringify({
    conversation_id: value.conversationId,
    text: value.text,
    media_urls: value.mediaUrl !== undefined ? [value.mediaUrl] : undefined,
    reply_to_message_id: value.replyToMessageId,
    plain_reply_fallback:
      value.replyToMessageId !== undefined ? true : undefined,
  });
}

export class InkboxError extends Error {
  readonly code: string;
  readonly outcomeUnknown: boolean;
  readonly status: number | undefined;
  constructor(code: string, outcomeUnknown = false, status?: number) {
    super(code);
    this.name = "InkboxError";
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.status = status;
  }
}

interface InkboxClientConfiguration {
  apiKey: string;
  identityId: string;
  agentHandle: string;
  timeoutMs?: number;
}

export class InkboxClient {
  private readonly configuration: InkboxClientConfiguration;
  private readonly timeoutMs: number;
  private readonly uploadedMedia = new Set<string>();

  constructor(configuration: InkboxClientConfiguration) {
    if (
      !inkboxIdentityIdSchema.safeParse(configuration.identityId).success ||
      !inkboxAgentHandleSchema.safeParse(configuration.agentHandle).success ||
      !/^[\x21-\x7e]{1,4096}$/u.test(configuration.apiKey) ||
      (configuration.timeoutMs !== undefined &&
        (!Number.isInteger(configuration.timeoutMs) ||
          configuration.timeoutMs < 1 ||
          configuration.timeoutMs > 10_000))
    )
      throw new InkboxError("inkbox_invalid_configuration");
    this.configuration = { ...configuration };
    this.timeoutMs = configuration.timeoutMs ?? 10_000;
  }

  async getRouter() {
    const response = z
      .object({
        number: phoneSchema,
        connect_command: z.string().max(80),
      })
      .safeParse(await this.request(`${imessagePath}/triage-number`, "GET"));
    const connectCommand = `connect @${this.configuration.agentHandle}`;
    if (!response.success || response.data.connect_command !== connectCommand)
      throw new InkboxError("inkbox_invalid_router");
    return {
      number: response.data.number,
      connectCommand,
      smsLink: `sms:${response.data.number}?&body=${encodeURIComponent(connectCommand)}`,
    };
  }

  async findActiveConversation(
    phone: string
  ): Promise<InkboxConversation | null> {
    requirePhone(phone);
    // Bound account-wide scans. An incomplete scan never authorizes a cold send.
    for (let offset = 0; offset < 200; offset += 50) {
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Pagination depends on the previous bounded provider page. */
      const result = await this.request(
        `${imessagePath}/conversations`,
        "GET",
        {
          query: new URLSearchParams({
            limit: "50",
            offset: String(offset),
            include_groups: "false",
          }),
        }
      );
      const rows = z.array(z.unknown()).max(50).safeParse(result);
      if (!rows.success) throw new InkboxError("inkbox_invalid_conversations");
      const matches = rows.data.flatMap((row) => {
        const parsed = conversationSchema.safeParse(row);
        return parsed.success && parsed.data.remote_number === phone
          ? [parsed.data.id]
          : [];
      });
      if (matches.length > 1)
        throw new InkboxError("inkbox_ambiguous_conversation");
      if (matches[0]) return this.getConversation(matches[0], phone);
      if (rows.data.length < 50) return null;
    }
    throw new InkboxError("inkbox_conversation_scan_limit");
  }

  async getConversation(
    conversationId: string,
    phone: string
  ): Promise<InkboxConversation> {
    requireId(conversationId);
    requirePhone(phone);
    const result = conversationSchema.safeParse(
      await this.request(
        `${imessagePath}/conversations/${conversationId}`,
        "GET"
      )
    );
    if (
      !result.success ||
      result.data.id !== conversationId ||
      result.data.remote_number !== phone ||
      (result.data.agent_identity_id !== undefined &&
        result.data.agent_identity_id !== this.configuration.identityId) ||
      result.data.participants.length !== 1 ||
      result.data.participants[0] !== phone
    )
      throw new InkboxError("inkbox_conversation_inactive");
    return {
      conversationId,
      assignmentId: result.data.assignment_id,
      identityId: this.configuration.identityId,
      remotePhoneNumber: phone,
      assignmentStatus: "active",
    };
  }

  async sendMessage(input: InkboxSendInput): Promise<InkboxMessage> {
    const body = serializeInkboxMessage(input);
    const {
      conversationId,
      recipientPhoneNumber,
      idempotencyKey,
      beforeSend,
      mediaUrl,
      expectedAssignmentId,
    } = input;
    requirePhone(recipientPhoneNumber);
    requireKey(idempotencyKey);
    if (expectedAssignmentId !== undefined) requireId(expectedAssignmentId);
    if (mediaUrl && !this.uploadedMedia.has(mediaUrl))
      throw new InkboxError("inkbox_untrusted_media");
    const conversation = await this.getConversation(
      conversationId,
      recipientPhoneNumber
    );
    if (
      expectedAssignmentId !== undefined &&
      conversation.assignmentId !== expectedAssignmentId
    )
      throw new InkboxError("inkbox_assignment_changed");
    const response = z.object({ message: messageSchema }).safeParse(
      await this.request(`${imessagePath}/messages`, "POST", {
        body,
        idempotencyKey,
        beforeSend,
      })
    );
    if (!response.success || response.data.message.direction !== "outbound")
      throw new InkboxError("inkbox_invalid_send_response", true);
    if (response.data.message.assignment_id !== conversation.assignmentId)
      throw new InkboxError("inkbox_assignment_changed", true);
    return this.normalizeMessage(
      response.data.message,
      conversationId,
      recipientPhoneNumber,
      true
    );
  }

  async getMessage(
    messageId: string,
    conversationId: string,
    phone: string
  ): Promise<InkboxMessage> {
    requireId(messageId);
    await this.getConversation(conversationId, phone);
    const parsed = messageSchema.safeParse(
      await this.request(`${imessagePath}/messages/${messageId}`, "GET")
    );
    if (!parsed.success || parsed.data.id !== messageId)
      throw new InkboxError("inkbox_invalid_message_response");
    return this.normalizeMessage(parsed.data, conversationId, phone, false);
  }

  async lookupMessageSend(idempotencyKey: string): Promise<string | null> {
    requireKey(idempotencyKey);
    try {
      const parsed = z.object({ message_id: z.uuid() }).safeParse(
        await this.request("/api/v1/message-sends/lookup", "GET", {
          idempotencyKey,
          query: new URLSearchParams({
            sender_kind: "imessage_identity",
            sender_id: this.configuration.identityId,
            operation: "imessage.send",
          }),
        })
      );
      if (!parsed.success) throw new InkboxError("inkbox_invalid_lookup");
      return parsed.data.message_id;
    } catch (error) {
      if (error instanceof InkboxError && error.status === 404) return null;
      throw error;
    }
  }

  async uploadMedia(input: {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
    beforeSend: () => Promise<void>;
  }) {
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > maximumMediaBytes ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(input.contentType) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(input.filename)
    )
      throw new InkboxError("inkbox_invalid_media");
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
      input.filename
    );
    const response = z
      .object({
        media_url: mediaUrlSchema,
        content_type: z.string(),
        size: z.number().int(),
      })
      .safeParse(
        await this.request(`${imessagePath}/media`, "POST", {
          body: form,
          beforeSend: input.beforeSend,
        })
      );
    if (
      !response.success ||
      response.data.size !== input.bytes.byteLength ||
      response.data.content_type !== input.contentType
    )
      throw new InkboxError("inkbox_invalid_media_response", true);
    this.uploadedMedia.add(response.data.media_url);
    return {
      mediaUrl: response.data.media_url,
      contentType: input.contentType,
      size: input.bytes.byteLength,
    };
  }

  private normalizeMessage(
    message: z.infer<typeof messageSchema>,
    conversationId: string,
    phone: string,
    outcomeUnknown: boolean
  ): InkboxMessage {
    if (
      message.conversation_id !== conversationId ||
      message.remote_number !== phone ||
      (message.agent_identity_id !== undefined &&
        message.agent_identity_id !== this.configuration.identityId)
    )
      throw new InkboxError("inkbox_message_scope_mismatch", outcomeUnknown);
    return {
      messageId: message.id,
      conversationId,
      assignmentId: message.assignment_id,
      recipientPhoneNumber: phone,
      status: message.status,
      errorCode:
        message.error_reason === "delivery_unconfirmed"
          ? "send_outcome_ambiguous"
          : (message.error_code ?? null),
    };
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    options: {
      query?: URLSearchParams;
      body?: string | FormData;
      idempotencyKey?: string;
      beforeSend?: () => Promise<void>;
    } = {}
  ): Promise<z.infer<typeof jsonValueSchema>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    let dispatched = false;
    try {
      const url = new URL(path, apiOrigin);
      if (path.startsWith(`${imessagePath}/`))
        url.searchParams.set(
          "agent_identity_id",
          this.configuration.identityId
        );
      for (const [key, value] of options.query ?? [])
        url.searchParams.set(key, value);
      const headers = new Headers({
        "X-API-Key": this.configuration.apiKey,
        Accept: "application/json",
      });
      if (options.body !== undefined && !(options.body instanceof FormData))
        headers.set("Content-Type", "application/json");
      if (options.idempotencyKey)
        headers.set("Idempotency-Key", options.idempotencyKey);
      if (method === "POST" && options.idempotencyKey)
        headers.set("Prefer", "idempotency-replay");
      if (method === "POST") {
        if (!options.beforeSend)
          throw new InkboxError("inkbox_authorization_required");
        try {
          await abortable(options.beforeSend(), controller.signal);
        } catch {
          throw new InkboxError("inkbox_authorization_failed");
        }
      }
      controller.signal.throwIfAborted();
      dispatched = method === "POST";
      const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
      };
      if (options.body !== undefined) init.body = options.body;
      const response = await abortable(
        globalThis.fetch(url, init),
        controller.signal
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        // A status alone cannot prove that a keyed send was never submitted.
        throw new InkboxError("inkbox_http_error", dispatched, response.status);
      }
      const bytes = await readBoundedBody(
        response,
        controller.signal,
        dispatched
      );
      try {
        return jsonValueSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
      } catch {
        throw new InkboxError("inkbox_invalid_json", dispatched);
      }
    } catch (error) {
      if (error instanceof InkboxError) throw error;
      throw new InkboxError(
        controller.signal.aborted ? "inkbox_timeout" : "inkbox_network_error",
        dispatched
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireId(value: string) {
  if (!inkboxIdentityIdSchema.safeParse(value).success)
    throw new InkboxError("inkbox_invalid_id");
}
function requirePhone(value: string) {
  if (!phoneSchema.safeParse(value).success)
    throw new InkboxError("inkbox_invalid_phone");
}
function requireKey(value: string) {
  if (!/^[\x20-\x7e]{1,255}$/u.test(value) || !value.trim())
    throw new InkboxError("inkbox_invalid_idempotency_key");
}
function publicHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      !isIP(url.hostname.replace(/^\[|\]$/gu, "")) &&
      url.hostname.includes(".") &&
      !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/iu.test(url.hostname)
    );
  } catch {
    return false;
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      reject(new Error("Request deadline exceeded"));
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}
async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  outcomeUnknown: boolean
) {
  if (Number(response.headers.get("content-length")) > maximumResponseBytes)
    throw new InkboxError("inkbox_response_too_large", outcomeUnknown);
  const reader = response.body?.getReader();
  if (!reader) throw new InkboxError("inkbox_empty_response", outcomeUnknown);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Streaming reads are sequential and bounded by one overall request deadline. */
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumResponseBytes)
        throw new InkboxError("inkbox_response_too_large", outcomeUnknown);
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}
