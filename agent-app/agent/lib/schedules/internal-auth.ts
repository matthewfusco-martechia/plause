import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { env } from "@shared/environment";
import { claimInternalRequest } from "@db/services/internal-requests";

export type ScheduledInternalPath =
  | "/internal/scheduled-run/report"
  | "/internal/scheduled-run/respond"
  | "/internal/linq/dispatch";

const MAX_BODY_BYTES = 65_536;
const MAX_CLOCK_SKEW_SECONDS = 300;
const timestampHeader = "x-plause-internal-timestamp";
const requestIdHeader = "x-plause-internal-id";
const signatureHeader = "x-plause-internal-signature";

function configuredSecret() {
  const secret = env.INTERNAL_SERVICE_SECRET;
  return secret && secret.trim().length >= 32 ? secret : undefined;
}

function signature(
  secret: string,
  path: string,
  body: string,
  timestamp: string,
  requestId: string
) {
  return createHmac("sha256", secret)
    .update(
      `plause-scheduled-v1\n${timestamp}\n${requestId}\nPOST\n${path}\n${body}`
    )
    .digest("hex");
}

export function signScheduledRequest(
  path: ScheduledInternalPath,
  body: string
) {
  const secret = configuredSecret();
  if (!secret) throw new Error("INTERNAL_SERVICE_SECRET is not configured.");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = randomUUID();
  return new Headers({
    "content-type": "application/json",
    [timestampHeader]: timestamp,
    [requestIdHeader]: requestId,
    [signatureHeader]: `v1=${signature(secret, path, body, timestamp, requestId)}`,
  });
}

// Authentication is independent of Vercel and never accepts a browser session,
// loopback address, or caller-supplied principal as service authorization.
// A durable nonce receipt is consumed before dispatch. A failed/unknown action
// never makes that authenticated request replayable; run claims also fence new attempts.
export async function authenticateScheduledRequest(
  request: Request
): Promise<{ body: string } | Response> {
  const secret = configuredSecret();
  if (!secret) return rejection(503);
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    request.method !== "POST" ||
    url.search ||
    (path !== "/internal/scheduled-run/report" &&
      path !== "/internal/scheduled-run/respond" &&
      path !== "/internal/linq/dispatch")
  )
    return rejection(401);
  const timestamp = request.headers.get(timestampHeader);
  const requestId = request.headers.get(requestIdHeader);
  const supplied = request.headers.get(signatureHeader);
  if (
    !timestamp ||
    !/^[1-9]\d{0,10}$/u.test(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) >
      MAX_CLOCK_SKEW_SECONDS ||
    !requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      requestId
    ) ||
    !supplied ||
    !/^v1=[a-f0-9]{64}$/u.test(supplied)
  )
    return rejection(401);
  let rawBody: string;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (request.body) {
      for await (const chunk of request.body) {
        length += chunk.byteLength;
        if (
          length >
          (path === "/internal/linq/dispatch" ? 262_144 : MAX_BODY_BYTES)
        )
          return rejection(413);
        chunks.push(chunk);
      }
    }
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks)
    );
  } catch {
    return rejection(401);
  }
  const expected = signature(secret, path, rawBody, timestamp, requestId);
  if (
    !timingSafeEqual(
      Buffer.from(supplied.slice(3), "hex"),
      Buffer.from(expected, "hex")
    )
  )
    return rejection(401);
  try {
    const claimed = await claimInternalRequest({
      requestId,
      signatureDigest: createHash("sha256").update(supplied).digest("hex"),
      path,
      expiresAt: new Date(
        (Number(timestamp) + MAX_CLOCK_SKEW_SECONDS + 1) * 1000
      ),
    });
    if (!claimed) return rejection(409);
  } catch {
    return rejection(503);
  }
  return { body: rawBody };
}

function rejection(status: number) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
