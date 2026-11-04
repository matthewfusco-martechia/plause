import type * as EveTools from "eve/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { toolContextFor } from "@tests/helpers/tool-context";
import type * as Environment from "@shared/environment";
import type * as Transport from "@agent/lib/inkbox/transport";
import type { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { InkboxClient } from "@shared/messaging/inkbox";
import messaging from "@agent/tools/messaging";

const controls = vi.hoisted(() => {
  const reset: (() => void)[] = [];
  return {
    reset,
    send: vi.fn<typeof Transport.sendInkboxMessage>(),
    assertUser: vi.fn<typeof assertEnrolledWorkspaceUser>(),
    sent: vi.fn<() => boolean | undefined>(),
    router: vi.fn<InkboxClient["getRouter"]>(),
  };
});
vi.mock("eve/tools", async (original) =>
  withEvaluableDynamic(await original<typeof EveTools>())
);
vi.mock("eve/context", () => ({
  defineState<T>(name: string, initial: () => T) {
    let value = initial();
    if (name === "openinstinct.contact-delivery")
      controls.sent.mockImplementation(
        () => z.object({ sent: z.boolean() }).nullable().parse(value)?.sent
      );
    controls.reset.push(() => {
      value = initial();
    });
    return {
      get: () => value,
      update(update: (current: T) => T) {
        value = update(value);
      },
    };
  },
}));
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: controls.assertUser,
}));
vi.mock("@agent/lib/inkbox/transport", async (original) => ({
  ...(await original<typeof Transport>()),
  sendInkboxMessage: controls.send,
}));
vi.mock("@shared/environment", async (original) => {
  const loaded = await original<typeof Environment>();
  return {
    ...loaded,
    env: {
      ...loaded.env,
      MESSAGING_PROVIDER: "inkbox",
      INKBOX_API_KEY: "fixture-inkbox-api-key",
      INKBOX_IDENTITY_ID: "10000000-0000-4000-8000-000000000001",
      INKBOX_AGENT_HANDLE: "plause",
      INTERNAL_SERVICE_SECRET: "fixture-internal-service-secret-0123456789",
    },
  };
});

const identityId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000002";
const assignmentId = "30000000-0000-4000-8000-000000000003";
const address = `inkbox:${identityId}:${conversationId}:${assignmentId}`;
const phone = "+15555550123";
const scope = accessScopeForUser("better-auth:fixture-owner");

