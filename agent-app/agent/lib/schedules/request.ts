import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { signScheduledRequest } from "./internal-auth";

const eveDevServerSchema = z.object({
  appRoot: z.string(),
  origin: z.url(),
});

interface ScheduledRunRequestBodies {
  "/internal/scheduled-run/report": { runId: string };
  "/internal/scheduled-run/respond": {
    answer: string;
    leaseToken: string;
    runId: string;
  };
}

export async function postScheduledRunRoute<
  Route extends keyof ScheduledRunRequestBodies,
>(route: Route, body: ScheduledRunRequestBodies[Route]) {
  const rawBody = JSON.stringify(body);
  const headers = signScheduledRequest(route, rawBody);
  const origin = await scheduledRunOrigin();
  return fetch(new URL(route, origin), {
    body: rawBody,
    headers,
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

async function scheduledRunOrigin() {
  if (env.NODE_ENV === "development") {
    try {
      const registry = eveDevServerSchema.parse(
        JSON.parse(await readFile(".eve/next-dev-server.json", "utf8"))
      );
      if (registry.appRoot === process.cwd()) {
        return new URL(registry.origin).origin;
      }
    } catch {
      // Standalone development does not create the Next.js server registry.
    }
  }
  return applicationOrigin();
}

export async function postScheduledReport(runId: string) {
  const response = await postScheduledRunRoute(
    "/internal/scheduled-run/report",
    { runId }
  );
  if (response.status !== 202) {
    throw new Error(
      `Scheduled report callback failed (${String(response.status)}).`
    );
  }
}
