import { z } from "zod";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";
import {
  assertInkboxOutboundDispatch,
  assertInkboxDestinationAvailable,
  finishInkboxOutbound,
  holdInkboxOutboundUnknown,
  readInkboxOutbound,
  reconcileInkboxOutbound,
  startInkboxOutbound,
} from "@db/services/inkbox-outbox";
import {
  InkboxClient,
  InkboxError,
  inkboxDigest,
  serializeInkboxMessage,
  type InkboxMessageInput,
} from "@shared/messaging/inkbox";

export function inkboxClient() {
  if (
    env.MESSAGING_PROVIDER !== "inkbox" ||
    !env.INKBOX_API_KEY ||
    !env.INKBOX_IDENTITY_ID ||
    !env.INKBOX_AGENT_HANDLE ||
    !env.INTERNAL_SERVICE_SECRET
  ) {
    throw new InkboxError("inkbox_not_configured");
  }
  return new InkboxClient({
    apiKey: env.INKBOX_API_KEY,
    identityId: env.INKBOX_IDENTITY_ID,
    agentHandle: env.INKBOX_AGENT_HANDLE,
  });
}

export function inkboxConversationAddress(
  identityId: string,
  conversationId: string,
  assignmentId: string
) {
  return `inkbox:${z.uuid().parse(identityId)}:${z.uuid().parse(conversationId)}:${z.uuid().parse(assignmentId)}`;
}

export function parseInkboxConversationAddress(address: string) {
  const match = /^inkbox:([^:]+):([^:]+):([^:]+)$/u.exec(address);
  if (
    !match ||
    !z.uuid().safeParse(match[1]).success ||
    !z.uuid().safeParse(match[2]).success ||
    !z.uuid().safeParse(match[3]).success ||
    match[1] !== env.INKBOX_IDENTITY_ID
  ) {
    throw new InkboxError("inkbox_invalid_conversation");
  }
  return {
    identityId: z.uuid().parse(match[1]),
    conversationId: z.uuid().parse(match[2]),
    assignmentId: z.uuid().parse(match[3]),
  };
}

export interface InkboxOutboundInput {
  scope: AccessScope;
  conversationId: string;
  assignmentId: string;
  phoneNumber: string;
  idempotencyKey: string;
  text?: string;
  replyToMessageId?: string;
  file?: { bytes: Uint8Array; contentType: string; filename: string };
  beforeSend?: () => Promise<void>;
}

