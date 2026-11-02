import http, { request as httpRequest } from "node:http";
import https, { get as httpsGet } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkAccessDeniedError } from "./helpers/no-network";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unit-test network boundary", () => {
  it("rejects default fetch without contacting a server", async () => {
    await expect(fetch("https://127.0.0.1:9/fixture")).rejects.toMatchObject({
      code: "TEST_NETWORK_DENIED",
      message: "Unit tests must explicitly mock network access.",
      name: "NetworkAccessDeniedError",
    });
  });

  it.each([
    ["http.request", () => http.request("http://127.0.0.1:9/fixture")],
    ["http.get", () => http.get("http://127.0.0.1:9/fixture")],
    ["https.request", () => https.request("https://127.0.0.1:9/fixture")],
    ["https.get", () => https.get("https://127.0.0.1:9/fixture")],
    ["named http request", () => httpRequest("http://127.0.0.1:9/fixture")],
    ["named https get", () => httpsGet("https://127.0.0.1:9/fixture")],
    ["net.connect", () => net.connect({ host: "127.0.0.1", port: 9 })],
    ["net.createConnection", () => net.createConnection(9, "127.0.0.1")],
    ["tls.connect", () => tls.connect(9, "127.0.0.1")],
  ])("rejects unmocked %s synchronously", (_name, connect) => {
    expect(connect).toThrow(NetworkAccessDeniedError);
  });

  it("blocks direct Socket instances before connection setup", () => {
    const socket = new net.Socket();
    try {
      expect(() => socket.connect(9, "127.0.0.1")).toThrow(
        NetworkAccessDeniedError
      );
    } finally {
      socket.destroy();
    }
  });

  it("supports an explicit fetch spy and restores denial afterward", async () => {
    const fixture = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ fixture: true }));
    const response = await fetch("https://provider.invalid/fixture");
    await expect(response.json()).resolves.toEqual({ fixture: true });
    expect(fixture).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    await expect(fetch("https://127.0.0.1:9/fixture")).rejects.toThrow(
      NetworkAccessDeniedError
    );
  });

  it("supports stubGlobal cleanup without restoring native fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("fixture response"))
    );
    expect(await (await fetch("https://provider.invalid/fixture")).text()).toBe(
      "fixture response"
    );
    vi.unstubAllGlobals();
    await expect(fetch("https://127.0.0.1:9/fixture")).rejects.toThrow(
      NetworkAccessDeniedError
    );
  });

  it("supports an explicit HTTP fixture and retains denial after restoration", () => {
    const fixtureError = new Error("Handled by the explicit HTTP fixture");
    const fixture = vi.spyOn(http, "request").mockImplementation(() => {
      throw fixtureError;
    });
    expect(() => http.request("http://127.0.0.1:9/fixture")).toThrow(
      fixtureError
    );
    expect(fixture).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    expect(() => http.request("http://127.0.0.1:9/fixture")).toThrow(
      NetworkAccessDeniedError
    );
  });

  it("keeps embedded PGlite usable without any network exception", async () => {
    const database = new PGlite();
    try {
      const result = await database.query<{ answer: number }>(
        "SELECT 42::integer AS answer"
      );
      expect(result.rows).toEqual([{ answer: 42 }]);
      await expect(fetch("https://127.0.0.1:9/fixture")).rejects.toThrow(
        NetworkAccessDeniedError
      );
    } finally {
      await database.close();
    }
  }, 20_000);
});
