import { auth } from "@googleapis/gmail";
import { z } from "zod";
import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolContextFor } from "@tests/helpers/tool-context";

vi.mock("@agent/lib/google-workspace/client", () => ({
  withGoogleAuth: async <T>(
    _ctx: ToolContext,
    execute: (client: InstanceType<typeof auth.OAuth2>) => Promise<T>
  ) => {
    const client = new auth.OAuth2();
    client.setCredentials({ access_token: "fixture-private-token" });
    return execute(client);
  },
}));

import {
  readDriveTextFile,
  searchDriveFiles,
} from "@agent/lib/google-workspace/drive";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch");
});
afterEach(() => vi.restoreAllMocks());

const context = toolContextFor({ toolName: "drive-test" });
const file = {
  id: "file_123",
  name: "Fictional notes",
  mimeType: "text/plain",
  size: "5",
  capabilities: { canDownload: true },
};

describe("bounded read-only Drive", () => {
  it("searches one bounded page and keeps tokens exclusively in the Authorization header", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      Response.json({ files: [file], nextPageToken: "next-fixture-page" })
    );
    const result = await searchDriveFiles(context, {
      query: "Project' or trashed = true",
      maxResults: 10,
      pageToken: "prior-page",
    });
    expect(result.nextPageToken).toBe("next-fixture-page");
    expect(result.files[0]?.url).toBe(
      "https://drive.google.com/file/d/file_123/view"
    );
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = requestUrl(call?.[0]);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/drive/v3/files"
    );
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(url.searchParams.get("pageToken")).toBe("prior-page");
    expect(url.searchParams.get("q")).toContain("Project\\' or trashed = true");
    expect(url.href).not.toContain("fixture-private-token");
    expect(call?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { authorization: "Bearer fixture-private-token" },
    });
  });

  it("reads only an exact plain-text file endpoint", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json(file))
      .mockResolvedValueOnce(
        new Response("hello", { headers: { "content-type": "text/plain" } })
      );
    const result = await readDriveTextFile(context, "file_123");
    expect(result).toMatchObject({
      text: "hello",
      truncated: false,
      untrustedContent: true,
    });
    const url = requestUrl(vi.mocked(globalThis.fetch).mock.calls[1]?.[0]);
    expect(url.pathname).toBe("/drive/v3/files/file_123");
    expect(url.searchParams.get("alt")).toBe("media");
  });

  it("exports a native Google Doc as text, ignoring provider-supplied download URLs", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        Response.json({
          ...file,
          mimeType: "application/vnd.google-apps.document",
          webContentLink: "https://attacker.invalid/download",
        })
      )
      .mockResolvedValueOnce(
        new Response("fictional document", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      );
    expect((await readDriveTextFile(context, "file_123")).text).toBe(
      "fictional document"
    );
    const url = requestUrl(vi.mocked(globalThis.fetch).mock.calls[1]?.[0]);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/drive/v3/files/file_123/export"
    );
    expect(url.searchParams.get("mimeType")).toBe("text/plain");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["application/pdf", "application/vnd.google-apps.shortcut"])(
    "never follows or downloads unsupported %s files",
    async (mimeType) => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        Response.json({ ...file, mimeType })
      );
      await expect(readDriveTextFile(context, "file_123")).rejects.toThrow(
        "supports Google Docs"
      );
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { ...file, id: "wrong-id" },
    { ...file, trashed: true },
    { ...file, capabilities: { canDownload: false } },
    { ...file, size: "3000000" },
  ])(
    "refuses mismatched, removed, restricted or oversized files",
    async (metadata) => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        Response.json(metadata)
      );
      await expect(readDriveTextFile(context, "file_123")).rejects.toThrow(
        /available|too large|Invalid|Too big|Too small/u
      );
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    }
  );

  it("limits text bytes and model-visible characters and declares truncation", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json({ ...file, size: "100000" }))
      .mockResolvedValueOnce(
        new Response("a".repeat(100_000), {
          headers: { "content-type": "text/plain" },
        })
      );
    const result = await readDriveTextFile(context, "file_123");
    expect(result.text).toHaveLength(16_000);
    expect(result.truncated).toBe(true);
  });

  it("rejects binary content despite misleading text metadata", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json(file))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0, 0x80]), {
          headers: { "content-type": "application/octet-stream" },
        })
      );
    await expect(readDriveTextFile(context, "file_123")).rejects.toThrow(
      "binary or invalid text"
    );
  });

  it("never follows redirects or retries an unknown read failure", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/collect" },
      })
    );
    await expect(
      searchDriveFiles(context, { query: "notes", maxResults: 10 })
    ).rejects.toThrow("Google Drive request failed.");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.redirect).toBe(
      "manual"
    );
  });

  it("rejects arbitrary URLs, excessive pages and oversized metadata before exposing content", async () => {
    await expect(
      readDriveTextFile(context, "https://attacker.invalid/file")
    ).rejects.toThrow(/available|too large|Invalid|Too big|Too small/u);
    await expect(
      searchDriveFiles(context, { query: "notes", maxResults: 21 })
    ).rejects.toThrow(/available|too large|Invalid|Too big|Too small/u);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("SECRET".repeat(20_000))
    );
    await expect(
      searchDriveFiles(context, { query: "notes", maxResults: 10 })
    ).rejects.toThrow(/^Google Drive response could not be read safely\.$/u);
  });

  it("preserves a caller cancellation before any request", async () => {
    const controller = new AbortController();
    const reason = new Error("Task cancelled.");
    controller.abort(reason);
    await expect(
      searchDriveFiles(
        { ...context, abortSignal: controller.signal },
        { query: "notes", maxResults: 10 }
      )
    ).rejects.toBe(reason);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

function requestUrl(input: Parameters<typeof fetch>[0] | undefined) {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(z.string().parse(input));
}
