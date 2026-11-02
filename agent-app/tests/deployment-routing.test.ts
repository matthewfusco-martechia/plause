import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import scheduledRun from "@agent/channels/scheduled-run";

it("routes signed callbacks to Eve while password-protecting app routes", () => {
  const config = readFileSync("ops/Caddyfile", "utf8");
  const servicePaths = /@service path ([^\n]+)/u
    .exec(config)?.[1]
    ?.trim()
    .split(/\s+/u);
  expect(servicePaths).toEqual([
    "/webhooks/linq",
    "/internal/linq/dispatch",
    ...scheduledRun.routes.map((route) => route.path),
    "/.well-known/workflow/*",
  ]);
  expect(config).toContain("reverse_proxy 127.0.0.1:4274");
  expect(config).toContain("basic_auth");
  expect(config).toContain("plause {$PLAUSE_ACCESS_HASH}");
  expect(config).toContain("reverse_proxy 127.0.0.1:3000");
  expect(config).toContain("header_up -Authorization");
  for (const path of ["/", "/chat", "/vault", "/eve/*", "/internal/*"]) {
    expect(servicePaths).not.toContain(path);
  }
});
