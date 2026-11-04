import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, parseAnswers, type ClientSession } from "eve/client";
import { APPROVE_OPTION_ID } from "eve/events";
import { Client as PgClient } from "pg";
import { z } from "zod";

const app = fileURLToPath(new URL("..", import.meta.url));
// The sole accepted database is a disposable, fictional, loopback fixture.
/* oxlint-disable eslint/no-restricted-properties, turbo/no-undeclared-env-vars -- Isolated integration runner forwards only executable/home paths, never app configuration. */
const database = process.env.PLAUSE_TEST_POSTGRES_URL;
const target = database ? URL.parse(database) : null;
assert.ok(target && ["postgres:", "postgresql:"].includes(target.protocol));
assert.equal(target.hostname, "127.0.0.1");
assert.ok(Number(target.port) >= 1024);
assert.equal(target.pathname, "/restart_world");
assert.equal(target.username, "world");
assert.equal(target.password, "fictional-hosting-fixture");
assert.equal(target.search + target.hash, "");
const fixture = await mkdtemp(join(tmpdir(), "plause-recovery-"));
const replacement = `${fixture}-replacement`;
const artifacts = join(app, "..", ".local", "agent-hosting");
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const log = await open(join(artifacts, "workflow-recovery.log"), "w", 0o600);
const report = {
  fictionalOnly: true,
  liveModelCalls: 0,
  messagesSent: 0,
  checks: z.array(z.string()).parse([]),
  passed: false,
  error: "",
};
const run = promisify(execFile);
const pg = new PgClient({
  connectionString: database,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});
