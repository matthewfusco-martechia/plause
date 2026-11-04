import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@shared/environment";
import type { directOpenAIPolicy } from "@shared/models/openai";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  decryptWorkspaceValue,
  encryptWorkspaceValue,
} from "@db/services/protected-values";
import {
  readModelAttempt,
  reserveModelAttempt,
  startModelAttempt,
  holdUnknownModelAttempt,
  settleModelAttempt,
} from "@db/services/model-budget";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";

interface ModelRequestContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly turnId: string | null;
  readonly modelRunId: string;
  readonly role: "root" | "browser";
  readonly scheduledRunId?: string;
  readonly scheduledLeaseToken?: string;
}

const requestSchema = z
  .object({
    model: z.literal("gpt-6-luna"),
    input: z.union([z.string(), z.array(z.json())]),
    store: z.literal(false),
    stream: z.boolean().optional(),
    max_output_tokens: z.number().int().positive(),
    tools: z
      .array(z.object({ type: z.literal("function") }).loose())
      .optional(),
    background: z.literal(false).optional(),
    service_tier: z.literal("default").optional(),
    previous_response_id: z.never().optional(),
    conversation: z.never().optional(),
  })
  .loose();
const countRequestSchema = requestSchema
  .pick({ model: true, input: true, tools: true })
  .extend({
    instructions: z.string().optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z.record(z.string(), z.json()).optional(),
    text: z.record(z.string(), z.json()).optional(),
    tool_choice: z
      .union([z.string(), z.record(z.string(), z.json())])
      .optional(),
    truncation: z.literal("disabled").optional(),
  })
  .strip();
const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .refine(
    (usage) => usage.input_tokens + usage.output_tokens === usage.total_tokens,
    "OpenAI usage total is invalid."
  );
const completedSchema = z
  .object({
    model: z.literal("gpt-6-luna"),
    object: z.literal("response"),
    id: z.string().min(1).max(200),
    status: z.literal("completed"),
    usage: usageSchema,
    service_tier: z.literal("default").optional(),
  })
  .loose();
type CompletedResponse = z.infer<typeof completedSchema>;
const countSchema = z.object({
  object: z.literal("response.input_tokens"),
  input_tokens: z.number().int().nonnegative(),
});
const cachedSchema = z.object({
  body: z.string().max(2_000_000),
  contentType: z.enum(["application/json", "text/event-stream"]),
});

