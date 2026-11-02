/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers describe the mocked SDK command inputs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetObjectCommandInput, S3ClientConfig } from "@aws-sdk/client-s3";

interface StorageFixtureResponse {
  Body?: { transformToWebStream(): ReadableStream<Uint8Array> };
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
}

const mocks = vi.hoisted(() => {
  const configurations: S3ClientConfig[] = [];
  return {
    configurations,
    environment: {
      R2_ACCESS_KEY_ID: "fixture-access-key",
      R2_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      R2_BUCKET: "plause-fixture-private",
      R2_SECRET_ACCESS_KEY: "fixture-secret-key",
    },
    send: vi.fn<
      (
        command: { input: GetObjectCommandInput },
        options?: { abortSignal?: AbortSignal }
      ) => Promise<StorageFixtureResponse>
    >(),
  };
});

vi.mock("@shared/environment", () => ({ env: mocks.environment }));
vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: GetObjectCommandInput) {}
  }
  return {
    DeleteObjectCommand: Command,
    GetObjectCommand: Command,
    PutObjectCommand: Command,
    S3Client: class {
      constructor(configuration: S3ClientConfig) {
        mocks.configurations.push(configuration);
      }
      send = mocks.send;
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  mocks.send.mockReset();
  mocks.configurations.length = 0;
  mocks.environment.R2_SECRET_ACCESS_KEY = "fixture-secret-key";
});

