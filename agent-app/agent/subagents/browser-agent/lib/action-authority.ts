import { createHash, randomUUID } from "node:crypto";
import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";
import { always, type ApprovalPolicy } from "eve/tools/approval";
import { z } from "zod";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";
import {
  startBrowserAction,
  completeBrowserAction,
  markBrowserActionUnknown,
} from "@db/services/browser-actions";
import { requireWorkerScope } from "./access";
import { currentKernelPageOrigin, PaymentFillError } from "./autofill/native";
import { requireOwnedBrowserSession } from "./owned-browser";

export const browserActionContextSchema = z.strictObject({
  observationId: z.uuid(),
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && value === url.origin;
  }, "An exact HTTPS origin is required."),
});

const observationSchema = browserActionContextSchema.extend({
  userId: z.string(),
  workspaceId: z.string(),
  workerSessionId: z.string(),
  browserSessionId: z.string(),
  observedAt: z.number(),
  expiresAt: z.number(),
});
const observations = defineState<z.infer<typeof observationSchema>[]>(
  "worker.browser-action-observations",
  () => []
);
const observationLifetimeMs = 5 * 60_000;
type ActionContext = Pick<ToolContext, "session" | "abortSignal">;

export async function dispatchBrowserAction<TResult>(
  scope: AccessScope,
  input: {
    readonly browserSessionId: string | null;
    readonly observationId: string | null;
    readonly arguments: object;
  },
  context: Pick<ToolContext, "session" | "abortSignal" | "callId" | "toolName">,
  execute: () => Promise<TResult>
) {
  const parent = context.session.parent;
  if (!parent) throw new Error("Browser mutations require a delegated worker.");
  await assertBrowserActionAuthority(scope, context);
  const id = await startBrowserAction(scope, {
    workerSessionId: context.session.id,
    rootSessionId: parent.rootSessionId,
    callId: context.callId,
    toolName: context.toolName,
    browserSessionId: input.browserSessionId,
    observationId: input.observationId,
    inputHash: createHash("sha256")
      .update(JSON.stringify(input.arguments))
      .digest("hex"),
  });
  let result: TResult;
  try {
    // The durable started marker is committed before any external mutation.
    await assertBrowserActionAuthority(scope, context);
    result = await execute();
    await completeBrowserAction(scope, id);
  } catch (error) {
    await markBrowserActionUnknown(scope, id);
    // Only this checkout-state class has a safe public diagnostic. Its cause
    // is discarded before the Link tool adds the no-retry instruction.
    if (error instanceof PaymentFillError) {
      throw new PaymentFillError(error.message);
    }
    // oxlint-disable-next-line eslint/preserve-caught-error -- Never journal provider credentials or page content in error causes.
    throw new Error(
      "Browser action stopped and may have taken effect. Automatic repeat actions are blocked for this conversation; inspect and reconcile the existing outcome."
    );
  }
  // Suppress revoked results without changing an already known completion.
  await assertBrowserActionAuthority(scope, context);
  return result;
}

export function browserActionApproval<TInput>(): ApprovalPolicy<TInput> {
  const request = always<TInput>();
  return (context) => {
    try {
      assertBrowserActionsEnabled(context);
    } catch {
      return {
        type: "denied",
        reason:
          "Browser actions are unavailable for this deployment or scheduled session.",
      };
    }
    return request(context);
  };
}

export function assertBrowserActionsEnabled(context: ActionContext) {
  context.abortSignal.throwIfAborted();
  if (
    [context.session.auth.current, context.session.auth.initiator].some(
      (caller) =>
        caller?.authenticator === "scheduled-worker" ||
        caller?.authenticator === "scheduled-result"
    )
  ) {
    throw new Error(
      "Scheduled browser access is read-only. Do not retry this action through another tool."
    );
  }
  if (env.BROWSER_ACTIONS_ENABLED !== "true") {
    throw new Error(
      "Browser actions are disabled for this deployment. Inspection remains available; do not use another tool to bypass this restriction."
    );
  }
}

