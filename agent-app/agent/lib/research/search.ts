import { createHash } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import type { ApprovalConfiguration } from "eve/tools/approval";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { env } from "@shared/environment";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import {
  readModelAttempt,
  reserveModelAttempt,
  startModelAttempt,
  settleModelAttempt,
  holdUnknownModelAttempt,
} from "@db/services/model-budget";
import {
  encryptWorkspaceValue,
  decryptWorkspaceValue,
} from "@db/services/protected-values";

export const searchInputSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(1_000)
    .refine(
      (query) => query.trim().length > 0,
      "A public search query is required."
    ),
  max_results: z.number().int().min(1).max(5).default(5),
});
const sourceSchema = z.object({
  title: z.string().max(300),
  url: z
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    }, "A public web URL is required."),
  content: z.string().max(2_000),
  truncated: z.boolean(),
});
const resultSchema = z.strictObject({
  sources: z.array(sourceSchema).max(5),
  estimatedMicroUsd: z.literal(8_000),
  credits: z.literal(1),
});
const providerSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().max(2_048),
        content: z.string(),
      })
    )
    .max(5),
  usage: z.object({ credits: z.literal(1) }),
});
const endpoint = "https://api.tavily.com/search";
const providerModel = "tavily/basic-search";
const reservedMicroUsd = 8_000;

function sameOwner(
  requester: SessionAuthContext | null,
  responder: SessionAuthContext
) {
  return (
    requester?.principalType === "user" &&
    responder.principalType === "user" &&
    requester.principalId === responder.principalId &&
    requester.authenticator === responder.authenticator &&
    requester.issuer === responder.issuer
  );
}

async function authority(
  context: Pick<ToolContext, "session" | "abortSignal">
) {
  context.abortSignal.throwIfAborted();
  if (env.WEB_RESEARCH_ENABLED !== "true" || !env.TAVILY_API_KEY)
    throw new Error(
      "Public web research is disabled or not configured. No further search-provider request is permitted."
    );
  const { current, initiator } = context.session.auth;
  if (
    [current, initiator].some(
      (caller) => caller?.authenticator === "scheduled-result"
    )
  )
    throw new Error("Scheduled reports cannot start web research.");
  if (current?.principalType !== "user")
    throw new Error(
      "An authenticated workspace owner is required for web research."
    );
  const scope = scopeFromPrincipal(current);
  await assertEnrolledWorkspaceUser(scope);
  const scheduled = scheduledRunIdentity(context.session.auth);
  if (
    [current, initiator].some(
      (caller) => caller?.authenticator === "scheduled-worker"
    ) &&
    (!scheduled ||
      !(await isScheduledAgentRunLeaseActive(
        scheduled.runId,
        scheduled.leaseToken
      )))
  )
    throw new Error("The scheduled research run is no longer authorized.");
  context.abortSignal.throwIfAborted();
  return scope;
}

export const searchApproval: ApprovalConfiguration<
  z.infer<typeof searchInputSchema>