describe("private R2 objects", () => {
  it("uses the fixed account endpoint, private cache policy and one-attempt conditional writes", async () => {
    const { putPrivateObject } = await import("./r2");
    mocks.send.mockResolvedValue({ ETag: '"first"' });
    const signal = new AbortController().signal;
    await expect(
      putPrivateObject("memory/scoped.json", Buffer.from("hello"), {
        abortSignal: signal,
        contentType: "application/json",
        expectedVersion: null,
        maximumSizeInBytes: 20,
      })
    ).resolves.toEqual({ etag: '"first"' });
    expect(mocks.configurations).toEqual([
      expect.objectContaining({
        credentials: {
          accessKeyId: "fixture-access-key",
          secretAccessKey: "fixture-secret-key",
        },
        endpoint:
          "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
        forcePathStyle: true,
        maxAttempts: 1,
        region: "auto",
        requestHandler: {
          connectionTimeout: 5_000,
          requestTimeout: 20_000,
          throwOnRequestTimeout: true,
        },
      }),
    ]);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "plause-fixture-private",
          CacheControl: "private, no-store",
          ContentLength: 5,
          IfNoneMatch: "*",
          IfMatch: undefined,
          Key: "memory/scoped.json",
        }),
      }),
      { abortSignal: signal }
    );
    await putPrivateObject("memory/scoped.json", Buffer.from("next"), {
      contentType: "application/json",
      expectedVersion: '"first"',
      maximumSizeInBytes: 20,
    });
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          IfMatch: '"first"',
          IfNoneMatch: undefined,
        }),
      }),
      { abortSignal: undefined }
    );
  });

  it("classifies only definitive precondition failures as conflicts and strips provider detail", async () => {
    const { putPrivateObject, PrivateObjectConflictError } =
      await import("./r2");
    const write = () =>
      putPrivateObject("memory/scoped.json", Buffer.from("hello"), {
        contentType: "text/plain",
        expectedVersion: null,
        maximumSizeInBytes: 20,
      });
    mocks.send.mockRejectedValueOnce({
      $metadata: { httpStatusCode: 412 },
      message: "SECRET",
    });
    await expect(write()).rejects.toBeInstanceOf(PrivateObjectConflictError);
    mocks.send.mockRejectedValueOnce(new Error("SECRET signed request"));
    await expect(write()).rejects.toThrow(
      /^Private R2 storage request failed\.$/u
    );
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("reads private bytes and forwards conditional reads without public URLs", async () => {
    const { getPrivateObject } = await import("./r2");
    mocks.send.mockResolvedValue(objectResult([1, 2, 3]));
    const result = await getPrivateObject("browser-images/scoped/image", {
      maximumSizeInBytes: 3,
    });
    expect(result?.statusCode).toBe(200);
    if (result?.statusCode !== 200) throw new Error("Expected object.");
    expect(result.metadata).toEqual({
      contentType: "image/png",
      etag: '"v1"',
      size: 3,
    });
    expect(await new Response(result.stream).arrayBuffer()).toEqual(
      new Uint8Array([1, 2, 3]).buffer
    );
    expect(result).not.toHaveProperty("url");
    mocks.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 304 } });
    expect(
      await getPrivateObject("browser-images/scoped/image", {
        ifNoneMatch: '"v1"',
        maximumSizeInBytes: 3,
      })
    ).toMatchObject({ statusCode: 304, stream: null });
    mocks.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    expect(
      await getPrivateObject("browser-images/missing", {
        maximumSizeInBytes: 3,
      })
    ).toBeNull();
  });

  it.each([
    [4, [1, 2, 3, 4]],
    [2, [1, 2, 3]],
    [3, [1]],
  ])(
    "rejects oversized or mismatched body metadata (%i)",
    async (declared, bytes) => {
      const { getPrivateObject } = await import("./r2");
      mocks.send.mockResolvedValue(objectResult(bytes, declared));
      await expect(
        getPrivateObject("browser-images/image", { maximumSizeInBytes: 3 })
      ).rejects.toThrow("Private R2 storage request failed.");
    }
  );

  it("does not dispatch with missing credentials, oversized writes or caller-controlled URLs", async () => {
    const { getPrivateObject, putPrivateObject, isR2StorageConfigured } =
      await import("./r2");
    mocks.environment.R2_SECRET_ACCESS_KEY = "";
    expect(isR2StorageConfigured()).toBe(false);
    await expect(
      getPrivateObject("object", { maximumSizeInBytes: 3 })
    ).rejects.toThrow("Private R2 storage request failed.");
    await expect(
      getPrivateObject("https://external.example/object", {
        maximumSizeInBytes: 3,
      })
    ).rejects.toThrow("Invalid private object key.");
    await expect(
      putPrivateObject("object", Buffer.from("long"), {
        contentType: "text/plain",
        maximumSizeInBytes: 3,
      })
    ).rejects.toThrow("Private object is too large.");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.configurations).toHaveLength(0);
  });

  it.each(["*", '"one", "two"', 'W/"weak"'])(
    "never broadens a memory CAS to the %s condition",
    async (expectedVersion) => {
      const { putPrivateObject } = await import("./r2");
      await expect(
        putPrivateObject("memory/scoped", Buffer.from("fact"), {
          contentType: "text/plain",
          expectedVersion,
          maximumSizeInBytes: 20,
        })
      ).rejects.toThrow("Invalid private object version.");
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );

  it("cancels a body read when the owning turn aborts", async () => {
    const { getPrivateObject } = await import("./r2");
    const reading = Promise.withResolvers<undefined>();
    const cancelled = vi.fn<() => void>();
    const stream = new ReadableStream<Uint8Array>({
      cancel: cancelled,
      pull() {
        reading.resolve(undefined);
      },
    });
    mocks.send.mockResolvedValue({
      ...objectResult([1]),
      Body: { transformToWebStream: () => stream },
    });
    const controller = new AbortController();
    const result = getPrivateObject("private/image", {
      abortSignal: controller.signal,
      maximumSizeInBytes: 3,
    });
    await reading.promise;
    const reason = new Error("owner cancelled");
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("preserves cancellation before dispatch and after a response, without retry", async () => {
    const { getPrivateObject, putPrivateObject } = await import("./r2");
    const controller = new AbortController();
    const reason = new Error("turn cancelled");
    controller.abort(reason);
    await expect(
      getPrivateObject("object", {
        abortSignal: controller.signal,
        maximumSizeInBytes: 3,
      })
    ).rejects.toBe(reason);
    expect(mocks.send).not.toHaveBeenCalled();
    const late = new AbortController();
    mocks.send.mockImplementationOnce(async () => {
      late.abort(reason);
      return { ETag: '"v2"' };
    });
    await expect(
      putPrivateObject("object", Buffer.from("ok"), {
        abortSignal: late.signal,
        contentType: "text/plain",
        maximumSizeInBytes: 3,
      })
    ).rejects.toBe(reason);
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("deletes only the configured bucket key and sanitizes a failed cleanup", async () => {
    const { deletePrivateObject } = await import("./r2");
    mocks.send.mockResolvedValueOnce({});
    await deletePrivateObject("browser-images/orphan");
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          Bucket: "plause-fixture-private",
          Key: "browser-images/orphan",
        },
      })
    );
    mocks.send.mockRejectedValueOnce(new Error("SECRET"));
    await expect(deletePrivateObject("browser-images/orphan")).rejects.toThrow(
      /^Private R2 storage request failed\.$/u
    );
  });
});

function objectResult(bytes: number[], declared = bytes.length) {
  return {
    Body: {
      transformToWebStream: () => new Blob([new Uint8Array(bytes)]).stream(),
    },
    ContentLength: declared,
    ContentType: "image/png",
    ETag: '"v1"',
  };
}
