import { createHash } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import type { ApprovalConfiguration } from "eve/tools/approval";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  executeGoogleAction,
  GoogleActionApprovalError,
  readGoogleActionGrant,
  requestGoogleActionApproval,
  respondGoogleActionApproval,
  type GoogleActionBinding,
} from "@db/services/google-actions";
import { readGoogleWorkspaceGrantVersion } from "@db/services/google-workspace";
import { assertGoogleWorkspaceWriteAllowed } from "./writes";
import { withGoogleAuth } from "./client";

type GoogleWriteTool = GoogleActionBinding["toolName"];

function principalHash(principal: SessionAuthContext) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        principal.principalId,
        principal.principalType,
        principal.authenticator,
        principal.issuer ?? null,
      ])
    )
    .digest("hex");
}

function bindingFor(
  session: Pick<ToolContext["session"], "id" | "parent">,
  principal: SessionAuthContext | null,
  callId: string,
  toolName: GoogleWriteTool,
  input: z.infer<ReturnType<typeof z.json>>
): GoogleActionBinding {
  if (principal?.principalType !== "user")
    throw new GoogleActionApprovalError();
  return {
    ...scopeFromPrincipal(principal),
    sessionId: session.id,
    rootSessionId: session.parent?.rootSessionId ?? session.id,
    callId,
    toolName,
    principalHash: principalHash(principal),
    input,
  };
}

export function googleWriteApproval<T>(
  toolName: GoogleWriteTool,
  schema: z.ZodType<T>
): ApprovalConfiguration<T> {
  return {
    async request(ctx) {
      try {
        assertGoogleWorkspaceWriteAllowed(ctx);
        ctx.abortSignal.throwIfAborted();
        if (ctx.toolName !== toolName) return "denied";
        const input = z.json().parse(schema.parse(ctx.toolInput));
        const binding = bindingFor(
          ctx.session,
          ctx.session.auth.current,
          ctx.callId,
          toolName,
          input
        );
        const version = await readGoogleWorkspaceGrantVersion(binding);
        await requestGoogleActionApproval(binding, version);
        ctx.abortSignal.throwIfAborted();
        return "user-approval";
      } catch {
        return {
          type: "denied",
          reason:
            "This Google write cannot be approved now. Review the connection and exact action; do not route it through another tool.",
        };
      }
    },
    prompt({ input }) {
      const reviewed = JSON.stringify(schema.parse(input), null, 2);
      if (reviewed.length > 3_000) throw new GoogleActionApprovalError();
      return `Approve this exact ${toolName} action? This permission expires five minutes after it was first requested and permits one provider dispatch. Review every recipient, body, date, calendar and attendee below. No other action is authorized.\n\n${reviewed}`;
    },
    async response(ctx) {
      try {
        const requester = ctx.request.principal;
        if (
          ctx.request.toolName !== toolName ||
          requester?.principalType !== "user" ||
          principalHash(requester) !== principalHash(ctx.response.principal)
        )
          throw new GoogleActionApprovalError();
        const input = z.json().parse(schema.parse(ctx.request.toolInput));
        const binding = bindingFor(
          ctx.session,
          requester,
          ctx.request.callId,
          toolName,
          input
        );
        const version = await readGoogleWorkspaceGrantVersion(binding);
        await respondGoogleActionApproval(
          binding,
          version,
          ctx.request.interactionId,
          ctx.response.decision
        );
        return { status: "allowed" };
      } catch {
        return {
          status: "rejected",
          reason:
            "Only the requesting workspace owner can answer this exact, unexpired Google action.",
        };
      }
    },
  };
}

export async function withApprovedGoogleWrite<T>(
  ctx: ToolContext,
  toolName: GoogleWriteTool,
  input: z.infer<ReturnType<typeof z.json>>,
  resultSchema: z.ZodType<T>,
  execute: Parameters<typeof withGoogleAuth<T>>[1]
) {
  assertGoogleWorkspaceWriteAllowed(ctx);
  ctx.abortSignal.throwIfAborted();
  const requester = ctx.session.auth.current;
  if (
    ctx.toolName !== toolName ||
    !requester ||
    !ctx.approval ||
    principalHash(requester) !== principalHash(ctx.approval.responder)
  )
    throw new GoogleActionApprovalError();
  const binding = bindingFor(
    ctx.session,
    requester,
    ctx.callId,
    toolName,
    input
  );
  const grantVersion = await readGoogleActionGrant(binding);
  return withGoogleAuth(
    ctx,
    (auth) =>
      executeGoogleAction(binding, grantVersion, resultSchema, async () => {
        assertGoogleWorkspaceWriteAllowed(ctx);
        ctx.abortSignal.throwIfAborted();
        return execute(auth);
      }),
    grantVersion
  );
}
