import {
  defineDynamic,
  defineTool,
  type DynamicToolResult,
  type ToolContext,
} from "eve/tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import { always } from "eve/tools/approval";
import { env } from "@shared/environment";
import { requestScheduleWake } from "@agent/lib/schedules/wake";
import { scheduleNotificationPreferencesSchema } from "@shared/schedules/notifications";
import { resolveModeValue } from "@agent/lib/mode";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
import { postScheduledRunRoute } from "@agent/lib/schedules/request";
import {
  scheduleListSummary,
  scheduleOwner,
  scheduleReplyAnchor,
  scheduleSummary,
} from "@agent/lib/schedules/tools";
import { scheduleTimingSchema } from "@shared/schedules/timing";
import {
  createScheduledAgentJob,
  getScheduledAgentRunInput,
  getScheduledAgentRunInputForReport,
  listScheduledAgentJobs,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";

export const createSchedule = defineTool({
  approval: {
    request: always(),
    prompt: ({ input }) =>
      `Allow this scheduled task and its future messages in this conversation?\nTask: ${input.prompt}\nTiming: ${JSON.stringify(input.timing)}\nDelivery: ${JSON.stringify(input.notifications)}`,
  },
  description:
    "Create a one-time, fixed-interval, or timezone-aware calendar job for this conversation. Use calendar timing for human wall-clock recurrence so it remains stable across daylight saving time. Summarize the exact requested work in prompt.",
  inputSchema: z.object({
    missedRunPolicy: z.enum(["run_latest", "catch_up"]).default("run_latest"),
    prompt: z.string().trim().min(1).max(8_000),
    timing: scheduleTimingSchema,
    notifications: scheduleNotificationPreferencesSchema,
  }),
  async execute(input, context) {
    const owner = scheduleOwner(context);
    requireScheduleApproval(context);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          owner.scope.workspaceId,
          context.session.id,
          context.callId,
          "schedules-create",
        ])
      )
      .digest("hex");
    const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    const job = await createScheduledAgentJob(owner.scope, {
      id,
      ...owner.conversation,
      missedRunPolicy: input.missedRunPolicy,
      prompt: input.prompt,
      replyAnchorMessageId: scheduleReplyAnchor(context),
      timing: input.timing,
      notificationPolicy: {
        ...input.notifications,
        consentedBy: owner.scope.userId,
        consentedAt: new Date().toISOString(),
      },
    });
    try {
      await requestScheduleWake(job.nextRunAt);
    } catch (error) {
      await updateScheduledAgentJob(owner.scope, owner.conversation, job.id, {
        status: "paused",
      });
      throw error;
    }
    return scheduleSummary(job);
  },
});

export const listSchedules = defineTool({
  description:
    "List the authenticated user's one-time and recurring jobs for this conversation. Use this before changing a schedule when the target is ambiguous.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const owner = scheduleOwner(context);
    return (await listScheduledAgentJobs(owner.scope, owner.conversation)).map(
      scheduleListSummary
    );
  },
});

const updateScheduleInputSchema = z
  .object({
    id: z.uuid(),
    prompt: z.string().trim().min(1).max(8_000).optional(),
    status: z.enum(["active", "paused", "deleted"]).optional(),
    timing: scheduleTimingSchema.optional(),
    notifications: scheduleNotificationPreferencesSchema.optional(),
  })
  .refine(
    ({ prompt, status, timing, notifications }) =>
      prompt !== undefined ||
      status !== undefined ||
      timing !== undefined ||
      notifications !== undefined,
    { message: "Provide at least one schedule change." }
  )
  .refine(
    ({ status, prompt, timing, notifications }) =>
      status !== "active" || Boolean(prompt && timing && notifications),
    {
      message:
        "Resuming a task requires its complete prompt, timing and notification preferences for owner review.",
    }
  );

