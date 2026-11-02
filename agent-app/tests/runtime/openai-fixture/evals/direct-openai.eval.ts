import { readFile } from "node:fs/promises";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { z } from "zod";

const recordSchema = z.object({
  role: z.enum(["root", "browser"]),
  compact: z.boolean(),
  model: z.literal("gpt-6-luna"),
  store: z.literal(false),
  outputLimit: z.number().int().positive().max(2_000),
});

export default defineEval({
  description:
    "Direct OpenAI SDK routing survives durable root/worker execution and compaction without network",
  async test(t) {
    const first = await t.send("Start");
    first.expectOk();
    first.requireToolCall("run_browser", { status: "completed" });
    const compacted = await first.session.compact();
    compacted.event("context.settled", {
      data: { kind: "compaction", outcome: "completed" },
    });
    const records = (
      await readFile(".eve/direct-openai-fixture/calls.jsonl", "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => recordSchema.parse(JSON.parse(line)));
    t.check(
      records.some((record) => record.role === "root" && !record.compact),
      equals(true)
    );
    t.check(
      records.some((record) => record.role === "browser" && !record.compact),
      equals(true)
    );
    t.check(
      records.some((record) => record.role === "root" && record.compact),
      equals(true)
    );
    t.check(records.length <= 8, equals(true));
  },
});
