import { appendFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { createDirectOpenAIModel } from "@agent/lib/models/client";

const requestSchema = z.object({
  model: z.literal("gpt-6-luna"),
  max_output_tokens: z.number().int().positive().max(2_000),
  store: z.literal(false),
  truncation: z.literal("disabled"),
  input: z.array(z.unknown()),
  stream: z.boolean().optional(),
  tools: z
    .array(z.object({ type: z.string(), name: z.string().optional() }))
    .optional(),
});

export function fixtureModel(role: "root" | "browser") {
  return createDirectOpenAIModel(
    {
      model: "gpt-6-luna",
      maxInputTokens: 20_000,
      maxOutputTokens: 2_000,
      timeoutMs: 20_000,
      inputRateMicroUsdPerMillion: 250_000,
      outputRateMicroUsdPerMillion: 500_000,
      maxRetries: 0,
    },
    async (url, init) => {
      // There is deliberately no fallback to native fetch, even for an error.
      const request = new Request(url, init);
      if (request.url !== "https://api.openai.com/v1/responses")
        throw new Error("Unexpected fixture endpoint.");
      const body = requestSchema.parse(await request.json());
      const compact = !body.tools?.length;
      const input = JSON.stringify(body.input);
      const tool =
        role === "browser"
          ? "eve__reply"
          : !compact && !input.includes("function_call_output")
            ? "run_browser"
            : undefined;
      const argumentsText = JSON.stringify(
        role === "browser"
          ? {
              images: [],
              status: "success",
              message: "Verified offline worker",
            }
          : { message: "Complete the fictional fixture" }
      );
      await mkdir(".eve/direct-openai-fixture", { recursive: true });
      await appendFile(
        ".eve/direct-openai-fixture/calls.jsonl",
        JSON.stringify({
          role,
          compact,
          model: body.model,
          store: body.store,
          outputLimit: body.max_output_tokens,
        }) + "\n"
      );
      const content = compact
        ? "Fictional work completed. No pending tasks."
        : "Offline fixture completed.";
      const item = tool
        ? {
            type: "function_call",
            id: "fc_fixture",
            call_id: "call_fixture",
            name: tool,
            arguments: argumentsText,
            status: "completed",
          }
        : {
            type: "message",
            id: "msg_fixture",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: content, annotations: [] }],
          };
      const response = {
        id: "resp_fixture",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        model: body.model,
        output: [item],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      if (!body.stream) return Response.json(response);
      const events = tool
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_fixture",
              output_index: 0,
              delta: argumentsText,
            },
            { type: "response.output_item.done", output_index: 0, item },
          ]
        : [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_fixture",
                role: "assistant",
                content: [],
              },
            },
            {
              type: "response.output_text.delta",
              item_id: "msg_fixture",
              output_index: 0,
              content_index: 0,
              delta: content,
            },
            { type: "response.output_item.done", output_index: 0, item },
          ];
      return new Response(
        [...events, { type: "response.completed", response }]
          .map(
            (event, sequence) =>
              `data: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`
          )
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        }
      );
    },
    "fixture-only-not-a-real-key"
  );
}
