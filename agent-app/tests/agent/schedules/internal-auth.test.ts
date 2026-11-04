import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { claimInternalRequest } from "@db/services/internal-requests";
import {
  authenticateScheduledRequest,
  signScheduledRequest,
  type ScheduledInternalPath,
} from "@agent/lib/schedules/internal-auth";

interface InternalTestEnvironment {
  INTERNAL_SERVICE_SECRET: string | undefined;
  PLAUSE_EDGE_INTERNAL_TOKEN?: string;
}

const controls = vi.hoisted(() => {
  const env: InternalTestEnvironment = {
    INTERNAL_SERVICE_SECRET: "fixture-internal-secret-0123456789abcdef",
  };
  return {
    env,
    claim: vi.fn<typeof claimInternalRequest>(),
    seen: new Set<string>(),
  };
});
vi.mock("@shared/environment", () => ({ env: controls.env }));
vi.mock("@db/services/internal-requests", () => ({
  claimInternalRequest: controls.claim,
}));

const reportPath = "/internal/scheduled-run/report";
const body = JSON.stringify({ runId: "00000000-0000-4000-8000-000000000001" });

describe("portable scheduled callback authentication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
    controls.env.INTERNAL_SERVICE_SECRET =
      "fixture-internal-secret-0123456789abcdef";
    controls.seen.clear();
    delete controls.env.PLAUSE_EDGE_INTERNAL_TOKEN;
    controls.claim.mockReset().mockImplementation(async (receipt) => {
      if (controls.seen.has(receipt.requestId)) return false;
      controls.seen.add(receipt.requestId);
      return true;
    });
  });
  afterEach(() => vi.useRealTimers());

  it("authenticates a due-task tick once and never accepts its replay", async () => {
    const path = "/internal/schedules/tick";
    const request = new Request(`https://self-hosted.example${path}`, {
      method: "POST",
      body: "{}",
      headers: signScheduledRequest(path, "{}"),
    });
    const replay = request.clone();
    expect(await authenticateScheduledRequest(request)).toEqual({ body: "{}" });
    expect(await responseStatus(replay)).toBe(409);
    expect(controls.claim.mock.calls[0]?.[0].path).toBe(path);
  });

  it("authenticates exact raw JSON without Vercel or browser credentials", async () => {
    const request = signedRequest();
    expect(await authenticateScheduledRequest(request)).toEqual({ body });
    expect(request.headers.get("authorization")).toBeNull();
    expect(controls.claim).toHaveBeenCalledOnce();
    expect(controls.claim.mock.calls[0]?.[0].path).toBe(reportPath);
    expect(controls.claim.mock.calls[0]?.[0].signatureDigest).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(JSON.stringify(controls.claim.mock.calls)).not.toContain("runId");
  });

  it("rejects a replay while a separately signed new attempt gets a fresh nonce", async () => {
    const request = signedRequest();
    const replay = request.clone();
    expect(await authenticateScheduledRequest(request)).toEqual({ body });
    expect(await responseStatus(replay)).toBe(409);
    expect(await authenticateScheduledRequest(signedRequest())).toEqual({
      body,
    });
    expect(controls.claim.mock.calls[0]?.[0].requestId).not.toBe(
      controls.claim.mock.calls[2]?.[0].requestId
    );
  });

  it("adds edge admission without replacing the signed body or nonce checks", async () => {
    controls.env.PLAUSE_EDGE_INTERNAL_TOKEN =
      "fictional-edge-token-0123456789abcdef";
    const request = signedRequest();
    expect(request.headers.get("authorization")).toBe(
      `Bearer ${controls.env.PLAUSE_EDGE_INTERNAL_TOKEN}`
    );
    expect(await authenticateScheduledRequest(request.clone())).toEqual({
      body,
    });
    expect(await responseStatus(request)).toBe(409);
    expect(
      await responseStatus(
        new Request(`https://self-hosted.example${reportPath}`, {
          method: "POST",
          body,
          headers: {
            authorization: `Bearer ${controls.env.PLAUSE_EDGE_INTERNAL_TOKEN}`,
          },
        })
      )
    ).toBe(401);
  });

  it.each([-301, 301])(
    "rejects clock skew %i seconds before database access",
    async (offset) => {
      const request = signedRequest();
      vi.setSystemTime(Date.now() + offset * 1000);
      expect(await responseStatus(request)).toBe(401);
      expect(controls.claim).not.toHaveBeenCalled();
    }
  );

  it("binds the signature to the path and raw body", async () => {
    const headers = signScheduledRequest(reportPath, body);
    expect(
      await responseStatus(
        new Request(
          "https://self-hosted.example/internal/scheduled-run/respond",
          { method: "POST", body, headers }
        )
      )
    ).toBe(401);
    expect(
      await responseStatus(
        new Request(`https://self-hosted.example${reportPath}`, {
          method: "POST",
          body: `${body}\n`,
          headers,
        })
      )
    ).toBe(401);
    expect(
      await responseStatus(
        new Request(`https://self-hosted.example${reportPath}?forward=1`, {
          method: "POST",
          body,
          headers,
        })
      )
    ).toBe(401);
    expect(controls.claim).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret, changed nonce and malformed MAC without claiming", async () => {
    const wrongSecret = signedRequest();
    controls.env.INTERNAL_SERVICE_SECRET =
      "another-fixture-secret-0123456789abcdef";
    expect(await responseStatus(wrongSecret)).toBe(401);
    const changedNonce = signedRequest();
    changedNonce.headers.set(
      "x-plause-internal-id",
      "00000000-0000-4000-8000-000000000099"
    );
    expect(await responseStatus(changedNonce)).toBe(401);
    const invalidMac = signedRequest();
    invalidMac.headers.append("x-plause-internal-signature", "v1=bad");
    expect(await responseStatus(invalidMac)).toBe(401);
    expect(controls.claim).not.toHaveBeenCalled();
  });

  it("requires a secret even for loopback requests and never falls back to localDev", async () => {
    controls.env.INTERNAL_SERVICE_SECRET = undefined;
    expect(
      await responseStatus(
        new Request(`http://localhost:3000${reportPath}`, {
          method: "POST",
          body,
        })
      )
    ).toBe(503);
    expect(() => signScheduledRequest(reportPath, body)).toThrow(
      "not configured"
    );
    expect(controls.claim).not.toHaveBeenCalled();
  });

  it("fails closed when the durable receipt cannot be committed", async () => {
    controls.claim.mockRejectedValue(new Error("private database diagnostic"));
    const response = await authenticateScheduledRequest(signedRequest());
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response))
      throw new Error("Expected unavailable authentication");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  it("bounds unauthenticated body reads before receipt insertion", async () => {
    const oversized = "x".repeat(65_537);
    const headers = signScheduledRequest(reportPath, oversized);
    expect(
      await responseStatus(
        new Request(`https://self-hosted.example${reportPath}`, {
          method: "POST",
          body: oversized,
          headers,
        })
      )
    ).toBe(413);
    expect(controls.claim).not.toHaveBeenCalled();
  });
});

function signedRequest(path: ScheduledInternalPath = reportPath) {
  return new Request(`https://self-hosted.example${path}`, {
    method: "POST",
    body,
    headers: signScheduledRequest(path, body),
  });
}

async function responseStatus(request: Request) {
  const result = await authenticateScheduledRequest(request);
  if (!(result instanceof Response))
    throw new Error("Expected request rejection");
  expect(result.headers.get("cache-control")).toBe("no-store");
  return result.status;
}
