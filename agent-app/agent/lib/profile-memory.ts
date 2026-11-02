import {
  defineMemoryProvider,
  type MemoryOperationContext,
  type MemoryProvider,
  type MemoryRecallHandler,
  type MemoryScopeContext,
} from "eve/memory";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import {
  MemoryDocumentConflictError,
  type MemoryDocumentBackend,
} from "eve/memory/file";
import {
  getPrivateObject,
  putPrivateObject,
  PrivateObjectConflictError,
} from "@shared/storage/r2";
import { resolveModeValue } from "@agent/lib/mode";

const maximumMemoryBytes = 65_536;
const maximumEnvelopeBytes = maximumMemoryBytes * 6 + 1024;
const envelopeSchema = z.strictObject({
  content: z
    .string()
    .refine((value) => Buffer.byteLength(value) <= maximumMemoryBytes),
  revision: z.uuid(),
  version: z.literal(1),
});

export function resolveProfileMemoryBackend(): MemoryDocumentBackend {
  return {
    async read({ key, signal }) {
      signal.throwIfAborted();
      const result = await getPrivateObject(memoryPathname(key), {
        abortSignal: signal,
        maximumSizeInBytes: maximumEnvelopeBytes,
      });
      if (result === null) return null;
      if (result.statusCode !== 200)
        throw new Error("Memory storage returned no document.");
      let value: unknown;
      try {
        value = await new Response(result.stream).json();
      } catch {
        signal.throwIfAborted();
        throw new Error("Memory storage returned an invalid document.");
      }
      const envelope = envelopeSchema.safeParse(value);
      signal.throwIfAborted();
      if (!envelope.success)
        throw new Error("Memory storage returned an invalid document.");
      return { content: envelope.data.content, version: result.metadata.etag };
    },
    async write({ content, expectedVersion, key, signal }) {
      signal.throwIfAborted();
      if (Buffer.byteLength(content) > maximumMemoryBytes) {
        throw new Error("Memory document is too large.");
      }
      // Fresh revisions prevent ETag ABA when a document returns to older text.
      // Empty Eve documents are written too: never delete their allocated indices.
      const envelope = JSON.stringify({
        content,
        revision: randomUUID(),
        version: 1,
      });
      try {
        const result = await putPrivateObject(
          memoryPathname(key),
          Buffer.from(envelope),
          {
            abortSignal: signal,
            contentType: "application/json; charset=utf-8",
            expectedVersion,
            maximumSizeInBytes: maximumEnvelopeBytes,
          }
        );
        signal.throwIfAborted();
        return { content, version: result.etag };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PrivateObjectConflictError) {
          throw new MemoryDocumentConflictError(key);
        }
        throw error;
      }
    },
  };
}

function memoryPathname(key: string) {
  const scope = createHash("sha256").update(key).digest("hex");
  return `eve/memory/file/${scope}/MEMORY.json`;
}

export function resolveProfileMemoryScope(context: MemoryScopeContext) {
  const caller = context.session.auth.current;
  const workspaceId = z.string().safeParse(caller?.attributes.workspaceId);
  const scope =
    caller?.principalType === "user" && workspaceId.success
      ? workspaceId.data
      : null;
  return resolveModeValue(context, {
    interactive: scope,
    "scheduled-worker": scope,
  });
}

export function preserveProfileMemoryCancellation(provider: MemoryProvider) {
  // eve recalls memory before each turn, outside the history compaction rewrites.
  return defineMemoryProvider({
    ...provider,
    recall: {
      "turn.started": (context) =>
        recallWithCancellationReason(provider.recall["turn.started"], context),
    },
  });
}

async function recallWithCancellationReason<
  Context extends MemoryOperationContext,
>(handler: MemoryRecallHandler<Context>, context: Context) {
  try {
    return await handler(context);
  } catch (error) {
    if (context.abortSignal.aborted) {
      context.abortSignal.throwIfAborted();
    }
    throw error;
  }
}