let server: ReturnType<typeof spawn> | undefined;
const listener = createServer();
await new Promise<void>((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const address = z
  .object({ port: z.number().int().min(1024).max(65535) })
  .parse(listener.address());
const baseUrl = `http://127.0.0.1:${String(address.port)}`;
await new Promise<void>((resolve) =>
  listener.close(() => {
    resolve();
  })
);
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: "development",
  EVE_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  DATABASE_URL: database,
  KERNEL_API_KEY: "fictional-disabled-key",
  WORKFLOW_POSTGRES_URL: database,
  WORKFLOW_LOCAL_BASE_URL: baseUrl,
  WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "4",
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: "10",
  WORKFLOW_POSTGRES_POLL_INTERVAL_MS: "2000",
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
} satisfies NodeJS.ProcessEnv;
/* oxlint-enable eslint/no-restricted-properties, turbo/no-undeclared-env-vars */

async function waitUntil(check: () => Promise<boolean>, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded observation of actual persisted fixture state.
    if (await check()) return;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling remains bounded by the deadline.
    await delay(100);
  }
  throw new Error("Fixture state did not reach the required checkpoint");
}
async function start() {
  server = spawn(
    join(app, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1", "--port", String(address.port)],
    {
      cwd: fixture,
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    }
  );
  await waitUntil(async () => {
    if (server?.exitCode !== null)
      throw new Error("Fixture server exited; inspect its private log");
    try {
      return (
        await fetch(`${baseUrl}/eve/v1/health`, {
          signal: AbortSignal.timeout(2000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, 60_000);
}
async function stop() {
  const child = server;
  server = undefined;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const closed = once(child, "close");
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
  await Promise.race([
    closed,
    delay(5000, undefined, { ref: false }).then(() => {
      throw new Error("Owned fixture process did not stop");
    }),
  ]);
}
async function approval(session: ClientSession) {
  for await (const event of session.stream({
    signal: AbortSignal.timeout(30_000),
  }))
    if (
      event.type === "interaction.opened" &&
      event.data.request.kind === "approval"
    )
      return event;
  throw new Error("Expected delegated approval was not recorded");
}
async function history(session: ClientSession) {
  const events = [];
  for await (const event of session.stream({
    follow: false,
    startIndex: 0,
    signal: AbortSignal.timeout(30_000),
  }))
    events.push(event);
  return events;
}

try {
  await pg.connect();
  const existing = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM workflow.workflow_runs"
  );
  assert.equal(
    existing.rows[0]?.count,
    0,
    "Recovery fixtures need their own fresh database"
  );
  await cp(join(app, "tests/runtime/fixture"), fixture, { recursive: true });
  await mkdir(join(fixture, "agent/tools"), { recursive: true });
  await mkdir(join(fixture, "agent/channels"), { recursive: true });
  // eve start correctly rejects the implicit dev authenticator. This explicit
  // credential exists only in the temporary loopback fixture, never the app.
  await writeFile(
    join(fixture, "agent/channels/eve.ts"),
    `
import { eveChannel } from "eve/channels/eve";
export default eveChannel({
  auth: (request) => request.headers.get("authorization") === "Bearer fictional-recovery-token-0123456789abcdef"
    ? { authenticator: "fixture", principalId: "fixture-owner", principalType: "user", attributes: {} }
    : null,
});
`
  );
  await cp(
    join(app, "agent/tools/run_browser.ts"),
    join(fixture, "agent/tools/run_browser.ts")
  );
  await Promise.all(
    ["agent", "agent/subagents/browser-agent"].map((path) =>
      cp(
        join(app, "tests/runtime/sandbox.ts"),
        join(fixture, path, "sandbox.ts")
      )
    )
  );
  await cp(
    join(app, "agent/subagents/browser-agent/instructions.md"),
    join(fixture, "agent/subagents/browser-agent/instructions.md")
  );
  await writeFile(
    join(fixture, "agent/instructions.md"),
    [
      await readFile(join(fixture, "agent/instructions.md"), "utf8"),
      await readFile(
        join(app, "agent/instructions/content/worker-coordination.md"),
        "utf8"
      ),
    ].join("\n\n")
  );
  const agentFile = join(fixture, "agent/agent.ts");
  await writeFile(
    agentFile,
    (await readFile(agentFile, "utf8")).replace(
      "defineAgent({",
      'defineAgent({ experimental: { workflow: { world: "@workflow/world-postgres" } },'
    )
  );
  await symlink(
    join(app, "node_modules"),
    join(fixture, "node_modules"),
    "junction"
  );
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "plause-recovery-fixture",
      private: true,
      type: "module",
      dependencies: { eve: "*", "@workflow/world-postgres": "5.0.4" },
    })
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@agent/*": [join(app, "agent/*")],
          "@shared/*": [join(app, "shared/*")],
        },
      },
    })
  );
  const compiled = await run(
    join(app, "node_modules/.bin/eve"),
    ["build", "--skip-sandbox-prewarm"],
    { cwd: fixture, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
  );
  await log.write(compiled.stdout + compiled.stderr);
  // Snapshot only the clean build: no session, sandbox, stream or marker files.
  await cp(fixture, replacement, { recursive: true, verbatimSymlinks: true });
  await start();
  const client = new Client({
    baseUrl,
    auth: { bearer: "fictional-recovery-token-0123456789abcdef" },
  });
  const pending = await client.sessions.create({ message: "Approve" });
  const interaction = await approval(pending.session);
  const childId = interaction.data.origin?.sessionId;
  assert.ok(childId, "Approval must belong to the delegated worker");
  const approvedMarker = join(
    fixture,
    ".eve",
    "fixture-tool",
    childId,
    "approved"
  );
  assert.equal(existsSync(approvedMarker), false);
  const timer = await client.sessions.create({ message: "Timer" });
  await waitUntil(
    async () =>
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM workflow.workflow_waits WHERE status='waiting' AND resume_at BETWEEN now() AND now() + interval '15 seconds'"
        )
      ).rows[0]?.count === 1
  );
  report.checks.push(
    "delegated approval blocks execution before consent",
    "timer wait is durable in PostgreSQL"
  );
  await stop();
  await rm(fixture, { recursive: true, force: true });
  await rename(replacement, fixture);
  assert.equal(existsSync(approvedMarker), false);
  await delay(8000);
  await start();
  const resumedClient = new Client({
    baseUrl,
    auth: { bearer: "fictional-recovery-token-0123456789abcdef" },
  });
  const restored = resumedClient.sessions.attach(pending.session.id);
  const timerMarker = join(
    fixture,
    ".eve",
    "fixture-tool",
    timer.session.id,
    "timer-fired"
  );
  await waitUntil(async () => existsSync(timerMarker));
  assert.equal(await readFile(timerMarker, "utf8"), "executed\n");
  assert.equal(existsSync(approvedMarker), false);
  report.checks.push(
    "overdue durable timer executes once after fresh-filesystem replacement",
    "pending approval remains blocked after replacement"
  );
  const beforeAnswer = await history(restored);
  const oldInteraction = beforeAnswer.filter(
    (event) =>
      event.type === "interaction.opened" &&
      event.data.interactionId === interaction.data.interactionId
  );
  assert.equal(oldInteraction.length, 1);
  const answers = parseAnswers([
    {
      interactionId: interaction.data.interactionId,
      optionId: APPROVE_OPTION_ID,
    },
  ]);
  const response = await restored.respond(answers);
  assert.equal(
    (await response.result({ signal: AbortSignal.timeout(30_000) })).status,
    "completed"
  );
  assert.equal(await readFile(approvedMarker, "utf8"), "executed\n");
  await restored.respond(answers);
  await delay(300);
  assert.equal(await readFile(approvedMarker, "utf8"), "executed\n");
  const afterAnswer = await history(restored);
  assert.equal(
    afterAnswer.filter(
      (event) =>
        event.type === "interaction.settled" &&
        event.data.interactionId === interaction.data.interactionId &&
        event.data.outcome === "accepted"
    ).length,
    1
  );
  report.checks.push(
    "same persisted interaction resumes the original delegated worker",
    "one execution and one accepted approval after duplicate answer"
  );
  report.passed = true;
} catch (error) {
  report.error =
    error instanceof Error
      ? error.message.slice(0, 2000)
      : "Recovery fixture failed";
  process.exitCode = 1;
} finally {
  await stop();
  await pg.end().catch(() => {
    // A failed startup may already have closed the fixture connection.
  });
  await log.close();
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await rm(replacement, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await writeFile(
    join(artifacts, "workflow-recovery.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 }
  );
  console.log(JSON.stringify(report));
}
