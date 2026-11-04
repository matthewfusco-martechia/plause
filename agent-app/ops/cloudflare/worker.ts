import type {
  DurableObjectState,
  Request as PlatformRequest,
  AbortSignal as PlatformAbortSignal,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { readVerifiedLinqWebhook } from "./linq-webhook";

const internalPaths = new Set([
  "/internal/linq/dispatch",
  "/internal/inkbox/dispatch",
  "/internal/scheduled-run/report",
  "/internal/scheduled-run/respond",
  "/internal/schedules/tick",
  "/internal/schedules/wake",
]);
const runtimeKeys = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "SECRET_ENCRYPTION_KEY",
  "INTERNAL_SERVICE_SECRET",
  "DATABASE_URL",
  "WORKFLOW_POSTGRES_URL",
  "PLAUSE_WORKFLOW_BACKEND",
  "WORKFLOW_POSTGRES_WORKER_CONCURRENCY",
  "WORKFLOW_POSTGRES_MAX_POOL_SIZE",
  "WORKFLOW_POSTGRES_POLL_INTERVAL_MS",
  "KERNEL_API_KEY",
  "OPENAI_API_KEY",
  "MESSAGING_PROVIDER",
  "LINQ_API_KEY",
  "LINQ_PHONE_NUMBER",
  "LINQ_WEBHOOK_SIGNING_SECRET",
  "INKBOX_API_KEY",
  "INKBOX_IDENTITY_ID",
  "INKBOX_AGENT_HANDLE",
  "INKBOX_WEBHOOK_SIGNING_KEY",
  "PRIVATE_ALLOWED_PHONE_NUMBERS",
  "LIVE_MODEL_ENABLED",
  "SCHEDULED_TASKS_ENABLED",
  "BROWSER_ACTIONS_ENABLED",
  "GOOGLE_WORKSPACE_WRITES_ENABLED",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD",
  "MODEL_GLOBAL_MONTHLY_ATTEMPT_LIMIT",
  "MODEL_USER_MONTHLY_BUDGET_MICRO_USD",
  "MODEL_MAX_INPUT_TOKENS",
  "MODEL_MAX_OUTPUT_TOKENS",
  "MODEL_TIMEOUT_MS",
  "PLAUSE_ACCESS_HASH",
  "PLAUSE_EDGE_INTERNAL_TOKEN",
] as const;

type RuntimeEnvironment = Partial<
  Record<(typeof runtimeKeys)[number], string>
> & {
  PLAUSE_HOSTING_ENABLED?: string;
  PLAUSE_ALWAYS_ON?: string;
  PLAUSE_HOST?: string;
  PLAUSE_EDGE_AUTH_SHA256?: string;
  PLAUSE_INKBOX_CALLBACK_TOKEN?: string;
  PLAUSE_RUNTIME: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
};

function rejection(status: number) {
  const headers = new Headers({ "cache-control": "no-store" });
  if (status === 401)
    headers.set(
      "www-authenticate",
      'Basic realm="Plause private staging", charset="UTF-8"'
    );
  return new Response(null, {
    status,
    headers,
  });
}

function equalSecret(actual: string | null, expected: string | undefined) {
  if (!actual || !expected || expected.length < 32 || actual.length > 1024)
    return false;
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest()
  );
}

function basicAuthorized(request: Request, env: RuntimeEnvironment) {
  const header = request.headers.get("authorization") ?? "";
  const expectedHash = env.PLAUSE_EDGE_AUTH_SHA256;
  if (
    !/^Basic [A-Za-z0-9+/]{1,1024}={0,2}$/u.test(header) ||
    !expectedHash ||
    !/^[a-f0-9]{64}$/u.test(expectedHash)
  )
    return false;
  const credential = Buffer.from(header.slice(6), "base64").toString("utf8");
  if (!credential.startsWith("plause:")) return false;
  return timingSafeEqual(
    createHash("sha256").update(credential).digest(),
    Buffer.from(expectedHash, "hex")
  );
}

