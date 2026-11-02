import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "../lib/access";
import {
  browserActionContextSchema,
  observeBrowserAction,
} from "../lib/action-authority";

export default defineTool({
  description:
    "Read an owned browser's current HTTPS origin and mint a server observation for one separately approved page action. Copy actionContext exactly into the action tool input. It expires in five minutes and is bound to this worker, account, and browser. This inspection does not authorize an action or bypass a disabled deployment flag.",
  inputSchema: z.strictObject({ session_id: z.string().min(1).max(500) }),
  outputSchema: z.strictObject({
    actionContext: browserActionContextSchema,
    observedAt: z.number().int(),
    expiresAt: z.number().int(),
  }),
  async execute(input, context) {
    return observeBrowserAction(
      await requireWorkerScope(context),
      input.session_id,
      context
    );
  },
});
