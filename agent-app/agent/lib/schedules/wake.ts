import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

export async function requestScheduleWake(at: Date | null) {
  if (!at || env.PLAUSE_WORKFLOW_BACKEND !== "postgres") return;
  if (!env.PLAUSE_EDGE_INTERNAL_TOKEN || env.SCHEDULED_TASKS_ENABLED !== "true")
    throw new Error("Scheduled task wakeups are not enabled on this host.");
  const response = await fetch(
    new URL("/internal/schedules/wake", applicationOrigin()),
    {
      method: "POST",
      body: JSON.stringify({ at: at.getTime() }),
      headers: {
        authorization: `Bearer ${env.PLAUSE_EDGE_INTERNAL_TOKEN}`,
        "content-type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }
  );
  await response.body?.cancel();
  if (response.status !== 204)
    throw new Error("The scheduled task wakeup could not be registered.");
}
