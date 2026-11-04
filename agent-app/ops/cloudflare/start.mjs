import { spawn } from "node:child_process";

/* oxlint-disable eslint/no-restricted-properties, turbo/no-undeclared-env-vars -- Standalone container supervisor validates deployment settings before starting services. */

// This image is exclusively for a stateless host. Never fall back to workflow
// files on its disposable disk, or send internal job deliveries through ingress.
if (
  process.env.PLAUSE_WORKFLOW_BACKEND !== "postgres" ||
  process.env.WORKFLOW_LOCAL_BASE_URL !== "http://127.0.0.1:4274" ||
  !process.env.DATABASE_URL ||
  !process.env.WORKFLOW_POSTGRES_URL ||
  !process.env.PLAUSE_ACCESS_HASH ||
  !process.env.PLAUSE_EDGE_INTERNAL_TOKEN ||
  process.env.PLAUSE_EDGE_INTERNAL_TOKEN.length < 32
) {
  console.error(
    "Private runtime configuration incomplete. No services started."
  );
  process.exit(1);
}

const children = [
  spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3000",
    ],
    { detached: true, stdio: "inherit" }
  ),
  spawn(
    "/usr/bin/caddy",
    ["run", "--config", "ops/cloudflare/Caddyfile", "--adapter", "caddyfile"],
    { detached: true, stdio: "inherit" }
  ),
];
let stopping = false;
function stop(failed = false) {
  if (stopping) return;
  stopping = true;
  process.exitCode = failed ? 1 : 0;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
    }
  }, 20_000);
}
process.once("SIGINT", () => {
  stop();
});
process.once("SIGTERM", () => {
  stop();
});
for (const child of children) {
  child.once("error", () => {
    stop(true);
  });
  child.once("exit", () => {
    stop(true);
  });
}
