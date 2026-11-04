import { createHmac } from "node:crypto";
import {
  APPROVE_OPTION_ID,
  DENY_OPTION_ID,
  type Answer,
  type InteractionRequest,
} from "eve/events";

export interface InkboxPendingInteraction {
  interactionId: string;
  ownerId: string;
  address: string;
  expiresAt: number;
  request: InteractionRequest;
}

export function inkboxInteractionToken(
  secret: string,
  input: {
    sessionId: string;
    interactionId: string;
    ownerId: string;
    address: string;
  }
) {
  if (secret.trim().length < 32)
    throw new Error("Interaction signing is not configured.");
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "inkbox:interaction:v1",
        input.sessionId,
        input.interactionId,
        input.ownerId,
        input.address,
      ])
    )
    .digest("hex")
    .slice(0, 24);
}

export function renderInkboxInteraction(
  request: InteractionRequest,
  token: string,
  callDetails?: { name: string; input?: unknown }
) {
  const lines = [request.title, request.prompt];
  if (request.kind === "sign-in") {
    lines.push(request.signIn?.instructions);
    if (request.signIn?.userCode)
      lines.push(`Code: ${request.signIn.userCode}`);
    const url = request.signIn?.url ?? request.link?.url;
    if (url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:")
        throw new Error("Sign-in requires HTTPS.");
      lines.push(url);
    }
  } else {
    if (callDetails)
      lines.push(
        `Action: ${callDetails.name}\n${JSON.stringify(callDetails.input ?? {})}`
      );
    if (request.options?.length)
      lines.push(
        request.options
          .map(
            (option, index) =>
              `${String(index + 1)}. ${option.label}${option.description ? ` — ${option.description}` : ""}`
          )
          .join("\n")
      );
    lines.push(
      request.kind === "approval"
        ? `Reply APPROVE ${token} or DENY ${token}. This request expires in five minutes.`
        : `Reply REPLY ${token} followed by your answer or option number. This request expires in five minutes.`
    );
  }
  const text = lines
    .filter((line) => line !== undefined && line !== "")
    .join("\n\n");
  // Never truncate an action whose full details the person must review.
  if (!text.trim() || text.length > 18_995)
    throw new Error("This request is too large to review in Messages.");
  return text;
}

/** Only exact commands naming a live, owner-bound request become framework answers. */
export function resolveInkboxAnswer(
  text: string,
  pending: Record<string, InkboxPendingInteraction>,
  ownerId: string,
  address: string,
  nowMs = Date.now()
): Answer[] | undefined {
  const match =
    /^(APPROVE|DENY|REPLY) ([a-f0-9]{24})(?: ([\s\S]{1,8000}))?$/u.exec(
      text.trim()
    );
  if (!match) return undefined;
  const token = match[2];
  if (!token) return [];
  const item = pending[token];
  if (
    !item ||
    item.ownerId !== ownerId ||
    item.address !== address ||
    item.expiresAt <= nowMs
  )
    return [];
  const options = item.request.options ?? [];
  if (match[1] !== "REPLY") {
    if (item.request.kind !== "approval" || match[3]) return [];
    const optionId =
      match[1] === "APPROVE" ? APPROVE_OPTION_ID : DENY_OPTION_ID;
    return options.some((option) => option.id === optionId)
      ? [{ interactionId: item.interactionId, optionId }]
      : [];
  }
  if (item.request.kind === "approval" || !match[3]?.trim()) return [];
  const answer = match[3].trim();
  const index = /^[1-9][0-9]*$/u.test(answer) ? Number(answer) - 1 : -1;
  const selected =
    options[index] ??
    options.find((option) => option.id === answer || option.label === answer);
  if (selected)
    return [{ interactionId: item.interactionId, optionId: selected.id }];
  return item.request.allowFreeform
    ? [{ interactionId: item.interactionId, text: answer }]
    : [];
}
