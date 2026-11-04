import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = process.argv.slice(2);
if (
  options.some((option) => option !== "--openai" && option !== "--postgres") ||
  new Set(options).size !== options.length
) {
  throw new Error("Use --openai and/or --postgres for deterministic fixtures.");
}
const directOpenAI = options.includes("--openai");
const postgres = options.includes("--postgres");
// Only the explicitly named disposable local database can reach this fixture.
// Never forward an application's DATABASE_URL or production environment file.
// oxlint-disable-next-line eslint/no-restricted-properties, turbo/no-undeclared-env-vars -- Dedicated fictional fixture connection, validated before use.
const postgresUrl = postgres ? process.env.PLAUSE_TEST_POSTGRES_URL : undefined;
if (postgres) {
  const url = postgresUrl ? URL.parse(postgresUrl) : null;
  if (
    !url ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.pathname !== "/world" ||
    url.username !== "world" ||
    url.password !== "fictional-hosting-fixture" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Postgres fixtures require the disposable loopback world database."
    );
}
const fixture = await mkdtemp(join(tmpdir(), "openinstinct-runtime-"));
const artifacts = join(
  root,
  ".eve",
  `${directOpenAI ? "openai-runtime-smoke" : "runtime-smoke"}${postgres ? "-postgres" : ""}`
);

try {
  await cp(
    join(
      root,
      directOpenAI ? "tests/runtime/openai-fixture" : "tests/runtime/fixture"
    ),
    fixture,
    { recursive: true }
  );
  if (postgres) {
    const agentFile = join(fixture, "agent/agent.ts");
    const source = await readFile(agentFile, "utf8");
    await writeFile(
      agentFile,
      source.replace(
        "defineAgent({",
        'defineAgent({ experimental: { workflow: { world: "@workflow/world-postgres" } },'
      )
    );
  }
  // Eve compiles workflow directives from authored tool files, not re-exports.
  // Copy current production source on every run so the fixture cannot drift.
  await mkdir(join(fixture, "agent/tools"), { recursive: true });
  await cp(
    join(root, "agent/tools/run_browser.ts"),
    join(fixture, "agent/tools/run_browser.ts")
  );
  await Promise.all(
    ["agent", "agent/subagents/browser-agent"].map((agentPath) =>
      cp(
        join(root, "tests/runtime/sandbox.ts"),
        join(fixture, agentPath, "sandbox.ts")
      )
    )
  );
  // Validate the production instruction contract against the installed runtime,
  // rather than running the deterministic worker with a fixture-only prompt.
  await cp(
    join(root, "agent/subagents/browser-agent/instructions.md"),
    join(fixture, "agent/subagents/browser-agent/instructions.md")
  );
  await writeFile(
    join(fixture, "agent/instructions.md"),
    [
      await readFile(join(fixture, "agent/instructions.md"), "utf8"),
      await readFile(
        join(root, "agent/instructions/content/worker-coordination.md"),
        "utf8"
      ),
    ].join("\n\n")
  );
  await symlink(
    join(root, "node_modules"),
    join(fixture, "node_modules"),
    "junction"
  );
  const dependencies = { eve: "*" };
  if (postgres)
    Object.assign(dependencies, { "@workflow/world-postgres": "5.0.4" });
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "openinstinct-runtime-smoke",
      private: true,
      type: "module",
      dependencies,
    })
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@agent/*": [join(root, "agent/*")],
          "@shared/*": [join(root, "shared/*")],
          "@db": [join(root, "db/index.ts")],
          "@db/*": [join(root, "db/*")],
        },
      },
    })
  );
  await mkdir(artifacts, { recursive: true });
  await rm(join(artifacts, "junit.xml"), { force: true });
  const child = spawn(
    join(root, "node_modules/.bin/eve"),
    [
      "eval",
      "--strict",
      "--skip-report",
      "--junit",
      join(artifacts, "junit.xml"),
    ],
    {
      cwd: fixture,
      detached: process.platform !== "win32",
      // This fixture has mock models and no production service credentials or env files.
      /* oxlint-disable eslint/no-restricted-properties, turbo/no-undeclared-env-vars -- standalone subprocess bootstrap forwards only host executable and home paths. */
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://fictional:fictional@127.0.0.1:9/fixture",
        KERNEL_API_KEY: "fictional-offline-fixture-key",
        BETTER_AUTH_URL: "http://localhost:3000",
        EVE_TELEMETRY_DISABLED: "1",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        WORKFLOW_POSTGRES_URL: postgresUrl,
        WORKFLOW_POSTGRES_WORKER_CONCURRENCY: postgres ? "4" : undefined,
        WORKFLOW_POSTGRES_MAX_POOL_SIZE: postgres ? "10" : undefined,
        WORKFLOW_POSTGRES_POLL_INTERVAL_MS: postgres ? "2000" : undefined,
      },
      /* oxlint-enable eslint/no-restricted-properties, turbo/no-undeclared-env-vars */
      stdio: "inherit",
    }
  );
  let interrupted = false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  function terminate(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  }
  function interrupt() {
    interrupted = true;
    terminate("SIGTERM");
    forceStop ??= setTimeout(() => {
      terminate("SIGKILL");
    }, 5_000);
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timeout = setTimeout(interrupt, 180_000);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve(interrupted ? 1 : (code ?? 1));
      });
    });
  } finally {
    // The CLI can exit while a child is still finishing template preparation.
    // Stop only this fixture's process group before removing its directory.
    terminate("SIGTERM");
    clearTimeout(timeout);
    clearTimeout(forceStop);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (existsSync(join(fixture, ".eve/evals"))) {
      await cp(join(fixture, ".eve/evals"), join(artifacts, "evals"), {
        recursive: true,
      });
    }
  }
} finally {
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
