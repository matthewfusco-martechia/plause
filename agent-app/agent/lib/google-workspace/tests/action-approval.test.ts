import type { ApprovalResponseContext } from "eve/tools/approval";
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as Environment from "@shared/environment";
import type * as Actions from "@db/services/google-actions";
import { toolContextFor } from "@tests/helpers/tool-context";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  googleWriteApproval,
  withApprovedGoogleWrite,
} from "@agent/lib/google-workspace/action-approval";
import { withGoogleAuth } from "@agent/lib/google-workspace/client";

const boundary = vi.hoisted(() => ({
  enabled: "true",
  tokenVersion: 7,
  enrolled: true,
  enrollmentChecks: 0,
  request: vi.fn<() => Promise<void>>(async () => undefined),
  response: vi.fn<() => Promise<void>>(async () => undefined),
  execute: vi.fn<() => Promise<void>>(async () => undefined),
  token: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("@shared/environment", async (importOriginal) => ({
  ...(await importOriginal<typeof Environment>()),
  env: {
    get GOOGLE_WORKSPACE_WRITES_ENABLED() {
      return boundary.enabled;
    },
  },
}));
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: async () => {
    boundary.enrollmentChecks += 1;
    if (!boundary.enrolled) throw new Error("Private Plause access removed.");
  },
}));
vi.mock("@db/services/google-workspace", () => ({
  readGoogleWorkspaceGrantVersion: async () => 7,
  getGoogleWorkspaceAccessToken: async () => {
    await boundary.token();
    return { token: "fixture-private-token", version: boundary.tokenVersion };
  },
  assertGoogleWorkspaceVersion: async () => undefined,
  invalidateGoogleWorkspaceConnection: async () => undefined,
  GoogleWorkspaceConnectionRequiredError: class extends Error {},
}));
vi.mock("@db/services/google-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof Actions>()),
  requestGoogleActionApproval: boundary.request,
  respondGoogleActionApproval: boundary.response,
  readGoogleActionGrant: async () => 7,
  executeGoogleAction: async <T>(
    _binding: Actions.GoogleActionBinding,
    _grant: number,
    _schema: z.ZodType<T>,
    execute: () => Promise<T>
  ) => {
    await boundary.execute();
    return execute();
  },
}));

const inputSchema = z.object({
  to: z.array(z.email()),
  cc: z.array(z.email()),
  bcc: z.array(z.email()),
  body: z.string(),
});
const input = {
  to: ["to@example.com"],
  cc: ["cc@example.com"],
  bcc: ["bcc@example.com"],
  body: "Exact complete body\nSecond line.",
};
const policy = googleWriteApproval("gmail-send", inputSchema);
const principal = {
  principalId: "better-auth:alice",
  principalType: "user",
  authenticator: "linq-message",
  issuer: "plause",
  attributes: {
    workspaceId: accessScopeForUser("better-auth:alice").workspaceId,
  },
};

function context(): ToolContext {
  return toolContextFor({
    toolName: "gmail-send",
    auth: { current: principal, initiator: principal },
  });
}

function response(): ApprovalResponseContext<z.infer<typeof inputSchema>> {
  const ctx = context();
  return {
    auth: {
      getToken: (...args) => ctx.getToken(...args),
      requireAuth: (...args) => ctx.requireAuth(...args),
    },
    session: { ...ctx.session, initiator: principal },
    request: {
      callId: ctx.callId,
      interactionId: "interaction-1",
      principal,
      toolInput: input,
      toolName: "gmail-send",
    },
    response: { decision: "approve", principal },
  };
}

