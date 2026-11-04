import { defineChannel, POST } from "eve/channels";
import { env } from "@shared/environment";
import { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import { recordInkboxInbound } from "@db/services/inkbox-inbox";
import { processInkboxInbox } from "@agent/lib/inkbox/inbox";
import {
  INKBOX_MAX_WEBHOOK_BYTES,
  verifyInkboxWebhook,
} from "@shared/messaging/inkbox";

export default defineChannel({
  routes: [
    POST("/webhooks/inkbox", async (request, { waitUntil }) => {
      if (
        env.MESSAGING_PROVIDER !== "inkbox" ||
        !env.INKBOX_API_KEY ||
        !env.INKBOX_IDENTITY_ID ||
        !env.INKBOX_AGENT_HANDLE ||
        !env.INKBOX_WEBHOOK_SIGNING_KEY ||
        !env.INTERNAL_SERVICE_SECRET
      )
        return response(503);
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (request.body) {
          for await (const chunk of request.body) {
            size += chunk.byteLength;
            if (size > INKBOX_MAX_WEBHOOK_BYTES) return response(413);
            chunks.push(chunk);
          }
        }
        const bytes = Buffer.concat(chunks);
        const envelope = verifyInkboxWebhook(request, bytes, {
          identityId: env.INKBOX_IDENTITY_ID,
          signingKey: env.INKBOX_WEBHOOK_SIGNING_KEY,
        });
        if (!envelope) return response(401);
        const userId = await findVerifiedAuthUserIdByPhoneNumber(
          envelope.senderPhoneNumber
        );
        if (!userId) return response(200);
        const result = await recordInkboxInbound(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          envelope,
          userId
        );
        if (result === "conflict") return response(409);
        if (result === "full") return response(429);
        if (result === "recorded") waitUntil(processInkboxInbox());
        return response(202);
      } catch {
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
