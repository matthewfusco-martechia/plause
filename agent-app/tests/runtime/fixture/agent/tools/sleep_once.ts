import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflowTool } from "eve/tools";
import { sleep } from "eve/workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Wait for a durable fictional timer and record its execution.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    "use workflow";
    await sleep(5_000);
    return recordTimer(ctx.session.id);
  },
});

async function recordTimer(sessionId: string) {
  "use step";
  const directory = join(".eve", "fixture-tool", sessionId);
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, "timer-fired"), "executed\n");
  return { executed: true };
}
