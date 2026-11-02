import type { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TestEnvironment {
  NODE_ENV: "development" | "production" | "test";
  INTERNAL_SERVICE_SECRET: string;
}

const mocks = vi.hoisted(() => {
  const env: TestEnvironment = {
    NODE_ENV: "development",
    INTERNAL_SERVICE_SECRET: "fixture-internal-secret-0123456789abcdef",
  };
  return {
    env,
    readFile: vi.fn<typeof readFile>(),
  };
});

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@shared/environment", () => ({ env: mocks.env }));
vi.mock("@shared/environment/origin", () => ({
  applicationOrigin: () => "https://example.com",
}));

import {
  postScheduledReport,
  postScheduledRunRoute,
} from "@agent/lib/schedules/request";

describe("scheduled run requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
    mocks.env.NODE_ENV = "development";
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        appRoot: process.cwd(),
        origin: "http://127.0.0.1:51829",
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only the report handler's asynchronous acknowledgment", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));
    await expect(postScheduledReport("run-1")).resolves.toBeUndefined();
  });

  it("rejects a successful HTML fallback instead of losing a scheduled report", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<!doctype html><h1>404</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    await expect(postScheduledReport("run-1")).rejects.toThrow(
      "Scheduled report callback failed (200)"
    );
  });

  it("authenticates hosted callbacks with an app-owned signature", async () => {
    mocks.env.NODE_ENV = "production";

    await postScheduledRunRoute("/internal/scheduled-run/report", {
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://example.com/internal/scheduled-run/report"),
      expect.objectContaining({
        body: JSON.stringify({ runId: "run-1" }),
        method: "POST",
        redirect: "error",
      })
    );
    expect(sentHeaders().get("authorization")).toBeNull();
    expect(sentHeaders().get("content-type")).toBe("application/json");
    expect(sentHeaders().get("x-vercel-trusted-oidc-idp-token")).toBeNull();
    expectSignature(
      "/internal/scheduled-run/report",
      JSON.stringify({ runId: "run-1" })
    );
  });

  it("signs local callbacks with the same path/body/time-bound protocol", async () => {
    await postScheduledRunRoute("/internal/scheduled-run/respond", {
      answer: "Logan",
      leaseToken: "lease-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:51829/internal/scheduled-run/respond"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
    expect(sentHeaders().get("authorization")).toBeNull();
    expect(sentHeaders().get("content-type")).toBe("application/json");
    expect(sentHeaders().get("x-vercel-trusted-oidc-idp-token")).toBeNull();
    expectSignature(
      "/internal/scheduled-run/respond",
      JSON.stringify({ answer: "Logan", leaseToken: "lease-1", runId: "run-1" })
    );
  });

  it("falls back to the application origin outside Next development", async () => {
    mocks.env.NODE_ENV = "test";

    await postScheduledRunRoute("/internal/scheduled-run/report", {
      runId: "run-1",
    });

    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://example.com/internal/scheduled-run/report"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
  });

  it("ignores a development registry owned by another checkout", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        appRoot: "/tmp/another-checkout",
        origin: "http://127.0.0.1:51829",
      })
    );

    await postScheduledRunRoute("/internal/scheduled-run/report", {
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://example.com/internal/scheduled-run/report"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
  });
});

function expectSignature(path: string, body: string) {
  const headers = sentHeaders();
  const timestamp = headers.get("x-plause-internal-timestamp");
  const id = headers.get("x-plause-internal-id");
  if (!timestamp || !id) throw new Error("Signed callback headers missing");
  expect(timestamp).toMatch(/^[1-9]\d*$/u);
  expect(id).toMatch(/^[a-f0-9-]{36}$/u);
  const expected = createHmac("sha256", mocks.env.INTERNAL_SERVICE_SECRET)
    .update(`plause-scheduled-v1\n${timestamp}\n${id}\nPOST\n${path}\n${body}`)
    .digest("hex");
  expect(headers.get("x-plause-internal-signature")).toBe(`v1=${expected}`);
}

function sentHeaders() {
  const call = vi.mocked(fetch).mock.calls[0];
  if (!call) throw new Error("No scheduled run request was sent.");
  return new Headers(call[1]?.headers);
}
