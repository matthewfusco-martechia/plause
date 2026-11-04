import { describe, expect, it } from "vitest";
import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "eve/events";
import {
  inkboxInteractionToken,
  renderInkboxInteraction,
  resolveInkboxAnswer,
  type InkboxPendingInteraction,
} from "./interactions";

const secret = "fictional-interaction-secret-at-least-32-characters";
const address = "inkbox:identity:conversation:assignment";
const ownerId = "better-auth:fixture-owner";
const scope = {
  sessionId: "fixture-session",
  interactionId: "fixture-interaction",
  ownerId,
  address,
};
const token = inkboxInteractionToken(secret, scope);
const now = 1_800_000_000_000;
const approval: InkboxPendingInteraction = {
  interactionId: scope.interactionId,
  ownerId,
  address,
  expiresAt: now + 300_000,
  request: {
    kind: "approval",
    prompt: "Send the reviewed calendar invitation?",
    options: [
      { id: APPROVE_OPTION_ID, label: "Approve" },
      { id: DENY_OPTION_ID, label: "Deny" },
    ],
  },
};

describe("Inkbox owner-bound interaction replies", () => {
  it("requires the exact live token and explicit approval command", () => {
    const pending = { [token]: approval };
    expect(
      resolveInkboxAnswer(`APPROVE ${token}`, pending, ownerId, address, now)
    ).toEqual([
      { interactionId: scope.interactionId, optionId: APPROVE_OPTION_ID },
    ]);
    expect(
      resolveInkboxAnswer(`DENY ${token}`, pending, ownerId, address, now)
    ).toEqual([
      { interactionId: scope.interactionId, optionId: DENY_OPTION_ID },
    ]);
    expect(
      resolveInkboxAnswer("yes", pending, ownerId, address, now)
    ).toBeUndefined();
    expect(
      resolveInkboxAnswer(
        `APPROVE ${token} and change the recipient`,
        pending,
        ownerId,
        address,
        now
      )
    ).toEqual([]);
    expect(
      resolveInkboxAnswer(`REPLY ${token} yes`, pending, ownerId, address, now)
    ).toEqual([]);
  });

  it.each([
    ["better-auth:other-owner", address, now],
    [ownerId, "inkbox:identity:conversation:replacement-assignment", now],
    [ownerId, address, now + 300_000],
  ] as const)(
    "rejects a different owner, assignment or expired request",
    (owner, target, clock) => {
      expect(
        resolveInkboxAnswer(
          `APPROVE ${token}`,
          { [token]: approval },
          owner,
          target,
          clock
        )
      ).toEqual([]);
    }
  );

  it("cannot approve an interaction after its settled state is removed", () => {
    expect(
      resolveInkboxAnswer(`APPROVE ${token}`, {}, ownerId, address, now)
    ).toEqual([]);
  });

  it("binds deterministic tokens to session, interaction, owner and assignment", () => {
    expect(inkboxInteractionToken(secret, scope)).toBe(token);
    for (const field of [
      "sessionId",
      "interactionId",
      "ownerId",
      "address",
    ] as const) {
      expect(
        inkboxInteractionToken(secret, { ...scope, [field]: "different" })
      ).not.toBe(token);
    }
  });

  it("only answers listed choices unless the question permits free text", () => {
    const pending = {
      [token]: {
        ...approval,
        request: {
          kind: "question" as const,
          prompt: "Which day?",
          options: [{ id: "monday", label: "Monday" }],
          allowFreeform: false,
        },
      },
    };
    expect(
      resolveInkboxAnswer(`REPLY ${token} 1`, pending, ownerId, address, now)
    ).toEqual([{ interactionId: scope.interactionId, optionId: "monday" }]);
    expect(
      resolveInkboxAnswer(
        `REPLY ${token} Tuesday`,
        pending,
        ownerId,
        address,
        now
      )
    ).toEqual([]);
    Object.assign(pending[token]?.request ?? {}, { allowFreeform: true });
    expect(
      resolveInkboxAnswer(
        `REPLY ${token} Tuesday`,
        pending,
        ownerId,
        address,
        now
      )
    ).toEqual([{ interactionId: scope.interactionId, text: "Tuesday" }]);
  });

  it("renders complete action details and never silently truncates approval content", () => {
    const text = renderInkboxInteraction(approval.request, token, {
      name: "create_event",
      input: {
        summary: "Fictional event",
        attendees: ["fictional@example.com"],
      },
    });
    expect(text).toContain("fictional@example.com");
    expect(text).toContain(`APPROVE ${token}`);
    expect(() =>
      renderInkboxInteraction(
        { ...approval.request, prompt: "x".repeat(19_000) },
        token
      )
    ).toThrow("too large");
  });

  it("permits private HTTPS sign-in links and rejects insecure links", () => {
    const request = {
      kind: "sign-in" as const,
      prompt: "Connect your account.",
      signIn: {
        name: "Google",
        url: "https://accounts.google.com/example",
        userCode: "FICTIONAL",
      },
    };
    expect(renderInkboxInteraction(request, token)).toContain(
      "Code: FICTIONAL"
    );
    expect(() =>
      renderInkboxInteraction(
        {
          ...request,
          signIn: { ...request.signIn, url: "http://example.com" },
        },
        token
      )
    ).toThrow("HTTPS");
  });
});
