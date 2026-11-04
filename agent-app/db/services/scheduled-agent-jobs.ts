import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Interaction } from "eve/events";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { isPhoneEnrollmentAllowed } from "@shared/identity/enrollment";
import {
  computeNextRun,
  computeLatestRun,
  scheduleTimingSchema,
  type ScheduleTiming,
} from "@shared/schedules/timing";
import {
  scheduledRunOutcomeSchema,
  type ScheduledRunOutcome,
} from "@shared/schedules/outcome";
import { db, scheduledAgentJobs, scheduledAgentRuns, user } from "@db";
import {
  scheduleNotificationPolicySchema,
  nextScheduledNotificationTime,
} from "@shared/schedules/notifications";

// eve exports the Interaction type without a runtime guard; check the fields
// the answer route and report prompt read before trusting a stored request.
const storedInteractionSchema = z.looseObject({
  interactionId: z.string().min(1),
  request: z.looseObject({
    kind: z.string().min(1),
    options: z
      .array(z.looseObject({ id: z.string(), label: z.string() }))
      .optional(),
    prompt: z.string(),
  }),
});
const pendingInputRequestsSchema = z
  .array(
    z.custom<Interaction>(
      (value) => storedInteractionSchema.safeParse(value).success
    )
  )
  .min(1);

const exhaustedRunOutcome = {
  kind: "blocked",
  summary: "The scheduled task could not complete after three attempts.",
  userActionNeeded: "Try the task again or update the schedule.",
} satisfies ScheduledRunOutcome;

export interface CreateScheduledAgentJob {
  readonly id?: string;
  readonly notificationPolicy?: z.infer<
    typeof scheduleNotificationPolicySchema
  >;
  readonly conversationChannel: "eve" | "linq" | "inkbox";
  readonly conversationId: string;
  readonly missedRunPolicy: "catch_up" | "run_latest";
  readonly prompt: string;
  readonly replyAnchorMessageId?: string;
  readonly timing: ScheduleTiming;
}

export interface UpdateScheduledAgentJob {
  readonly notificationPolicy?: z.infer<
    typeof scheduleNotificationPolicySchema
  >;
  readonly prompt?: string;
  readonly status?: "active" | "deleted" | "paused";
  readonly timing?: ScheduleTiming;
}

function parseJob<T extends typeof scheduledAgentJobs.$inferSelect>(job: T) {
  const policy = scheduleNotificationPolicySchema.safeParse(
    job.notificationPolicy
  );
  return {
    ...job,
    timing: scheduleTimingSchema.parse(job.timing),
    notificationPolicy:
      policy.success && policy.data.consentedBy === job.createdByUserId
        ? policy.data
        : null,
  };
}

function parseRun<T extends typeof scheduledAgentRuns.$inferSelect>(run: T) {
  return {
    ...run,
    pendingInputRequests: run.pendingInputRequests
      ? pendingInputRequestsSchema.parse(run.pendingInputRequests)
      : null,
    outcome: run.outcome ? scheduledRunOutcomeSchema.parse(run.outcome) : null,
  };
}

