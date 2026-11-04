import { createHmac, timingSafeEqual } from "node:crypto";

// Verify before starting a paid container; the app independently verifies the
// signature, receiving line, enrollment and durable event deduplication.
export async function readVerifiedLinqWebhook(
  request: Request,
  secret: string | undefined
): Promise<Request | null> {
  const timestamp = request.headers.get("webhook-timestamp");
  const eventId = request.headers.get("webhook-id");
  const signatures = request.headers.get("webhook-signature");
  if (
    request.method !== "POST" ||
    !secret?.startsWith("whsec_") ||
    secret.length > 180 ||
    !timestamp ||
    !/^[1-9]\d{0,10}$/u.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !eventId ||
    eventId.length > 200 ||
    !signatures ||
    signatures.length > 2048
  )
    return null;
  const encodedKey = secret.slice(6);
  const key = Buffer.from(encodedKey, "base64");
  if (
    key.byteLength < 32 ||
    key.toString("base64") !== encodedKey ||
    !request.body
  )
    return null;

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > 262_144) return null;
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const expected = createHmac("sha256", key)
      .update(`${eventId}.${timestamp}.`)
      .update(bytes)
      .digest();
    const verified = signatures.split(" ").some((signature) => {
      if (!/^v1,[A-Za-z0-9+/]{43}=$/u.test(signature)) return false;
      const actual = Buffer.from(signature.slice(3), "base64");
      return (
        actual.byteLength === expected.byteLength &&
        timingSafeEqual(actual, expected)
      );
    });
    return verified
      ? new Request(request, { method: "POST", body: bytes })
      : null;
  } catch {
    return null;
  }
}