export function budgetedOpenAIFetch(
  context: ModelRequestContext,
  policy: ReturnType<typeof directOpenAIPolicy>
): typeof fetch {
  const transport = globalThis.fetch;
  return async (input, init) => {
    if (env.LIVE_MODEL_ENABLED !== "true" || !env.OPENAI_API_KEY)
      throw new Error("Live OpenAI access is disabled.");
    if (
      context.userId.startsWith("better-auth:") &&
      accessScopeForUser(context.userId).workspaceId !== context.workspaceId
    ) {
      throw new Error("Model workspace ownership is invalid.");
    }
    const request = new Request(input, init);
    if (
      request.url !== "https://api.openai.com/v1/responses" ||
      request.method !== "POST"
    ) {
      throw new Error("Only direct OpenAI Responses requests are allowed.");
    }
    const bodyText = await request.text();
    if (Buffer.byteLength(bodyText) > 8_000_000)
      throw new Error("The model request is too large.");
    const payload = requestSchema.parse(JSON.parse(bodyText));
    if (payload.max_output_tokens > policy.maxOutputTokens)
      throw new Error("Model policy mismatch.");
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(policy.timeoutMs),
    ]);
    signal.throwIfAborted();
    await assertModelAuthority(context);
    const requestHash = digest(JSON.stringify(payload));
    // A selection can serve both a compaction and a normal call. Bind replay to
    // the exact payload as well as the persisted model selection position.
    const id = digest(
      JSON.stringify([
        context.workspaceId,
        context.sessionId,
        context.role,
        context.modelRunId,
        requestHash,
      ])
    );
    const previous = await readModelAttempt(context, id);
    if (previous) {
      if (previous.status !== "completed" || !previous.encryptedResult)
        throw new Error(
          "The previous model request is unresolved. Automatic retry is blocked."
        );
      const cached = cachedSchema.parse(
        JSON.parse(
          await decryptWorkspaceValue(
            context,
            `model:${id}`,
            previous.encryptedResult
          )
        )
      );
      completionFromBody(cached.body, cached.contentType);
      signal.throwIfAborted();
      await assertModelAuthority(context);
      signal.throwIfAborted();
      return new Response(cached.body, {
        headers: { "content-type": cached.contentType },
      });
    }
    await assertModelAuthority(context);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    };
    const countInput = countRequestSchema.parse(payload);
    const counted = await transport(
      "https://api.openai.com/v1/responses/input_tokens",
      {
        method: "POST",
        headers,
        body: JSON.stringify(countInput),
        signal,
        redirect: "error",
      }
    );
    if (!counted.ok) throw new Error("OpenAI input preflight failed.");
    const { input_tokens: inputTokens } = countSchema.parse(
      JSON.parse(await readBounded(counted, 16_384, signal))
    );
    if (inputTokens > policy.maxInputTokens)
      throw new Error("The model input limit has been reached.");
    const reservedMicroUsd = estimate(
      policy,
      inputTokens,
      payload.max_output_tokens
    );
    signal.throwIfAborted();
    const admitted = await reserveModelAttempt({
      id,
      workspaceId: context.workspaceId,
      rootSessionId: context.rootSessionId,
      requestHash,
      model: payload.model,
      reservedMicroUsd,
    });
    if (!admitted.admitted)
      throw new Error(
        "The model request was already admitted. Automatic retry is blocked."
      );
    let completedResponse: Response;
    let phase = "authorization";
    let providerRequestId: string | undefined;
    let httpStatus: number | undefined;
    try {
      signal.throwIfAborted();
      await assertModelAuthority(context);
      phase = "dispatch_marker";
      await startModelAttempt(context, id);
      phase = "authorization_after_dispatch";
      signal.throwIfAborted();
      await assertModelAuthority(context);
      signal.throwIfAborted();
      phase = "provider_request";
      const response = await transport("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { ...headers, "X-Client-Request-Id": id },
        body: bodyText,
        signal,
        redirect: "error",
      });
      phase = "response_headers";
      httpStatus = response.status;
      const requestId = response.headers.get("x-request-id");
      if (requestId && /^req_[A-Za-z0-9_-]{1,196}$/u.test(requestId))
        providerRequestId = requestId;
      if (!response.ok) throw new Error("OpenAI generation did not complete.");
      const contentType = response.headers.get("content-type")?.split(";")[0];
      if (
        contentType !== "application/json" &&
        contentType !== "text/event-stream"
      )
        throw new Error("Unexpected OpenAI response format.");
      phase = "response_body";
      const body = await readBounded(response, 2_000_000, signal);
      phase = "completion_validation";
      const completion = completionFromBody(body, contentType);
      phase = "usage_validation";
      if (
        completion.usage.input_tokens !== inputTokens ||
        completion.usage.output_tokens > payload.max_output_tokens
      )
        throw new Error("OpenAI usage exceeded its preflight bounds.");
      const actualMicroUsd = estimate(
        policy,
        completion.usage.input_tokens,
        completion.usage.output_tokens
      );
      phase = "result_encryption";
      const encryptedResult = await encryptWorkspaceValue(
        context,
        `model:${id}`,
        JSON.stringify({ body, contentType })
      );
      phase = "accounting_settlement";
      await settleModelAttempt(context, id, {
        actualMicroUsd,
        encryptedResult,
        inputTokens: completion.usage.input_tokens,
        outputTokens: completion.usage.output_tokens,
      });
      completedResponse = new Response(body, {
        headers: { "content-type": contentType },
      });
    } catch (error) {
      await holdUnknownModelAttempt(context, id);
      // Persist only controlled diagnostic fields in the workflow error. Never
      // include provider bodies, prompts, credentials or raw exception messages.
      const failure =
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
          ? error.name
          : "request_failed";
      // oxlint-disable-next-line eslint/preserve-caught-error -- Raw provider exceptions can contain private content; only controlled diagnostics may enter workflow history.
      throw new Error(
        `Model execution stopped. Its reserved cost remains held until the outcome is reconciled. Diagnostic: ${JSON.stringify({ phase, failure, clientRequestId: id, providerRequestId, httpStatus })}`
      );
    }
    // Accounting has already committed. Revocation must suppress the result
    // without relabeling a known, settled charge as an unknown reservation.
    signal.throwIfAborted();
    await assertModelAuthority(context);
    signal.throwIfAborted();
    return completedResponse;
  };
}

async function assertModelAuthority(context: ModelRequestContext) {
  await assertEnrolledWorkspaceUser(context);
  if (
    context.scheduledRunId &&
    (!context.scheduledLeaseToken ||
      !(await isScheduledAgentRunLeaseActive(
        context.scheduledRunId,
        context.scheduledLeaseToken
      )))
  ) {
    throw new Error("The scheduled model run is no longer authorized.");
  }
}

function estimate(
  policy: ReturnType<typeof directOpenAIPolicy>,
  input: number,
  output: number
) {
  return (
    Math.ceil((input * policy.inputRateMicroUsdPerMillion) / 1_000_000) +
    Math.ceil((output * policy.outputRateMicroUsdPerMillion) / 1_000_000)
  );
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function completionFromBody(
  body: string,
  contentType: "application/json" | "text/event-stream"
): CompletedResponse {
  if (contentType === "application/json")
    return completedSchema.parse(JSON.parse(body));
  let completion: CompletedResponse | undefined;
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]")
      continue;
    const event = z
      .object({ type: z.string(), response: z.unknown().optional() })
      .parse(JSON.parse(line.slice(5)));
    if (completion)
      throw new Error("OpenAI returned data after its completion.");
    if (event.type === "response.completed") {
      completion = completedSchema.parse(event.response);
    }
    if (
      ["response.failed", "response.incomplete", "error"].includes(event.type)
    )
      throw new Error("OpenAI stream failed.");
  }
  if (!completion) throw new Error("OpenAI returned no completed response.");
  return completion;
}

async function readBounded(
  response: Response,
  maximum: number,
  signal: AbortSignal
) {
  if (!response.body) throw new Error("Empty provider response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      // oxlint-disable-next-line eslint/no-await-in-loop -- read one bounded response stream in order.
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum)
        throw new Error("Provider response exceeded its bound.");
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks)
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