beforeEach(() => {
  for (const reset of controls.reset) reset();
  vi.clearAllMocks();
  controls.assertUser.mockReset().mockResolvedValue(phone);
  controls.send.mockReset().mockResolvedValue({
    messageId: "40000000-0000-4000-8000-000000000004",
    status: "accepted",
  });
  controls.router.mockReset().mockResolvedValue({
    number: "+15555550999",
    connectCommand: "connect @plause",
    smsLink: "sms:+15555550999?&body=connect%20%40plause",
  });
  vi.spyOn(InkboxClient.prototype, "getRouter").mockImplementation(
    controls.router
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

function context(
  channel: "inkbox" | "eve" = "inkbox",
  conversation = address
): ToolContext {
  return toolContextFor({
    auth: {
      current: {
        authenticator: "inkbox-verified-phone",
        principalId: scope.userId,
        principalType: "user",
        attributes: {
          workspaceId: scope.workspaceId,
          phoneNumber: phone,
          conversationChannel: channel,
          conversationId: conversation,
        },
      },
      initiator: null,
    },
    callId: "contact-call",
    sessionId: "fixture-session",
    toolName: "share_contact",
    channel: { kind: `channel:${channel}`, metadata: {} },
  });
}
async function tool(name: string, channel: "inkbox" | "eve" = "inkbox") {
  const current = context(channel);
  const tools = await evaluateDynamic(
    messaging,
    dynamicContextFor({
      auth: current.session.auth,
      sessionId: current.session.id,
      channel: current.channel,
    })
  );
  return dynamicTool(tools, name);
}

describe("Inkbox messaging tool contracts", () => {
  it("shares handle/router instructions in the exact current assignment without claiming a dedicated contact card", async () => {
    const contact = await tool("share_contact");
    const output = await contact.execute(
      { text: "Here is how to reconnect." },
      context()
    );
    expect(output).toEqual({
      kind: "message",
      text: "Here is how to reconnect.\n\nPlause: @plause\nTo reconnect, send connect @plause using sms:+15555550999?&body=connect%20%40plause, then send hi. The shared connection number can change.",
    });
    expect(controls.send).toHaveBeenCalledExactlyOnceWith({
      scope,
      phoneNumber: phone,
      conversationId,
      assignmentId,
      text: z.object({ text: z.string() }).parse(output).text,
      idempotencyKey: "inkbox-contact:fixture-session",
    });
    expect(contact.description).toContain("does not send a contact card");
    expect(controls.sent()).toBe(true);
  });

  it("suppresses successful repeated sharing without a second provider send", async () => {
    const contact = await tool("share_contact");
    await contact.execute({ text: "Save the instructions." }, context());
    expect(
      await contact.execute({ text: "A second introduction." }, context())
    ).toBeNull();
    expect(controls.send).toHaveBeenCalledTimes(1);
    expect(controls.router).toHaveBeenCalledTimes(1);
  });

  it("keeps the first logical payload and stable key after an unconfirmed send", async () => {
    controls.send.mockRejectedValueOnce(new Error("Fixture provider unknown"));
    const contact = await tool("share_contact");
    await expect(
      contact.execute({ text: "Original introduction." }, context())
    ).rejects.toThrow("Fixture provider unknown");
    expect(controls.sent()).toBe(false);
    await contact.execute({ text: "A changed introduction." }, context());
    expect(controls.send.mock.calls[1]?.[0]).toEqual(
      controls.send.mock.calls[0]?.[0]
    );
    expect(controls.sent()).toBe(true);
  });

  it("requires the enrolled owner before looking up router instructions", async () => {
    controls.assertUser.mockRejectedValueOnce(
      new Error("Fixture enrollment revoked")
    );
    const contact = await tool("share_contact");
    await expect(
      contact.execute({ text: "Share." }, context())
    ).rejects.toThrow("Fixture enrollment revoked");
    expect(controls.router).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it.each([
    `inkbox:${identityId}:${conversationId}`,
    `inkbox:90000000-0000-4000-8000-000000000009:${conversationId}:${assignmentId}`,
    `inkbox:${identityId}:${conversationId}:not-an-assignment`,
    "linq:another-conversation",
  ])(
    "refuses a missing, malformed or cross-identity assignment address",
    async (target) => {
      const contact = await tool("share_contact");
      await expect(
        contact.execute({ text: "Share." }, context("inkbox", target))
      ).rejects.toBeInstanceOf(Error);
      expect(controls.send).not.toHaveBeenCalled();
      expect(controls.sent()).toBe(false);
    }
  );

  it("renders browser connection instructions without sending an iMessage or vCard", async () => {
    const contact = await tool("share_contact", "eve");
    const output = await contact.execute(
      { text: "Reconnect from Messages." },
      context("eve")
    );
    expect(output).toMatchObject({ kind: "message" });
    expect(z.object({ text: z.string() }).parse(output).text).toContain(
      "@plause"
    );
    expect(
      z.object({ attachments: z.unknown().optional() }).parse(output)
        .attachments
    ).toBeUndefined();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("advertises add-only emoji text acknowledgements and rejects native reaction removal", async () => {
    const reaction = await tool("react_to_message");
    expect(reaction.description).toContain("short emoji text reply");
    expect(reaction.description).toContain("not a native Tapback");
    expect(reaction.description).toContain("cannot be removed");
    if (!(reaction.inputSchema instanceof z.ZodType))
      throw new Error("Expected the authored reaction schema");
    expect(
      reaction.inputSchema.safeParse({ operation: "remove", type: "heart" })
        .success
    ).toBe(false);
    expect(
      reaction.inputSchema.safeParse({ operation: "add", type: "heart" })
        .success
    ).toBe(true);
    expect(
      await reaction.execute({ operation: "add", type: "heart" }, context())
    ).toEqual({ operation: "add", type: "heart" });
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("states the exact text limit and distinguishes attachment URLs from captured media", async () => {
    const send = await tool("send_message");
    expect(send.description).toContain("18,995 characters");
    expect(send.description).toContain(
      "HTTPS attachment URLs are shared as links"
    );
    expect(send.description).toContain("do not claim they were attached");
    const output = { kind: "link", url: "https://example.com/fictional" };
    expect(await send.execute(output, context())).toEqual(output);
    const finalOutput = await send.execute(
      { ...output, final: true },
      context()
    );
    if (!(send.endsTurn instanceof Function))
      throw new Error("Expected final reply handling.");
    expect(await send.endsTurn(finalOutput)).toBe(true);
    expect(await send.endsTurn(output)).toBe(false);
    expect(controls.send).not.toHaveBeenCalled();
  });
});