export async function assertBrowserActionAuthority(
  scope: AccessScope,
  context: ActionContext
) {
  assertBrowserActionsEnabled(context);
  const latestScope = await requireWorkerScope(context);
  if (
    latestScope.userId !== scope.userId ||
    latestScope.workspaceId !== scope.workspaceId
  )
    throw new Error("Browser action ownership changed.");
  await assertEnrolledWorkspaceUser(scope);
  assertBrowserActionsEnabled(context);
}

export async function observeBrowserAction(
  scope: AccessScope,
  browserSessionId: string,
  context: ActionContext
) {
  context.abortSignal.throwIfAborted();
  await requireOwnedBrowserSession(scope, browserSessionId);
  const origin = browserActionContextSchema.shape.origin.parse(
    await currentKernelPageOrigin({
      browserSessionId,
      signal: context.abortSignal,
      requireSinglePage: true,
    })
  );
  // Recheck authority after the remote inspection before retaining an observation.
  await requireWorkerScope(context);
  await requireOwnedBrowserSession(scope, browserSessionId);
  context.abortSignal.throwIfAborted();
  const observedAt = Date.now();
  const observation = {
    ...scope,
    observationId: randomUUID(),
    origin,
    workerSessionId: context.session.id,
    browserSessionId,
    observedAt,
    expiresAt: observedAt + observationLifetimeMs,
  };
  observations.update((current) => [
    ...current.filter((item) => item.expiresAt > observedAt).slice(-15),
    observation,
  ]);
  return {
    actionContext: {
      observationId: observation.observationId,
      origin,
    },
    observedAt,
    expiresAt: observation.expiresAt,
  };
}

export async function claimBrowserAction(
  scope: AccessScope,
  browserSessionId: string,
  input: z.infer<typeof browserActionContextSchema>,
  context: ActionContext
) {
  assertBrowserActionsEnabled(context);
  const selected = browserActionContextSchema.parse(input);
  const observation = observations
    .get()
    .find((item) => item.observationId === selected.observationId);
  if (
    !observation ||
    observation.userId !== scope.userId ||
    observation.workspaceId !== scope.workspaceId ||
    observation.workerSessionId !== context.session.id ||
    observation.browserSessionId !== browserSessionId ||
    observation.origin !== selected.origin
  ) {
    throw new Error("This browser action has no matching server observation.");
  }
  // Consume even when the final check fails: a fresh observation and a new
  // per-call approval are required. Eve journals state with tool completion;
  // this is not a provider-side exactly-once guarantee after a process crash.
  observations.update((current) =>
    current.filter((item) => item.observationId !== selected.observationId)
  );
  const assertCurrent = async () => {
    assertBrowserActionsEnabled(context);
    assertFresh(observation);
    await assertBrowserActionAuthority(scope, context);
    await requireOwnedBrowserSession(scope, browserSessionId);
    const currentOrigin = await currentKernelPageOrigin({
      browserSessionId,
      signal: context.abortSignal,
      requireSinglePage: true,
    });
    if (currentOrigin !== observation.origin)
      throw new Error("The browser origin changed. Inspect and approve again.");
    await requireOwnedBrowserSession(scope, browserSessionId);
    await assertBrowserActionAuthority(scope, context);
    assertFresh(observation);
  };
  await assertCurrent();
  return {
    assertCurrent,
    origin: observation.origin,
    signal: AbortSignal.any([
      context.abortSignal,
      AbortSignal.timeout(Math.max(1, observation.expiresAt - Date.now())),
    ]),
  };
}

function assertFresh(observation: z.infer<typeof observationSchema>) {
  const now = Date.now();
  if (now < observation.observedAt || now >= observation.expiresAt) {
    throw new Error(
      "The browser observation expired. Inspect and approve again."
    );
  }
}
