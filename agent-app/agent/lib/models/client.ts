import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import type { directOpenAIPolicy } from "@shared/models/openai";

export function createDirectOpenAIModel(
  policy: ReturnType<typeof directOpenAIPolicy>,
  fetch: typeof globalThis.fetch,
  apiKey: string
) {
  const provider = createOpenAI({
    apiKey,
    baseURL: "https://api.openai.com/v1",
    fetch,
  });
  // doGenerate/doStream each make one provider request. The budget transport
  // rejects duplicate dispatch, including framework-level replay or retries.
  return wrapLanguageModel({
    model: provider.responses(policy.model),
    middleware: {
      specificationVersion: "v4",
      async transformParams({ params }) {
        return {
          ...params,
          maxOutputTokens: Math.min(
            params.maxOutputTokens ?? policy.maxOutputTokens,
            policy.maxOutputTokens
          ),
          providerOptions: {
            ...params.providerOptions,
            openai: {
              ...params.providerOptions?.openai,
              store: false,
              truncation: "disabled",
              serviceTier: "default",
            },
          },
        };
      },
    },
  });
}