function approvedContext(): ToolContext {
  const ctx = context();
  return {
    ...ctx,
    approval: {
      responder: { ...principal, getToken: (...args) => ctx.getToken(...args) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.enabled = "true";
  boundary.tokenVersion = 7;
  boundary.enrolled = true;
  boundary.enrollmentChecks = 0;
});

describe("Google exact-call framework approval", () => {
  it("persists the exact request and always asks a human instead of granting policy approval", async () => {
    const ctx = { ...context(), toolInput: input };
    expect(await policy.request(ctx)).toBe("user-approval");
    expect(await policy.request(ctx)).toBe("user-approval");
    expect(boundary.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ...accessScopeForUser("better-auth:alice"),
        sessionId: ctx.session.id,
        callId: ctx.callId,
        input,
        toolName: "gmail-send",
      }),
      7
    );
    expect(boundary.response).not.toHaveBeenCalled();
    expect(boundary.token).not.toHaveBeenCalled();
  });

  it.each(["false", "malformed"])(
    "refuses approval when writes capability is %s",
    async (enabled) => {
      boundary.enabled = enabled;
      expect(
        await policy.request({ ...context(), toolInput: input })
      ).toMatchObject({ type: "denied" });
      expect(boundary.request).not.toHaveBeenCalled();
    }
  );

  it("records an authenticated same-owner approval response against the original interaction", async () => {
    expect(await policy.response?.(response())).toEqual({ status: "allowed" });
    expect(boundary.response).toHaveBeenCalledWith(
      expect.objectContaining({ input, toolName: "gmail-send" }),
      7,
      "interaction-1",
      "approve"
    );
  });

  it.each([
    { principalId: "better-auth:bob" },
    { authenticator: "different-authenticator" },
    { issuer: "different-issuer" },
    { principalType: "service" },
  ])(
    "rejects a response with altered identity $principalId $authenticator $issuer $principalType",
    async (change) => {
      const ctx = response();
      expect(
        await policy.response?.({
          ...ctx,
          response: { ...ctx.response, principal: { ...principal, ...change } },
        })
      ).toMatchObject({ status: "rejected" });
      expect(boundary.response).not.toHaveBeenCalled();
    }
  );

  it("renders all exact recipients and the complete body, and refuses an oversized prompt", () => {
    const prompt =
      policy.prompt?.({ callId: "call-1", toolName: "gmail-send", input }) ??
      "";
    for (const address of [...input.to, ...input.cc, ...input.bcc])
      expect(prompt).toContain(address);
    expect(prompt).toContain(JSON.stringify(input.body));
    expect(prompt).toContain("five minutes");
    expect(() =>
      policy.prompt?.({
        callId: "call-1",
        toolName: "gmail-send",
        input: { ...input, body: "x".repeat(3_001) },
      })
    ).toThrow("exact Google action");
  });

  it("blocks direct writes without an authenticated owner approval before obtaining tokens", async () => {
    await expect(
      withApprovedGoogleWrite(
        context(),
        "gmail-send",
        input,
        z.object({ id: z.string() }),
        async () => ({ id: "sent" })
      )
    ).rejects.toThrow("exact Google action");
    expect(boundary.token).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it("rejects a newly connected grant instead of substituting it for the approved version", async () => {
    boundary.tokenVersion = 8;
    await expect(
      withApprovedGoogleWrite(
        approvedContext(),
        "gmail-send",
        input,
        z.object({ id: z.string() }),
        async () => ({ id: "sent" })
      )
    ).rejects.toThrow("exact Google action");
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it("claims durable dispatch before executing the provider callback", async () => {
    const execute = vi.fn<() => Promise<{ id: string }>>(async () => {
      expect(boundary.execute).toHaveBeenCalledOnce();
      return { id: "sent" };
    });
    expect(
      await withApprovedGoogleWrite(
        approvedContext(),
        "gmail-send",
        input,
        z.object({ id: z.string() }),
        execute
      )
    ).toEqual({ id: "sent" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks queued reads after enrollment removal and hides an in-flight read result if removal wins", async () => {
    boundary.enrolled = false;
    const execute = vi.fn<() => Promise<string>>(
      async () => "private provider result"
    );
    await expect(withGoogleAuth(context(), execute)).rejects.toThrow(
      "access removed"
    );
    expect(boundary.token).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    boundary.enrolled = true;
    await expect(
      withGoogleAuth(context(), async () => {
        boundary.enrolled = false;
        return "private provider result";
      })
    ).rejects.toThrow("Google Workspace operation failed");
  });
});
