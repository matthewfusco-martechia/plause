import { APIError } from "better-auth/api";
import { InkboxClient } from "@shared/messaging/inkbox";
import { env } from "@shared/environment";
import { isPhoneEnrollmentAllowed } from "@shared/identity/enrollment";

export function inkboxSignInConfigured() {
  return Boolean(
    env.MESSAGING_PROVIDER === "inkbox" &&
    env.INKBOX_API_KEY &&
    env.INKBOX_IDENTITY_ID &&
    env.INKBOX_AGENT_HANDLE &&
    env.INKBOX_WEBHOOK_SIGNING_KEY &&
    env.INTERNAL_SERVICE_SECRET
  );
}

function configuration() {
  const apiKey = env.INKBOX_API_KEY;
  const identityId = env.INKBOX_IDENTITY_ID;
  const agentHandle = env.INKBOX_AGENT_HANDLE;
  if (!inkboxSignInConfigured() || !apiKey || !identityId || !agentHandle)
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "MESSAGING_NOT_CONFIGURED",
      message: "iMessage sign-in is not configured for this deployment.",
    });
  return { apiKey, identityId, agentHandle };
}

export async function readInkboxOnboarding() {
  return new InkboxClient(configuration()).getRouter();
}

export async function sendInkboxPhoneCode({
  to,
  code,
  idempotencyKey,
}: {
  readonly to: string;
  readonly code: string;
  readonly idempotencyKey: string;
}) {
  if (!/^\d{6}$/u.test(code) || !idempotencyKey.trim())
    throw new APIError("BAD_REQUEST", {
      code: "INVALID_SIGN_IN_CODE",
      message: "A valid sign-in code and explicit send key are required.",
    });
  const config = configuration();
  const check = async () => {
    if (!isPhoneEnrollmentAllowed(to))
      throw new APIError("FORBIDDEN", {
        code: "PRIVATE_ENROLLMENT_REQUIRED",
        message:
          "This private Plause installation is not accepting this phone number.",
      });
    if (
      !inkboxSignInConfigured() ||
      env.INKBOX_IDENTITY_ID !== config.identityId ||
      env.INKBOX_AGENT_HANDLE !== config.agentHandle ||
      env.INKBOX_API_KEY !== config.apiKey
    )
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "MESSAGING_NOT_CONFIGURED",
        message:
          "Messaging configuration changed. Review the connection before requesting another code.",
      });
  };
  await check();
  const client = new InkboxClient(config);
  try {
    const conversation = await client.findActiveConversation(to);
    if (!conversation)
      throw new APIError("CONFLICT", {
        code: "MESSAGING_CONNECT_REQUIRED",
        message:
          "Complete the Messages connection steps, then send hi to Plause from this phone before requesting a code.",
      });
    const sent = await client.sendMessage({
      conversationId: conversation.conversationId,
      expectedAssignmentId: conversation.assignmentId,
      recipientPhoneNumber: to,
      text: `Plause sign-in code: ${code}. Expires in 5 minutes.`,
      idempotencyKey,
      beforeSend: check,
    });
    if (sent.errorCode === "send_outcome_ambiguous")
      throw new APIError("BAD_GATEWAY", {
        code: "MESSAGING_CODE_UNCONFIRMED",
        message:
          "Plause could not confirm delivery of the sign-in code. Review the Messages connection before requesting another code.",
      });
    if (sent.status === "declined" || sent.status === "error")
      throw new APIError("BAD_GATEWAY", {
        code: "MESSAGING_UNAVAILABLE",
        message:
          "The sign-in code was not accepted. Review the Messages connection before requesting another code.",
      });
  } catch (error) {
    if (error instanceof APIError) throw error;
    throw new APIError("BAD_GATEWAY", {
      code: "MESSAGING_CODE_UNCONFIRMED",
      message:
        "Plause could not confirm delivery of the sign-in code. Review the Messages connection before requesting another code.",
    });
  }
}
