import type * as EveTools from "eve/tools";
import type * as Environment from "@shared/environment";
import type * as BrowserActions from "@db/services/browser-actions";
import type * as Access from "@agent/subagents/browser-agent/lib/access";
import type * as Owned from "@agent/subagents/browser-agent/lib/owned-browser";
import type * as Native from "@agent/subagents/browser-agent/lib/autofill/native";
import type * as Semantic from "@agent/subagents/browser-agent/lib/semantic-loop";
import type { AccessScope } from "@shared/identity/access-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { toolContextFor } from "@tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  flag: "false",
  scope: vi.fn<typeof Access.requireWorkerScope>(),
  owned: vi.fn<typeof Owned.requireOwnedBrowserSession>(),
  origin: vi.fn<typeof Native.currentKernelPageOrigin>(),
  fill: vi.fn<typeof Native.fillWithKernelNativeAutofill>(),
  semantic: vi.fn<typeof Semantic.executeBrowserLoopTool>(),
  enrolled: vi.fn<(scope: AccessScope) => Promise<void>>(),
  start: vi.fn<typeof BrowserActions.startBrowserAction>(),
  complete: vi.fn<typeof BrowserActions.completeBrowserAction>(),
  unknown: vi.fn<typeof BrowserActions.markBrowserActionUnknown>(),
}));
vi.mock("@shared/environment", async (importOriginal) => {
  const actual = await importOriginal<typeof Environment>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get BROWSER_ACTIONS_ENABLED() {
        return mocks.flag;
      },
    },
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: mocks.enrolled,
}));
vi.mock("@db/services/browser-actions", () => ({
  startBrowserAction: mocks.start,
  completeBrowserAction: mocks.complete,
  markBrowserActionUnknown: mocks.unknown,
}));
vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: mocks.scope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.owned,
}));
vi.mock(
  "@agent/subagents/browser-agent/lib/autofill/native",
  async (importOriginal) => ({
    ...(await importOriginal<typeof Native>()),
    currentKernelPageOrigin: mocks.origin,
    fillWithKernelNativeAutofill: mocks.fill,
  })
);
vi.mock(
  "@agent/subagents/browser-agent/lib/semantic-loop",
  async (importOriginal) => ({
    ...(await importOriginal<typeof Semantic>()),
    executeBrowserLoopTool: mocks.semantic,
  })
);
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("eve/context", () => ({
  defineState: <T>(_name: string, initial: () => T) => {
    let value = initial();
    return {
      get: () => value,
      update: (update: (current: T) => T) => {
        value = update(value);
      },
    };
  },
}));

import {
  claimBrowserAction,
  browserActionApproval,
} from "@agent/subagents/browser-agent/lib/action-authority";
import inspectBrowserAction from "@agent/subagents/browser-agent/tools/inspect_browser_action";
import computerAction from "@agent/subagents/browser-agent/tools/computer_action";
import semanticBrowser from "@agent/subagents/browser-agent/tools/semantic_browser";
import fillFromVault from "@agent/subagents/browser-agent/tools/fill_from_vault";
import fillFromLink from "@agent/subagents/browser-agent/tools/fill_from_link";
import manageBrowsers from "@agent/subagents/browser-agent/tools/manage_browsers";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";

const scope = {
  userId: "better-auth:fixture",
  workspaceId: "workspace-fixture",
};
const browser = "browser-fixture";
const batch = vi.spyOn(kernel.browsers.computer, "batch");
const clipboard = vi.spyOn(kernel.browsers.computer, "readClipboard");
const createBrowser = vi.spyOn(kernel.browsers, "create");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag = "false";
  mocks.scope.mockResolvedValue(scope);
  mocks.owned.mockResolvedValue({
    createdAt: "2026-11-02T00:00:00Z",
    sessionId: browser,
    workerSessionId: "worker-fixture",
  });
  mocks.origin.mockResolvedValue("https://shop.example");
  mocks.enrolled.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue("fixture-action");
  mocks.complete.mockResolvedValue(undefined);
  mocks.unknown.mockResolvedValue(undefined);
  batch.mockResolvedValue(undefined);
  clipboard.mockResolvedValue({ text: "read only" });
  mocks.semantic.mockImplementation(
    async (_browser, _spec, _input, _signal, beforeDispatch) => {
      await beforeDispatch?.();
      return {
        content: [{ type: "text", text: "fixture inspection" }],
        details: { statusText: "done" },
      };
    }
  );
});
afterEach(() => {
  vi.useRealTimers();
});

function principal(value: string) {
  return {
    principalId: "fixture",
    principalType: "user",
    issuer: "fixture",
    authenticator: value,
    attributes: {},
  };
}
function context(authenticator?: string, initiator?: string) {
  return toolContextFor({
    sessionId: "worker-fixture",
    parentSessionId: "root-fixture",
    auth: {
      current: authenticator ? principal(authenticator) : null,
      initiator: initiator ? principal(initiator) : null,
    },
  });
}
async function observation(ctx = context()) {
  const result = await inspectBrowserAction.execute(
    { session_id: browser },
    ctx
  );
  if (!("actionContext" in result))
    throw new Error("Expected one inspection result.");
  return result;
}
async function semantic(name: string) {
  return dynamicTool(
    await evaluateDynamic(semanticBrowser, dynamicContextFor()),
    name
  );
}

