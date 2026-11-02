import { getPrivateObject, isR2StorageConfigured } from "@shared/storage/r2";
import { z } from "zod";
import { getAuthSession } from "@db/services/auth/session";
import { readReadyBrowserImageArtifact } from "@db/services/browser-images";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/artifacts/[artifactId]">
) {
  const session = await getAuthSession(request.headers);
  const parsedId = z.uuid().safeParse((await context.params).artifactId);
  if (!session || !parsedId.success) return notFound();

  const scope = accessScopeForUser(`better-auth:${session.user.id}`);
  const opened = await openArtifact(scope, parsedId.data, {
    ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    signal: request.signal,
  });
  if (!opened) return notFound();

  const headers = privateImageHeaders();
  if (opened.result.statusCode === 304) {
    if (opened.result.metadata.etag)
      headers.set("etag", opened.result.metadata.etag);
    return new Response(null, { headers, status: 304 });
  }
  headers.set("etag", opened.result.metadata.etag);

  headers.set("content-length", String(opened.artifact.byteSize));
  headers.set("content-type", opened.artifact.mediaType);
  headers.set(
    "content-disposition",
    contentDisposition(opened.artifact.filename)
  );
  return new Response(opened.result.stream, { headers, status: 200 });
}

async function openArtifact(
  scope: ReturnType<typeof accessScopeForUser>,
  artifactId: string,
  options: { readonly ifNoneMatch?: string; readonly signal?: AbortSignal }
) {
  const artifact = await readReadyBrowserImageArtifact(scope, artifactId);
  const byteSize = artifact?.byteSize;
  const filename = artifact?.filename;
  const mediaType = artifact?.mediaType;
  if (!artifact || !byteSize || !filename || !mediaType) return undefined;
  if (!isR2StorageConfigured()) return undefined;
  const result = await getPrivateObject(artifact.storagePathname, {
    abortSignal: options.signal,
    ifNoneMatch: options.ifNoneMatch,
    maximumSizeInBytes: maximumBrowserImageBytes,
  });
  if (!result) return undefined;
  if (
    result.statusCode === 200 &&
    (result.metadata.size !== byteSize ||
      result.metadata.contentType !== mediaType)
  )
    return undefined;
  return { artifact: { ...artifact, byteSize, filename, mediaType }, result };
}

function notFound() {
  return new Response("Not found", {
    headers: privateImageHeaders(),
    status: 404,
  });
}

function privateImageHeaders() {
  return new Headers({
    "cache-control": "private, max-age=3600",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
