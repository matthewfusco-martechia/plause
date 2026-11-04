import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import gateway from "./worker";

const credential = "plause:fictional-password-0123456789abcdef";
const token = "fictional-edge-token-0123456789abcdef";
function environment() {
  const forward = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockResolvedValue(new Response("private", { status: 200 }));
  return {
    PLAUSE_HOSTING_ENABLED: "true",
    PLAUSE_ALWAYS_ON: "true",
    PLAUSE_HOST: "agent.plause.si",
    PLAUSE_WORKFLOW_BACKEND: "postgres",
    PLAUSE_EDGE_AUTH_SHA256: createHash("sha256")
      .update(credential)
      .digest("hex"),
    PLAUSE_EDGE_INTERNAL_TOKEN: token,
    PLAUSE_INKBOX_CALLBACK_TOKEN: token,
    PLAUSE_RUNTIME: {
      getByName: vi.fn<(name: string) => { fetch: typeof forward }>(() => ({
        fetch: forward,
      })),
    },
    forward,
  };
}
function request(
  path = "/",
  authorization = `Basic ${Buffer.from(credential).toString("base64")}`,
  method = "GET"
) {
  return new Request(`https://agent.plause.si${path}`, {
    method,
    headers: { authorization },
  });
}

describe("private Cloudflare admission before paid container access", () => {
  it.each([
    "",
    "Basic bad",
    "Bearer wrong",
    `Basic ${Buffer.from("other:password").toString("base64")}`,
  ])(
    "rejects invalid credentials without accessing a container (%s)",
    async (authorization) => {
      const env = environment();
      const response = await gateway.fetch(request("/", authorization), env);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
    }
  );
  it("keeps the disabled profile offline even with correct credentials", async () => {
    const env = { ...environment(), PLAUSE_HOSTING_ENABLED: "false" };
    expect((await gateway.fetch(request(), env)).status).toBe(503);
    expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
  });
  it.each([
    "/.well-known/workflow/v1/flow",
    "/.well-known/workflow/v1/manifest",
    "/_plause/runtime-ready",
  ])("never publishes privileged runtime route %s", async (path) => {
    const env = environment();
    expect((await gateway.fetch(request(path), env)).status).toBe(404);
    expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
  });
  it.each(["http://agent.plause.si/", "https://other.example/"])(
    "rejects unexpected origin %s",
    async (url) => {
      const env = environment();
      expect((await gateway.fetch(new Request(url), env)).status).toBe(404);
      expect(env.PLAUSE_RUNTIME.getByName).not.toHaveBeenCalled();
    }
  );
  it("forwards an admitted request exactly once to the single named owner", async () => {
    const env = environment();
    const input = request("/api/action", undefined, "POST");
    expect((await gateway.fetch(input, env)).status).toBe(200);
    expect(env.PLAUSE_RUNTIME.getByName).toHaveBeenCalledExactlyOnceWith(
      "private-agent"
    );
    expect(env.forward).toHaveBeenCalledExactlyOnceWith(input);
  });
  it.each([
    "/webhooks/inkbox",
    "/internal/linq/dispatch",
    "/internal/inkbox/dispatch",
    "/internal/scheduled-run/respond",
    "/internal/scheduled-run/report",
  ])(
    "admits only POST callbacks bearing the edge token on %s",
    async (path) => {
      const env = environment();
      /* oxlint-disable eslint/no-await-in-loop -- Serial attempts verify rejection before the one admitted callback. */
      for (const input of [
        request(path),
        request(path, `Bearer ${token}`),
        request(`${path}?extra=1`, `Bearer ${token}`, "POST"),
      ]) {
        expect((await gateway.fetch(input, env)).status).toBe(401);
      }
      expect(env.forward).not.toHaveBeenCalled();
      expect(
        (await gateway.fetch(request(path, `Bearer ${token}`, "POST"), env))
          .status
      ).toBe(200);
      // App signature verification and durable nonce claims remain a separate boundary.
      expect(env.forward).toHaveBeenCalledOnce();
    }
  );
  it("rejects an exact match to a misconfigured short callback token", async () => {
    const short = "x".repeat(25);
    const env = { ...environment(), PLAUSE_INKBOX_CALLBACK_TOKEN: short };
    expect(
      (
        await gateway.fetch(
          request("/webhooks/inkbox", `Bearer ${short}`, "POST"),
          env
        )
      ).status
    ).toBe(401);
    expect(env.forward).not.toHaveBeenCalled();
  });
  it("does not wake disabled or on-demand hosting from cron", async () => {
    /* oxlint-disable eslint/no-await-in-loop -- Each isolated configuration must independently avoid a wake. */
    for (const override of [
      { PLAUSE_HOSTING_ENABLED: "false" },
      { PLAUSE_ALWAYS_ON: "false" },
      { PLAUSE_EDGE_INTERNAL_TOKEN: "" },
    ]) {
      const env = { ...environment(), ...override };
      await gateway.scheduled({ scheduledTime: 0 }, env);
      expect(env.forward).not.toHaveBeenCalled();
    }
  });
  it("wakes only the internal health route, without models or user actions", async () => {
    const env = environment();
    await gateway.scheduled({ scheduledTime: 0 }, env);
    expect(env.forward).toHaveBeenCalledOnce();
    const input = env.forward.mock.calls[0]?.[0];
    if (!input) throw new Error("Expected a health request");
    expect(new URL(input.url).pathname).toBe("/_plause/runtime-ready");
    expect(input.headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});
