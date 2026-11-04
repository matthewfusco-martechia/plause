import { linqInboundEnvelopeSchema } from "@shared/chat/linq-inbound";
import type { LinqAPIV3 } from "@linqapp/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { POST } from "eve/channels";
import type { SessionAuth, SessionContext } from "eve/context";
import type { AdapterPostableMessage } from "chat";
import {
  defaultLinqAuth,
  linqChannel,
  type LinqChannelCredentials,
  type LinqChannelConfig,
} from "eve/channels/linq";
import { z } from "zod";
import { resolveLinqReplyTarget } from "@agent/lib/reply-targets";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  assertEnrolledWorkspaceUser,
  findVerifiedAuthUserIdByPhoneNumber,
} from "@db/services/auth/phone-user";
import { authenticateScheduledRequest } from "@agent/lib/schedules/internal-auth";
import {
  finishLinqInbox,
  holdLinqInboxUnknown,
  linqDigest,
  readLinqRelayScope,
} from "@db/services/linq-inbox";
import { LINQ_INTERNAL_ROUTE } from "@agent/lib/linq/inbox";
import { verifyLinqWebhook } from "@agent/lib/linq/webhook";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { reactToMessageToolResultSchema } from "@shared/chat/reaction";
import { settledToolResult } from "@agent/lib/settled-tool-result";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { prepareLinqImageArtifactDelivery } from "../lib/linq-image-artifact/delivery";
import {
  extractImageArtifactMarkdownReferences,
  stripImageArtifactMarkdownReferences,
} from "../lib/linq-image-artifact/markdown";
import { env } from "@shared/environment";
import {
  linqCredentials,
  LINQ_API_BASE_URL,
  sendNativeLinqMessage,
} from "@agent/lib/linq/transport";
import {
  finalizeScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@agent/lib/schedules/report-lifecycle";

const unavailableReplyTargetSchema = z.object({
  status: z.union([z.literal(400), z.literal(404)]),
});

type LinqMessageContent = Parameters<
  LinqAPIV3["chats"]["messages"]["send"]
>[1]["message"];

interface RelayAuthorization {
  bodyDigest: string;
  userId: string;
  eligible: boolean;
}
const relayAuthorization = new AsyncLocalStorage<RelayAuthorization>();

export const linqWebhookVerifier: NonNullable<
  LinqChannelCredentials["webhookVerifier"]
> = (request, rawBody) =>
  env.MESSAGING_PROVIDER === "linq" &&
  verifyLinqWebhook(request, rawBody) !== null;

function verifyInternalRelayBody(_request: Request, rawBody: Uint8Array) {
  if (!linqSelected()) return false;
  const authorization = relayAuthorization.getStore();
  if (!authorization) return false;
  try {
    return (
      linqDigest(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) ===
      authorization.bodyDigest
    );
  } catch {
    return false;
  }
}

const credentials = {
  ...linqCredentials,
  webhookVerifier: verifyInternalRelayBody,
} satisfies LinqChannelCredentials;

const channel = linqChannel({
  async beforeOutbound(auth) {
    await assertLinqAuth(auth);
  },
  route: LINQ_INTERNAL_ROUTE,
  baseURL: LINQ_API_BASE_URL,
  credentials,
  events: {
    async "interaction.opened"(event, ctx) {
      const { origin, request } = event.data;
      const { thread } = ctx.channel;
      // Approvals and questions render through the default committed handler;
      // delegated sign-ins stay out of the root conversation.
      if (
        request.kind !== "sign-in" ||
        !thread ||
        (origin !== undefined && origin.sessionId !== ctx.session.id)
      )
        return;
      const signIn = request.signIn;
      const displayName = signIn?.displayName ?? signIn?.name ?? "this account";
      if (!thread.isDM) {
        await thread.post({
          raw: `Connect ${displayName} in a direct message with this agent.`,
        });
        return;
      }
      const adapter = ctx.channel.bot.getAdapter("linq");
      const senderScope = await assertLinqSender(ctx);
      const { chatId, pendingHandle } = adapter.decodeThreadId(thread.id);
      if (!chatId || pendingHandle)
        throw new Error(
          "Authorization delivery requires an existing Linq conversation."
        );
      const parts: NonNullable<LinqMessageContent["parts"]> = [
        {
          type: "text",
          value: [
            signIn?.instructions ?? `Connect ${displayName} to continue.`,
            signIn?.userCode ? `Code: ${signIn.userCode}` : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ];
      const idempotencyKey = `authorization:${ctx.session.id}:${event.data.interactionId}`;
      await sendNativeLinqMessage(
        chatId,
        {
          parts,
          idempotency_key: `${idempotencyKey}:prompt`,
        },
        undefined,
        senderScope
      );
      // Linq requires a native link to be the message's only part.
      if (signIn?.url)
        await sendNativeLinqMessage(
          chatId,
          {
            parts: [{ type: "link", value: signIn.url }],
            idempotency_key: `${idempotencyKey}:link`,
          },
          undefined,
          senderScope
        );
    },
    async "call.settled"(event, ctx) {
      const context = ctx.channel;
      const session = ctx;
      const result = settledToolResult(event, ctx.view);
      const reaction = reactToMessageToolResultSchema.safeParse(result);
      if (reaction.success) {
        if (!context.thread) {
          throw new Error(
            "react_to_message requires an active Linq conversation thread."
          );
        }
        // The thread is a persisted snapshot; auth identifies this incoming message.
        const target = resolveLinqReplyTarget(
          { kind: "current" },
          session.session.auth
        );
        const messageId =
          target?.conversationId === context.thread.id
            ? target.messageId
            : undefined;
        if (!messageId) {
          throw new Error("react_to_message requires a current Linq message.");
        }
        const adapter = context.bot.getAdapter("linq");
        await assertLinqSender(session);
        if (reaction.data.output.operation === "remove") {
          await adapter.removeReaction(
            context.thread.id,
            messageId,
            reaction.data.output.type
          );
        } else {
          await adapter.addReaction(
            context.thread.id,
            messageId,
            reaction.data.output.type
          );
        }
        await finalizeScheduledReportDelivery(session);
        return;
      }

      const message = sendMessageToolResultSchema.safeParse(result);
      if (message.success && message.data.toolName === "send_message") {
        const { thread } = context;
        if (!thread) {
          throw new Error(
            "send_message requires an active Linq conversation thread."
          );
        }
        const report = scheduledReportFromSession(session);
        const replyTarget = resolveLinqReplyTarget(
          message.data.output.replyTo,
          session.session.auth
        );
        const requestedReplyMessageId =
          replyTarget?.conversationId === thread.id
            ? replyTarget.messageId
            : undefined;
        const idempotencyKey = report
          ? `scheduled-report:${report.runId}:${String(report.sequence)}`
          : `linq-call:${session.session.id}:${event.data.callId}`;
        const adapter = context.bot.getAdapter("linq");
        const post = async (content: AdapterPostableMessage) => {
          await assertLinqSender(session);
          return adapter.postMessage(thread.id, content, { idempotencyKey });
        };
        const postReply = async (
          content: AdapterPostableMessage,
          replyToMessageId: string
        ) => {
          await assertLinqSender(session);
          return adapter.postMessage(thread.id, content, {
            idempotencyKey,
            replyToMessageId,
          });
        };
        const resolveExistingChatId = () => {
          const { chatId, pendingHandle } = adapter.decodeThreadId(thread.id);
          if (pendingHandle || !chatId) {
            throw new Error("A Linq reply requires an existing conversation.");
          }
          return chatId;
        };

        if (message.data.output.kind === "link") {
          const { url } = message.data.output;
          const chatId = resolveExistingChatId();
          const sendLink = async (replyToMessageId?: string) => {
            const nativeMessage: LinqMessageContent = {
              parts: [{ type: "link", value: url }],
            };
            nativeMessage.idempotency_key = idempotencyKey;
            if (replyToMessageId) {
              nativeMessage.reply_to = { message_id: replyToMessageId };
            }
            const senderScope = await assertLinqSender(session);
            return sendNativeLinqMessage(
              chatId,
              nativeMessage,
              undefined,
              senderScope
            );
          };
          try {
            await sendLink(requestedReplyMessageId);
          } catch (error) {
            if (
              !requestedReplyMessageId ||
              !unavailableReplyTargetSchema.safeParse(error).success
            ) {
              throw error;
            }
            console.warn("[linq] reply target is unavailable", {
              sessionId: session.session.id,
            });
            await sendLink();
          }
          await finalizeScheduledReportDelivery(session);
          return;
        }

        const attachments = message.data.output.attachments?.map(
          ({ kind, ...attachment }) => ({ ...attachment, type: kind })
        );
        const { text: requestedText } = message.data.output;
        if (!requestedText) {
          if (attachments?.length) {
            await sendLinqMessage({
              outgoing: { attachments, raw: "" },
              post,
              postReply,
              replyToMessageId: requestedReplyMessageId,
            });
            await finalizeScheduledReportDelivery(session);
            return;
          }
          await finalizeScheduledReportDelivery(session);
          return;
        }

        const caller =
          session.session.auth.current ?? session.session.auth.initiator;
        if (!caller) {
          const references =
            extractImageArtifactMarkdownReferences(requestedText);
          const text =
            references.length === 0
              ? requestedText
              : [
                  stripImageArtifactMarkdownReferences(requestedText),
                  "I couldn't attach the image.",
                ]
                  .filter(Boolean)
                  .join("\n\n");
          const outgoing: Extract<
            Parameters<typeof thread.post>[0],
            { raw: string }
          > = { raw: text };
          if (attachments?.length) outgoing.attachments = attachments;
          await sendLinqMessage({
            outgoing,
            post,
            postReply,
            replyToMessageId: requestedReplyMessageId,
          });
          await finalizeScheduledReportDelivery(session);
          return;
        }

        const delivery = await prepareLinqImageArtifactDelivery(requestedText, {
          rootSessionId: report?.workerSessionId ?? session.session.id,
          scope: scopeFromPrincipal(caller),
        });
        if (delivery.failedArtifactIds.length > 0) {
          console.warn("[linq] browser image delivery failed", {
            artifactIds: delivery.failedArtifactIds,
            sessionId: session.session.id,
          });
        }
        const failureMessage =
          delivery.failedArtifactIds.length === 0
            ? ""
            : delivery.failedArtifactIds.length === 1
              ? "I couldn't attach one image."
              : `I couldn't attach ${String(delivery.failedArtifactIds.length)} images.`;
        const text = [delivery.text, failureMessage]
          .filter(Boolean)
          .join("\n\n");
        const outgoing: Extract<
          Parameters<typeof thread.post>[0],
          { raw: string }
        > = { raw: text };
        if (attachments?.length) outgoing.attachments = attachments;
        if (delivery.files.length > 0) outgoing.files = delivery.files;
        await sendLinqMessage({
          outgoing,
          post,
          postReply,
          replyToMessageId: requestedReplyMessageId,
        });
        await finalizeScheduledReportDelivery(session);
      }
    },
    // Linq output is delivered only through send_message, so the default
    // reply posting is replaced with a no-op.
    // oxlint-disable-next-line eslint/no-empty-function -- Overriding the built-in handler suppresses automatic reply posting.
    async "content.completed"() {},
    async "session.ended"(_event, ctx) {
      if (scheduledReportFromSession(ctx)) {
        await finalizeScheduledReportDelivery(ctx, "suppressed");
      }
    },
    async "turn.settled"(event, ctx) {
      if (event.data.outcome === "completed") {
        if (scheduledReportFromSession(ctx)) {
          await finalizeScheduledReportDelivery(ctx, "suppressed");
        }
      } else if (event.data.outcome === "cancelled") {
        await releaseScheduledReportDelivery(
          ctx,
          "Scheduled result reporting was cancelled."
        );
      } else {
        await releaseScheduledReportDelivery(
          ctx,
          event.data.error?.message ?? "The scheduled report turn failed."
        );
      }
    },
  },
  async onMessage(context, message) {
    const relay = relayAuthorization.getStore();
    if (!relay) return null;
    const result = await resolveVerifiedLinqMessage(context, message);
    if (
      !result?.auth ||
      result.auth.principalId !== `better-auth:${relay.userId}`
    )
      return null;
    relay.eligible = true;
    return result;
  },
});

async function sendLinqMessage({
  outgoing,
  post,
  postReply,
  replyToMessageId,
}: {
  readonly outgoing: Extract<AdapterPostableMessage, { raw: string }>;
  readonly post: (
    content: AdapterPostableMessage
  ) => Promise<{ readonly id: string }>;
  readonly postReply: (
    content: AdapterPostableMessage,
    replyToMessageId: string
  ) => Promise<{ readonly id: string }>;
  readonly replyToMessageId?: string;
}) {
  if (!replyToMessageId) {
    await post(outgoing);
    return;
  }
  try {
    await postReply(outgoing, replyToMessageId);
    return;
  } catch (error) {
    if (!unavailableReplyTargetSchema.safeParse(error).success) throw error;
    console.warn("[linq] reply target is unavailable", {
      replyToMessageId,
    });
    await post(outgoing);
  }
}

export async function resolveVerifiedLinqMessage(
  context: Parameters<NonNullable<LinqChannelConfig["onMessage"]>>[0],
  message: Parameters<NonNullable<LinqChannelConfig["onMessage"]>>[1]
) {
  if (!linqSelected() || message.author.isBot) return null;

  const auth = defaultLinqAuth(message);
  const authorUserName = z.string().safeParse(message.author.userName);
  const phoneNumber = authorUserName.success
    ? normalizeAuthPhoneNumber(authorUserName.data)
    : undefined;
  const verifiedUserId = phoneNumber
    ? await findVerifiedAuthUserIdByPhoneNumber(phoneNumber)
    : undefined;
  if (!verifiedUserId || !phoneNumber) {
    // Phone possession is the only sign-in factor, so a handle that is not
    // linked to a verified user is unauthenticated: never mint a principal
    // or a workspace for it.
    console.warn("[linq] ignoring message from an unlinked handle", {
      threadId: context.thread.id,
    });
    return null;
  }
  const principalId = `better-auth:${verifiedUserId}`;
  const scope = accessScopeForUser(principalId);
  return {
    auth: {
      ...auth,
      attributes: {
        ...auth.attributes,
        conversationChannel: "linq",
        conversationId: context.thread.id,
        linqThreadId: context.thread.id,
        linqMessageId: message.id,
        phoneNumber,
        workspaceId: scope.workspaceId,
      },
      principalId,
    },
  };
}

async function assertLinqSender(context: Pick<SessionContext, "session">) {
  return assertLinqAuth(context.session.auth);
}

async function assertLinqAuth(auth: SessionAuth) {
  if (!linqSelected()) throw new Error("Linq messaging is not selected.");
  const caller = auth.current ?? auth.initiator;
  if (!caller)
    throw new Error("Linq delivery requires an enrolled workspace user.");
  const scope = scopeFromPrincipal(caller);
  await assertEnrolledWorkspaceUser(scope);
  if (!linqSelected()) throw new Error("Linq messaging is not selected.");
  return scope;
}

const originalPost = channel.routes.find(
  (route) => route.transport !== "websocket" && route.method === "POST"
);
if (!originalPost || originalPost.transport === "websocket")
  throw new Error("The Linq admission route is unavailable.");
const admissionHandler = originalPost.handler;

export default Object.assign(channel, {
  // Only the signed, durable-inbox relay can reach the native SDK admission path.
  routes: [
    POST(LINQ_INTERNAL_ROUTE, async (request, context) => {
      if (!linqSelected()) return new Response(null, { status: 503 });
      const authenticated = await authenticateScheduledRequest(request);
      if (authenticated instanceof Response) return authenticated;
      const eventKey = request.headers.get("x-plause-linq-event");
      const leaseToken = request.headers.get("x-plause-linq-lease");
      if (
        !eventKey ||
        !/^[a-f0-9]{64}$/u.test(eventKey) ||
        !leaseToken ||
        !z.uuid().safeParse(leaseToken).success
      )
        return new Response(null, { status: 409 });
      const bodyDigest = linqDigest(authenticated.body);
      let envelope: z.infer<typeof linqInboundEnvelopeSchema>;
      try {
        envelope = linqInboundEnvelopeSchema.parse(
          JSON.parse(authenticated.body)
        );
      } catch {
        return new Response(null, { status: 409 });
      }
      const phone = normalizeAuthPhoneNumber(
        envelope.data.sender_handle.handle
      );
      if (
        !phone ||
        envelope.data.chat.owner_handle.handle !== env.LINQ_PHONE_NUMBER ||
        envelope.data.reconciled_at !== undefined
      )
        return new Response(null, { status: 409 });
      const row = await readLinqRelayScope(
        eventKey,
        leaseToken,
        bodyDigest,
        phone
      );
      if (!row?.userId) return new Response(null, { status: 409 });
      if (!linqSelected()) return new Response(null, { status: 503 });
      const tasks: Promise<unknown>[] = [];
      const authorization: RelayAuthorization = {
        bodyDigest,
        userId: row.userId,
        eligible: false,
      };
      try {
        const response = await relayAuthorization.run(authorization, () =>
          admissionHandler(
            new Request(request.url, {
              method: "POST",
              body: authenticated.body,
              headers: request.headers,
            }),
            {
              ...context,
              waitUntil(task) {
                tasks.push(task);
              },
            }
          )
        );
        // Chat SDK's propagateHandlerErrors option makes failures observable here.
        // These tasks await send admission, never Delivery.result() or the model turn.
        await Promise.all(tasks);
        if (
          !response.ok ||
          tasks.length !== 1 ||
          !(await finishLinqInbox(
            eventKey,
            leaseToken,
            authorization.eligible ? "accepted" : "ignored"
          ))
        ) {
          await holdLinqInboxUnknown(eventKey, leaseToken);
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 200 });
      } catch {
        await holdLinqInboxUnknown(eventKey, leaseToken);
        return new Response(null, { status: 503 });
      }
    }),
  ],
});

function linqSelected() {
  return env.MESSAGING_PROVIDER === "linq";
}