/** One durable attempt per logical message. Unknown outcomes only permit GET lookup. */
export async function sendInkboxMessage(input: InkboxOutboundInput) {
  const client = inkboxClient();
  const configuration = [
    env.INKBOX_API_KEY,
    env.INKBOX_IDENTITY_ID,
    env.INKBOX_AGENT_HANDLE,
  ];
  const assertConfiguration = () => {
    if (
      env.MESSAGING_PROVIDER !== "inkbox" ||
      configuration[0] !== env.INKBOX_API_KEY ||
      configuration[1] !== env.INKBOX_IDENTITY_ID ||
      configuration[2] !== env.INKBOX_AGENT_HANDLE
    ) {
      throw new InkboxError("inkbox_configuration_changed");
    }
  };
  await assertOwner(input);
  assertConfiguration();
  const intentDigest = inkboxDigest(
    JSON.stringify({
      conversationId: z.uuid().parse(input.conversationId),
      assignmentId: z.uuid().parse(input.assignmentId),
      phoneNumber: input.phoneNumber,
      text: input.text ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      file: input.file
        ? {
            sha256: inkboxDigest(input.file.bytes),
            contentType: input.file.contentType,
            filename: input.file.filename,
          }
        : null,
    })
  );
  const previous = await readInkboxOutbound(input.scope, input.idempotencyKey);
  if (previous) {
    if (previous.intentDigest !== intentDigest)
      throw new InkboxError("inkbox_changed_intent");
    if (previous.status === "failed" || previous.status === "cancelled") {
      throw new InkboxError("inkbox_previous_send_failed");
    }
    if (
      previous.providerMessageId &&
      (previous.status === "accepted" || previous.status === "delivered")
    ) {
      return { messageId: previous.providerMessageId, status: previous.status };
    }
    const messageId =
      previous.providerMessageId ??
      (await client.lookupMessageSend(input.idempotencyKey));
    if (!messageId) throw new InkboxError("inkbox_send_unknown", true);
    const receipt = await client.getMessage(
      messageId,
      input.conversationId,
      input.phoneNumber
    );
    if (receipt.assignmentId !== input.assignmentId)
      throw new InkboxError("inkbox_changed_assignment");
    await assertOwner(input);
    if (receipt.errorCode === "send_outcome_ambiguous")
      throw new InkboxError("inkbox_send_unknown", true);
    const status =
      receipt.status === "delivered"
        ? "delivered"
        : receipt.status === "declined" || receipt.status === "error"
          ? "failed"
          : "accepted";
    if (
      !(await reconcileInkboxOutbound(
        input.scope,
        input.idempotencyKey,
        previous.bodyDigest,
        messageId,
        status
      ))
    )
      throw new InkboxError("inkbox_receipt_unavailable", true);
    if (status === "failed")
      throw new InkboxError("inkbox_previous_send_failed");
    return { messageId, status };
  }
  // Private files are uploaded only from bytes validated against the owner's R2 artifact.
  // A crash here can leave an orphan vendor upload, but never authorizes another message POST.
  const uploaded = input.file
    ? await client.uploadMedia({
        bytes: input.file.bytes,
        contentType: input.file.contentType,
        filename: input.file.filename,
        async beforeSend() {
          const conversation = await client.getConversation(
            input.conversationId,
            input.phoneNumber
          );
          if (conversation.assignmentId !== input.assignmentId)
            throw new InkboxError("inkbox_changed_assignment");
          await assertInkboxDestinationAvailable(
            input.scope,
            input.phoneNumber,
            input.conversationId,
            input.assignmentId,
            input.idempotencyKey
          );
          await assertOwner(input);
          await input.beforeSend?.();
          assertConfiguration();
        },
      })
    : undefined;
  const message: InkboxMessageInput = { conversationId: input.conversationId };
  if (input.text !== undefined) message.text = input.text;
  if (input.replyToMessageId) message.replyToMessageId = input.replyToMessageId;
  if (uploaded) message.mediaUrl = uploaded.mediaUrl;
  const claim = await startInkboxOutbound({
    scope: input.scope,
    phoneNumber: input.phoneNumber,
    conversationId: input.conversationId,
    assignmentId: input.assignmentId,
    idempotencyKey: input.idempotencyKey,
    intentDigest,
    body: serializeInkboxMessage(message),
  });
  if (claim.kind !== "started")
    throw new InkboxError("inkbox_send_unknown", true);
  try {
    const receipt = await client.sendMessage({
      ...message,
      recipientPhoneNumber: input.phoneNumber,
      expectedAssignmentId: input.assignmentId,
      idempotencyKey: input.idempotencyKey,
      async beforeSend() {
        await assertOwner(input);
        if (
          !(await assertInkboxOutboundDispatch(
            input.scope,
            input.idempotencyKey,
            claim.row.attemptToken,
            claim.row.bodyDigest,
            input.phoneNumber
          ))
        ) {
          throw new InkboxError("inkbox_send_not_authorized");
        }
        await input.beforeSend?.();
        assertConfiguration();
      },
    });
    if (receipt.errorCode === "send_outcome_ambiguous")
      throw new InkboxError("inkbox_send_unknown", true);
    const status =
      receipt.status === "delivered"
        ? "delivered"
        : receipt.status === "declined" || receipt.status === "error"
          ? "failed"
          : "accepted";
    if (
      !(await finishInkboxOutbound(
        input.scope,
        input.idempotencyKey,
        claim.row.attemptToken,
        receipt.messageId,
        status
      ))
    ) {
      throw new InkboxError("inkbox_receipt_unavailable", true);
    }
    if (status === "failed") throw new InkboxError("inkbox_send_failed");
    return { messageId: receipt.messageId, status };
  } catch (error) {
    await holdInkboxOutboundUnknown(
      input.scope,
      input.idempotencyKey,
      claim.row.attemptToken
    );
    throw error;
  }
}

async function assertOwner(input: InkboxOutboundInput) {
  inkboxClient();
  if ((await assertEnrolledWorkspaceUser(input.scope)) !== input.phoneNumber) {
    throw new InkboxError("inkbox_owner_changed");
  }
}
