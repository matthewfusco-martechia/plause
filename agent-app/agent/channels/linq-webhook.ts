import { defineChannel, POST } from "eve/channels";
import { env } from "@shared/environment";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import { recordLinqInbound } from "@db/services/linq-inbox";
import { processLinqInbox } from "@agent/lib/linq/inbox";
import {
  MAX_LINQ_WEBHOOK_BYTES,
  verifyLinqWebhook,
} from "@agent/lib/linq/webhook";

export default defineChannel({
  routes: [
    POST("/webhooks/linq", async (request, { waitUntil }) => {
      if (
        !env.LINQ_API_KEY ||
        !env.LINQ_WEBHOOK_SIGNING_SECRET ||
        !env.LINQ_PHONE_NUMBER ||
        !env.INTERNAL_SERVICE_SECRET
      )
        return response(503);
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (request.body) {
          for await (const chunk of request.body) {
            size += chunk.byteLength;
            if (size > MAX_LINQ_WEBHOOK_BYTES) return response(413);
            chunks.push(chunk);
          }
        }
        const bytes = Buffer.concat(chunks);
        const envelope = verifyLinqWebhook(request, bytes);
        if (!envelope) return response(401);
        const phone = normalizeAuthPhoneNumber(
          envelope.data.sender_handle.handle
        );
        const userId = phone
          ? await findVerifiedAuthUserIdByPhoneNumber(phone)
          : undefined;
        // Unlinked handles never create accounts, history or model requests.
        if (!userId) return response(200);
        const result = await recordLinqInbound(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          envelope,
          userId
        );
        if (result === "conflict") return response(409);
        if (result === "full") return response(429);
        if (result === "recorded") waitUntil(processLinqInbox());
        return response(202);
      } catch {
        // Acknowledgment follows durable commit; database failures remain retryable.
        return response(503);
      }
    }),
  ],
});

function response(status: number) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
