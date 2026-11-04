import type { LinqChannelConfig } from "eve/channels/linq";
import { Message } from "chat";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
import {
  linqWebhookVerifier,
  resolveVerifiedLinqMessage,
} from "@agent/channels/linq";

interface AuthUserRow {
  readonly id: string;
  readonly phoneNumberVerified: boolean;
}

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as LinqChannelConfig | undefined,
  findOne: vi.fn<() => Promise<AuthUserRow | null>>(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      MESSAGING_PROVIDER: "linq",
      PRIVATE_ALLOWED_PHONE_NUMBERS: "+15550100011",
      LINQ_API_KEY: "linq-test-api-key",
      LINQ_PHONE_NUMBER: "+15550100000",
      LINQ_WEBHOOK_SIGNING_SECRET: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
    },
  };
});
vi.mock(import("eve/channels/linq"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    linqChannel(config: LinqChannelConfig) {
      capture.config = config;
      return original.linqChannel(config);
    },
  };
});
vi.mock("@db/services/auth", () => ({
  getAuth: async () => ({
    $context: Promise.resolve({ adapter: { findOne: capture.findOne } }),
  }),
}));

const verifier = linqWebhookVerifier;
const onMessage = resolveVerifiedLinqMessage;

describe("Linq inbound authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a webhook without a direct signature", async () => {
    const request = new Request("https://assistant.example/eve/v1/linq", {
      body: "{}",
      method: "POST",
    });
    expect(await verifier(request, new Uint8Array())).toBe(false);
  });

  it("rejects a webhook with a malformed bearer token", async () => {
    const request = new Request("https://assistant.example/eve/v1/linq", {
      body: "{}",
      headers: { authorization: "Bearer aaa.bbb.ccc" },
      method: "POST",
    });
    expect(await verifier(request, new Uint8Array())).toBe(false);
  });

  it("accepts the signed raw body only for the assigned direct-message line", async () => {
    const { request, bytes } = signedWebhook();
    expect(await verifier(request, bytes)).toBe(true);
  });

  it.each([
    { owner: "+15550100099" },
    { group: true },
    { group: undefined },
    { reconciledAt: "2026-09-01T00:00:00Z" },
    { version: "2025-01-01" },
    { timestamp: Math.floor(Date.now() / 1000) - 600 },
    { timestamp: Math.floor(Date.now() / 1000) + 600 },
  ])(
    "rejects authenticated but ineligible webhook metadata %j",
    async (options) => {
      const { request, bytes } = signedWebhook(options);
      expect(await verifier(request, bytes)).toBe(false);
    }
  );

  it("rejects modified raw JSON and a changed event-id header", async () => {
    const { request, bytes } = signedWebhook();
    expect(
      await verifier(
        request,
        new TextEncoder().encode(`${new TextDecoder().decode(bytes)} `)
      )
    ).toBe(false);
    request.headers.set("webhook-id", "different-event");
    expect(await verifier(request, bytes)).toBe(false);
  });

  it("supports signing-key rotation signatures without accepting a bad signature", async () => {
    const { request, bytes } = signedWebhook();
    const goodSignature = request.headers.get("webhook-signature");
    if (!goodSignature) throw new Error("Fixture signature missing");
    request.headers.set(
      "webhook-signature",
      `v1,${Buffer.alloc(32).toString("base64")} ${goodSignature}`
    );
    expect(await verifier(request, bytes)).toBe(true);
  });

  it("drops messages from handles that are not linked to a verified user", async () => {
    capture.findOne.mockResolvedValue(null);

    await expect(
      onMessage(threadContext(), linqMessage("+15550100011"))
    ).resolves.toBeNull();
    expect(capture.findOne).toHaveBeenCalledExactlyOnceWith({
      model: "user",
      where: [{ field: "phoneNumber", value: "+15550100011" }],
    });
  });

  it("drops messages from handles whose user has not verified the phone", async () => {
    capture.findOne.mockResolvedValue({
      id: "user-1",
      phoneNumberVerified: false,
    });

    await expect(
      onMessage(threadContext(), linqMessage("+15550100011"))
    ).resolves.toBeNull();
  });

  it("scopes a verified handle to that user's own workspace", async () => {
    capture.findOne.mockResolvedValue({
      id: "user-1",
      phoneNumberVerified: true,
    });

    const result = await onMessage(
      threadContext(),
      linqMessage("+15550100011")
    );

    expect(result?.auth.principalId).toBe("better-auth:user-1");
    expect(result?.auth.attributes).toMatchObject({
      conversationChannel: "linq",
      conversationId: "linq:dm:chat-1",
      linqMessageId: "message-1",
      phoneNumber: "+15550100011",
    });
    expect(result?.auth.attributes.workspaceId).toMatch(
      /^personal:[0-9a-f]{32}$/
    );
  });
});

function signedWebhook(
  options: {
    owner?: string;
    group?: boolean | undefined;
    reconciledAt?: string;
    version?: string;
    timestamp?: number;
  } = {}
) {
  const id = "event-1";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    webhook_version: options.version ?? "2026-02-03",
    event_id: id,
    event_type: "message.received",
    data: {
      id: "message-1",
      direction: "inbound",
      sender_handle: { handle: "+15550100011", is_me: false },
      chat: {
        id: "chat-1",
        is_group: Object.hasOwn(options, "group") ? options.group : false,
        owner_handle: { handle: options.owner ?? "+15550100000", is_me: true },
      },
      reconciled_at: options.reconciledAt,
    },
  });
  const mac = createHmac("sha256", Buffer.alloc(32, 7))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    bytes: new TextEncoder().encode(body),
    request: new Request("https://assistant.example/eve/v1/linq", {
      method: "POST",
      body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${mac}`,
      },
    }),
  };
}

type InboundContext = Parameters<
  NonNullable<LinqChannelConfig["onMessage"]>
>[0];

interface ThreadIdentity {
  readonly thread: Pick<InboundContext["thread"], "id">;
}

function threadContext(): InboundContext {
  const identity: ThreadIdentity = { thread: { id: "linq:dm:chat-1" } };
  // SAFETY: The inbound policy reads only the thread id from this context.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Chat SDK thread mock would add unrelated methods.
  return identity as InboundContext;
}

function linqMessage(handle: string) {
  return new Message({
    attachments: [],
    author: {
      fullName: handle,
      isBot: false,
      isMe: false,
      userId: handle,
      userName: handle,
    },
    formatted: { children: [], type: "root" },
    id: "message-1",
    metadata: {
      dateSent: new Date("2026-09-03T00:00:00.000Z"),
      edited: false,
    },
    raw: {},
    text: "list my vault items",
    threadId: "linq:dm:chat-1",
  });
}
