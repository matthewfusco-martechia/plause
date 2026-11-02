import type { DynamicModelContext } from "eve/models";

export function browserExecutionAllowed(
  context: Pick<DynamicModelContext, "session">
) {
  return ![context.session.auth.current, context.session.auth.initiator].some(
    (caller) => caller?.authenticator === "scheduled-result"
  );
}