> = {
  async request(context) {
    try {
      searchInputSchema.parse(context.toolInput);
      await authority(context);
      return "user-approval";
    } catch {
      return {
        type: "denied",
        reason:
          "Public web research is unavailable for this account or run. Do not send the query through another tool.",
      };
    }
  },
  prompt({ input }) {
    const reviewed = searchInputSchema.parse(input);
    return `Send this complete public query to Tavily? Only approve information you want sent outside Plause. This permits one basic search, up to ${String(reviewed.max_results)} sources, with an estimated budget debit of $0.008 (not an invoice).\n\n${JSON.stringify(reviewed.query)}`;
  },
  async response(context) {
    if (!sameOwner(context.request.principal, context.response.principal))
      return {
        status: "rejected",
        reason:
          "Only the requesting workspace owner can approve this public query.",
      };
    try {
      searchInputSchema.parse(context.request.toolInput);
      const requester = context.request.principal;
      if (!requester)
        return {
          status: "rejected",
          reason: "An authenticated workspace owner is required.",
        };
      await assertEnrolledWorkspaceUser(scopeFromPrincipal(requester));
      return { status: "allowed" };
    } catch {
      return {
        status: "rejected",
        reason: "This account cannot approve web research now.",
      };
    }
  },
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function searchPublicWeb(
  input: z.infer<typeof searchInputSchema>,
  context: ToolContext
) {
  const query = searchInputSchema.parse(input);
  const scope = await authority(context);
  if (
    context.toolName !== "web_search" ||
    !context.approval ||
    !sameOwner(context.session.auth.current, context.approval.responder)
  )
    throw new Error(
      "The workspace owner must approve this exact public query before web research can run."
    );
  const rootSessionId =
    context.session.parent?.rootSessionId ?? context.session.id;
  const requestHash = digest(JSON.stringify(query));
  const id = digest(
    JSON.stringify([
      "public-search-v1",
      scope.workspaceId,
      context.session.id,
      context.callId,
    ])
  );
  const previous = await readModelAttempt(scope, id);
  if (previous) {
    if (
      previous.requestHash !== requestHash ||
      previous.rootSessionId !== rootSessionId ||
      previous.model !== providerModel
    )
      throw new Error(
        "This search call does not match its original approved query."
      );
    if (previous.status !== "completed" || !previous.encryptedResult)
      throw new Error(
        "The previous search outcome is unresolved. Its reservation remains held; do not retry it or send the query through another tool."
      );
    let result: z.infer<typeof resultSchema>;
    try {
      result = resultSchema.parse(
        JSON.parse(
          await decryptWorkspaceValue(
            scope,
            `research:${id}`,
            previous.encryptedResult
          )
        )
      );
    } catch {
      throw new Error(
        "The stored search result is unavailable. No provider retry is permitted."
      );
    }
    await authority(context);
    return result;
  }
  await authority(context);
  const admitted = await reserveModelAttempt({
    id,
    workspaceId: scope.workspaceId,
    rootSessionId,
    requestHash,
    model: providerModel,
    reservedMicroUsd,
  });
  if (!admitted.admitted)
    throw new Error(
      "This search was already admitted. Automatic retries are blocked."
    );
  let result: z.infer<typeof resultSchema>;
  try {
    await authority(context);
    await startModelAttempt(scope, id);
    await authority(context);
    const signal = AbortSignal.any([
      context.abortSignal,
      AbortSignal.timeout(10_000),
    ]);
    const apiKey = z.string().min(1).parse(env.TAVILY_API_KEY);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...query,
        search_depth: "basic",
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_usage: true,
        topic: "general",
      }),
      signal,
      redirect: "error",
      cache: "no-store",
    });
    if (response.status !== 200) throw new Error("Search did not complete.");
    const data = providerSchema.parse(
      JSON.parse(await boundedBody(response, signal))
    );
    if (data.results.length > query.max_results)
      throw new Error("Search exceeded its result limit.");
    result = resultSchema.parse({
      sources: data.results.map((source) => {
        const url = new URL(source.url);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("Search returned an invalid public source URL.");
        return {
          title: source.title.slice(0, 300),
          url: url.href,
          content: source.content.slice(0, 2_000),
          truncated: source.title.length > 300 || source.content.length > 2_000,
        };
      }),
      estimatedMicroUsd: reservedMicroUsd,
      credits: data.usage.credits,
    });
    const encryptedResult = await encryptWorkspaceValue(
      scope,
      `research:${id}`,
      JSON.stringify(result)
    );
    await settleModelAttempt(scope, id, {
      actualMicroUsd: reservedMicroUsd,
      inputTokens: 0,
      outputTokens: 0,
      encryptedResult,
    });
  } catch {
    await holdUnknownModelAttempt(scope, id);
    throw new Error(
      "Search stopped without a confirmed outcome. Its estimated cost remains held until reconciliation. Do not retry it or send the query through another tool."
    );
  }
  await authority(context);
  return result;
}

async function boundedBody(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error("Search returned no response body.");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > 131_072)) {
    await response.body.cancel();
    throw new Error("Search returned an oversized response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Bound and cancel the provider stream before consuming more bytes.
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 131_072)
        throw new Error("Search returned an oversized response.");
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