export async function createScheduledAgentJob(
  scope: AccessScope,
  input: CreateScheduledAgentJob,
  now = new Date()
) {
  if (
    input.notificationPolicy &&
    input.notificationPolicy.consentedBy !== scope.userId
  )
    throw new Error("Schedule notification consent must belong to its owner.");
  const nextRunAt = computeNextRun(input.timing, now);
  if (!nextRunAt) throw new Error("That schedule has no future occurrence.");
  const [job] = await db
    .insert(scheduledAgentJobs)
    .values({
      id: input.id,
      createdAt: now,
      createdByUserId: scope.userId,
      conversationChannel: input.conversationChannel,
      conversationId: input.conversationId,
      missedRunPolicy: input.missedRunPolicy,
      notificationPolicy: input.notificationPolicy
        ? scheduleNotificationPolicySchema.parse(input.notificationPolicy)
        : null,
      nextRunAt,
      prompt: input.prompt,
      replyAnchorMessageId: input.replyAnchorMessageId,
      status: "active",
      timing: input.timing,
      updatedAt: now,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing({ target: scheduledAgentJobs.id })
    .returning();
  if (!job && input.id) {
    const existing = await db.query.scheduledAgentJobs.findFirst({
      where: and(
        eq(scheduledAgentJobs.id, input.id),
        eq(scheduledAgentJobs.workspaceId, scope.workspaceId),
        eq(scheduledAgentJobs.createdByUserId, scope.userId)
      ),
    });
    const policy = existing ? parseJob(existing).notificationPolicy : null;
    if (
      !existing ||
      existing.conversationId !== input.conversationId ||
      existing.conversationChannel !== input.conversationChannel ||
      existing.prompt !== input.prompt ||
      !isDeepStrictEqual(existing.timing, input.timing) ||
      existing.missedRunPolicy !== input.missedRunPolicy ||
      existing.status === "deleted"
    )
      throw new Error(
        "The scheduled request identity conflicts with existing work."
      );
    if (
      !isDeepStrictEqual(
        policy
          ? [policy.timezone, policy.quietHours, policy.consentedBy]
          : null,
        input.notificationPolicy
          ? [
              input.notificationPolicy.timezone,
              input.notificationPolicy.quietHours,
              input.notificationPolicy.consentedBy,
            ]
          : null
      )
    )
      throw new Error(
        "The scheduled request identity conflicts with existing delivery consent."
      );
    return parseJob(existing);
  }
  if (!job) throw new Error("The schedule could not be created.");
  return parseJob(job);
}

export async function listScheduledAgentJobs(
  scope: AccessScope,
  conversation: Pick<
    CreateScheduledAgentJob,
    "conversationChannel" | "conversationId"
  >
) {
  const jobs = await db.query.scheduledAgentJobs.findMany({
    orderBy: asc(scheduledAgentJobs.nextRunAt),
    where: and(
      eq(scheduledAgentJobs.workspaceId, scope.workspaceId),
      eq(scheduledAgentJobs.createdByUserId, scope.userId),
      eq(
        scheduledAgentJobs.conversationChannel,
        conversation.conversationChannel
      ),
      eq(scheduledAgentJobs.conversationId, conversation.conversationId),
      sql`${scheduledAgentJobs.status} <> 'deleted'`
    ),
    with: {
      runs: {
        limit: 1,
        orderBy: desc(scheduledAgentRuns.scheduledFor),
      },
    },
  });
  return jobs.map(({ runs, ...job }) => {
    const parsed = parseJob(job);
    parsed.lastError = runs[0]?.lastError ?? parsed.lastError;
    return Object.assign(parsed, {
      latestRun: runs[0] ? parseRun(runs[0]) : null,
    });
  });
}

export async function updateScheduledAgentJob(
  scope: AccessScope,
  conversation: Pick<
    CreateScheduledAgentJob,
    "conversationChannel" | "conversationId"
  >,
  id: string,
  patch: UpdateScheduledAgentJob,
  now = new Date()
) {
  if (
    patch.notificationPolicy &&
    patch.notificationPolicy.consentedBy !== scope.userId
  )
    throw new Error("Schedule notification consent must belong to its owner.");
  const current = await db.query.scheduledAgentJobs.findFirst({
    where: and(
      eq(scheduledAgentJobs.id, id),
      eq(scheduledAgentJobs.workspaceId, scope.workspaceId),
      eq(scheduledAgentJobs.createdByUserId, scope.userId),
      eq(
        scheduledAgentJobs.conversationChannel,
        conversation.conversationChannel
      ),
      eq(scheduledAgentJobs.conversationId, conversation.conversationId),
      sql`${scheduledAgentJobs.status} <> 'deleted'`
    ),
  });
  if (!current) return undefined;
  const timing = patch.timing ?? scheduleTimingSchema.parse(current.timing);
  const status = patch.status ?? current.status;
  const shouldRecompute =
    patch.timing !== undefined ||
    (patch.status === "active" && current.status !== "active");
  const nextRunAt =
    status !== "active"
      ? null
      : shouldRecompute
        ? computeNextRun(timing, now)
        : current.nextRunAt;
  if (status === "active" && !nextRunAt) {
    throw new Error("That schedule has no future occurrence.");
  }
  const [job] = await db
    .update(scheduledAgentJobs)
    .set({
      ...patch,
      nextRunAt,
      revision: sql`${scheduledAgentJobs.revision} + 1`,
      timing,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentJobs.id, current.id),
        eq(scheduledAgentJobs.revision, current.revision)
      )
    )
    .returning();
  return job ? parseJob(job) : undefined;
}

export async function materializeDueScheduledAgentRuns(options: {
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const due = await transaction
      .select()
      .from(scheduledAgentJobs)
      .where(
        and(
          eq(scheduledAgentJobs.status, "active"),
          sql`${scheduledAgentJobs.notificationPolicy}->>'consentedBy' = ${scheduledAgentJobs.createdByUserId}`,
          lte(scheduledAgentJobs.nextRunAt, options.now)
        )
      )
      .orderBy(asc(scheduledAgentJobs.nextRunAt))
      .limit(options.limit)
      .for("update", { skipLocked: true });
    const createdRunIds = await Promise.all(
      due.map(async (job) => {
        if (!job.nextRunAt) return undefined;
        const timing = scheduleTimingSchema.parse(job.timing);
        const scheduledFor =
          job.missedRunPolicy === "catch_up"
            ? job.nextRunAt
            : (computeLatestRun(timing, options.now) ?? job.nextRunAt);
        const next = computeNextRun(timing, scheduledFor);
        const [run] = await transaction
          .insert(scheduledAgentRuns)
          .values({
            createdAt: options.now,
            jobId: job.id,
            jobRevision: job.revision,
            scheduledFor,
            updatedAt: options.now,
          })
          .onConflictDoNothing({
            target: [scheduledAgentRuns.jobId, scheduledAgentRuns.scheduledFor],
          })
          .returning({ id: scheduledAgentRuns.id });
        await transaction
          .update(scheduledAgentJobs)
          .set({
            lastRunAt: scheduledFor,
            nextRunAt: next,
            status: next ? "active" : "completed",
            updatedAt: options.now,
          })
          .where(eq(scheduledAgentJobs.id, job.id));
        return run?.id;
      })
    );
    return createdRunIds.filter((id) => id !== undefined);
  });
}

