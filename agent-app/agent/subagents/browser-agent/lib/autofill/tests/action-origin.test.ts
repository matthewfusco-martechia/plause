import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { currentKernelPageOrigin } from "../native";

vi.mock("@onkernel/sdk", () => ({
  default: class {
    browsers = { retrieve: async () => ({ cdp_ws_url: "wss://kernel.test" }) };
  },
}));

const commandSchema = z.object({ id: z.number(), method: z.string() });
let pages = ["https://shop.example/checkout"];
const methods: string[] = [];
class BrowserSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  send(data: string) {
    const command = commandSchema.parse(JSON.parse(data));
    methods.push(command.method);
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            id: command.id,
            result: resultFor(command.method),
          }),
        })
      )
    );
  }
}
function resultFor(method: string) {
  if (method === "Target.getTargets")
    return {
      targetInfos: pages.map((url, index) => ({
        targetId: `page-${String(index)}`,
        type: "page",
        url,
      })),
    };
  if (method === "Target.attachToTarget") return { sessionId: "page-session" };
  if (method === "Page.getFrameTree")
    return {
      frameTree: { frame: { id: "frame", url: pages[0] ?? "about:blank" } },
    };
  return {};
}
beforeEach(() => {
  methods.length = 0;
  pages = ["https://shop.example/checkout"];
  vi.stubGlobal("WebSocket", BrowserSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("browser action starting-origin inspection", () => {
  it("reads one current page without executing page-authored JavaScript", async () => {
    await expect(
      currentKernelPageOrigin({
        browserSessionId: "browser",
        requireSinglePage: true,
      })
    ).resolves.toBe("https://shop.example");
    expect(methods).not.toContain("Runtime.evaluate");
    expect(methods).toContain("Target.getTargets");
  });
  it.each(["https://other.example", "about:blank"])(
    "rejects an additional %s tab rather than guessing which origin an action targets",
    async (second) => {
      pages.push(second);
      await expect(
        currentKernelPageOrigin({
          browserSessionId: "browser",
          requireSinglePage: true,
        })
      ).rejects.toThrow("exactly one");
      expect(methods).not.toContain("Target.attachToTarget");
    }
  );
});
