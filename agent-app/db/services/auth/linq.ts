import { z } from "zod";
import { isE164PhoneNumber } from "@shared/identity/phone-number";
import { env } from "@shared/environment";

const LINQ_CHATS_URL = "https://api.linqapp.com/api/partner/v3/chats";
const linqErrorResponseSchema = z.object({
  code: z.number().int().optional(),
  error: z
    .object({
      code: z.number().int().optional(),
      message: z.string().min(1).optional(),
    })
    .optional(),
  message: z.string().min(1).optional(),
  trace_id: z.string().min(1).optional(),
});

export class LinqDeliveryError extends Error {
  readonly code: number | undefined;
  readonly linqMessage: string | undefined;
  readonly status: number;
  readonly traceId: string | undefined;

  constructor({
    code,
    linqMessage,
    status,
    traceId,
  }: {
    readonly code?: number;
    readonly linqMessage?: string;
    readonly status: number;
    readonly traceId?: string;
  }) {
    const diagnostics = [
      code === undefined ? undefined : `code ${String(code)}`,
      linqMessage,
      traceId === undefined ? undefined : `trace_id ${traceId}`,
    ].filter((value) => value !== undefined);
    super(
      `Linq message delivery failed with HTTP ${String(status)}${
        diagnostics.length === 0 ? "" : ` (${diagnostics.join("; ")})`
      }.`
    );
    this.name = "LinqDeliveryError";
    this.code = code;
    this.linqMessage = linqMessage;
    this.status = status;
    this.traceId = traceId;
  }
}

export function linqOtpFailure(error: LinqDeliveryError) {
  if (
    error.status === 409 &&
    /no eligible (?:sending )?(?:line|phone number)/i.test(
      error.linqMessage ?? ""
    )
  ) {
    return {
      code: "LINQ_SENDING_LINE_UNAVAILABLE",
      message:
        "No Linq line is currently eligible to send a code. If this is a new line, complete the first-time sign-in steps above; otherwise review the line's health in Linq and try again.",
    };
  }

  switch (error.code) {
    case 2006:
      return {
        code: "LINQ_SENDING_LINE_NOT_AUTHORIZED",
        message:
          "Linq has not authorized this sending line. If this is a new line, complete the first-time sign-in steps above; otherwise confirm the API token can access the configured line in Linq.",
      };
    case 2008:
      return {
        code: "LINQ_RECIPIENT_NOT_VERIFIED",
        message:
          "Complete the first-time sign-in steps above: text the deployment's Linq number once from this phone, then request another code.",
      };
    case 2024:
      return {
        code: "LINQ_RECIPIENT_OPTED_OUT",
        message:
          "This phone number has opted out of messages from this Linq line. Re-enable messages or use another phone number.",
      };
    case 2027:
      return {
        code: "LINQ_REPUTATION_BLOCKED",
        message:
          "This Linq line cannot send a code because of its messaging reputation. Review the line in Linq, then try again.",
      };
    default:
      return {
        code: "LINQ_DELIVERY_FAILED",
        message:
          "Linq could not send a sign-in code. Check the API credentials and configured sending line, then try again.",
      };
  }
}

export async function readLinqOnboardingPhoneNumber() {
  // Never select a different account line automatically.
  return env.LINQ_API_KEY && env.LINQ_PHONE_NUMBER
    ? env.LINQ_PHONE_NUMBER
    : undefined;
}

export async function sendLinqText({
  idempotencyKey,
  message,
  to,
}: {
  readonly idempotencyKey: string;
  readonly message: string;
  readonly to: string;
}) {
  if (!env.LINQ_API_KEY || !env.LINQ_PHONE_NUMBER || !isE164PhoneNumber(to)) {
    throw new Error(
      "Direct Linq credentials, sending line and recipient are required."
    );
  }
  const response = await fetch(LINQ_CHATS_URL, {
    body: JSON.stringify({
      from: env.LINQ_PHONE_NUMBER,
      message: {
        idempotency_key: idempotencyKey,
        parts: [{ type: "text", value: message }],
      },
      to: [to],
    }),
    headers: {
      Authorization: `Bearer ${env.LINQ_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return;

  const body: unknown = await response.json().catch(() => undefined);
  const linqError = linqErrorResponseSchema.safeParse(body).data;
  throw new LinqDeliveryError({
    code: linqError?.error?.code ?? linqError?.code,
    linqMessage: linqError?.error?.message ?? linqError?.message,
    status: response.status,
    traceId:
      linqError?.trace_id ?? response.headers.get("x-trace-id") ?? undefined,
  });
}