export async function claimReadyScheduledAgentRuns(options: {
  readonly leaseForMs: number;
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const ready = await transaction
      .select({ job: scheduledAgentJobs, run: scheduledAgentRuns })
      .from(scheduledAgentRuns)
      .innerJoin(
        scheduledAgentJobs,
        eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
      )
      .where(
        and(
          inArray(scheduledAgentJobs.status, ["active", "completed"]),
          eq(scheduledAgentRuns.jobRevision, scheduledAgentJobs.revision),
          sql`${scheduledAgentJobs.notificationPolicy}->>'consentedBy' = ${scheduledAgentJobs.createdByUserId}`,
          or(
            eq(scheduledAgentRuns.status, "queued"),
            and(
              eq(scheduledAgentRuns.status, "running"),
              isNull(scheduledAgentRuns.workerSessionId),
              lte(scheduledAgentRuns.leaseExpiresAt, options.now)
            )
          ),
          or(
            isNull(scheduledAgentRuns.retryAt),
            lte(scheduledAgentRuns.retryAt, options.now)
          )
        )
      )
      .orderBy(asc(scheduledAgentRuns.scheduledFor))
      .limit(options.limit)
      .for("update", { of: scheduledAgentRuns, skipLocked: true });
    if (ready.length === 0) return [];
    const exhausted = ready.filter(({ run }) => run.attempts >= 3);
    if (exhausted.length > 0) {
      await transaction
        .update(scheduledAgentRuns)
        .set({
          lastError: "Scheduled worker dispatch did not complete.",
          leaseExpiresAt: null,
          leaseToken: null,
          outcome: exhaustedRunOutcome,
          reportSequence: sql`${scheduledAgentRuns.reportSequence} + 1`,
          reportStatus: "pending",
          retryAt: null,
          status: "dead_letter",
          updatedAt: options.now,
        })
        .where(
          inArray(
            scheduledAgentRuns.id,
            exhausted.map(({ run }) => run.id)
          )
        );
    }
    const claimable = ready.filter(({ run }) => run.attempts < 3);
    if (claimable.length === 0) return [];
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(options.now.getTime() + options.leaseForMs);
    const ids = claimable.map(({ run }) => run.id);
    await transaction
      .update(scheduledAgentRuns)
      .set({
        attempts: sql`${scheduledAgentRuns.attempts} + 1`,
        deferredCompletionTurnId: null,
        leaseExpiresAt,
        leaseToken,
        retryAt: null,
        startedAt: null,
        status: "running",
        updatedAt: options.now,
      })
      .where(inArray(scheduledAgentRuns.id, ids));
    return claimable.map(({ job, run }) => ({
      job: parseJob(job),
      run: parseRun({
        ...run,
        attempts: run.attempts + 1,
        leaseExpiresAt,
        leaseToken,
        retryAt: null,
        startedAt: null,
        status: "running",
      }),
    }));
  });
}

