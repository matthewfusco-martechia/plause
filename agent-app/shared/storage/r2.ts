import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "@shared/environment";

const maximumObjectBytes = 8 * 1024 * 1024;
const strongEtagSchema = z.string().regex(/^"[^"\\,\r\n]+"$/u);
const configurationSchema = z.object({
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/iu),
  R2_BUCKET: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});
const storageErrorSchema = z.object({
  $metadata: z.object({ httpStatusCode: z.number() }),
  $response: z
    .object({
      headers: z.object({ etag: z.string().optional() }),
    })
    .optional(),
});
let client: S3Client | undefined;

export class PrivateObjectConflictError extends Error {
  constructor() {
    super("The private object changed before this write.");
    this.name = "PrivateObjectConflictError";
  }
}

export function isR2StorageConfigured() {
  return configurationSchema.safeParse(env).success;
}

function storageClient() {
  const configured = configurationSchema.safeParse(env);
  if (!configured.success) {
    throw new Error("Private R2 storage is not configured.");
  }
  client ??= new S3Client({
    credentials: {
      accessKeyId: configured.data.R2_ACCESS_KEY_ID,
      secretAccessKey: configured.data.R2_SECRET_ACCESS_KEY,
    },
    endpoint: `https://${configured.data.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    maxAttempts: 1,
    region: "auto",
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 20_000,
      throwOnRequestTimeout: true,
    },
  });
  return client;
}

function objectKey(pathname: string) {
  if (
    pathname.length === 0 ||
    Buffer.byteLength(pathname) > 1024 ||
    pathname.startsWith("/") ||
    pathname.includes("://") ||
    // oxlint-disable-next-line eslint/no-control-regex -- Object keys must never carry HTTP/control characters.
    /[\u0000-\u001f\u007f\\]/u.test(pathname) ||
    pathname.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid private object key.");
  }
  return pathname;
}

function byteLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumObjectBytes) {
    throw new Error("Invalid private object size limit.");
  }
  return value;
}

function storageFailure(signal?: AbortSignal): never {
  signal?.throwIfAborted();
  // Provider errors can contain signed headers, bucket names, or object keys.
  throw new Error("Private R2 storage request failed.");
}

export async function getPrivateObject(
  pathname: string,
  options: {
    readonly abortSignal?: AbortSignal;
    readonly ifNoneMatch?: string;
    readonly maximumSizeInBytes: number;
  }
) {
  const key = objectKey(pathname);
  const limit = byteLimit(options.maximumSizeInBytes);
  options.abortSignal?.throwIfAborted();
  if (options.ifNoneMatch && /[\r\n]/u.test(options.ifNoneMatch)) {
    throw new Error("Invalid private object condition.");
  }
  try {
    const result = await storageClient().send(
      new GetObjectCommand({
        Bucket: env.R2_BUCKET,
        IfNoneMatch: options.ifNoneMatch,
        Key: key,
      }),
      { abortSignal: options.abortSignal }
    );
    const size = result.ContentLength;
    if (
      !result.Body ||
      size === undefined ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > limit ||
      !strongEtagSchema.safeParse(result.ETag).success ||
      !result.ContentType
    ) {
      await result.Body?.transformToWebStream().cancel();
      throw new Error("Invalid private object metadata.");
    }
    const stream: ReadableStream<unknown> = result.Body.transformToWebStream();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    options.abortSignal?.addEventListener("abort", cancel, { once: true });
    try {
      /* oxlint-disable eslint/no-await-in-loop -- Object chunks must be consumed in order under one bound. */
      for (;;) {
        options.abortSignal?.throwIfAborted();
        const chunk = await reader.read();
        const { done } = chunk;
        if (done) break;
        const value = z.instanceof(Uint8Array).parse(chunk.value);
        length += value.byteLength;
        if (length > limit || length > size) {
          await reader.cancel();
          throw new Error("Private object exceeds its declared size.");
        }
        chunks.push(value);
      }
      /* oxlint-enable eslint/no-await-in-loop */
    } finally {
      options.abortSignal?.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    options.abortSignal?.throwIfAborted();
    if (length !== size) throw new Error("Private object size mismatch.");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const etag = strongEtagSchema.parse(result.ETag);
    return {
      metadata: { contentType: result.ContentType, etag, size },
      statusCode: 200 as const,
      stream: new Blob([bytes]).stream(),
    };
  } catch (error) {
    options.abortSignal?.throwIfAborted();
    const failure = storageErrorSchema.safeParse(error);
    const status = failure.success
      ? failure.data.$metadata.httpStatusCode
      : undefined;
    if (status === 404) return null;
    if (status === 304 && options.ifNoneMatch) {
      const etag = strongEtagSchema.safeParse(
        failure.success ? failure.data.$response?.headers.etag : undefined
      );
      return {
        metadata: { etag: etag.success ? etag.data : undefined },
        statusCode: 304 as const,
        stream: null,
      };
    }
    return storageFailure(options.abortSignal);
  }
}

export async function putPrivateObject(
  pathname: string,
  body: Uint8Array,
  options: {
    readonly abortSignal?: AbortSignal;
    readonly contentType: string;
    // null is create-only; a version is compare-and-swap; omitted is replacement.
    readonly expectedVersion?: string | null;
    readonly maximumSizeInBytes: number;
  }
) {
  const key = objectKey(pathname);
  const limit = byteLimit(options.maximumSizeInBytes);
  const bytes = body;
  if (bytes.byteLength > limit) throw new Error("Private object is too large.");
  if (!options.contentType || /[\r\n]/u.test(options.contentType)) {
    throw new Error("Invalid private object content type.");
  }
  if (
    options.expectedVersion !== undefined &&
    options.expectedVersion !== null &&
    !strongEtagSchema.safeParse(options.expectedVersion).success
  ) {
    throw new Error("Invalid private object version.");
  }
  options.abortSignal?.throwIfAborted();
  try {
    const result = await storageClient().send(
      new PutObjectCommand({
        Body: bytes,
        Bucket: env.R2_BUCKET,
        CacheControl: "private, no-store",
        ContentLength: bytes.byteLength,
        ContentType: options.contentType,
        IfMatch: options.expectedVersion ?? undefined,
        IfNoneMatch: options.expectedVersion === null ? "*" : undefined,
        Key: key,
      }),
      { abortSignal: options.abortSignal }
    );
    options.abortSignal?.throwIfAborted();
    return { etag: strongEtagSchema.parse(result.ETag) };
  } catch (error) {
    options.abortSignal?.throwIfAborted();
    const failure = storageErrorSchema.safeParse(error);
    if (failure.success && failure.data.$metadata.httpStatusCode === 412)
      throw new PrivateObjectConflictError();
    return storageFailure(options.abortSignal);
  }
}

export async function deletePrivateObject(pathname: string) {
  const key = objectKey(pathname);
  try {
    await storageClient().send(
      new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key })
    );
  } catch {
    storageFailure();
  }
}
