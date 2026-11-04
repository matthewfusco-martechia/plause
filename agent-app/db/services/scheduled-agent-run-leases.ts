import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db, scheduledAgentRuns, scheduledAgentJobs } from "@db";

export async function isScheduledAgentRunLeaseActive(
  runId: string,
  leaseToken: string,
  now = new Date()
) {
  const [run] = await db
    .select({ id: scheduledAgentRuns.id })
    .from(scheduledAgentRuns)
    .innerJoin(
      scheduledAgentJobs,
      eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
    )
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken),
        gt(scheduledAgentRuns.leaseExpiresAt, now),
        inArray(scheduledAgentJobs.status, ["active", "completed"]),
        eq(scheduledAgentRuns.jobRevision, scheduledAgentJobs.revision),
        sql`${scheduledAgentJobs.notificationPolicy}->>'consentedBy' = ${scheduledAgentJobs.createdByUserId}`
      )
    )
    .limit(1);
  return run !== undefined;
}
