import { defineState, type SessionAuth } from "eve/context";
import { z } from "zod";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
import type { ReplyReference } from "@shared/chat/message-delivery";

const linqReplyTargetSchema = z.strictObject({
  conversationId: z.string().startsWith("linq:"),
  messageId: z.string().min(1),
});
const inkboxConversationSchema = z.string().refine((value) => {
  const parts = value.split(":");
  return (
    parts.length === 4 &&
    parts[0] === "inkbox" &&
    z.uuid().safeParse(parts[1]).success &&
    z.uuid().safeParse(parts[2]).success &&
    z.uuid().safeParse(parts[3]).success
  );
});
const inkboxReplyTargetSchema = z.strictObject({
  conversationId: inkboxConversationSchema,
  messageId: z.uuid(),
});

type MessageReplyTarget =
  | z.infer<typeof linqReplyTargetSchema>
  | z.infer<typeof inkboxReplyTargetSchema>;

const backgroundReplyTargets = defineState<Record<string, MessageReplyTarget>>(
  "open-instinct.background-reply-targets",
  () => ({})
);

const maximumBackgroundReplyTargets = 100;

export function registerBackgroundReplyTarget(
  taskId: string,
  auth: SessionAuth
) {
  const target = currentReplyTarget(auth);
  if (!target) return;

  backgroundReplyTargets.update((current) =>
    Object.fromEntries(
      [
        ...Object.entries(current).filter(([id]) => id !== taskId),
        [taskId, target] as const,
      ].slice(-maximumBackgroundReplyTargets)
    )
  );
}

export function resolveLinqReplyTarget(
  reference: ReplyReference | undefined,
  auth: SessionAuth
) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.attributes.conversationChannel !== "linq") return undefined;
  return resolveReplyTarget(reference, auth);
}

export function resolveInkboxReplyTarget(
  reference: ReplyReference | undefined,
  auth: SessionAuth
) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.attributes.conversationChannel !== "inkbox") return undefined;
  return resolveReplyTarget(reference, auth);
}

function resolveReplyTarget(
  reference: ReplyReference | undefined,
  auth: SessionAuth
) {
  if (!reference) return undefined;

  const conversationId = currentConversationId(auth);
  if (!conversationId) return undefined;

  if (reference.kind === "current") {
    return currentReplyTarget(auth);
  }

  if (reference.kind === "task") {
    const target = backgroundReplyTargets.get()[reference.id];
    return target?.conversationId === conversationId ? target : undefined;
  }

  const report = scheduledReportIdentity(auth);
  if (report?.scheduleId !== reference.id || !report.replyAnchorMessageId) {
    return undefined;
  }
  return {
    conversationId,
    messageId: report.replyAnchorMessageId,
  } satisfies MessageReplyTarget;
}

function currentConversationId(auth: SessionAuth) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.attributes.conversationChannel === "inkbox") {
    const parsed = inkboxConversationSchema.safeParse(
      caller.attributes.conversationId
    );
    return parsed.success ? parsed.data : undefined;
  }
  if (caller?.attributes.conversationChannel !== "linq") return undefined;
  const parsed = z
    .string()
    .startsWith("linq:")
    .safeParse(caller.attributes.conversationId);
  return parsed.success ? parsed.data : undefined;
}

function currentReplyTarget(auth: SessionAuth) {
  const caller = auth.current;
  if (caller?.attributes.conversationChannel === "inkbox") {
    const parsed = inkboxReplyTargetSchema.safeParse({
      conversationId: caller.attributes.conversationId,
      messageId: caller.attributes.inkboxMessageId,
    });
    return parsed.success ? parsed.data : undefined;
  }
  if (caller?.attributes.conversationChannel !== "linq") return undefined;
  const parsed = linqReplyTargetSchema.safeParse({
    conversationId: caller.attributes.conversationId,
    messageId: caller.attributes.linqMessageId,
  });
  return parsed.success ? parsed.data : undefined;
}