export const updateSchedule = defineTool({
  approval: ({ toolInput }) =>
    toolInput?.status === "deleted" || toolInput?.status === "paused"
      ? "not-applicable"
      : "user-approval",
  description:
    "Update, pause, resume, or delete a user-owned scheduled job. Resuming with status active requires the complete prompt, timing and notification preferences for approval. Pausing/deleting needs no new notification consent. List schedules first when the target is ambiguous.",
  inputSchema: updateScheduleInputSchema,
  async execute({ id, notifications, ...patch }, context) {
    const owner = scheduleOwner(context);
    if (patch.status !== "paused" && patch.status !== "deleted")
      requireScheduleApproval(context);
    if (
      patch.status === "active" &&
      (!patch.prompt || !patch.timing || !notifications)
    )
      throw new Error(
        "Resuming requires the complete task, timing and notification preferences for review."
      );
    const job = await updateScheduledAgentJob(
      owner.scope,
      owner.conversation,
      id,
      notifications
        ? {
            ...patch,
            notificationPolicy: {
              ...notifications,
              consentedBy: owner.scope.userId,
              consentedAt: new Date().toISOString(),
            },
          }
        : patch
    );
    if (!job) throw new Error("Schedule not found.");
    if (job.status === "active") {
      try {
        await requestScheduleWake(job.nextRunAt);
      } catch (error) {
        await updateScheduledAgentJob(owner.scope, owner.conversation, job.id, {
          status: "paused",
        });
        throw error;
      }
    }
    return scheduleSummary(job);
  },
});

function requireScheduleApproval(context: ToolContext) {
  if (env.SCHEDULED_TASKS_ENABLED !== "true")
    throw new Error("Scheduled tasks are disabled on this host.");
  const owner = context.session.auth.current;
  if (
    !owner ||
    context.approval?.responder.principalType !== "user" ||
    context.approval.responder.principalId !== owner.principalId
  )
    throw new Error(
      "The schedule owner must approve this exact task and its delivery preferences."
    );
}

export const answerSchedule = defineTool({
  description:
    "Resume a scheduled task that is waiting for input. During scheduled reporting, use existing conversation context when it clearly answers the request. During an interactive turn, pass the user's answer exactly as given.",
  inputSchema: z.strictObject({
    answer: z.string().trim().min(1).max(8_000),
    runId: z.uuid(),
  }),
  async execute({ answer, runId }, context) {
    const pending = await pendingScheduledRun(context, runId);
    if (!pending) {
      throw new Error("That scheduled task is not waiting for input.");
    }
    const response = await postScheduledRunRoute(
      "/internal/scheduled-run/respond",
      {
        answer,
        leaseToken: pending.leaseToken,
        runId: pending.runId,
      }
    );
    if (response.status !== 202) {
      throw new Error(
        response.status === 422
          ? "That answer does not match the pending choices."
          : "The scheduled task could not be resumed."
      );
    }
    return { resumed: true, runId };
  },
});

export default defineDynamic((context): DynamicToolResult => {
  if (env.SCHEDULED_TASKS_ENABLED !== "true")
    return resolveModeValue(context, {
      interactive: {
        "schedules-list": listSchedules,
        "schedules-update": updateSchedule,
      },
      "scheduled-report": { "schedules-answer": answerSchedule },
    });
  return resolveModeValue(context, {
    interactive: {
      "schedules-list": listSchedules,
      "schedules-update": updateSchedule,
      "schedules-create": createSchedule,
      "schedules-answer": answerSchedule,
    },
    "scheduled-report": { "schedules-answer": answerSchedule },
  });
});

async function pendingScheduledRun(context: ToolContext, runId: string) {
  const resolvePending = resolveModeValue(context, {
    interactive: () => {
      const owner = scheduleOwner(context);
      return getScheduledAgentRunInput(owner.scope, owner.conversation, runId);
    },
    "scheduled-report": () => {
      const report = scheduledReportIdentity(context.session.auth);
      if (!report || report.runId !== runId) {
        throw new Error("This reporting turn cannot resume that run.");
      }
      return getScheduledAgentRunInputForReport(
        report.runId,
        report.leaseToken
      );
    },
  });
  return resolvePending?.();
}
