import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { withGoogleAuth } from "./client";

const fileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const metadataSchema = z.object({
  id: fileIdSchema,
  name: z.string().max(1024),
  mimeType: z.string().max(200),
  modifiedTime: z.string().max(100).optional(),
  size: z.string().regex(/^\d+$/u).max(24).optional(),
  trashed: z.boolean().optional(),
  capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
});
const listingSchema = z.object({
  files: z.array(metadataSchema).max(20).default([]),
  nextPageToken: z.string().max(4096).optional(),
});
const textMimeTypes = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
const maximumReadBytes = 64 * 1024;
const maximumTextCharacters = 16_000;

export async function searchDriveFiles(
  ctx: ToolContext,
  input: { query: string; maxResults: number; pageToken?: string }
) {
  const query = z.string().trim().min(1).max(500).parse(input.query);
  const maxResults = z.number().int().min(1).max(20).parse(input.maxResults);
  const pageToken = z.string().max(4096).optional().parse(input.pageToken);
  return withGoogleAuth(ctx, async (client) => {
    const token = z.string().min(1).parse(client.credentials.access_token);
    const literal = query.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.search = new URLSearchParams({
      q: `trashed = false and (name contains '${literal}' or fullText contains '${literal}')`,
      pageSize: String(maxResults),
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
      spaces: "drive",
    }).toString();
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await driveRequest(url, token, ctx.abortSignal);
    const body = await boundedText(
      response,
      maximumReadBytes,
      ctx.abortSignal,
      false
    );
    try {
      const result = listingSchema.parse(JSON.parse(body.text));
      return {
        files: result.files.map((file) => ({
          ...file,
          url: `https://drive.google.com/file/d/${file.id}/view`,
        })),
        nextPageToken: result.nextPageToken ?? null,
      };
    } catch {
      throw new Error("Google Drive returned invalid file metadata.");
    }
  });
}

export async function readDriveTextFile(ctx: ToolContext, rawFileId: string) {
  const fileId = fileIdSchema.parse(rawFileId);
  return withGoogleAuth(ctx, async (client) => {
    const token = z.string().min(1).parse(client.credentials.access_token);
    const metadataUrl = new URL(
      `https://www.googleapis.com/drive/v3/files/${fileId}`
    );
    metadataUrl.searchParams.set(
      "fields",
      "id,name,mimeType,size,trashed,capabilities(canDownload)"
    );
    const metadataBody = await boundedText(
      await driveRequest(metadataUrl, token, ctx.abortSignal),
      maximumReadBytes,
      ctx.abortSignal,
      false
    );
    let file: z.infer<typeof metadataSchema>;
    try {
      file = metadataSchema.parse(JSON.parse(metadataBody.text));
    } catch {
      throw new Error("Google Drive returned invalid file metadata.");
    }
    if (
      file.id !== fileId ||
      file.trashed ||
      file.capabilities?.canDownload === false
    )
      throw new Error("This Drive file is not available for text reading.");
    const nativeDocument =
      file.mimeType === "application/vnd.google-apps.document";
    if (!nativeDocument && !textMimeTypes.has(file.mimeType))
      throw new Error(
        "Drive reading supports Google Docs and plain text, Markdown, CSV or JSON files only."
      );
    if (!nativeDocument && file.size && Number(file.size) > 2 * 1024 * 1024)
      throw new Error("This Drive file is too large for a bounded text read.");
    const contentUrl = new URL(
      `https://www.googleapis.com/drive/v3/files/${fileId}${nativeDocument ? "/export" : ""}`
    );
    contentUrl.searchParams.set(
      nativeDocument ? "mimeType" : "alt",
      nativeDocument ? "text/plain" : "media"
    );
    const response = await driveRequest(contentUrl, token, ctx.abortSignal);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim();
    if (
      !contentType ||
      (!textMimeTypes.has(contentType) &&
        contentType !== "application/octet-stream")
    ) {
      await response.body?.cancel();
      throw new Error("Google Drive did not return supported text content.");
    }
    const body = await boundedText(
      response,
      maximumReadBytes,
      ctx.abortSignal,
      true
    );
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      text: body.text.slice(0, maximumTextCharacters),
      truncated: body.truncated || body.text.length > maximumTextCharacters,
      untrustedContent: true as const,
    };
  });
}

async function driveRequest(url: URL, token: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (
    url.origin !== "https://www.googleapis.com" ||
    !url.pathname.startsWith("/drive/v3/files")
  )
    throw new Error("Unsupported Google Drive endpoint.");
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error("Google Drive request failed."), {
        response: { status: response.status },
      });
    }
    return response;
  } catch (error) {
    signal.throwIfAborted();
    const known = z
      .object({ response: z.object({ status: z.number() }) })
      .safeParse(error);
    if (known.success)
      throw Object.assign(
        new Error("Google Drive request failed."),
        known.data
      );
    // oxlint-disable-next-line eslint/preserve-caught-error -- Never journal the provider request, token, or response body.
    throw new Error("Google Drive request failed.");
  }
}

async function boundedText(
  response: Response,
  limit: number,
  signal: AbortSignal,
  allowTruncation: boolean
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google Drive returned no content.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    /* oxlint-disable eslint/no-await-in-loop -- Read one bounded provider stream in order. */
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        truncated = true;
        await reader.cancel();
        if (!allowTruncation)
          throw new Error("Google Drive metadata exceeds the size limit.");
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } catch {
    signal.throwIfAborted();
    throw new Error("Google Drive response could not be read safely.");
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
      { stream: truncated }
    );
    if (text.includes("\0")) throw new Error("Binary content.");
    return { text, truncated };
  } catch {
    throw new Error("Google Drive returned binary or invalid text content.");
  }
}