export async function setScheduledRunSession(
  runId: string,
  leaseToken: string,
  workerSessionId: string
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({ workerSessionId, updatedAt: new Date() })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  if (run) return true;
  const current = await db.query.scheduledAgentRuns.findFirst({
    columns: { workerSessionId: true },
    where: eq(scheduledAgentRuns.id, runId),
  });
  return current?.workerSessionId === workerSessionId;
}

export async function markScheduledAgentRunStarted(
  runId: string,
  leaseToken: string,
  workerSessionId: string,
  leaseForMs: number,
  now = new Date()
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseForMs),
      startedAt: sql`coalesce(${scheduledAgentRuns.startedAt}, ${now})`,
      updatedAt: now,
      workerSessionId,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}

export async function waitForScheduledAgentRunInput(
  runId: string,
  leaseToken: string,
  pendingInputRequests: readonly Interaction[],
  now = new Date()
) {
  const parsedRequests = pendingInputRequestsSchema.parse(pendingInputRequests);
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      pendingInputRequests: parsedRequests,
      leaseExpiresAt: null,
      reportSequence: sql`${scheduledAgentRuns.reportSequence} + 1`,
      reportStatus: "pending",
      status: "waiting_for_input",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning();
  return run ? parseRun(run) : undefined;
}

export async function getScheduledAgentRunInput(
  scope: AccessScope,
  conversation: Pick<
    CreateScheduledAgentJob,
    "conversationChannel" | "conversationId"
  >,
  runId: string
) {
  const pending = await db.query.scheduledAgentRuns.findFirst({
    where: and(
      eq(scheduledAgentRuns.id, runId),
      eq(scheduledAgentRuns.status, "waiting_for_input"),
      eq(scheduledAgentRuns.reportStatus, "delivered")
    ),
    with: { job: true },
  });
  if (
    !pending ||
    pending.job.workspaceId !== scope.workspaceId ||
    pending.job.createdByUserId !== scope.userId ||
    pending.job.conversationChannel !== conversation.conversationChannel ||
    pending.job.conversationId !== conversation.conversationId ||
    !pending.leaseToken ||
    !pending.pendingInputRequests ||
    !pending.workerSessionId
  ) {
    return undefined;
  }
  return {
    leaseToken: pending.leaseToken,
    runId: pending.id,
  };
}

export async function getScheduledAgentRunInputForReport(
  runId: string,
  reportLeaseToken: string
) {
  const pending = await db.query.scheduledAgentRuns.findFirst({
    where: and(
      eq(scheduledAgentRuns.id, runId),
      eq(scheduledAgentRuns.status, "waiting_for_input"),
      eq(scheduledAgentRuns.reportStatus, "queued"),
      eq(scheduledAgentRuns.reportLeaseToken, reportLeaseToken)
    ),
  });
  if (
    !pending?.leaseToken ||
    !pending.pendingInputRequests ||
    !pending.workerSessionId
  ) {
    return undefined;
  }
  return { leaseToken: pending.leaseToken, runId: pending.id };
}

