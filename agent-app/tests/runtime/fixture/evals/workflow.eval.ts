import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";
import { parseAnswers, type SessionStreamEvent } from "eve/client";
import { APPROVE_OPTION_ID } from "eve/events";
import { taskCompletionOutputSchema } from "@agent/subagents/browser-agent/lib/completion";

const verifiedCompletion = {
  images: [],
  status: "success",
  message: "Verified fixture outcome",
};

async function waitForToolMarker(
  sessionId: string,
  marker: "started" | "aborted",
  signal: AbortSignal
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  // The tool executes in Eve's worker process; its marker proves entry or abort observation.
  while (!existsSync(join(".eve", "fixture-tool", sessionId, marker))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- bounded observation of a marker written by the runtime worker.
    await setTimeout(10, undefined, { signal: deadline });
  }
}

/** The task a `run_browser` call reached, from its `call.started` fact. */
function browserTaskId(turn: EveEvalTurn) {
  const call = turn.requireToolCall("run_browser", { status: "completed" });
  const started = turn.events
    .flatMap((event) => (event.type === "call.started" ? [event] : []))
    .find((event) => event.data.callId === call.callId);
  if (!started?.data.taskId) {
    throw new Error("run_browser did not run as a resumable task.");
  }
  return started.data.taskId;
}

/** The worker session the task opened (`child.opened`) or sent to again (`child.sent`). */
function workerSessionId(events: readonly SessionStreamEvent[]) {
  const opened = events
    .flatMap((event) => (event.type === "child.opened" ? [event] : []))
    .find((event) => event.data.name === "browser-agent");
  const sent = events.find((event) => event.type === "child.sent");
  const sentSessionId =
    sent?.type === "child.sent" ? sent.data.sessionId : undefined;
  const sessionId = opened?.data.sessionId ?? sentSessionId;
  if (!sessionId) throw new Error("No browser worker session was recorded.");
  return sessionId;
}

function checkCompletion(t: EveEvalContext, turn: EveEvalTurn) {
  const call = turn.requireToolCall("run_browser", { status: "completed" });
  t.check(
    taskCompletionOutputSchema.parse(call.output),
    equals(verifiedCompletion)
  );
}

function checkTaskCancelled(t: EveEvalContext, turn: EveEvalTurn) {
  const requested = turn.events
    .flatMap((event) => (event.type === "call.requested" ? [event] : []))
    .find((event) => event.data.capability.name === "eve__task_cancel");
  const settled = turn.events
    .flatMap((event) => (event.type === "call.settled" ? [event] : []))
    .find((event) => event.data.callId === requested?.data.callId);
  t.check(settled?.data.outcome, equals("completed"));
}

