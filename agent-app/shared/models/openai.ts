import { z } from "zod";
import { env } from "@shared/environment";

// Keep the initial allowlist aligned with Plause's already-priced model.
// These are conservative accounting rates, not an invoice reconciliation.
export const openAIModelIdSchema = z.literal("gpt-6-luna");

export function directOpenAIPolicy(role: "root" | "browser" = "root") {
  const model = openAIModelIdSchema.parse(
    role === "browser" ? env.OPENAI_BROWSER_MODEL : env.OPENAI_MODEL
  );
  return {
    model,
    maxInputTokens: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .parse(env.MODEL_MAX_INPUT_TOKENS),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .parse(env.MODEL_MAX_OUTPUT_TOKENS),
    timeoutMs: z.number().int().min(1).max(45_000).parse(env.MODEL_TIMEOUT_MS),
    inputRateMicroUsdPerMillion: 250_000,
    outputRateMicroUsdPerMillion: 500_000,
    maxRetries: 0,
  } as const;
}

export function openAIModelCatalog() {
  return [
    {
      id: openAIModelIdSchema.value,
      name: "GPT-6 Luna",
      ownedBy: "openai",
      pricing: { input: 0.1, output: 0.5 },
    },
  ];
}
