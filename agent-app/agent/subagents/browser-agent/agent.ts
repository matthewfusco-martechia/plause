import { defineAgent, defineDynamic } from "eve";
import { resolveDirectOpenAIModel } from "@agent/lib/models/openai";

export default defineAgent({
  tool: false,
  description:
    "Execute one bounded browser assignment for the root coordinator, including secure vault autofill, transaction preparation, optional durable browser images, human-takeover handoff, cleanup, and a concise verified result.",
  model: defineDynamic((context) =>
    resolveDirectOpenAIModel(context, "browser")
  ),
  reasoning: "low",
  compaction: {
    threshold: 0.7,
  },
});
