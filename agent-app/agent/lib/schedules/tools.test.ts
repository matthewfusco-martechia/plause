import { describe, expect, it } from "vitest";
import { toolContextFor } from "@tests/helpers/tool-context";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { scheduleOwner, scheduleReplyAnchor } from "./tools";
import { scheduledReportIdentity } from "./identity";

const scope = accessScopeForUser("better-auth:fixture-owner");
const address =
  "inkbox:10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000001:40000000-0000-4000-8000-000000000001";
const messageId = "30000000-0000-4000-8000-000000000001";

function context(conversationId = address) {
  return toolContextFor({
    auth: {
      current: {
        principalType: "user",
        principalId: scope.userId,
        authenticator: "inkbox-verified-phone",
        attributes: {
          workspaceId: scope.workspaceId,
          conversationChannel: "inkbox",
          conversationId,
          inkboxMessageId: messageId,
        },
      },
      initiator: null,
    },
  });
}

describe("Inkbox schedule ownership and reply anchors", () => {
  it("stores the complete identity/conversation/assignment destination and current provider message", () => {
    expect(scheduleOwner(context())).toEqual({
      scope,
      conversation: { conversationChannel: "inkbox", conversationId: address },
    });
    expect(scheduleReplyAnchor(context())).toBe(messageId);
  });

  it("rejects omitted or malformed assignment scope", () => {
    expect(() =>
      scheduleOwner(context(address.split(":").slice(0, 3).join(":")))
    ).toThrow("Invalid input");
    expect(() =>
      scheduleOwner(
        context(
          address.replace("40000000-0000-4000-8000-000000000001", "arbitrary")
        )
      )
    ).toThrow("Invalid input");
  });

  it("selects only the current channel's scheduled report anchor", () => {
    const auth = context().session.auth;
    if (!auth.current) throw new Error("Missing fixture principal");
    const report = {
      ...auth.current,
      authenticator: "scheduled-result",
      attributes: {
        ...auth.current.attributes,
        inkboxReplyAnchorMessageId: messageId,
        linqReplyAnchorMessageId: "wrong-provider",
        scheduleId: "50000000-0000-4000-8000-000000000001",
        scheduledReportLeaseToken: "60000000-0000-4000-8000-000000000001",
        scheduledReportSequence: "1",
        scheduledRunId: "70000000-0000-4000-8000-000000000001",
      },
    };
    expect(
      scheduledReportIdentity({ current: report, initiator: null })
        ?.replyAnchorMessageId
    ).toBe(messageId);
  });
});