describe("browser action authority", () => {
  it("keeps structured inspection available with actions disabled", async () => {
    await Promise.all(
      [
        "browser_snapshot",
        "browser_text",
        "browser_find",
        "browser_wait_for",
      ].map(async (name) => {
        const tool = await semantic(name);
        expect(tool.approval).toBeUndefined();
        await tool.execute(
          { session_id: browser, query: "heading" },
          { ...context(), toolName: name }
        );
      })
    );
    const result = await observation();
    expect(result.actionContext.origin).toBe("https://shop.example");
    expect(result.expiresAt - result.observedAt).toBe(300_000);
    expect(mocks.semantic).toHaveBeenCalledTimes(4);
    expect(batch).not.toHaveBeenCalled();
  });

  it("denies unavailable actions before an approval prompt and before execution", async () => {
    const request = browserActionApproval();
    expect(await request({ ...context(), toolInput: {} })).toMatchObject({
      type: "denied",
    });
    const result = await observation();
    await expect(
      computerAction.execute(
        {
          session_id: browser,
          actionContext: result.actionContext,
          actions: [{ type: "press_key", press_key: { keys: ["ENTER"] } }],
        },
        context()
      )
    ).rejects.toThrow("disabled");
    await expect(
      manageBrowsers.execute(
        { action: "create", start_url: "https://shop.example" },
        context()
      )
    ).rejects.toThrow("disabled");
    expect(batch).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it("requires fresh human approval on every enabled action tool call", async () => {
    mocks.flag = "true";
    await Promise.all(
      [
        computerAction,
        fillFromVault,
        fillFromLink,
        await semantic("browser_act"),
        await semantic("playwright_execute"),
      ].map(async (tool) => {
        const approval = tool.approval;
        if (!(approval instanceof Function))
          throw new Error("Missing browser approval policy.");
        expect(await approval(context())).toBe("user-approval");
        expect(await approval(context())).toBe("user-approval");
      })
    );
    const approval = manageBrowsers.approval;
    if (!approval || approval instanceof Function)
      throw new Error("Missing lifecycle approval.");
    const { request } = approval;
    expect(
      await request({
        ...context(),
        toolInput: { action: "create", start_url: "https://shop.example" },
      })
    ).toBe("user-approval");
    expect(
      await request({
        ...context(),
        toolInput: { action: "delete", session_id: browser },
      })
    ).toBe("user-approval");
    expect(
      await request({
        ...context(),
        toolInput: { action: "get", session_id: browser },
      })
    ).toBe("not-applicable");
  });

  it.each(["scheduled-worker", "scheduled-result"])(
    "denies %s including an interactive continuation of its session",
    async (authenticator) => {
      mocks.flag = "true";
      await Promise.all(
        [context(authenticator), context("better-auth", authenticator)].map(
          async (ctx) => {
            expect(
              await browserActionApproval()({ ...ctx, toolInput: {} })
            ).toMatchObject({ type: "denied" });
            const result = await observation(ctx);
            await expect(
              claimBrowserAction(scope, browser, result.actionContext, ctx)
            ).rejects.toThrow("read-only");
          }
        )
      );
      expect(batch).not.toHaveBeenCalled();
    }
  );

  it("rejects invented or cross-scope observations without dispatch", async () => {
    mocks.flag = "true";
    const result = await observation();
    await expect(
      claimBrowserAction(
        scope,
        browser,
        { ...result.actionContext, observationId: crypto.randomUUID() },
        context()
      )
    ).rejects.toThrow("matching server");
    await expect(
      claimBrowserAction(
        { ...scope, workspaceId: "other" },
        browser,
        result.actionContext,
        context()
      )
    ).rejects.toThrow("matching server");
    await expect(
      claimBrowserAction(
        scope,
        "another-browser",
        result.actionContext,
        context()
      )
    ).rejects.toThrow("matching server");
    await expect(
      claimBrowserAction(
        scope,
        browser,
        { ...result.actionContext, origin: "https://attacker.example" },
        context()
      )
    ).rejects.toThrow("matching server");
    await expect(
      claimBrowserAction(scope, browser, result.actionContext, {
        ...context(),
        session: { ...context().session, id: "another-worker" },
      })
    ).rejects.toThrow("matching server");
  });

  it("expires observations using server time and rejects backdated clocks", async () => {
    mocks.flag = "true";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
    const result = await observation();
    vi.setSystemTime(result.expiresAt);
    await expect(
      claimBrowserAction(scope, browser, result.actionContext, context())
    ).rejects.toThrow("expired");
    const next = await observation();
    vi.setSystemTime(next.observedAt - 1);
    await expect(
      claimBrowserAction(scope, browser, next.actionContext, context())
    ).rejects.toThrow("expired");
  });

  it("checks the current origin, then consumes the observation after a mismatch", async () => {
    mocks.flag = "true";
    const result = await observation();
    mocks.origin.mockResolvedValue("https://attacker.example");
    await expect(
      claimBrowserAction(scope, browser, result.actionContext, context())
    ).rejects.toThrow("origin changed");
    mocks.origin.mockResolvedValue("https://shop.example");
    await expect(
      claimBrowserAction(scope, browser, result.actionContext, context())
    ).rejects.toThrow("matching server");
  });

  it("stops later computer chunks when navigation changes the page after an earlier chunk", async () => {
    mocks.flag = "true";
    const result = await observation();
    mocks.origin
      .mockResolvedValueOnce("https://shop.example")
      .mockResolvedValueOnce("https://shop.example")
      .mockResolvedValueOnce("https://other.example");
    await expect(
      computerAction.execute(
        {
          session_id: browser,
          actionContext: result.actionContext,
          actions: [
            { type: "click_mouse", click_mouse: { x: 10, y: 20 } },
            { type: "read_clipboard" },
            { type: "type_text", type_text: { text: "Must not be sent" } },
          ],
        },
        context()
      )
    ).rejects.toThrow("may have taken effect");
    expect(batch).toHaveBeenCalledOnce();
    const sent = batch.mock.calls[0]?.[1].actions;
    expect(sent).toEqual([
      { type: "click_mouse", click_mouse: { x: 10, y: 20 } },
    ]);
  });

  it("never reuses an action observation after a provider timeout", async () => {
    mocks.flag = "true";
    const result = await observation();
    const input = {
      session_id: browser,
      actionContext: result.actionContext,
      actions: [{ type: "press_key" as const, press_key: { keys: ["ENTER"] } }],
    };
    batch.mockRejectedValueOnce(new Error("Uncertain provider outcome."));
    await expect(computerAction.execute(input, context())).rejects.toThrow(
      "may have taken effect"
    );
    await expect(computerAction.execute(input, context())).rejects.toThrow(
      "matching server"
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(mocks.unknown).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("commits the dispatch marker before mutation and records completion after it", async () => {
    mocks.flag = "true";
    const result = await observation();
    await computerAction.execute(
      {
        session_id: browser,
        actionContext: result.actionContext,
        actions: [{ type: "press_key", press_key: { keys: ["ENTER"] } }],
      },
      context()
    );
    expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(
      batch.mock.invocationCallOrder[0] ?? 0
    );
    expect(batch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.complete.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.start).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        rootSessionId: "root-fixture",
        workerSessionId: "worker-fixture",
        callId: "test-call",
        observationId: result.actionContext.observationId,
      })
    );
    expect(mocks.unknown).not.toHaveBeenCalled();
  });

  it("does not mutate when the durable receipt cannot be recorded", async () => {
    mocks.flag = "true";
    const result = await observation();
    mocks.start.mockRejectedValueOnce(
      new Error("Receipt storage unavailable.")
    );
    await expect(
      computerAction.execute(
        {
          session_id: browser,
          actionContext: result.actionContext,
          actions: [{ type: "press_key", press_key: { keys: ["ENTER"] } }],
        },
        context()
      )
    ).rejects.toThrow("Receipt storage unavailable");
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.unknown).not.toHaveBeenCalled();
  });

  it("revalidates an enabled semantic action after awaited resource preparation", async () => {
    mocks.flag = "true";
    const result = await observation();
    mocks.semantic.mockImplementationOnce(
      async (_browser, _spec, _input, _signal, beforeDispatch) => {
        mocks.enrolled.mockRejectedValue(new Error("Enrollment removed."));
        await beforeDispatch?.();
        throw new Error("Must not reach the provider.");
      }
    );
    const tool = await semantic("playwright_execute");
    await expect(
      tool.execute(
        {
          session_id: browser,
          actionContext: result.actionContext,
          code: "return await page.title()",
        },
        { ...context(), toolName: "playwright_execute" }
      )
    ).rejects.toThrow("may have taken effect");
  });

  it("does not retrieve wallet credentials or autofill when the deployment is disabled", async () => {
    const result = await observation();
    const ctx = context();
    const token = vi.spyOn(ctx, "getToken");
    await expect(
      fillFromLink.execute(
        {
          actionContext: result.actionContext,
          browserSessionId: browser,
          spendRequestId: "spr_fixture",
          amount: 100,
          currency: "usd",
        },
        ctx
      )
    ).rejects.toThrow("disabled");
    await expect(
      fillFromVault.execute(
        {
          actionContext: result.actionContext,
          browserSessionId: browser,
          candidateId: "vault-fixture",
        },
        ctx
      )
    ).rejects.toThrow("disabled");
    expect(token).not.toHaveBeenCalled();
    expect(mocks.fill).not.toHaveBeenCalled();
  });
});
