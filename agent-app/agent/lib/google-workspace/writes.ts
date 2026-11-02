import type { DynamicContext } from "eve";
import { env } from "@shared/environment";

type WriteContext = Pick<DynamicContext, "session">;

// Deployment capability and durable, owner-approved exact calls are separate gates.
// This remains off by default even with a connected Google account.
export function googleWorkspaceWritesAllowed(context: WriteContext) {
  return (
    env.GOOGLE_WORKSPACE_WRITES_ENABLED === "true" &&
    !isScheduledSession(context)
  );
}

export function assertGoogleWorkspaceWriteAllowed(context: WriteContext) {
  if (isScheduledSession(context)) {
    throw new Error(
      "Scheduled Google Workspace access is read-only. Nothing was changed. Do not retry this write or route it through another tool."
    );
  }
  if (env.GOOGLE_WORKSPACE_WRITES_ENABLED !== "true") {
    throw new Error(
      "Gmail and Google Calendar writes are disabled for this deployment. Nothing was changed. Do not retry this write or route it through another tool."
    );
  }
}

function isScheduledSession(context: WriteContext) {
  const { current, initiator } = context.session.auth;
  return [current, initiator].some(
    (caller) =>
      caller?.authenticator === "scheduled-worker" ||
      caller?.authenticator === "scheduled-result"
  );
}
