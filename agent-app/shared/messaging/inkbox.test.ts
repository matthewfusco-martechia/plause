import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  InkboxClient,
  InkboxError,
  INKBOX_MAX_WEBHOOK_BYTES,
  inkboxDigest,
  inkboxWebhookSigningKeySchema,
  parseInkboxInboundBody,
  serializeInkboxMessage,
  verifyInkboxWebhook,
} from "./inkbox";

const identityId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000002";
const assignmentId = "30000000-0000-4000-8000-000000000003";
const messageId = "40000000-0000-4000-8000-000000000004";
const phone = "+15555550123";
const now = Date.parse("2026-11-03T14:00:00Z");
const signingKey = "fixture-inkbox-per-identity-signing-key-0123456789";
const configuration = {
  apiKey: "fixture-inkbox-api-key",
  identityId,
  agentHandle: "plause",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function inbound() {
  return {
    id: `evt_${messageId}`,
    event_type: "imessage.received",
    timestamp: new Date(now).toISOString(),
    data: {
      message: {
        id: messageId,
        conversation_id: conversationId,
        assignment_id: assignmentId,
        direction: "inbound",
        remote_number: phone,
        sender_number: null,
        participants: null,
        is_group: false,
        content: "A fictional message",
        message_type: "message",
        service: "imessage",
        status: "received",
        media: null,
        created_at: new Date(now).toISOString(),
      },
      contacts: [{ memories: ["UNTRUSTED PRIVATE PROVIDER MEMORY"] }],
      context: { texts: ["UNTRUSTED PROVIDER HISTORY"] },
    },
  };
}

function webhook(
  body: string | Uint8Array,
  timestamp = String(now / 1000),
  key = signingKey
) {
  const bytes = body instanceof Uint8Array ? body : Buffer.from(body);
  const requestId = "delivery-identifier";
  const signature = createHmac("sha256", key)
    .update(`${requestId}.${timestamp}.`)
    .update(bytes)
    .digest("hex");
  return new Request("https://plause.example/webhooks/inkbox", {
    method: "POST",
    headers: {
      "X-Inkbox-Request-ID": requestId,
      "X-Inkbox-Timestamp": timestamp,
      "X-Inkbox-Signature": `sha256=${signature}`,
    },
  });
}

function verify(body: string, request = webhook(body)) {
  return verifyInkboxWebhook(
    request,
    Buffer.from(body),
    { identityId, signingKey },
    now
  );
}
function json(value: z.infer<ReturnType<typeof z.json>>, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function conversation() {
  return {
    id: conversationId,
    assignment_id: assignmentId,
    assignment_status: "active",
    remote_number: phone,
    participants: [phone],
    is_group: false,
  };
}
function message() {
  return {
    id: messageId,
    conversation_id: conversationId,
    assignment_id: assignmentId,
    direction: "outbound",
    remote_number: phone,
    is_group: false,
    status: "pending",
    error_code: null,
  };
}
function sendInput() {
  return {
    conversationId,
    expectedAssignmentId: assignmentId,
    recipientPhoneNumber: phone,
    text: "A fictional reply",
    idempotencyKey: "fictional-stable-send-1",
    beforeSend: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
}

describe("Inkbox authenticated inbound protocol", () => {
  it.each([
    "x".repeat(32),
    "x".repeat(512),
    `whsec_${"x".repeat(32)}`,
    `whsec_${"x".repeat(512)}`,
  ])(
    "uses the same supported signing key contract in configuration and verification",
    (key) => {
      expect(inkboxWebhookSigningKeySchema.parse(key)).toBe(key);
      const body = JSON.stringify(inbound());
      const actual = key.startsWith("whsec_") ? key.slice(6) : key;
      expect(
        verifyInkboxWebhook(
          webhook(body, String(now / 1000), actual),
          Buffer.from(body),
          { identityId, signingKey: key },
          now
        )
      ).not.toBeNull();
    }
  );

  it.each([
    "",
    "x".repeat(31),
    "x".repeat(513),
    `whsec_${"x".repeat(31)}`,
    `${"x".repeat(32)}\n`,
    `${"x".repeat(32)} `,
    "ü".repeat(32),
  ])(
    "rejects an unusable configured signing key before trusting a webhook",
    (key) => {
      expect(inkboxWebhookSigningKeySchema.safeParse(key).success).toBe(false);
      const body = JSON.stringify(inbound());
      expect(
        verifyInkboxWebhook(
          webhook(body),
          Buffer.from(body),
          { identityId, signingKey: key },
          now
        )
      ).toBeNull();
    }
  );

  it("matches the official UTF8 HMAC contract and binds an identity without trusting provider memories", () => {
    const body = JSON.stringify(inbound());
    const result = verify(body);
    expect(result).toEqual({
      eventId: `evt_${messageId}`,
      messageId,
      conversationId,
      assignmentId,
      identityId,
      senderPhoneNumber: phone,
      timestamp: now,
      text: "A fictional message",
      media: [],
      replyToMessageId: null,
    });
    expect(
      verifyInkboxWebhook(
        webhook(body),
        Buffer.from(body),
        { identityId, signingKey: `whsec_${signingKey}` },
        now
      )
    ).toEqual(result);
    expect(inkboxDigest(body)).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseInkboxInboundBody(body, identityId, now)).toEqual(result);
  });

  it("authenticates original bytes and rejects a tampered body or key", () => {
    const body = JSON.stringify(inbound());
    expect(verify(`${body} `, webhook(body))).toBeNull();
    expect(
      verifyInkboxWebhook(
        webhook(body),
        Buffer.from(body),
        { identityId, signingKey: `${signingKey}-wrong` },
        now
      )
    ).toBeNull();
  });

  it.each([
    "sha256=0",
    "sha256=" + "A".repeat(64),
    "sha256=" + "a".repeat(64) + ",sha256=" + "b".repeat(64),
  ])("rejects malformed signature %s", (signature) => {
    const body = JSON.stringify(inbound());
    const request = webhook(body);
    request.headers.set("x-inkbox-signature", signature);
    expect(verify(body, request)).toBeNull();
  });

  it.each([-301, 301])(
    "rejects a signed delivery outside the freshness window (%s seconds)",
    (seconds) => {
      const body = JSON.stringify(inbound());
      expect(
        verify(body, webhook(body, String(now / 1000 + seconds)))
      ).toBeNull();
    }
  );

  it.each([-300, 300])(
    "accepts the exact freshness boundary (%s seconds)",
    (seconds) => {
      const body = JSON.stringify(inbound());
      expect(
        verify(body, webhook(body, String(now / 1000 + seconds)))
      ).not.toBeNull();
    }
  );

  it("rejects old messages even when delivery headers and envelope timestamp are fresh", () => {
    const event = inbound();
    event.data.message.created_at = new Date(now - 300_001).toISOString();
    expect(verify(JSON.stringify(event))).toBeNull();
  });

  it.each([
    { event_type: "imessage.sent" },
    { companion: { phase: "initialization" } },
    { reconciled_at: new Date(now).toISOString() },
    { agent_identity_id: "90000000-0000-4000-8000-000000000009" },
  ])("rejects a non-live or cross-identity envelope", (replacement) => {
    expect(verify(JSON.stringify({ ...inbound(), ...replacement }))).toBeNull();
  });

  it.each([
    { direction: "outbound" },
    { status: "sent" },
    { is_group: true },
    { remote_number: "person@example.com" },
    { service: "sms" },
    { is_blocked: true },
    { reconciled_at: new Date(now).toISOString() },
    { agent_identity_id: "90000000-0000-4000-8000-000000000009" },
  ])("rejects unsupported inbound scope", (replacement) => {
    const event = inbound();
    expect(
      verify(
        JSON.stringify({
          ...event,
          data: {
            ...event.data,
            message: { ...event.data.message, ...replacement },
          },
        })
      )
    ).toBeNull();
  });

  it("rejects malformed UTF8, oversize bodies and unsigned requests", () => {
    const bytes = new Uint8Array([0xff]);
    expect(
      verifyInkboxWebhook(
        webhook(bytes),
        bytes,
        { identityId, signingKey },
        now
      )
    ).toBeNull();
    const large = new Uint8Array(INKBOX_MAX_WEBHOOK_BYTES + 1);
    expect(
      verifyInkboxWebhook(
        webhook(large),
        large,
        { identityId, signingKey },
        now
      )
    ).toBeNull();
    expect(
      verify("{}", new Request("https://plause.example", { method: "POST" }))
    ).toBeNull();
  });

  it("retains bounded media metadata without fetching it, and refuses obvious private destinations", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const event = inbound();
    const media = {
      url: "https://media.inkbox.ai/fictional.png?signature=opaque",
      content_type: "image/png",
      size: 12,
    };
    const withMedia = {
      ...event,
      data: {
        ...event.data,
        message: { ...event.data.message, content: null, media: [media] },
      },
    };
    expect(verify(JSON.stringify(withMedia))?.media).toEqual([
      {
        url: "https://media.inkbox.ai/fictional.png?signature=opaque",
        contentType: "image/png",
        size: 12,
      },
    ]);
    media.url = "https://127.0.0.1/private";
    expect(verify(JSON.stringify(withMedia))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Inkbox fixed-origin client", () => {
  it("asserts the configured identity and constructs router instructions without trusting provider URLs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        number: phone,
        connect_command: "connect @plause",
        sms_link: "https://evil.example",
        connect_qr_png_data_url: "unsafe",
      })
    );
    vi.stubGlobal("fetch", fetch);
    expect(await new InkboxClient(configuration).getRouter()).toEqual({
      number: phone,
      connectCommand: "connect @plause",
      smsLink: `sms:${phone}?&body=connect%20%40plause`,
    });
    const url = requestUrl(fetch.mock.calls[0]?.[0]);
    expect(url.origin).toBe("https://inkbox.ai");
    expect(url.pathname).toBe("/api/v1/imessage/triage-number");
    expect(url.searchParams.get("agent_identity_id")).toBe(identityId);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("rejects a router command for another handle", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          json({ number: phone, connect_command: "connect @different" })
        )
    );
    await expect(
      new InkboxClient(configuration).getRouter()
    ).rejects.toMatchObject({ code: "inkbox_invalid_router" });
  });

  it("finds only an active exact-phone DM and rechecks the selected conversation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json([
          { ...conversation(), assignment_status: "released" },
          { ...conversation(), remote_number: "+15555550999" },
          conversation(),
        ])
      )
      .mockResolvedValueOnce(json(conversation()));
    vi.stubGlobal("fetch", fetch);
    expect(
      await new InkboxClient(configuration).findActiveConversation(phone)
    ).toEqual({
      conversationId,
      assignmentId,
      identityId,
      remotePhoneNumber: phone,
      assignmentStatus: "active",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never creates a contact when no active conversation exists", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json([]));
    vi.stubGlobal("fetch", fetch);
    expect(
      await new InkboxClient(configuration).findActiveConversation(phone)
    ).toBeNull();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      expect.any(URL),
      expect.objectContaining({ method: "GET" })
    );
  });

  it("bounds scans instead of guessing a conversation from an incomplete result", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        json(
          Array.from({ length: 50 }, () => ({
            ...conversation(),
            remote_number: "+15555550999",
          }))
        )
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new InkboxClient(configuration).findActiveConversation(phone)
    ).rejects.toMatchObject({ code: "inkbox_conversation_scan_limit" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([null, undefined])(
    "normalizes delivery_unconfirmed when error_code is %s",
    async (errorCode) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(json(conversation()))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ...message(),
              status: "error",
              error_code: errorCode,
              error_reason: "delivery_unconfirmed",
            }),
            { headers: { "Content-Type": "application/json" } }
          )
        );
      vi.stubGlobal("fetch", fetch);
      expect(
        await new InkboxClient(configuration).getMessage(
          messageId,
          conversationId,
          phone
        )
      ).toMatchObject({
        messageId,
        status: "error",
        errorCode: "send_outcome_ambiguous",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("sends exact canonical input with both replay headers after the final owner check", async () => {
    const order: string[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, init) => {
        order.push(init?.method === "POST" ? "post" : "read");
        return init?.method === "POST"
          ? json({ message: message() }, 201)
          : json(conversation());
      });
    vi.stubGlobal("fetch", fetch);
    const input = {
      ...sendInput(),
      replyToMessageId: messageId,
      beforeSend: async () => {
        order.push("authorize");
      },
    };
    const result = await new InkboxClient(configuration).sendMessage(input);
    expect(order).toEqual(["read", "authorize", "post"]);
    expect(result).toMatchObject({
      messageId,
      status: "pending",
      conversationId,
      recipientPhoneNumber: phone,
    });
    const request = fetch.mock.calls[1]?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get("idempotency-key")).toBe(input.idempotencyKey);
    expect(headers.get("prefer")).toBe("idempotency-replay");
    expect(request?.body).toBe(serializeInkboxMessage(input));
    expect(JSON.parse(z.string().parse(request?.body))).toEqual({
      conversation_id: conversationId,
      text: input.text,
      reply_to_message_id: messageId,
      plain_reply_fallback: true,
    });
  });

  it("blocks the POST after a final authorization rejection without leaking its message", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(conversation()));
    vi.stubGlobal("fetch", fetch);
    const failure = new InkboxClient(configuration).sendMessage({
      ...sendInput(),
      beforeSend: async () => {
        throw new Error("PRIVATE USER INFORMATION");
      },
    });
    await expect(failure).rejects.toEqual(
      new InkboxError("inkbox_authorization_failed")
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { assignment_status: "released" },
    { is_group: true },
    { remote_number: "+15555550999" },
    { participants: [phone, "+15555550999"] },
    { agent_identity_id: "90000000-0000-4000-8000-000000000009" },
  ])(
    "fails closed when the current conversation changes",
    async (replacement) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          json(z.json().parse({ ...conversation(), ...replacement }))
        );
      vi.stubGlobal("fetch", fetch);
      await expect(
        new InkboxClient(configuration).sendMessage(sendInput())
      ).rejects.toMatchObject({ outcomeUnknown: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it("refuses an old assignment even when the same phone has reconnected to the conversation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        ...conversation(),
        assignment_id: "90000000-0000-4000-8000-000000000009",
      })
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new InkboxClient(configuration).sendMessage(sendInput())
    ).rejects.toMatchObject({
      code: "inkbox_assignment_changed",
      outcomeUnknown: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([302, 409, 429, 500, 503])(
    "does not retry or release uncertainty after mutation HTTP%s",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(json(conversation()))
        .mockResolvedValueOnce(
          new Response("PRIVATE PROVIDER ERROR", {
            status,
            headers: { Location: "https://evil.example" },
          })
        );
      vi.stubGlobal("fetch", fetch);
      await expect(
        new InkboxClient(configuration).sendMessage(sendInput())
      ).rejects.toEqual(new InkboxError("inkbox_http_error", true, status));
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("holds network uncertainty after the only POST attempt", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(conversation()))
      .mockRejectedValueOnce(new Error("PRIVATE NETWORK MESSAGE"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      new InkboxClient(configuration).sendMessage(sendInput())
    ).rejects.toEqual(new InkboxError("inkbox_network_error", true));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not accept a post-dispatch message for a different phone or identity", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(conversation()))
      .mockResolvedValueOnce(
        json(
          {
            message: {
              ...message(),
              agent_identity_id: "90000000-0000-4000-8000-000000000009",
            },
          },
          201
        )
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new InkboxClient(configuration).sendMessage(sendInput())
    ).rejects.toMatchObject({
      code: "inkbox_message_scope_mismatch",
      outcomeUnknown: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("holds uncertainty if the provider accepted the send under a different assignment", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(conversation()))
      .mockResolvedValueOnce(
        json(
          {
            message: {
              ...message(),
              assignment_id: "90000000-0000-4000-8000-000000000009",
            },
          },
          201
        )
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new InkboxClient(configuration).sendMessage(sendInput())
    ).rejects.toMatchObject({
      code: "inkbox_assignment_changed",
      outcomeUnknown: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds streamed responses and does not parse oversized or non-JSON provider content", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("x".repeat(262_145)))
      .mockResolvedValueOnce(new Response("PRIVATE NON-JSON BODY"));
    vi.stubGlobal("fetch", fetch);
    const client = new InkboxClient(configuration);
    await expect(client.getRouter()).rejects.toEqual(
      new InkboxError("inkbox_response_too_large")
    );
    await expect(client.getRouter()).rejects.toEqual(
      new InkboxError("inkbox_invalid_json")
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses only a read-only keyed lookup and never resends after404", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ message_id: messageId }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const client = new InkboxClient(configuration);
    expect(await client.lookupMessageSend("fictional-key")).toBe(messageId);
    expect(await client.lookupMessageSend("fictional-key")).toBeNull();
    for (const [target, options] of fetch.mock.calls) {
      const url = requestUrl(target);
      expect(url.pathname).toBe("/api/v1/message-sends/lookup");
      expect(url.searchParams.get("sender_id")).toBe(identityId);
      expect(url.searchParams.get("operation")).toBe("imessage.send");
      expect(options?.method).toBe("GET");
      expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(
        "fictional-key"
      );
    }
  });

  it("rejects an arbitrary attachment URL before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await expect(
      new InkboxClient(configuration).sendMessage({
        ...sendInput(),
        mediaUrl: "https://attacker.example/file.png",
      })
    ).rejects.toMatchObject({ code: "inkbox_untrusted_media" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads bounded raw bytes without following a URL, then sends only its returned URL", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(
          {
            media_url: "https://media.inkbox.ai/fixture.png",
            content_type: "image/png",
            size: 3,
          },
          201
        )
      )
      .mockResolvedValueOnce(json(conversation()))
      .mockResolvedValueOnce(json({ message: message() }, 201));
    vi.stubGlobal("fetch", fetch);
    const client = new InkboxClient(configuration);
    const authorize = vi.fn<() => Promise<void>>().mockResolvedValue();
    const media = await client.uploadMedia({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      filename: "fixture.png",
      beforeSend: authorize,
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith();
    expect(fetch.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
    await client.sendMessage({ ...sendInput(), mediaUrl: media.mediaUrl });
    expect(
      JSON.parse(z.string().parse(fetch.mock.calls[2]?.[1]?.body))
    ).toMatchObject({
      media_urls: [media.mediaUrl],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails closed for an uploaded private URL and invalid media bytes without retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(
        {
          media_url: "https://127.0.0.1/secret",
          content_type: "image/png",
          size: 1,
        },
        201
      )
    );
    vi.stubGlobal("fetch", fetch);
    const client = new InkboxClient(configuration);
    await expect(
      client.uploadMedia({
        bytes: new Uint8Array([1]),
        contentType: "image/png",
        filename: "fixture.png",
        beforeSend: () => Promise.resolve(),
      })
    ).rejects.toMatchObject({
      code: "inkbox_invalid_media_response",
      outcomeUnknown: true,
    });
    await expect(
      client.uploadMedia({
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        contentType: "image/png",
        filename: "fixture.png",
        beforeSend: () => Promise.resolve(),
      })
    ).rejects.toMatchObject({
      code: "inkbox_invalid_media",
      outcomeUnknown: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds response streaming and aborts a stalled body within the same deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array());
          },
        })
      )
    );
    vi.stubGlobal("fetch", fetch);
    const pending = new InkboxClient({
      ...configuration,
      timeoutMs: 10,
    }).getRouter();
    const checked = (async () => {
      await expect(pending).rejects.toMatchObject({
        code: "inkbox_timeout",
        outcomeUnknown: false,
      });
    })();
    await vi.advanceTimersByTimeAsync(11);
    await checked;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops a held authorization callback at the deadline and never POSTs after it resumes", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(conversation()));
    vi.stubGlobal("fetch", fetch);
    const pending = new InkboxClient({
      ...configuration,
      timeoutMs: 10,
    }).sendMessage({
      ...sendInput(),
      beforeSend: async () => {
        entered.resolve(undefined);
        await release.promise;
      },
    });
    const checked = (async () => {
      await expect(pending).rejects.toMatchObject({
        code: "inkbox_authorization_failed",
        outcomeUnknown: false,
      });
    })();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(11);
    await checked;
    release.resolve(undefined);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires valid configuration and stable printable keys without any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    expect(
      () => new InkboxClient({ ...configuration, identityId: "not-a-uuid" })
    ).toThrow("inkbox_invalid_configuration");
    expect(
      () => new InkboxClient({ ...configuration, agentHandle: "@plause" })
    ).toThrow("inkbox_invalid_configuration");
    await expect(
      new InkboxClient(configuration).sendMessage({
        ...sendInput(),
        idempotencyKey: "bad\nheader",
      })
    ).rejects.toMatchObject({ code: "inkbox_invalid_idempotency_key" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function requestUrl(
  target: Parameters<typeof globalThis.fetch>[0] | undefined
) {
  if (!target) throw new Error("Fixture request target missing");
  return target instanceof Request ? new URL(target.url) : new URL(target);
}
