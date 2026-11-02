import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import {
  cancelUnsentLinqInbox,
  claimLinqInbox,
  decryptLinqInbox,
  holdLinqInboxUnknown,
  linqDigest,
  markLinqInboxDispatched,
} from "@db/services/linq-inbox";
import { signScheduledRequest } from "@agent/lib/schedules/internal-auth";
import { linqInboundEnvelopeSchema } from "@shared/chat/linq-inbound";

export const LINQ_INTERNAL_ROUTE = "/internal/linq/dispatch";

export async function processLinqInbox() {
  if (
    !env.LINQ_API_KEY ||
    !env.LINQ_WEBHOOK_SIGNING_SECRET ||
    !env.LINQ_PHONE_NUMBER ||
    !env.INTERNAL_SERVICE_SECRET
  )
    return;
  const origin = new URL(applicationOrigin());
  if (
    origin.protocol !== "https:" &&
    !(
      env.NODE_ENV === "development" &&
      (origin.hostname === "localhost" ||
        origin.hostname === "127.0.0.1" ||
        origin.hostname === "[::1]")
    )
  )
    return;
  const claims = await claimLinqInbox();
  await Promise.all(
    claims.map(async (row) => {
      const token = row.leaseToken;
      if (!token) return;
      let body: string;
      let phoneNumber: string;
      try {
        body = await decryptLinqInbox(row);
        const envelope = linqInboundEnvelopeSchema.parse(JSON.parse(body));
        const phone = normalizeAuthPhoneNumber(
          envelope.data.sender_handle.handle
        );
        const userId = phone
          ? await findVerifiedAuthUserIdByPhoneNumber(phone)
          : undefined;
        if (
          linqDigest(body) !== row.bodyDigest ||
          envelope.data.chat.owner_handle.handle !== env.LINQ_PHONE_NUMBER ||
          envelope.data.reconciled_at !== undefined ||
          !userId ||
          userId !== row.userId
        ) {
          await cancelUnsentLinqInbox(row.eventKey, token);
          return;
        }
        if (!phone) return;
        phoneNumber = phone;
      } catch {
        await cancelUnsentLinqInbox(row.eventKey, token);
        return;
      }
      const headers = signScheduledRequest(LINQ_INTERNAL_ROUTE, body);
      headers.set("x-plause-linq-event", row.eventKey);
      headers.set("x-plause-linq-lease", token);
      // Persist the uncertainty boundary before starting HTTP; never automatically retry it.
      if (!(await markLinqInboxDispatched(row.eventKey, token, phoneNumber)))
        return;
      try {
        const response = await fetch(new URL(LINQ_INTERNAL_ROUTE, origin), {
          method: "POST",
          body,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        // The internal handler commits acceptance before returning 200.
        if (response.status !== 200)
          await holdLinqInboxUnknown(row.eventKey, token);
      } catch {
        await holdLinqInboxUnknown(row.eventKey, token);
      }
    })
  );
}
