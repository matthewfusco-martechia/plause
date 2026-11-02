import type * as Eve from "eve";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import browserAgent from "@agent/subagents/browser-agent/agent";

vi.mock("eve", async (importOriginal) => ({
  ...(await importOriginal<typeof Eve>()),
  defineDynamic: <T>(fn: T) => fn,
}));

describe("worker input bubbling", () => {
  it("keeps native questions disabled inside browser workers", () => {
    expect(
      existsSync("agent/subagents/browser-agent/tools/ask_question.ts")
    ).toBe(false);
  });

  it("declares a static worker with a per-call model resolver", () => {
    // A dynamic subagent config cannot serialize a provider instance; static
    // declaration lets Eve invoke its direct-model resolver inside model work.
    expect(browserAgent.tool).toBe(false);
    expect(browserAgent.model).toEqual(expect.any(Function));
  });

  it("ends the worker turn and routes the answer through its task id", () => {
    const instructions = readFileSync(
      "agent/instructions/content/role/interactive.md",
      "utf8"
    );
    const workerInstructions = readFileSync(
      "agent/subagents/browser-agent/instructions.md",
      "utf8"
    );

    expect(instructions).toContain(
      "continue that worker with its `run_browser` `taskId`"
    );
    expect(instructions).toContain(
      "Before surfacing a `Needs user input:` blocker"
    );
    expect(instructions).toContain(
      "confirm the worker explicitly reported checking compatible vault items"
    );
    expect(workerInstructions).toContain(
      "Before returning `Needs user input:` or `Needs vault setup:`"
    );
    expect(workerInstructions).toContain("select the relevant compatible item");
    expect(workerInstructions).toContain(
      "structured completion tool Eve supplies"
    );
    expect(workerInstructions).toContain(
      "Follow the structured completion tool's instructions"
    );
  });
});
