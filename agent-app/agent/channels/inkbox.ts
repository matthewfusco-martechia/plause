import { z } from "zod";
import { defineChannel, POST, type ChannelEventContext } from "eve/channels";
import { parseAnswers } from "eve/client";
import { call } from "eve/events";
import type { SessionAuth } from "eve/context";
import { env } from "@shared/environment";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { inkboxDigest, parseInkboxInboundBody } from "@shared/messaging/inkbox";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import {
  reactToMessageToolResultSchema,
  reactionTextFor,
} from "@shared/chat/reaction";
import {
  assertEnrolledWorkspaceUser,
  findVerifiedAuthUserIdByPhoneNumber,
} from "@db/services/auth/phone-user";
import {
  finishInkboxInbox,
  holdInkboxInboxUnknown,
  readInkboxRelayScope,
} from "@db/services/inkbox-inbox";
import { readInkboxOutbound } from "@db/services/inkbox-outbox";
import { INKBOX_INTERNAL_ROUTE } from "@agent/lib/inkbox/inbox";
import { resolveInkboxStreamAnswer } from "@agent/lib/inkbox/interaction-routing";
import {
  inkboxClient,
  inkboxConversationAddress,
  parseInkboxConversationAddress,
  sendInkboxMessage,
} from "@agent/lib/inkbox/transport";
import {
  inkboxInteractionToken,
  renderInkboxInteraction,
  resolveInkboxAnswer,
  type InkboxPendingInteraction,
} from "@agent/lib/inkbox/interactions";
import { authenticateScheduledRequest } from "@agent/lib/schedules/internal-auth";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { resolveInkboxReplyTarget } from "@agent/lib/reply-targets";
import { settledToolResult } from "@agent/lib/settled-tool-result";
import { prepareLinqImageArtifactDelivery } from "@agent/lib/linq-image-artifact/delivery";
import {
  finalizeScheduledReportDelivery,
  assertScheduledReportDelivery,
  holdScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@agent/lib/schedules/report-lifecycle";

interface InkboxState {
  ownerId: string;
  identityId: string;
  conversationId: string;
  assignmentId: string;
  phoneNumber: string;
  inboundMessageId?: string;
  inboundText?: string;
  pending: Record<string, InkboxPendingInteraction>;
  openInteractionIds: string[];
  reportAttempts: Record<string, "attempted" | "accepted" | "unknown">;
}
interface InkboxContext {
  state: InkboxState;
}
type EventContext = ChannelEventContext<InkboxContext>;

const inkbox = defineChannel<
  InkboxState,
  InkboxContext,
  { conversationId: string }
>({
  state: {
    ownerId: "",
    identityId: "",
    conversationId: "",
    assignmentId: "",
    phoneNumber: "",
    pending: {},
    openInteractionIds: [],
    reportAttempts: {},
  },
  context(state) {
    return { state };
  },
  audience() {
    return "private";
  },
  metadata(state) {
    return { provider: "inkbox", identityId: state.identityId };
  },
  // Eve resolves signed public media through its SSRF-protected downloader and checks actual bytes.
  uploadPolicy: {
    maxBytes: 10 * 1024 * 1024,
    allowedMediaTypes: [
      "image/*",
      "application/pdf",
      "audio/*",
      "video/*",
      "text/plain",
    ],
  },
  async fetchFile(_url, context) {
    if (!context) throw new Error("Attachment authorization is missing.");
    await authorize(context.session.auth);
    return null;
  },
  async deliver(payload, context) {
    const owner = await authorize(context.session.auth);
    const update = payload.state;
    if (update) {
      if (
        update.ownerId !== owner.scope.userId ||
        update.phoneNumber !== owner.phoneNumber ||
        update.identityId !== env.INKBOX_IDENTITY_ID ||
        !update.conversationId ||
        !update.assignmentId
      ) {
        throw new Error("Inkbox delivery ownership changed.");
      }
      const saved = context.state;
      if (
        saved.ownerId &&
        (saved.ownerId !== update.ownerId ||
          saved.identityId !== update.identityId ||
          saved.conversationId !== update.conversationId ||
          saved.phoneNumber !== update.phoneNumber ||
          saved.assignmentId !== update.assignmentId)
      )
        throw new Error("Inkbox conversation changed.");
      Object.assign(saved, { ...update, pending: saved.pending });
    }
    await assertState(context.state, context.session.auth);
    if (context.state.inboundText) {
      const answers = resolveInkboxAnswer(
        context.state.inboundText,
        context.state.pending,
        owner.scope.userId,
        address(context.state)
      );
      delete context.state.inboundText;
      if (answers !== undefined)
        return answers.length ? { answers: parseAnswers(answers) } : {};
    }
    // Eve can infer answers from ordinary text. Only this channel's explicit
    // owner-bound token commands may answer a pending request, even after expiry.
    if (
      context.state.openInteractionIds.length ||
      Object.keys(context.state.pending).length
    )
      return {};
    return undefined;
  },
  async receive(input, { from }) {
    const target = z
      .strictObject({ conversationId: z.string() })
      .parse(input.target);
    const ids = parseInkboxConversationAddress(target.conversationId);
    const owner = await authorizeInput(input.auth);
    const conversation = await inkboxClient().getConversation(
      ids.conversationId,
      owner.phoneNumber
    );
    if (conversation.assignmentId !== ids.assignmentId)
      throw new Error("Inkbox assignment changed.");
    await assertEnrolledWorkspaceUser(owner.scope);
    const { target: _target, ...send } = input;
    const text = z.string().safeParse(input.message);
    const message = text.success
      ? [{ type: "text" as const, text: text.data }]
      : input.message;
    return from(target.conversationId).send(message, {
      ...send,
      state: {
        ownerId: owner.scope.userId,
        identityId: ids.identityId,
        conversationId: ids.conversationId,
        assignmentId: conversation.assignmentId,
        phoneNumber: owner.phoneNumber,
      },
    });
  },
  routes: [
    POST(INKBOX_INTERNAL_ROUTE, async (request, { from, resolveSession }) => {
      try {
        inkboxClient();
      } catch {
        return response(503);
      }
      const authenticated = await authenticateScheduledRequest(request);
      if (authenticated instanceof Response) return authenticated;
      const eventKey = request.headers.get("x-plause-inkbox-event");
      const lease = request.headers.get("x-plause-inkbox-lease");
      if (
        !eventKey ||
        !/^[a-f0-9]{64}$/u.test(eventKey) ||
        !lease ||
        !z.uuid().safeParse(lease).success
      )
        return response(409);
      try {
        // The internal HMAC and durable body digest authenticate this retained payload.
        // First extract its phone, then enforce freshness against the original accepted time.
        const raw = z
          .object({ timestamp: z.iso.datetime({ offset: true }) })
          .parse(JSON.parse(authenticated.body));
        const tentative = parseInkboxInboundBody(
          authenticated.body,
          env.INKBOX_IDENTITY_ID ?? "",
          Date.parse(raw.timestamp)
        );
        if (!tentative) return response(409);
        const row = await readInkboxRelayScope(
          eventKey,
          lease,
          inkboxDigest(authenticated.body),
          tentative.senderPhoneNumber
        );
        if (!row?.userId) return response(409);
        const envelope = parseInkboxInboundBody(
          authenticated.body,
          env.INKBOX_IDENTITY_ID ?? "",
          row.createdAt.getTime()
        );
        if (
          !envelope ||
          inkboxDigest(envelope.identityId) !== row.identityDigest
        )
          return response(409);
        const userId = await findVerifiedAuthUserIdByPhoneNumber(
          envelope.senderPhoneNumber
        );
        if (!userId || userId !== row.userId) {
          await finishInkboxInbox(eventKey, lease, "ignored");
          return response(200);
        }
        const conversation = await inkboxClient().getConversation(
          envelope.conversationId,
          envelope.senderPhoneNumber
        );
        if (conversation.assignmentId !== envelope.assignmentId)
          throw new Error("Inkbox assignment changed.");
        const scope = accessScopeForUser(`better-auth:${userId}`);
        if (
          (await assertEnrolledWorkspaceUser(scope)) !==
          envelope.senderPhoneNumber
        )
          throw new Error("Inkbox owner changed.");
        const conversationId = inkboxConversationAddress(
          envelope.identityId,
          envelope.conversationId,
          envelope.assignmentId
        );
        const auth = {
          authenticator: "inkbox-verified-phone",
          principalType: "user" as const,
          principalId: scope.userId,
          attributes: {
            workspaceId: scope.workspaceId,
            phoneNumber: envelope.senderPhoneNumber,
            conversationChannel: "inkbox",
            conversationId,
            inkboxMessageId: envelope.messageId,
          },
        };
        if (
          resolveInkboxAnswer(
            envelope.text ?? "",
            {},
            scope.userId,
            conversationId
          ) !== undefined
        ) {
          const session = envelope.media.length
            ? undefined
            : await resolveSession(conversationId);
          const answers = session
            ? await resolveInkboxStreamAnswer(
                session,
                envelope.text ?? "",
                scope,
                conversationId
              )
            : undefined;
          if (!session || !answers?.length) {
            if (!(await finishInkboxInbox(eventKey, lease, "ignored")))
              throw new Error("Inkbox answer receipt unavailable.");
            return response(200);
          }
          const current = await inkboxClient().getConversation(
            envelope.conversationId,
            envelope.senderPhoneNumber
          );
          if (
            current.assignmentId !== envelope.assignmentId ||
            (await assertEnrolledWorkspaceUser(scope)) !==
              envelope.senderPhoneNumber
          )
            throw new Error("Inkbox answer ownership changed.");
          // Structured answers must reach Eve before child-proxy routing. A new
          // message converted later by deliver() cannot answer a delegated approval.
          await session.respond(answers, {
            auth,
            idempotencyKey: `inkbox-answer:${envelope.eventId}`,
          });
          if (!(await finishInkboxInbox(eventKey, lease, "accepted")))
            throw new Error("Inkbox answer receipt unavailable.");
          return response(200);
        }
        await from(conversationId).send(
          [
            ...(envelope.text
              ? [{ type: "text" as const, text: envelope.text }]
              : []),
            ...envelope.media.map((media) => ({
              type: "file" as const,
              data: new URL(media.url),
              mediaType: media.contentType,
            })),
          ],
          {
            auth,
            state: {
              ownerId: scope.userId,
              identityId: envelope.identityId,
              conversationId: envelope.conversationId,
              assignmentId: envelope.assignmentId,
              phoneNumber: envelope.senderPhoneNumber,
              inboundMessageId: envelope.messageId,
              inboundText: envelope.text ?? "",
            },
            idempotencyKey: `inkbox:${envelope.eventId}`,
          }
        );
        if (!(await finishInkboxInbox(eventKey, lease, "accepted")))
          throw new Error("Inkbox admission receipt unavailable.");
        return response(200);
      } catch {
        await holdInkboxInboxUnknown(eventKey, lease);
        return response(503);
      }
    }),
  ],
  events: {
    async "interaction.opened"(event, context) {
      const state = context.channel.state;
      await assertState(state, context.session.auth);
      const { request, interactionId, audience, origin, subject } = event.data;
      if (!state.openInteractionIds.includes(interactionId))
        state.openInteractionIds.push(interactionId);
      if (audience && !audience.principalIds.includes(state.ownerId)) return;
      const token = inkboxInteractionToken(env.INTERNAL_SERVICE_SECRET ?? "", {
        sessionId: context.session.id,
        interactionId,
        ownerId: state.ownerId,
        address: address(state),
      });
      const localCall =
        "callId" in subject ? call(context.view, subject.callId) : undefined;
      const details =
        origin?.call ??
        (localCall
          ? { name: localCall.name, input: localCall.input }
          : undefined);
      const text = renderInkboxInteraction(
        request,
        token,
        request.kind === "approval" ? details : undefined
      );
      const prior = state.pending[token];
      if (!prior && Object.keys(state.pending).length >= 32)
        throw new Error("Too many unanswered Messages requests.");
      const key = `inkbox-interaction:${context.session.id}:${interactionId}`;
      const pending = {
        interactionId,
        ownerId: state.ownerId,
        address: address(state),
        expiresAt: prior?.expiresAt ?? 0,
        request,
      };
      state.pending[token] = pending;
      try {
        await sendText(context, text, key);
      } finally {
        // The outbox claim survives a callback crash. Its first creation time
        // prevents replay from renewing a five-minute authorization window.
        const owner = await assertState(state, context.session.auth);
        const receipt = await readInkboxOutbound(owner.scope, key);
        pending.expiresAt = receipt
          ? Math.min(
              prior?.expiresAt ?? Infinity,
              receipt.createdAt.getTime() + 300_000
            )
          : 0;
      }
    },
    "interaction.settled"(event, context) {
      context.channel.state.openInteractionIds =
        context.channel.state.openInteractionIds.filter(
          (id) => id !== event.data.interactionId
        );
      context.channel.state.pending = Object.fromEntries(
        Object.entries(context.channel.state.pending).filter(
          ([, item]) => item.interactionId !== event.data.interactionId
        )
      );
    },
    async "call.settled"(event, context) {
      const result = settledToolResult(event, context.view);
      const reaction = reactToMessageToolResultSchema.safeParse(result);
      const message = sendMessageToolResultSchema.safeParse(result);
      const report = scheduledReportFromSession(context);
      const key = report
        ? `scheduled-report:${report.runId}:${String(report.sequence)}`
        : `inkbox-call:${context.session.id}:${event.data.callId}`;
      if (
        !reaction.success &&
        (!message.success || message.data.toolName !== "send_message")
      )
        return;
      if (report) context.channel.state.reportAttempts[key] = "attempted";
      try {
        if (reaction.success) {
          if (reaction.data.output.operation !== "add")
            throw new Error("Inkbox text reactions cannot be removed.");
          await sendText(
            context,
            reactionTextFor(reaction.data.output.type),
            key
          );
          await finalizeScheduledReportDelivery(context);
          if (report) context.channel.state.reportAttempts[key] = "accepted";
          return;
        }
        if (!message.success || message.data.toolName !== "send_message")
          return;
        await assertState(context.channel.state, context.session.auth);
        const outgoing = message.data.output;
        const reply = resolveInkboxReplyTarget(
          outgoing.replyTo,
          context.session.auth
        );
        const replyToMessageId =
          reply?.conversationId === address(context.channel.state)
            ? reply.messageId
            : undefined;
        if (outgoing.kind === "link") {
          await sendText(context, outgoing.url, key, replyToMessageId);
        } else {
          const owner = await authorize(context.session.auth);
          const prepared = await prepareLinqImageArtifactDelivery(
            outgoing.text ?? "",
            {
              rootSessionId: context.session.id,
              scope: owner.scope,
            }
          );
          const links = (outgoing.attachments ?? []).map((item) => item.url);
          const text = [
            prepared.text,
            ...links,
            ...(prepared.failedArtifactIds.length
              ? [
                  "Some images could not be attached. Please ask me to capture them again.",
                ]
              : []),
            ...(links.length ? ["Shared as links."] : []),
          ]
            .filter(Boolean)
            .join("\n\n");
          if (text.trim())
            await sendText(context, text, `${key}:text`, replyToMessageId);
          // Inkbox accepts one media file per message. Order and keys remain stable on replay.
          /* oxlint-disable eslint/no-await-in-loop -- Provider media messages must stay ordered. */
          for (const [index, file] of prepared.files.entries()) {
            await sendInkboxMessage({
              ...(await outboundScope(context)),
              idempotencyKey: `${key}:image:${String(index)}`,
              replyToMessageId,
              file: {
                bytes: file.data,
                contentType: file.mimeType,
                filename: file.filename,
              },
            });
          }
          /* oxlint-enable eslint/no-await-in-loop */
          if (!text.trim() && !prepared.files.length)
            throw new Error("There is no message to deliver.");
        }
        await finalizeScheduledReportDelivery(context);
        if (report) context.channel.state.reportAttempts[key] = "accepted";
      } catch (error) {
        if (report) {
          context.channel.state.reportAttempts[key] = "unknown";
          await holdScheduledReportDelivery(
            context,
            "Inkbox report delivery is unconfirmed; reconcile before retrying."
          );
        }
        throw error;
      }
    },
    async "turn.settled"(event, context) {
      if (await holdUnconfirmedReport(context)) return;
      const report = scheduledReportFromSession(context);
      if (
        report &&
        context.channel.state.reportAttempts[reportKey(report)] === "accepted"
      )
        return;
      if (event.data.outcome === "completed")
        await finalizeScheduledReportDelivery(context, "suppressed");
      else
        await releaseScheduledReportDelivery(
          context,
          `Inkbox report turn ${event.data.outcome}.`
        );
    },
    async "session.ended"(_event, context) {
      if (await holdUnconfirmedReport(context)) return;
      const report = scheduledReportFromSession(context);
      if (
        report &&
        context.channel.state.reportAttempts[reportKey(report)] === "accepted"
      )
        return;
      await releaseScheduledReportDelivery(
        context,
        "Inkbox conversation ended before report acceptance."
      );
    },
  },
});

export default inkbox;

function reportKey(
  report: NonNullable<ReturnType<typeof scheduledReportFromSession>>
) {
  return `scheduled-report:${report.runId}:${String(report.sequence)}`;
}

async function holdUnconfirmedReport(context: EventContext) {
  const report = scheduledReportFromSession(context);
  if (!report) return false;
  const status = context.channel.state.reportAttempts[reportKey(report)];
  if (status !== "attempted" && status !== "unknown") return false;
  await holdScheduledReportDelivery(
    context,
    "Inkbox report delivery is unconfirmed; reconcile before retrying."
  );
  return true;
}

function address(state: InkboxState) {
  return inkboxConversationAddress(
    state.identityId,
    state.conversationId,
    state.assignmentId
  );
}

async function authorize(auth: SessionAuth) {
  return authorizeInput(auth.current ?? auth.initiator);
}

async function authorizeInput(
  input: Parameters<typeof scopeFromPrincipal>[0] | null
) {
  inkboxClient();
  if (!input) throw new Error("Inkbox requires the enrolled owner.");
  const scope = scopeFromPrincipal(input);
  const phoneNumber = await assertEnrolledWorkspaceUser(scope);
  return { scope, phoneNumber };
}

async function assertState(state: InkboxState, auth: SessionAuth) {
  const owner = await authorize(auth);
  if (
    state.ownerId !== owner.scope.userId ||
    state.phoneNumber !== owner.phoneNumber ||
    state.identityId !== env.INKBOX_IDENTITY_ID
  )
    throw new Error("Inkbox conversation ownership changed.");
  parseInkboxConversationAddress(address(state));
  z.uuid().parse(state.assignmentId);
  return owner;
}

async function outboundScope(context: EventContext) {
  const state = context.channel.state;
  const owner = await assertState(state, context.session.auth);
  return {
    scope: owner.scope,
    conversationId: state.conversationId,
    assignmentId: state.assignmentId,
    phoneNumber: state.phoneNumber,
    beforeSend: () => assertScheduledReportDelivery(context),
  };
}

async function sendText(
  context: EventContext,
  text: string,
  idempotencyKey: string,
  replyToMessageId?: string
) {
  // Large outputs require the model to send several reviewed messages, never silent truncation.
  if (text.length > 18_995)
    throw new Error("This reply exceeds the Messages text limit.");
  return sendInkboxMessage({
    ...(await outboundScope(context)),
    text,
    idempotencyKey,
    replyToMessageId,
  });
}

function response(status: number) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
