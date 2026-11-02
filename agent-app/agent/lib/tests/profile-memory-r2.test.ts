import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Storage from "@shared/storage/r2";
import { MemoryDocumentConflictError } from "eve/memory/file";

const mocks = vi.hoisted(() => ({
  get: vi.fn<typeof Storage.getPrivateObject>(),
  put: vi.fn<typeof Storage.putPrivateObject>(),
  objects: new Map<string, { body: string; etag: string }>(),
}));

vi.mock("@shared/storage/r2", async (importOriginal) => ({
  ...(await importOriginal<typeof Storage>()),
  getPrivateObject: mocks.get,
  putPrivateObject: mocks.put,
}));

import { PrivateObjectConflictError } from "@shared/storage/r2";
import { resolveProfileMemoryBackend } from "@agent/lib/profile-memory";

beforeEach(() => {
  mocks.objects.clear();
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.get.mockImplementation(async (key) => {
    const row = mocks.objects.get(key);
    return row
      ? {
          metadata: {
            contentType: "application/json; charset=utf-8",
            etag: row.etag,
            size: Buffer.byteLength(row.body),
          },
          statusCode: 200,
          stream: new Blob([row.body]).stream(),
        }
      : null;
  });
  mocks.put.mockImplementation(async (key, body, options) => {
    const row = mocks.objects.get(key);
    if ((row?.etag ?? null) !== options.expectedVersion)
      throw new PrivateObjectConflictError();
    const text = new TextDecoder().decode(body);
    const etag = `"${createHash("sha256").update(text).digest("hex")}"`;
    mocks.objects.set(key, { body: text, etag });
    return { etag };
  });
});

const signal = new AbortController().signal;
const key = "authenticated-scope-key";

describe("R2 durable profile memory", () => {
  it("shares durable documents across backend instances and isolates other scopes", async () => {
    const first = resolveProfileMemoryBackend();
    const second = resolveProfileMemoryBackend();
    expect(await first.read({ key, signal })).toBeNull();
    const saved = await first.write({
      key,
      content: "saved fact",
      expectedVersion: null,
      signal,
    });
    expect(await second.read({ key, signal })).toEqual(saved);
    expect(await second.read({ key: "another-user", signal })).toBeNull();
    expect(mocks.put.mock.calls[0]?.[0]).toMatch(
      /^eve\/memory\/file\/[a-f0-9]{64}\/MEMORY\.json$/u
    );
    expect(mocks.put.mock.calls[0]?.[0]).not.toContain(key);
  });

  it("allows one create winner and rejects stale updates across independent instances", async () => {
    const first = resolveProfileMemoryBackend();
    const second = resolveProfileMemoryBackend();
    const results = await Promise.allSettled([
      first.write({ key, content: "first", expectedVersion: null, signal }),
      second.write({ key, content: "second", expectedVersion: null, signal }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      MemoryDocumentConflictError
    );
    const original = await first.read({ key, signal });
    if (!original) throw new Error("Expected saved document.");
    await second.write({
      key,
      content: "new",
      expectedVersion: original.version,
      signal,
    });
    await expect(
      first.write({
        key,
        content: "stale",
        expectedVersion: original.version,
        signal,
      })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
  });

  it("keeps allocated-index tombstones and rejects ABA versions after text returns", async () => {
    const backend = resolveProfileMemoryBackend();
    const original = await backend.write({
      key,
      content: "same text",
      expectedVersion: null,
      signal,
    });
    const empty = "<!-- eve-memory-file-v1 lastAllocatedIndex=7 -->\n";
    const tombstone = await backend.write({
      key,
      content: empty,
      expectedVersion: original.version,
      signal,
    });
    expect(await backend.read({ key, signal })).toEqual(tombstone);
    const restored = await backend.write({
      key,
      content: "same text",
      expectedVersion: tombstone.version,
      signal,
    });
    expect(restored.version).not.toBe(original.version);
    await expect(
      backend.write({
        key,
        content: "old write",
        expectedVersion: original.version,
        signal,
      })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
    await expect(
      backend.write({
        key,
        content: "new create",
        expectedVersion: null,
        signal,
      })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
  });

  it("fails closed on corrupt envelopes without exposing stored text", async () => {
    const backend = resolveProfileMemoryBackend();
    await backend.write({
      key,
      content: "valid",
      expectedVersion: null,
      signal,
    });
    const pathname = mocks.put.mock.calls[0]?.[0];
    if (!pathname) throw new Error("Expected object key.");
    mocks.objects.set(pathname, { body: "SECRET invalid JSON", etag: '"v1"' });
    await expect(backend.read({ key, signal })).rejects.toThrow(
      /^Memory storage returned an invalid document\.$/u
    );
  });

  it("rejects oversized content and propagates cancellation without any storage call", async () => {
    const backend = resolveProfileMemoryBackend();
    await expect(
      backend.write({
        key,
        content: "a".repeat(65_537),
        expectedVersion: null,
        signal,
      })
    ).rejects.toThrow("Memory document is too large.");
    const controller = new AbortController();
    const reason = new Error("cancelled memory operation");
    controller.abort(reason);
    await expect(backend.read({ key, signal: controller.signal })).rejects.toBe(
      reason
    );
    await expect(
      backend.write({
        key,
        content: "fact",
        expectedVersion: null,
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
