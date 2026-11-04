import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { parseInkboxInboundBody, inkboxDigest } from "@shared/messaging/inkbox";
import { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import {
  cancelUnsentInkboxInbox,
  claimInkboxInbox,
  decryptInkboxInbox,
  holdInkboxInboxUnknown,
  markInkboxInboxDispatched,
} from "@db/services/inkbox-inbox";
import { expireInkboxOutboundPayloads } from "@db/services/inkbox-outbox";
import { signScheduledRequest } from "@agent/lib/schedules/internal-auth";

export const INKBOX_INTERNAL_ROUTE = "/internal/inkbox/dispatch";

export async function processInkboxInbox() {
  await expireInkboxOutboundPayloads();
  if (
    env.MESSAGING_PROVIDER !== "inkbox" ||
    !env.INKBOX_API_KEY ||
    !env.INKBOX_IDENTITY_ID ||
    !env.INKBOX_WEBHOOK_SIGNING_KEY ||
    !env.INTERNAL_SERVICE_SECRET
  )
    return;
  const origin = new URL(applicationOrigin());
  if (
    origin.protocol !== "https:" &&
    !(
      env.NODE_ENV === "development" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
  )
    return;
  const claims = await claimInkboxInbox();
  await Promise.all(
    claims.map(async (row) => {
      const token = row.leaseToken;
      if (!token) return;
      let body: string;
      let phoneNumber: string;
      try {
        body = await decryptInkboxInbox(row);
        // Authentication happened at durable intake. Re-normalize against the accepted time,
        // not the recovery clock, so an unattempted lease can recover without widening freshness.
        const envelope = parseInkboxInboundBody(
          body,
          env.INKBOX_IDENTITY_ID ?? "",
          row.createdAt.getTime()
        );
        const userId = envelope
          ? await findVerifiedAuthUserIdByPhoneNumber(
              envelope.senderPhoneNumber
            )
          : undefined;
        if (
          !envelope ||
          !userId ||
          userId !== row.userId ||
          inkboxDigest(body) !== row.bodyDigest ||
          inkboxDigest(envelope.identityId) !== row.identityDigest
        ) {
          await cancelUnsentInkboxInbox(row.eventKey, token);
          return;
        }
        phoneNumber = envelope.senderPhoneNumber;
      } catch {
        await cancelUnsentInkboxInbox(row.eventKey, token);
        return;
      }
      const headers = signScheduledRequest(INKBOX_INTERNAL_ROUTE, body);
      headers.set("x-plause-inkbox-event", row.eventKey);
      headers.set("x-plause-inkbox-lease", token);
      if (!(await markInkboxInboxDispatched(row.eventKey, token, phoneNumber)))
        return;
      try {
        const response = await fetch(new URL(INKBOX_INTERNAL_ROUTE, origin), {
          method: "POST",
          body,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status !== 200)
          await holdInkboxInboxUnknown(row.eventKey, token);
      } catch {
        await holdInkboxInboxUnknown(row.eventKey, token);
      }
    })
  );
}
