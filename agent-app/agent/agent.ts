import { defineAgent, defineDynamic } from "eve";
import { resolveDirectOpenAIModel } from "@agent/lib/models/openai";

export default defineAgent({
  build: {
    // The browser-agent subagent's Browser Loop tools load this at runtime.
    externalDependencies: ["@onkernel/browser-loop"],
  },
  defaultTools: false,
  // eve resolves this before every model call, so the lease is rechecked per step.
  model: defineDynamic((ctx) => resolveDirectOpenAIModel(ctx)),
  reasoning: "low",
  compaction: {
    threshold: 0.7,
  },
});
