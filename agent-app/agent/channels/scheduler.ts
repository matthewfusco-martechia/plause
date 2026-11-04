import { defineChannel, POST } from "eve/channels";
import { env } from "@shared/environment";
import { authenticateScheduledRequest } from "@agent/lib/schedules/internal-auth";
import { dispatchDueWork } from "@agent/lib/schedules/dispatch";
import { readNextScheduledWake } from "@db/services/scheduled-agent-jobs";

export default defineChannel({
  routes: [
    POST("/internal/schedules/tick", async (request, { to }) => {
      if (env.SCHEDULED_TASKS_ENABLED !== "true")
        return new Response(null, { status: 503 });
      const authenticated = await authenticateScheduledRequest(request);
      if (authenticated instanceof Response) return authenticated;
      if (authenticated.body !== "{}")
        return new Response(null, { status: 400 });
      await dispatchDueWork(to);
      return Response.json({
        nextWakeAt: (await readNextScheduledWake())?.toISOString() ?? null,
      });
    }),
  ],
});
