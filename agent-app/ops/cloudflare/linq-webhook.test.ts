import { createHmac } from "node:crypto";
import { LinqAPIV3 } from "@linqapp/sdk";
import { describe, expect, it, vi } from "vitest";
import gateway from "./worker";

const key = Buffer.alloc(32, 7);
const secret = `whsec_${key.toString("base64")}`;
const body = JSON.stringify({ event_id: "evt_fixture", text: "café 👋" });
function signedRequest(
  payload = body,
  timestamp = String(Math.floor(Date.now() / 1000))
) {
  const signature = createHmac("sha256", key)
    .update(`evt_fixture.${timestamp}.${payload}`)
    .digest("base64");
  return new Request("https://agent.plause.si/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": "evt_fixture",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body: payload,
  });
}
function environment() {
  const forward = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 202 }));
  return {
    PLAUSE_HOSTING_ENABLED: "true",
    PLAUSE_WORKFLOW_BACKEND: "postgres",
    PLAUSE_HOST: "agent.plause.si",
    MESSAGING_PROVIDER: "linq",
    LINQ_WEBHOOK_SIGNING_SECRET: secret,
    PLAUSE_RUNTIME: {
      getByName: vi.fn<(name: string) => { fetch: typeof forward }>(() => ({
        fetch: forward,
      })),
    },
    forward,
  };
}

describe("Linq signatures before private container access", () => {
  it("accepts SDK-compatible Standard Webhooks and preserves exact body/headers", async () => {
    const input = signedRequest();
    const client = new LinqAPIV3({
      apiKey: "fictional-no-network",
      webhookSecret: secret,
      maxRetries: 0,
    });
    expect(
      client.webhooks.unwrap(body, {
        headers: Object.fromEntries(input.headers),
      })
    ).toEqual(JSON.parse(body));
    const env = environment();
    expect((await gateway.fetch(input, env)).status).toBe(202);
    expect(env.PLAUSE_RUNTIME.getByName).toHaveBeenCalledExactlyOnceWith(
      "private-agent"
    );
    expect(env.forward).toHaveBeenCalledOnce();
    const forwarded = env.forward.mock.calls[0]?.[0];
    expect(await forwarded?.text()).toBe(body);
    expect(forwarded?.headers.get("webhook-signature")).toBe(
      input.headers.get("webhook-signature")
    );
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])(
    "rejects missing %s without starting a container",
    async (header) => {
      const input = signedRequest();
      input.headers.delete(header);
      const env = environment();
      expect((await gateway.fetch(input, env)).status).toBe(401);
      expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
    }
  );
  it.each([-600, 600])(
    "rejects correctly signed stale/future timestamps (%s)",
    async (offset) => {
      const input = signedRequest(
        body,
        String(Math.floor(Date.now() / 1000) + offset)
      );
      const env = environment();
      expect((await gateway.fetch(input, env)).status).toBe(401);
      expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
    }
  );
  it.each([
    ["webhook-id", "evt_changed"],
    ["webhook-timestamp", "1.5"],
    ["webhook-signature", "v1,invalid"],
  ])("rejects altered envelope headers (%s)", async (header, value) => {
    const input = signedRequest();
    input.headers.set(header, value);
    const env = environment();
    expect((await gateway.fetch(input, env)).status).toBe(401);
    expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
  });
  it("rejects a modified body even with the original valid signature", async () => {
    const input = new Request(signedRequest(), {
      method: "POST",
      body: `${body} `,
    });
    const env = environment();
    expect((await gateway.fetch(input, env)).status).toBe(401);
    expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "whsec_invalid",
    `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
  ])(
    "rejects absent, malformed or different configured signing keys",
    async (configuredSecret) => {
      const env = {
        ...environment(),
        LINQ_WEBHOOK_SIGNING_SECRET: configuredSecret,
      };
      expect((await gateway.fetch(signedRequest(), env)).status).toBe(401);
      expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
    }
  );
  it("rejects a correctly signed oversized body without container access", async () => {
    const env = environment();
    expect(
      (await gateway.fetch(signedRequest("x".repeat(262_145)), env)).status
    ).toBe(401);
    expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
  });
  it("supports a valid v1 signature alongside an unknown signature version", async () => {
    const input = signedRequest();
    input.headers.set(
      "webhook-signature",
      `v0,ignored ${input.headers.get("webhook-signature") ?? ""}`
    );
    const env = environment();
    expect((await gateway.fetch(input, env)).status).toBe(202);
    expect(env.forward).toHaveBeenCalledOnce();
  });
  it.each(["disabled", "inkbox"])(
    "does not admit Linq while %s is selected",
    async (provider) => {
      const env = { ...environment(), MESSAGING_PROVIDER: provider };
      expect((await gateway.fetch(signedRequest(), env)).status).toBe(401);
      expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
    }
  );
  it("rejects callback queries and GET requests before container access", async () => {
    const env = environment();
    const input = signedRequest();
    expect(
      (await gateway.fetch(new Request(`${input.url}?extra=1`, input), env))
        .status
    ).toBe(401);
    expect((await gateway.fetch(new Request(input.url), env)).status).toBe(401);
    expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
  });

  it("admits the documented pinned webhook version without altering the signature", async () => {
    const input = signedRequest();
    const env = environment();
    const pinned = new Request(`${input.url}?version=2026-02-03`, input);
    expect((await gateway.fetch(pinned, env)).status).toBe(202);
    expect(env.forward).toHaveBeenCalledOnce();
    expect(await env.forward.mock.calls[0]?.[0].text()).toBe(body);
  });

  it.each([
    "?version=2025-01-01",
    "?version=2026-02-03&version=2026-02-03",
    "?version=2026-02-03&extra=1",
  ])(
    "rejects unsupported or ambiguous version selectors (%s)",
    async (query) => {
      const input = signedRequest();
      const env = environment();
      expect(
        (await gateway.fetch(new Request(`${input.url}${query}`, input), env))
          .status
      ).toBe(401);
      expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
    }
  );
});
