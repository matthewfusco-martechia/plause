import { LinqAPIV3 } from "@linqapp/sdk";
import {
  linqInboundEnvelopeSchema,
  type LinqInboundEnvelope,
} from "@shared/chat/linq-inbound";
import { env } from "@shared/environment";
import { LINQ_API_BASE_URL } from "./transport";

export const MAX_LINQ_WEBHOOK_BYTES = 262_144;

export function verifyLinqWebhook(
  request: Request,
  rawBody: Uint8Array
): LinqInboundEnvelope | null {
  if (
    !env.LINQ_API_KEY ||
    !env.LINQ_WEBHOOK_SIGNING_SECRET ||
    !env.LINQ_PHONE_NUMBER ||
    rawBody.byteLength > MAX_LINQ_WEBHOOK_BYTES ||
    request.method !== "POST"
  )
    return null;
  const timestamp = request.headers.get("webhook-timestamp");
  const eventId = request.headers.get("webhook-id");
  const signature = request.headers.get("webhook-signature");
  if (
    !timestamp ||
    !/^[1-9]\d{0,10}$/u.test(timestamp) ||
    !eventId ||
    eventId.length > 200 ||
    !signature ||
    signature.length > 2048
  )
    return null;
  try {
    const client = new LinqAPIV3({
      apiKey: env.LINQ_API_KEY,
      webhookSecret: env.LINQ_WEBHOOK_SIGNING_SECRET,
      baseURL: LINQ_API_BASE_URL,
      maxRetries: 0,
    });
    const event = client.webhooks.unwrap(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
      { headers: Object.fromEntries(request.headers) }
    );
    const parsed = linqInboundEnvelopeSchema.safeParse(event);
    return parsed.success &&
      parsed.data.event_id === eventId &&
      parsed.data.data.chat.owner_handle.handle === env.LINQ_PHONE_NUMBER &&
      parsed.data.data.reconciled_at === undefined
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
