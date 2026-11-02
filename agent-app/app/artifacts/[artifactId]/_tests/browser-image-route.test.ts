/* oxlint-disable vitest/require-mock-type-parameters -- The auth and R2 mocks implement only the route boundaries exercised here. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  getObject: vi.fn(),
  readArtifact: vi.fn(),
}));

vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));
vi.mock("@db/services/browser-images", () => ({
  readReadyBrowserImageArtifact: mocks.readArtifact,
}));
vi.mock("@shared/storage/r2", () => ({
  getPrivateObject: mocks.getObject,
  isR2StorageConfigured: () => true,
}));

import { GET } from "@app/artifacts/[artifactId]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.readArtifact.mockResolvedValue({
    byteSize: png.byteLength,
    filename: "Product image.png",
    mediaType: "image/png",
    storagePathname: "artifacts/product",
  });
  mocks.getObject.mockResolvedValue({
    metadata: {
      contentType: "image/png",
      etag: '"etag"',
      size: png.byteLength,
    },
    statusCode: 200,
    stream: new Response(png).body,
  });
});

describe("browser image route", () => {
  it("streams an authenticated artifact with private security headers", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain(
      "Product%20image.png"
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("passes conditional ETags through to private R2", async () => {
    mocks.getObject.mockResolvedValue({
      metadata: {
        contentType: "image/png",
        etag: '"etag"',
        size: png.byteLength,
      },
      statusCode: 304,
      stream: null,
    });

    const response = await GET(
      request({ "if-none-match": '"etag"' }),
      context()
    );

    expect(response.status).toBe(304);
    expect(mocks.getObject).toHaveBeenCalledWith(
      "artifacts/product",
      expect.objectContaining({ ifNoneMatch: '"etag"' })
    );
  });

  it.each([
    ["unauthenticated", null, artifactId],
    ["invalid id", { user: { id: "user-1" } }, "not-an-id"],
  ])(
    "returns the same not-found response for %s requests",
    async (_name, session, id) => {
      mocks.getAuthSession.mockResolvedValue(session);

      const response = await GET(request(), context(id));

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(mocks.getObject).not.toHaveBeenCalled();
    }
  );

  it("does not reveal an unavailable or cross-workspace artifact", async () => {
    mocks.readArtifact.mockResolvedValue(undefined);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it.each([
    { contentType: "image/jpeg", etag: '"etag"', size: png.byteLength },
    { contentType: "image/png", etag: '"etag"', size: png.byteLength + 1 },
  ])(
    "rejects storage that no longer matches the owned manifest",
    async (metadata) => {
      mocks.getObject.mockResolvedValue({
        metadata,
        statusCode: 200,
        stream: new Response(png).body,
      });
      const response = await GET(request(), context());
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  );
});

function request(headers?: HeadersInit) {
  return new Request(`https://example.com/artifacts/${artifactId}`, {
    headers,
  });
}

function context(id = artifactId) {
  return { params: Promise.resolve({ artifactId: id }) };
}
