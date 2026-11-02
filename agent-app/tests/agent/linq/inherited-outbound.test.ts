import type { Chat } from "chat";
import type { SessionAuth } from "eve/context";
import type { ChatSdkChannelConfig } from "eve/channels/chat-sdk";
import type { linqChannel, LinqChannelConfig } from "eve/channels/linq";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type HookName =
  | "committed"
  | "turn.started"
  | "call.requested"
  | "interaction.settled";
interface FixtureEvent {
  fixture?: string;
}
type FixtureHook = (
  event: FixtureEvent,
  context: { session: { auth: SessionAuth } }
) => Promise<void>;
type FixtureAdapter = Record<HookName, FixtureHook>;
type OriginalHooks = Record<HookName, Mock<FixtureHook>>;

const controls = (() => {
  const adapters: FixtureAdapter[] = [];
  const originals: OriginalHooks[] = [];
  const order: string[] = [];
  return { adapters, originals, order };
})();

// Mock the public Chat SDK factory; the real patched Linq module must guard the
// factory's inherited hooks without replacing or altering their arguments.
const dependencies = {
  chatSdkChannel: (_configuration: ChatSdkChannelConfig) => {
    const originals: OriginalHooks = {
      committed: vi.fn<FixtureHook>().mockImplementation(async () => {
        controls.order.push("handler");
      }),
      "turn.started": vi.fn<FixtureHook>().mockImplementation(async () => {
        controls.order.push("handler");
      }),
      "call.requested": vi.fn<FixtureHook>().mockImplementation(async () => {
        controls.order.push("handler");
      }),
      "interaction.settled": vi
        .fn<FixtureHook>()
        .mockImplementation(async () => {
          controls.order.push("handler");
        }),
    };
    const adapter = { ...originals };
    controls.adapters.push(adapter);
    controls.originals.push(originals);
    return {
      channel: { routes: [], adapter },
      bot: {
        onDirectMessage: vi.fn<Chat["onDirectMessage"]>(),
        onNewMessage: vi.fn<Chat["onNewMessage"]>(),
      },
    };
  },
};

const createLinqChannel = loadInstalledLinqFactory();

const auth: SessionAuth = {
  current: {
    authenticator: "fixture",
    principalId: "better-auth:fixture",
    principalType: "user",
    attributes: {},
  },
  initiator: null,
};
const names: readonly HookName[] = [
  "committed",
  "turn.started",
  "call.requested",
  "interaction.settled",
];

beforeEach(() => {
  controls.adapters.length = 0;
  controls.originals.length = 0;
  controls.order.length = 0;
});

describe("Linq inherited outbound authorization", () => {
  it.each(names)(
    "authorizes %s before preserving the original hook",
    async (name) => {
      const guard = vi
        .fn<NonNullable<LinqChannelConfig["beforeOutbound"]>>()
        .mockImplementation(async () => {
          controls.order.push("authorize");
        });
      createLinqChannel({
        credentials: { apiKey: "fixture-key", webhookVerifier: () => false },
        beforeOutbound: guard,
      });
      const adapter = controls.adapters[0];
      const original = controls.originals[0]?.[name];
      if (!adapter || !original)
        throw new Error("The public Chat SDK factory was not used");
      const event = { fixture: "unchanged" };
      const context = { session: { auth } };
      await adapter[name](event, context);
      expect(controls.order).toEqual(["authorize", "handler"]);
      expect(guard).toHaveBeenCalledExactlyOnceWith(auth);
      expect(original).toHaveBeenCalledExactlyOnceWith(event, context);
    }
  );

  it.each(names)("blocks %s when the current user is revoked", async (name) => {
    const guard = vi
      .fn<NonNullable<LinqChannelConfig["beforeOutbound"]>>()
      .mockRejectedValue(new Error("Fixture account revoked"));
    createLinqChannel({
      credentials: { apiKey: "fixture-key", webhookVerifier: () => false },
      beforeOutbound: guard,
    });
    const adapter = controls.adapters[0];
    const original = controls.originals[0]?.[name];
    if (!adapter || !original)
      throw new Error("The public Chat SDK factory was not used");
    await expect(adapter[name]({}, { session: { auth } })).rejects.toThrow(
      "Fixture account revoked"
    );
    expect(original).not.toHaveBeenCalled();
  });
});

function loadInstalledLinqFactory() {
  // Evaluate only the installed public entrypoint with isolated, local stubs.
  // Native ESM package-internal imports bypass Vitest's public-module mocks.
  const require = createRequire(import.meta.url);
  const source = readFileSync(
    new URL(
      "./linqChannel.js",
      pathToFileURL(require.resolve("eve/channels/linq"))
    ),
    "utf8"
  );
  const imports = /import\{[^}]+\}from"[^"]+";/gu;
  const exportLine = "export{defaultLinqAuth,linqChannel};";
  if (source.match(imports)?.length !== 7 || !source.endsWith(exportLine)) {
    throw new Error(
      "The pinned Linq public entrypoint changed; review the fixture boundary."
    );
  }
  const script = source
    .replace(imports, "")
    .replace(exportLine, "\nlinqChannel;");
  // SAFETY: The pinned module's import/export shape was checked above; evaluation
  // ends with its named factory. All imported capabilities are local stubs, and
  // the new VM context exposes no fetch, process, require or provider credentials.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This is the checked package-artifact boundary, not an application input cast.
  return runInNewContext(script, {
    chatSdkChannel: dependencies.chatSdkChannel,
    createLinqAdapter: () => ({}),
    createMemoryState: () => ({}),
    sameEnvironmentVercelOidc: unexpectedDependency,
    dispatchIMessageTapbacks: unexpectedDependency,
    iMessageTapbackTool: unexpectedDependency,
    formatReplyContext: unexpectedDependency,
    linqInboundContent: unexpectedDependency,
    linqQuotedMessage: unexpectedDependency,
    rehydrateLinqAttachment: unexpectedDependency,
  }) as typeof linqChannel;
}

function unexpectedDependency(): never {
  throw new Error("Unexpected package fixture dependency");
}