export async function claimScheduledAgentRunInput(
  runId: string,
  leaseToken: string,
  now = new Date()
) {
  const [claimed] = await db
    .update(scheduledAgentRuns)
    .set({
      leaseExpiresAt: new Date(now.getTime() + 6 * 60 * 60_000),
      status: "running",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "waiting_for_input"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning();
  if (!claimed?.pendingInputRequests || !claimed.workerSessionId) {
    return undefined;
  }
  const claimedWithJob = await db.query.scheduledAgentRuns.findFirst({
    where: eq(scheduledAgentRuns.id, claimed.id),
    with: { job: true },
  });
  if (!claimedWithJob) return undefined;
  const { job, ...run } = claimedWithJob;
  return { job: parseJob(job), run: parseRun(run) };
}

export async function restoreScheduledAgentRunInput(
  runId: string,
  leaseToken: string,
  errorMessage: string,
  now = new Date()
) {
  await db
    .update(scheduledAgentRuns)
    .set({
      deferredCompletionTurnId: null,
      lastError: errorMessage.slice(0, 2_000),
      leaseExpiresAt: null,
      status: "waiting_for_input",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    );
}

export async function finishScheduledAgentRunInput(
  runId: string,
  leaseToken: string,
  now = new Date()
) {
  await db
    .update(scheduledAgentRuns)
    .set({
      deferredCompletionTurnId: null,
      pendingInputRequests: null,
      lastError: null,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportStatus: "not_ready",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    );
}

export async function completeScheduledAgentRun(
  runId: string,
  leaseToken: string,
  outcome: ScheduledRunOutcome,
  completedAt = new Date()
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      completedAt,
      deferredCompletionTurnId: null,
      pendingInputRequests: null,
      lastError: null,
      leaseExpiresAt: null,
      leaseToken: null,
      outcome,
      reportSequence:
        outcome.kind === "nothing_to_report"
          ? scheduledAgentRuns.reportSequence
          : sql`${scheduledAgentRuns.reportSequence} + 1`,
      reportStatus:
        outcome.kind === "nothing_to_report" ? "not_needed" : "pending",
      status: "completed",
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning();
  return run ? { run: parseRun(run) } : undefined;
}

export async function releaseScheduledAgentRun(
  runId: string,
  leaseToken: string,
  errorMessage: string,
  now = new Date()
) {
  const run = await db.query.scheduledAgentRuns.findFirst({
    where: and(
      eq(scheduledAgentRuns.id, runId),
      eq(scheduledAgentRuns.leaseToken, leaseToken)
    ),
  });
  if (!run) return undefined;
  const dead = run.attempts >= 3;
  const [released] = await db
    .update(scheduledAgentRuns)
    .set({
      deferredCompletionTurnId: null,
      lastError: errorMessage.slice(0, 2_000),
      leaseExpiresAt: null,
      leaseToken: null,
      outcome: dead ? exhaustedRunOutcome : run.outcome,
      reportSequence: dead
        ? sql`${scheduledAgentRuns.reportSequence} + 1`
        : scheduledAgentRuns.reportSequence,
      reportStatus: dead ? "pending" : run.reportStatus,
      retryAt: dead ? null : new Date(now.getTime() + 5 * 60_000),
      status: dead ? "dead_letter" : "queued",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, run.id),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ status: scheduledAgentRuns.status });
  return released?.status;
}

export async function claimScheduledReport(runId: string, now = new Date()) {
  const candidate = await db.query.scheduledAgentRuns.findFirst({
    where: eq(scheduledAgentRuns.id, runId),
    with: { job: true },
  });
  const policy = candidate ? parseJob(candidate.job).notificationPolicy : null;
  if (
    !candidate ||
    !policy ||
    candidate.jobRevision !== candidate.job.revision ||
    !["active", "completed"].includes(candidate.job.status)
  )
    return undefined;
  const allowedAt = nextScheduledNotificationTime(policy, now);
  if (allowedAt > now) {
    await db
      .update(scheduledAgentRuns)
      .set({ reportNotBefore: allowedAt })
      .where(
        and(
          eq(scheduledAgentRuns.id, runId),
          eq(scheduledAgentRuns.reportStatus, "pending")
        )
      );
    return undefined;
  }
  const reportLeaseToken = randomUUID();
  const [claimed] = await db
    .update(scheduledAgentRuns)
    .set({
      reportLeaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
      reportLeaseToken,
      reportNotBefore: null,
      reportStatus: "queued",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        inArray(scheduledAgentRuns.status, [
          "completed",
          "dead_letter",
          "waiting_for_input",
        ]),
        eq(scheduledAgentRuns.reportStatus, "pending")
      )
    )
    .returning();
  if (!claimed) return undefined;
  const claimedWithJob = await db.query.scheduledAgentRuns.findFirst({
    where: eq(scheduledAgentRuns.id, claimed.id),
    with: { job: true },
  });
  if (!claimedWithJob) return undefined;
  const { job, ...run } = claimedWithJob;
  return { job: parseJob(job), run: parseRun(run) };
}

/** Final dispatch authority; database time is evaluated after any provider/media awaits. */
export async function isScheduledReportDeliveryActive(
  scope: AccessScope,
  runId: string,
  leaseToken: string,
  sequence: number
) {
  if (
    !scope.userId.startsWith("better-auth:") ||
    accessScopeForUser(scope.userId).workspaceId !== scope.workspaceId ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  )
    return false;
  const [current] = await db
    .select({
      phoneNumber: user.phoneNumber,
      notificationPolicy: scheduledAgentJobs.notificationPolicy,
      databaseNow: sql<Date>`clock_timestamp()`,
    })
    .from(scheduledAgentRuns)
    .innerJoin(
      scheduledAgentJobs,
      eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
    )
    .innerJoin(user, eq(user.id, scope.userId.slice("better-auth:".length)))
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.reportLeaseToken, leaseToken),
        eq(scheduledAgentRuns.reportSequence, sequence),
        eq(scheduledAgentRuns.reportStatus, "queued"),
        gt(scheduledAgentRuns.reportLeaseExpiresAt, sql`clock_timestamp()`),
        inArray(scheduledAgentRuns.status, [
          "completed",
          "dead_letter",
          "waiting_for_input",
        ]),
        eq(scheduledAgentJobs.workspaceId, scope.workspaceId),
        eq(scheduledAgentJobs.createdByUserId, scope.userId),
        eq(scheduledAgentRuns.jobRevision, scheduledAgentJobs.revision),
        // One-time jobs become completed when materialized, before their result is delivered.
        inArray(scheduledAgentJobs.status, ["active", "completed"]),
        eq(user.phoneNumberVerified, true)
      )
    );
  if (!current?.phoneNumber || !isPhoneEnrollmentAllowed(current.phoneNumber))
    return false;
  const policy = scheduleNotificationPolicySchema.safeParse(
    current.notificationPolicy
  );
  const now = new Date(current.databaseNow);
  return (
    policy.success &&
    policy.data.consentedBy === scope.userId &&
    nextScheduledNotificationTime(policy.data, now) <= now
  );
}