export default [
  defineEval({
    description:
      "Chains four Google tool contracts in one turn and retains the results for a follow-up without another read",
    async test(t) {
      const turn = await t.send("Google plan");
      turn.expectOk();
      const expected = [
        "gmail-search",
        "gmail-read-thread",
        "drive-read-text",
        "calendar-check-availability",
      ];
      const requests = turn.events.flatMap((event) =>
        event.type === "call.requested" ? [event.data.capability.name] : []
      );
      t.check(requests, equals(expected));
      for (const name of expected)
        turn.calledTool(name, { status: "completed", count: 1 });
      t.check(
        turn.requireToolCall("gmail-read-thread").input,
        equals({ threadId: "fixture-thread-42" })
      );
      t.check(
        turn.requireToolCall("drive-read-text").input,
        equals({ fileId: "fixture_notes" })
      );
      t.check(
        turn.reply,
        equals("Fictional plan: lunch and water; 15:00 UTC is free.")
      );
      const remembered = await turn.session.send("Recall Google plan");
      remembered.expectOk();
      t.check(
        remembered.events.filter((event) => event.type === "call.requested")
          .length,
        equals(0)
      );
      t.check(remembered.reply, equals(turn.reply));
    },
  }),
  defineEval({
    description:
      "Completes background browser work and resumes the same structured worker",
    async test(t) {
      const first = await t.send("Start");
      first.expectOk();
      const taskId = browserTaskId(first);
      const worker = workerSessionId(first.events);
      checkCompletion(t, first);

      const resumed = await first.session.send(`Resume:${taskId}`);
      resumed.expectOk();
      t.check(browserTaskId(resumed), equals(taskId));
      t.check(workerSessionId(resumed.events), equals(worker));
      checkCompletion(t, resumed);
    },
  }),
  defineEval({
    description:
      "Routes a delegated approval once even when the parent retains delivery context",
    async test(t) {
      const session = await t.session();
      const live = await session.start("Approve");
      const opened = await live.waitForEvent("child.opened", {
        data: { name: "browser-agent" },
      });
      const request = await live.waitForEvent("interaction.opened", {
        data: { request: { kind: "approval" } },
      });
      const origin = request.data.origin;
      if (!origin)
        throw new Error("The approval was not relayed from a child session.");
      t.check(origin.sessionId, equals(opened.data.sessionId));
      t.check(origin.call?.name, equals("require_approval"));
      const marker = join(
        ".eve",
        "fixture-tool",
        opened.data.sessionId,
        "approved"
      );
      t.check(existsSync(marker), equals(false));

      // The Inkbox resolver produces this validated parent ID before admission;
      // public respond must forward it to the child's original interaction.
      const answered = await session.respond(
        parseAnswers([
          {
            interactionId: request.data.interactionId,
            optionId: APPROVE_OPTION_ID,
          },
        ]),
        { clientContext: { source: "fixture approval reply" } }
      );
      answered.expectOk();
      await live.result();
      checkCompletion(t, answered);
      t.check(await readFile(marker, "utf8"), equals("executed\n"));

      const worker = session.agent(opened);
      let executions = 0;
      let settled = 0;
      for await (const event of worker.stream({
        follow: false,
        signal: t.abortSignal,
      })) {
        if (
          event.type === "call.started" &&
          event.data.callId === origin.call?.callId
        )
          executions += 1;
        if (
          event.type === "interaction.settled" &&
          event.data.interactionId === origin.interactionId &&
          event.data.outcome === "accepted"
        )
          settled += 1;
      }
      t.check(executions, equals(1));
      t.check(settled, equals(1));
    },
  }),
  defineEval({
    description: "Cancels admitted browser work while a child tool is running",
    async test(t) {
      const session = await t.session();
      const live = await session.start("Wait");
      const task = await live.waitForEvent("task.started", {
        data: { name: "run_browser" },
      });
      const opened = await live.waitForEvent("child.opened", {
        data: { name: "browser-agent" },
      });
      const worker = session.agent(opened);
      let toolStarted = false;
      for await (const event of worker.stream({ signal: t.abortSignal })) {
        if (
          event.type === "call.requested" &&
          event.data.capability.name === "wait_for_cancellation"
        ) {
          toolStarted = true;
          break;
        }
      }
      t.check(toolStarted, equals(true));
      await waitForToolMarker(opened.data.sessionId, "started", t.abortSignal);

      // The turn holds for the working task, so this steers it into eve__task_cancel.
      const cancelled = await session.send(`Cancel:${task.data.taskId}`, {
        turnPolicy: "steer",
      });
      cancelled.expectOk();
      await live.result();
      checkTaskCancelled(t, cancelled);

      let workerCancelled = false;
      for await (const event of worker.stream({ signal: t.abortSignal })) {
        if (event.type === "content.completed" && event.data.kind === "result")
          throw new Error("Cancelled worker produced a successful result.");
        if (event.type === "turn.settled") {
          workerCancelled = event.data.outcome === "cancelled";
          break;
        }
      }
      t.check(workerCancelled, equals(true));
      await waitForToolMarker(opened.data.sessionId, "aborted", t.abortSignal);

      // A cancelled serve task returns to receive(), so the same worker resumes.
      const resumed = await session.send(`Resume:${task.data.taskId}`);
      resumed.expectOk();
      t.check(browserTaskId(resumed), equals(task.data.taskId));
      t.check(workerSessionId(resumed.events), equals(opened.data.sessionId));
      checkCompletion(t, resumed);
    },
  }),
];
