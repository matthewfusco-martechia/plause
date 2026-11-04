import { parseAnswers } from "eve/client";
import type { InteractionOpenedData } from "eve/events";
import type { SessionReader } from "eve/sessions";
import { readInkboxOutbound } from "@db/services/inkbox-outbox";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  inkboxInteractionToken,
  resolveInkboxAnswer,
  type InkboxPendingInteraction,
} from "./interactions";

/** Resolve before admission: delegated requests must receive structured answers. */
export async function resolveInkboxStreamAnswer(
  session: SessionReader,
  text: string,
  scope: AccessScope,
  address: string
): Promise<ReturnType<typeof parseAnswers> | undefined> {
  if (resolveInkboxAnswer(text, {}, scope.userId, address) === undefined)
    return undefined;

  try {
    const signal = AbortSignal.timeout(5000);
    const open = new Map<string, InteractionOpenedData>();
    const settled = new Set<string>();
    let events = 0;
    let bytes = 0;
    let ended = false;
    for await (const event of session.stream({
      startIndex: -256,
      follow: false,
      signal,
    })) {
      signal.throwIfAborted();
      events += 1;
      bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
      if (events > 2048 || bytes > 2 * 1024 * 1024) return parseAnswers([]);
      if (event.type === "session.ended") {
        ended = true;
        open.clear();
      } else if (event.type === "interaction.settled") {
        settled.add(event.data.interactionId);
        open.delete(event.data.interactionId);
      } else if (event.type === "interaction.opened" && !ended) {
        const { interactionId, audience } = event.data;
        if (
          settled.has(interactionId) ||
          (audience && !audience.principalIds.includes(scope.userId))
        )
          continue;
        // A repeated opening cannot replace the details already reviewed.
        if (open.has(interactionId)) return parseAnswers([]);
        open.set(interactionId, event.data);
      }
    }
    signal.throwIfAborted();
    if (ended) return parseAnswers([]);

    const pending: Record<string, InkboxPendingInteraction> = {};
    for (const [interactionId, { request }] of open) {
      const token = inkboxInteractionToken(env.INTERNAL_SERVICE_SECRET ?? "", {
        sessionId: session.id,
        interactionId,
        ownerId: scope.userId,
        address,
      });
      pending[token] = {
        interactionId,
        ownerId: scope.userId,
        address,
        expiresAt: Infinity,
        request,
      };
    }
    const candidate = resolveInkboxAnswer(text, pending, scope.userId, address);
    const interactionId = candidate?.[0]?.interactionId;
    if (!interactionId) return parseAnswers([]);

    const receipt = await readInkboxOutbound(
      scope,
      `inkbox-interaction:${session.id}:${interactionId}`
    );
    signal.throwIfAborted();
    const createdAt = receipt?.createdAt.getTime();
    if (
      createdAt === undefined ||
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() ||
      createdAt + 300_000 <= Date.now()
    )
      return parseAnswers([]);
    return parseAnswers(candidate);
  } catch {
    // Unavailable history or ownership is never permission to create a new turn.
    return parseAnswers([]);
  }
}