export async function listRecoverableScheduledReports(
  now = new Date(),
  limit = 25
) {
  return db.transaction(async (transaction) => {
    const reports = await transaction
      .select({
        conversationChannel: scheduledAgentJobs.conversationChannel,
        run: scheduledAgentRuns,
      })
      .from(scheduledAgentRuns)
      .innerJoin(
        scheduledAgentJobs,
        eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
      )
      .where(
        and(
          inArray(scheduledAgentJobs.status, ["active", "completed"]),
          eq(scheduledAgentRuns.jobRevision, scheduledAgentJobs.revision),
          sql`${scheduledAgentJobs.notificationPolicy}->>'consentedBy' = ${scheduledAgentJobs.createdByUserId}`,
          or(
            isNull(scheduledAgentRuns.reportNotBefore),
            lte(scheduledAgentRuns.reportNotBefore, now)
          ),
          inArray(scheduledAgentRuns.status, [
            "completed",
            "dead_letter",
            "waiting_for_input",
          ]),
          or(
            eq(scheduledAgentRuns.reportStatus, "pending"),
            and(
              eq(scheduledAgentRuns.reportStatus, "queued"),
              lte(scheduledAgentRuns.reportLeaseExpiresAt, now)
            )
          )
        )
      )
      .orderBy(asc(scheduledAgentRuns.updatedAt))
      .limit(limit)
      .for("update", { of: scheduledAgentRuns, skipLocked: true });
    const stale = reports
      .map(({ run }) => run)
      .filter((run) => run.reportStatus === "queued");
    if (stale.length > 0) {
      await transaction
        .update(scheduledAgentRuns)
        .set({
          reportLeaseExpiresAt: null,
          reportLeaseToken: null,
          reportStatus: "pending",
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              scheduledAgentRuns.id,
              stale.map((run) => run.id)
            ),
            eq(scheduledAgentRuns.reportStatus, "queued"),
            lte(scheduledAgentRuns.reportLeaseExpiresAt, now)
          )
        );
    }
    return reports.map(({ conversationChannel, run }) => ({
      conversationChannel,
      runId: run.id,
    }));
  });
}

