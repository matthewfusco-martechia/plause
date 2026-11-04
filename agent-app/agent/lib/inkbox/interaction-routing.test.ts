import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVE_OPTION_ID,
  DENY_OPTION_ID,
  type Fact,
  type InteractionOpened,
  type InteractionSettled,
} from "eve/events";
import type { SessionReader } from "eve/sessions";
import { readInkboxOutbound } from "@db/services/inkbox-outbox";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { inkboxInteractionToken } from "./interactions";
import { resolveInkboxStreamAnswer } from "./interaction-routing";

const secret = "fictional-interaction-routing-secret-at-least-32-characters";
vi.mock("@shared/environment", () => ({
  env: {
    INTERNAL_SERVICE_SECRET:
      "fictional-interaction-routing-secret-at-least-32-characters",
  },
}));
vi.mock("@db/services/inkbox-outbox", () => ({
  readInkboxOutbound: vi.fn<typeof readInkboxOutbound>(),
}));

type StreamEvent =
  ReturnType<SessionReader["stream"]> extends AsyncIterable<infer Event>
    ? Event
    : never;

const now = new Date("2026-11-03T14:00:00.000Z");
const scope = accessScopeForUser("better-auth:fixture-owner");
const address = "inkbox:identity:conversation:assignment";
const sessionId = "parent-session";
const interactionId = "parent-relay-interaction";
const outbox = new Map<
  string,
  NonNullable<Awaited<ReturnType<typeof readInkboxOutbound>>>
