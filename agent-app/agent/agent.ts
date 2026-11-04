import { defineAgent, defineDynamic } from "eve";
import { resolveDirectOpenAIModel } from "@agent/lib/models/openai";
import { env } from "@shared/environment";

export default defineAgent({
  build: {
    // The browser-agent subagent's Browser Loop tools load this at runtime.
    externalDependencies: [
      "@onkernel/browser-loop",
      "@workflow/world-postgres",
    ],
  },
  experimental: {
    workflow: {
      world:
        env.PLAUSE_WORKFLOW_BACKEND === "postgres"
          ? "@workflow/world-postgres"
          : undefined,
    },
  },
  defaultTools: false,
  // eve resolves this before every model call, so the lease is rechecked per step.
  model: defineDynamic((ctx) => resolveDirectOpenAIModel(ctx)),
  reasoning: "low",
  compaction: {
    // Keep the framework's 90% threshold: the fixed instructions/tool catalog
    // already use about 14k of the private 20k input allocation. Summarizing at
    // 70% spent a model call before even a greeting and could not shrink it.
    threshold: 0.9,
  },
});