export default {
  async fetch(request: Request, env: RuntimeEnvironment) {
    if (env.PLAUSE_HOSTING_ENABLED !== "true") return rejection(503);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.host !== env.PLAUSE_HOST)
      return rejection(404);
    if (
      url.pathname.startsWith("/.well-known/workflow/") ||
      url.pathname === "/_plause/runtime-ready"
    )
      return rejection(404);
    if (url.pathname === "/webhooks/linq") {
      if (
        env.MESSAGING_PROVIDER !== "linq" ||
        request.method !== "POST" ||
        (url.search !== "" && url.search !== "?version=2026-02-03")
      )
        return rejection(401);
      const verified = await readVerifiedLinqWebhook(
        request,
        env.LINQ_WEBHOOK_SIGNING_SECRET
      );
      if (!verified) return rejection(401);
      request = verified;
    } else if (
      url.pathname === "/webhooks/inkbox" ||
      internalPaths.has(url.pathname)
    ) {
      if (request.method !== "POST" || url.search) return rejection(401);
      const token =
        url.pathname === "/webhooks/inkbox"
          ? env.PLAUSE_INKBOX_CALLBACK_TOKEN
          : env.PLAUSE_EDGE_INTERNAL_TOKEN;
      if (
        !token ||
        token.length < 32 ||
        !equalSecret(
          request.headers.get("authorization"),
          token ? `Bearer ${token}` : undefined
        )
      )
        return rejection(401);
    } else if (!basicAuthorized(request, env)) return rejection(401);
    if (env.PLAUSE_WORKFLOW_BACKEND !== "postgres") return rejection(503);
    // One named instance, one schedule owner. No random routing or auto-scaling.
    return env.PLAUSE_RUNTIME.getByName("private-agent").fetch(request);
  },
  async scheduled(
    _controller: Pick<ScheduledController, "scheduledTime">,
    env: RuntimeEnvironment
  ) {
    if (
      env.PLAUSE_HOSTING_ENABLED !== "true" ||
      env.PLAUSE_ALWAYS_ON !== "true" ||
      env.PLAUSE_WORKFLOW_BACKEND !== "postgres"
    )
      return;
    if (
      !env.PLAUSE_EDGE_INTERNAL_TOKEN ||
      env.PLAUSE_EDGE_INTERNAL_TOKEN.length < 32
    )
      return;
    await env.PLAUSE_RUNTIME.getByName("private-agent").fetch(
      new Request(`https://${env.PLAUSE_HOST ?? ""}/_plause/runtime-ready`, {
        headers: { authorization: `Bearer ${env.PLAUSE_EDGE_INTERNAL_TOKEN}` },
      })
    );
  },
};

// A fetch-only Durable Object does not need RPC inheritance. The constructor
// receives the platform state, including its configured Container binding.
export class PlauseRuntime {
  private starting: Promise<void> | undefined;
  private environmentRevision: string;
  constructor(
    private ctx: Pick<
      DurableObjectState,
      "container" | "blockConcurrencyWhile"
    > & {
      storage: Pick<
        DurableObjectState["storage"],
        "getAlarm" | "setAlarm" | "get" | "put"
      >;
    },
    private env: RuntimeEnvironment
  ) {
    this.starting = undefined;
    // A surviving container retains its startup environment across Worker deploys.
    // Persist only a fingerprint in its labels; never label secret values.
    this.environmentRevision = createHash("sha256")
      .update(JSON.stringify(runtimeKeys.map((key) => [key, env[key] ?? null])))
      .digest("hex");
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(async () => {
        const current = await container.inspect();
        if (!current) return;
        if (current.labels["plause-env"] !== this.environmentRevision) {
          // PostgreSQL/R2 own durable state. Fence admission until the old
          // process stops, including when a live feature has been disabled.
          await container.destroy();
          return;
        }
        await container.setInactivityTimeout(600_000);
      });
  }