// The gateway stores only this deadline. Prompts, identity and results stay in PostgreSQL.
export async function expireScheduledAgentRuns(now = new Date()) {
  return db
    .update(scheduledAgentRuns)
    .set({
      status: "dead_letter",
      leaseToken: null,
      leaseExpiresAt: null,
      reportStatus: "pending",
      reportSequence: sql`${scheduledAgentRuns.reportSequence} + 1`,
      outcome: {
        kind: "blocked",
        summary:
          "The scheduled task exceeded its allowed runtime. It was not automatically retried.",
        userActionNeeded:
          "Review the task outcome before starting distinct new work.",
      } satisfies ScheduledRunOutcome,
      lastError: "Scheduled worker runtime expired.",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.status, "running"),
        sql`${scheduledAgentRuns.workerSessionId} IS NOT NULL`,
        lte(scheduledAgentRuns.leaseExpiresAt, now)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
}

export async function readNextScheduledWake(now = new Date()) {
  const [job] = await db
    .select({ at: sql<Date | null>`min(${scheduledAgentJobs.nextRunAt})` })
    .from(scheduledAgentJobs)
    .where(
      and(
        eq(scheduledAgentJobs.status, "active"),
        sql`${scheduledAgentJobs.notificationPolicy}->>'consentedBy' = ${scheduledAgentJobs.createdByUserId}`
      )
    );
  const [run] = await db
    .select({
      at: sql<Date | null>`least(
    min(case when ${scheduledAgentRuns.status} = 'queued' then coalesce(${scheduledAgentRuns.retryAt}, ${now}) when ${scheduledAgentRuns.status} = 'running' then least(${scheduledAgentRuns.leaseExpiresAt}, ${new Date(now.getTime() + 60_000)}) end),
    min(case when ${scheduledAgentRuns.reportStatus} = 'pending' then coalesce(${scheduledAgentRuns.reportNotBefore}, ${now}) when ${scheduledAgentRuns.reportStatus} = 'queued' then ${scheduledAgentRuns.reportLeaseExpiresAt} end))`,
    })
    .from(scheduledAgentRuns)
    .innerJoin(
      scheduledAgentJobs,
      eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
    )
    .where(
      and(
        inArray(scheduledAgentJobs.status, ["active", "completed"]),
        eq(scheduledAgentRuns.jobRevision, scheduledAgentJobs.revision),
        sql`${scheduledAgentJobs.notificationPolicy}->>'consentedBy' = ${scheduledAgentJobs.createdByUserId}`
      )
    );
  const times = [job?.at, run?.at]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => new Date(value).getTime());
  return times.length
    ? new Date(Math.max(now.getTime() + 1000, Math.min(...times)))
    : null;
}

export async function releaseScheduledReport(
  runId: string,
  leaseToken: string,
  errorMessage: string
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      lastError: errorMessage.slice(0, 2_000),
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportStatus: "pending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.reportLeaseToken, leaseToken),
        eq(scheduledAgentRuns.reportStatus, "queued")
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}

/** An uncertain provider dispatch is never eligible for automatic report recovery. */
export async function holdScheduledReport(
  runId: string,
  leaseToken: string,
  errorMessage: string
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      reportStatus: "unknown",
      lastError: errorMessage.slice(0, 2_000),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.reportLeaseToken, leaseToken),
        eq(scheduledAgentRuns.reportStatus, "queued")
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}

export async function finalizeScheduledReport(
  runId: string,
  leaseToken: string,
  reportStatus: "delivered" | "suppressed"
) {
  const reportableRunStatus =
    reportStatus === "suppressed"
      ? inArray(scheduledAgentRuns.status, ["completed", "dead_letter"])
      : inArray(scheduledAgentRuns.status, [
          "completed",
          "dead_letter",
          "waiting_for_input",
        ]);
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportStatus,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.reportLeaseToken, leaseToken),
        eq(scheduledAgentRuns.reportStatus, "queued"),
        reportableRunStatus
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}