>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  outbox.clear();
  outbox.set(promptKey(), receipt());
  vi.mocked(readInkboxOutbound).mockImplementation(async (_scope, key) =>
    outbox.get(key)
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Inkbox pre-admission interaction routing", () => {
  it("does not read private history or the outbox for ordinary messages", async () => {
    const session = reader([opened()]);
    const results = await Promise.all(
      ["Hello", "yes", "approve", "1", "APPROVE invalid"].map((text) =>
        resolveInkboxStreamAnswer(session, text, scope, address)
      )
    );
    expect(results).toEqual(Array.from({ length: 5 }, () => undefined));
    expect(session.stream).not.toHaveBeenCalled();
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });

  it("resolves a delegated parent request before fixed-session respond admission", async () => {
    const event = opened({
      origin: {
        sessionId: "browser-child-session",
        interactionId: "child-approval",
        call: {
          callId: "browser-call",
          name: "browser_click",
          input: { selector: "#fictional-submit" },
        },
      },
    });
    const session = reader([event]);
    const answers = await resolveInkboxStreamAnswer(
      session,
      `APPROVE ${token()}`,
      scope,
      address
    );
    expect(answers).toEqual([{ interactionId, optionId: APPROVE_OPTION_ID }]);
    // The runtime fixture separately drives public respond with this parent-ID shape.
    const options = session.stream.mock.calls[0]?.[0];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(session.stream).toHaveBeenCalledExactlyOnceWith({
      startIndex: -256,
      follow: false,
      signal: options?.signal,
    });
    expect(readInkboxOutbound).toHaveBeenCalledExactlyOnceWith(
      scope,
      promptKey()
    );
  });

  it("also maps exact denial and choice/free-text replies", async () => {
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened()]),
        `DENY ${token()}`,
        scope,
        address
      )
    ).toEqual([{ interactionId, optionId: DENY_OPTION_ID }]);
    const event = opened({
      request: {
        kind: "question",
        prompt: "Choose a fictional day.",
        options: [{ id: "monday", label: "Monday" }],
        allowFreeform: true,
      },
    });
    expect(
      await resolveInkboxStreamAnswer(
        reader([event]),
        `REPLY ${token()} 1`,
        scope,
        address
      )
    ).toEqual([{ interactionId, optionId: "monday" }]);
    expect(
      await resolveInkboxStreamAnswer(
        reader([event]),
        `REPLY ${token()} Tuesday`,
        scope,
        address
      )
    ).toEqual([{ interactionId, text: "Tuesday" }]);
  });

  it.each(["accepted", "withdrawn", "expired", "declined"] as const)(
    "does not revive an interaction after it is %s",
    async (outcome) => {
      const settled: InteractionSettled = {
        type: "interaction.settled",
        data: { interactionId, outcome },
      };
      expect(
        await resolveInkboxStreamAnswer(
          reader([opened(), received(settled, 2)]),
          `APPROVE ${token()}`,
          scope,
          address
        )
      ).toEqual([]);
      expect(readInkboxOutbound).not.toHaveBeenCalled();
    }
  );

  it("rejects an ended session, including an opening replayed after its end", async () => {
    const ended = received({
      type: "session.ended",
      data: { outcome: "completed" },
    });
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened(), ended, opened()]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });

  it("requires the exact owner audience and session/assignment token", async () => {
    const otherAudience = opened({
      audience: { principalIds: ["better-auth:another-owner"] },
    });
    expect(
      await resolveInkboxStreamAnswer(
        reader([otherAudience]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened()]),
        `APPROVE ${token()}`,
        scope,
        `${address}-new-assignment`
      )
    ).toEqual([]);
    const replacement = reader([opened()]);
    replacement.id = "replacement-session";
    expect(
      await resolveInkboxStreamAnswer(
        replacement,
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["expired", new Date(now.getTime() - 300_000)],
    ["future", new Date(now.getTime() + 1)],
    ["invalid", new Date(Number.NaN)],
  ] as const)(
    "requires the original durable prompt timestamp: %s",
    async (_label, createdAt) => {
      outbox.clear();
      if (createdAt) outbox.set(promptKey(), receipt(createdAt));
      expect(
        await resolveInkboxStreamAnswer(
          reader([opened()]),
          `APPROVE ${token()}`,
          scope,
          address
        )
      ).toEqual([]);
    }
  );

  it("does not extend TTL when the opening is read again with fresh metadata", async () => {
    outbox.set(promptKey(), receipt(new Date(now.getTime() - 299_999)));
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened()]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toHaveLength(1);
    vi.setSystemTime(new Date(now.getTime() + 1));
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened()]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
  });

  it("rejects a request that expires while its owner-bound receipt is read", async () => {
    vi.mocked(readInkboxOutbound).mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 300_000));
      return receipt(now);
    });
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened()]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
  });

  it("rejects duplicate openings rather than substituting reviewed details", async () => {
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened(), opened()]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });

  it("ignores unrecognized tokens and control/action mismatches without receipt reads", async () => {
    const results = await Promise.all(
      [
        `APPROVE ${"0".repeat(24)}`,
        `APPROVE ${token()} change the recipient`,
        `REPLY ${token()} yes`,
      ].map((text) =>
        resolveInkboxStreamAnswer(reader([opened()]), text, scope, address)
      )
    );
    expect(results).toEqual([[], [], []]);
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });

  it("keeps sign-in controls distinct from action approvals", async () => {
    const event = opened({
      request: {
        kind: "sign-in",
        prompt: "Connect the fictional account.",
        signIn: { name: "Google", url: "https://accounts.google.com/example" },
      },
    });
    expect(
      await resolveInkboxStreamAnswer(
        reader([event]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
  });

  it("fails closed when stream or ownership lookup is unavailable", async () => {
    const unavailable = reader([]);
    unavailable.stream.mockImplementation(() => {
      throw new Error("Fictional unavailable private history.");
    });
    expect(
      await resolveInkboxStreamAnswer(
        unavailable,
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    vi.mocked(readInkboxOutbound).mockRejectedValue(
      new Error("Fictional owner revoked.")
    );
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened()]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
  });

  it("stops on the event-count budget before reading authorization state", async () => {
    const events: StreamEvent[] = Array.from({ length: 2048 }, (_, index) =>
      received({
        type: "content.completed",
        data: {
          partId: `part-${String(index)}`,
          runId: "fixture-run",
          kind: "text",
          phase: "reply",
          value: "Fictional unrelated history.",
        },
      })
    );
    events.push(opened());
    expect(
      await resolveInkboxStreamAnswer(
        reader(events),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });

  it("bounds retained event bytes even with a small record count", async () => {
    const large = received({
      type: "content.completed",
      data: {
        partId: "large-fixture-part",
        runId: "fixture-run",
        kind: "text",
        phase: "reply",
        value: "x".repeat(2 * 1024 * 1024),
      },
    });
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened(), large]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });

  it("honors stream abort without admitting an answer", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      AbortSignal.abort(new Error("Fictional stream deadline."))
    );
    expect(
      await resolveInkboxStreamAnswer(
        reader([opened()]),
        `APPROVE ${token()}`,
        scope,
        address
      )
    ).toEqual([]);
    expect(readInkboxOutbound).not.toHaveBeenCalled();
  });
});

function reader(events: readonly StreamEvent[]) {
  const stream = vi.fn<SessionReader["stream"]>(async function* () {
    yield* events;
  });
  return { id: sessionId, stream };
}

function received<Event extends Fact>(event: Event, line = 1) {
  return {
    ...event,
    meta: { position: { line, index: 0 }, at: now.toISOString() },
  };
}

function opened(overrides: Partial<InteractionOpened["data"]> = {}) {
  const event: InteractionOpened = {
    type: "interaction.opened",
    data: {
      interactionId,
      subject: { callId: "delegating-call" },
      audience: { principalIds: [scope.userId] },
      request: {
        kind: "approval",
        prompt: "Approve the exact fictional browser action?",
        options: [
          { id: APPROVE_OPTION_ID, label: "Approve" },
          { id: DENY_OPTION_ID, label: "Deny" },
        ],
      },
      ...overrides,
    },
    scope: { turnId: "parent-turn", runId: "parent-run" },
  };
  return received(event);
}

function token() {
  return inkboxInteractionToken(secret, {
    sessionId,
    interactionId,
    ownerId: scope.userId,
    address,
  });
}

function promptKey() {
  return `inkbox-interaction:${sessionId}:${interactionId}`;
}

function receipt(createdAt = now) {
  return {
    key: "fixture-outbox-key",
    idempotencyKey: promptKey(),
    userId: "fixture-owner",
    workspaceId: scope.workspaceId,
    identityDigest: "a".repeat(64),
    ownerDigest: "b".repeat(64),
    destinationDigest: "c".repeat(64),
    bodyDigest: "d".repeat(64),
    intentDigest: "e".repeat(64),
    bodyCiphertext: "encrypted-fixture-prompt",
    providerMessageId: "10000000-0000-4000-8000-000000000001",
    status: "accepted" as const,
    attemptToken: "20000000-0000-4000-8000-000000000002",
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000),
    errorCode: null,
  };
}
