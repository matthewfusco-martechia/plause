import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Record one fixture execution after a delegated approval.",
  inputSchema: z.object({}),
  approval: always(),
  async execute(_input, ctx) {
    const directory = join(".eve", "fixture-tool", ctx.session.id);
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "approved"), "executed\n");
    return { executed: true };
  },
});
