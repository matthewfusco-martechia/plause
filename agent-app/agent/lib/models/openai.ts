import type { DynamicModelContext } from "eve/models";
import { position, runs } from "eve/events";
import { env } from "@shared/environment";
import { directOpenAIPolicy, openAIModelIdSchema } from "@shared/models/openai";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { getOpenAIModel } from "@db/services/settings";
import { browserExecutionAllowed } from "@agent/lib/browser-execution";
import { budgetedOpenAIFetch } from "./budget-fetch";
import { createDirectOpenAIModel } from "./client";

export async function resolveDirectOpenAIModel(
  context: DynamicModelContext,
  role: "root" | "browser" = "root"
) {
  if (role === "browser" && !browserExecutionAllowed(context)) {
    throw new Error("Browser execution is unavailable in scheduled reports.");
  }
  const scheduled = scheduledRunIdentity(context.session.auth);
  const isScheduled = [
    context.session.auth.current,
    context.session.auth.initiator,
  ].some((caller) => caller?.authenticator === "scheduled-worker");
  if (
    isScheduled &&
    (!scheduled ||
      !(await isScheduledAgentRunLeaseActive(
        scheduled.runId,
        scheduled.leaseToken
      )))
  ) {
    throw new Error("The scheduled run lease is no longer active.");
  }
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (!caller) throw new Error("An authenticated user is required.");
  const scope = scopeFromPrincipal(caller);
  const policy = directOpenAIPolicy(role);
  const model =
    role === "root"
      ? openAIModelIdSchema.parse(await getOpenAIModel(scope))
      : policy.model;
  const activeRun = runs(context.view).findLast(
    (run) => run.status !== "settled"
  );
  const fetch = budgetedOpenAIFetch(
    {
      ...scope,
      sessionId: context.session.id,
      rootSessionId:
        context.session.parent?.rootSessionId ?? context.session.id,
      turnId: context.turn?.id ?? null,
      // The budget ledger also binds the exact request digest. Context-summary
      // calls can reuse a selection but carry a different request payload.
      modelRunId:
        activeRun?.runId ?? `resolve:${String(position(context.view))}`,
      role,
      scheduledRunId: scheduled?.runId,
      scheduledLeaseToken: scheduled?.leaseToken,
    },
    { ...policy, model }
  );
  const bounded = createDirectOpenAIModel(
    { ...policy, model },
    fetch,
    env.OPENAI_API_KEY ?? "unconfigured"
  );
  return {
    model: bounded,
    // An operational input allocation, not the model's technical maximum.
    modelContextWindowTokens: policy.maxInputTokens,
    modelOptions: {
      providerOptions: {
        openai: {
          store: false,
          truncation: "disabled",
          serviceTier: "default",
        },
      },
    },
  };
}