  async fetch(request: PlatformRequest) {
    if (
      this.env.PLAUSE_HOSTING_ENABLED !== "true" ||
      this.env.PLAUSE_WORKFLOW_BACKEND !== "postgres"
    )
      return rejection(503);
    if (new URL(request.url).pathname === "/internal/schedules/wake") {
      if (
        this.env.SCHEDULED_TASKS_ENABLED !== "true" ||
        request.method !== "POST" ||
        !equalSecret(
          request.headers.get("authorization"),
          `Bearer ${this.env.PLAUSE_EDGE_INTERNAL_TOKEN ?? ""}`
        )
      )
        return rejection(401);
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (request.body)
          for await (const chunk of request.body) {
            if (!(chunk instanceof Uint8Array)) return rejection(400);
            length += chunk.byteLength;
            if (length > 128) return rejection(413);
            chunks.push(chunk);
          }
        const hint = z
          .strictObject({
            at: z.number().int().positive().max(8_640_000_000_000_000),
          })
          .parse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks)
              )
            )
          );
        await this.setEarlierWake(hint.at);
        return new Response(null, { status: 204 });
      } catch {
        return rejection(400);
      }
    }
    try {
      await this.startRuntime();
      // Never retry a forwarded request: the app owns durable intake/send receipts.
      const container = this.ctx.container;
      if (!container) return rejection(503);
      // Container port connections use HTTP over Cloudflare's secure internal
      // transport. Preserve the public host, payload and authentication headers.
      const upstream = new URL(request.url);
      upstream.protocol = "http:";
      return await container.getTcpPort(8080).fetch(upstream.href, request);
    } catch {
      return rejection(503);
    }
  }

  private startRuntime() {
    this.starting ??= this.ensureRunning().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async setEarlierWake(at: number) {
    // Hints may arrive out of order while an alarm awaits the app. They can
    // advance a wakeup, never cancel or postpone another task's deadline.
    await this.ctx.blockConcurrencyWhile(async () => {
      const candidate = Math.max(
        Date.now() + 1000,
        Math.min(at, Date.now() + 366 * 86_400_000)
      );
      const current = await this.ctx.storage.getAlarm();
      if (current === null || candidate < current)
        await this.ctx.storage.setAlarm(candidate);
    });
  }

  async alarm() {
    if (
      this.env.PLAUSE_HOSTING_ENABLED !== "true" ||
      this.env.SCHEDULED_TASKS_ENABLED !== "true" ||
      this.env.PLAUSE_WORKFLOW_BACKEND !== "postgres"
    )
      return;
    const secret = this.env.INTERNAL_SERVICE_SECRET,
      token = this.env.PLAUSE_EDGE_INTERNAL_TOKEN;
    if (!secret || secret.length < 32 || !token || token.length < 32) return;
    try {
      await this.startRuntime();
      const container = this.ctx.container;
      if (!container) throw new Error("Runtime unavailable.");
      const path = "/internal/schedules/tick",
        body = "{}",
        timestamp = String(Math.floor(Date.now() / 1000)),
        id = randomUUID();
      const signature = createHmac("sha256", secret)
        .update(
          `plause-scheduled-v1\n${timestamp}\n${id}\nPOST\n${path}\n${body}`
        )
        .digest("hex");
      const response = await container
        .getTcpPort(8080)
        .fetch(`http://container${path}`, {
          method: "POST",
          body,
          // SAFETY: Worker runtime supplies this native signal; only DOM versus Workers declarations differ.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Runtime uses the platform-native AbortSignal.
          signal: AbortSignal.timeout(30_000) as PlatformAbortSignal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-plause-internal-timestamp": timestamp,
            "x-plause-internal-id": id,
            "x-plause-internal-signature": `v1=${signature}`,
          },
        });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("Scheduled wake failed.");
      }
      const result = z
        .strictObject({ nextWakeAt: z.iso.datetime().nullable() })
        .parse(await response.json());
      await this.ctx.storage.put("schedule-wake-failures", 0);
      if (result.nextWakeAt)
        await this.setEarlierWake(Date.parse(result.nextWakeAt));
    } catch {
      const failures = Math.min(
        ((await this.ctx.storage.get<number>("schedule-wake-failures")) ?? 0) +
          1,
        6
      );
      await this.ctx.storage.put("schedule-wake-failures", failures);
      await this.setEarlierWake(
        Date.now() + Math.min(3_600_000, 30_000 * 2 ** failures)
      );
      console.warn(
        "Scheduled wake failed; a bounded-backoff wakeup is registered."
      );
    }
  }

  async ensureRunning() {
    const container = this.ctx.container;
    if (!container) throw new Error("Runtime unavailable.");
    if (!container.running) {
      const env: Partial<Record<(typeof runtimeKeys)[number], string>> = {};
      for (const key of runtimeKeys)
        if (this.env[key] !== undefined) env[key] = this.env[key];
      container.start({
        enableInternet: true,
        env,
        labels: { "plause-env": this.environmentRevision },
      });
    }
    await container.setInactivityTimeout(600_000);
    const deadline = Date.now() + 25_000;
    /* oxlint-disable eslint/no-await-in-loop -- Readiness probes must run serially with backoff, never concurrent starts. */
    while (Date.now() < deadline) {
      try {
        const response = await container
          .getTcpPort(8080)
          .fetch("http://container/_plause/runtime-ready", {
            headers: {
              authorization: `Bearer ${this.env.PLAUSE_EDGE_INTERNAL_TOKEN ?? ""}`,
            },
            // SAFETY: This is the Worker-native AbortSignal at runtime; DOM and Cloudflare declare its listener types separately.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Same platform-native signal; no representation conversion.
            signal: AbortSignal.timeout(1000) as PlatformAbortSignal,
          });
        await response.body?.cancel();
        if (response.status === 200) return;
      } catch {
        /* Only readiness GETs are safe to retry. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Runtime unavailable.");
  }
}
