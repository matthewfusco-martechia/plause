import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

export function fixtureModel(worker: boolean) {
  return new MockLanguageModelV4({
    // A catalog identity supplies context-window metadata; calls stay in this mock.
    provider: "openai",
    modelId: "gpt-5.4-mini",
    async doStream({ prompt, tools }) {
      const userIndex = prompt.findLastIndex(
        (message) => message.role === "user"
      );
      const user = prompt[userIndex];
      const text =
        user?.role === "user"
          ? user.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("")
          : "";
      const returned = prompt
        .slice(userIndex + 1)
        .some((message) => message.role === "tool");
      let toolName: string | undefined;
      let input = "{}";
      let reply = "Fixture turn settled.";
      const toolResults = prompt
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .filter((part) => part.type === "tool-result");
      function result(name: string) {
        const output = toolResults.findLast(
          (part) => part.toolName === name
        )?.output;
        return output?.type === "json" ? output.value : undefined;
      }
      const instructions = prompt
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      if (instructions.includes("`final_output`")) {
        throw new Error(
          "Production instructions reference an unavailable completion tool."
        );
      }
      if (
        !worker &&
        (text === "Google plan" || text === "Recall Google plan")
      ) {
        const searched = result("gmail-search"),
          thread = result("gmail-read-thread"),
          notes = result("drive-read-text"),
          available = result("calendar-check-availability");
        if (!searched) {
          toolName = "gmail-search";
          input = JSON.stringify({
            query: "subject:fictional picnic",
            maxResults: 1,
          });
        } else if (!thread) {
          const found = z
            .object({
              messages: z.array(z.object({ threadId: z.string() })).min(1),
            })
            .parse(searched);
          toolName = "gmail-read-thread";
          input = JSON.stringify({ threadId: found.messages[0]?.threadId });
        } else if (!notes) {
          const mail = z
            .object({
              thread: z.object({
                messages: z.array(z.object({ body: z.string() })).min(1),
              }),
            })
            .parse(thread);
          const fileId = /notes:([A-Za-z0-9_-]+)/u.exec(
            mail.thread.messages[0]?.body ?? ""
          )?.[1];
          if (!fileId)
            throw new Error("The mail thread did not supply a notes ID.");
          toolName = "drive-read-text";
          input = JSON.stringify({ fileId });
        } else {
          const content = z.object({ text: z.string() }).parse(notes);
          const plan = z
            .object({
              items: z.array(z.string()),
              timeMin: z.string(),
              timeMax: z.string(),
            })
            .parse(JSON.parse(content.text));
          if (!available) {
            toolName = "calendar-check-availability";
            input = JSON.stringify({
              calendars: ["primary"],
              timeMin: plan.timeMin,
              timeMax: plan.timeMax,
              timezone: "UTC",
            });
          } else {
            const calendar = z
              .object({
                calendars: z.object({
                  primary: z.object({ busy: z.array(z.unknown()) }),
                }),
              })
              .parse(available);
            if (calendar.calendars.primary.busy.length)
              throw new Error("The fictional slot is busy.");
            reply = `Fictional plan: ${plan.items.join(" and ")}; 15:00 UTC is free.`;
          }
        }
      } else if (worker) {
        if (!instructions.includes("structured completion tool Eve supplies")) {
          throw new Error(
            "The runtime fixture must exercise the production completion instructions."
          );
        }
        if (text.includes("Wait for cancellation") && !returned)
          toolName = "wait_for_cancellation";
        else if (text.includes("Approve the fixture") && !returned)
          toolName = "require_approval";
        else toolName = "eve__reply";
        if (toolName === "eve__reply")
          input = JSON.stringify({
            status: "success",
            message: "Verified fixture outcome",
            images: [],
          });
      } else if (!returned && text === "Timer") {
        toolName = "sleep_once";
      } else if (!returned && /^(Start|Wait|Approve|Resume:)/u.test(text)) {
        toolName = "run_browser";
        const assignment = {
          message: text.startsWith("Wait")
            ? "Wait for cancellation"
            : text.startsWith("Approve")
              ? "Approve the fixture"
              : "Complete the fixture",
        };
        input = JSON.stringify(
          text.startsWith("Resume:")
            ? { ...assignment, taskId: text.slice(7) }
            : assignment
        );
      } else if (!returned && text.startsWith("Cancel:")) {
        toolName = "eve__task_cancel";
        input = JSON.stringify({ taskId: text.slice(7) });
      }
      if (toolName && !tools?.some((tool) => tool.name === toolName))
        throw new Error(`Missing fixture tool: ${toolName}`);
      const stream: Awaited<
        ReturnType<MockLanguageModelV4["doStream"]>
      >["stream"] = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (toolName)
            controller.enqueue({
              type: "tool-call",
              toolCallId: `fixture-${String(prompt.length)}`,
              toolName,
              input,
            });
          else {
            controller.enqueue({ type: "text-start", id: "reply" });
            controller.enqueue({
              type: "text-delta",
              id: "reply",
              delta: reply,
            });
            controller.enqueue({ type: "text-end", id: "reply" });
          }
          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: toolName ? "tool-calls" : "stop",
              raw: undefined,
            },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      });
      return { stream };
    },
  });
}
