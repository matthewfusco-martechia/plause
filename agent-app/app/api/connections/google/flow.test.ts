import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getAuthSession } from "@db/services/auth/session";
import type * as Google from "@db/services/google-workspace";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  session: vi.fn<typeof getAuthSession>(),
  begin: vi.fn<typeof Google.beginGoogleWorkspaceOAuth>(),
  complete: vi.fn<typeof Google.completeGoogleWorkspaceOAuth>(),
  read: vi.fn<typeof Google.readGoogleWorkspaceConnection>(),
}));
vi.mock("@db/services/auth/session", () => ({ getAuthSession: mocks.session }));
vi.mock("@db/services/google-workspace", () => ({
  beginGoogleWorkspaceOAuth: mocks.begin,
  completeGoogleWorkspaceOAuth: mocks.complete,
  readGoogleWorkspaceConnection: mocks.read,
}));
vi.mock("@web/auth/request-scope", () => ({
  requireRequestScope: async () => accessScopeForUser("better-auth:alice"),
}));

import { POST } from "./start/route";
import { GET } from "./callback/route";
import Page from "@app/(authenticated)/connections/google/page";

const browserToken = "b".repeat(43);
const state = "s".repeat(43);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({
    user: {
      id: "alice",
      phoneNumber: "+12025550123",
      phoneNumberVerified: true,
    },
    session: { id: "phone-session" },
  });
  mocks.begin.mockResolvedValue({
    authorizationUrl:
      "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
    browserToken,
    expiresAt: new Date(Date.now() + 600_000),
  });
  mocks.complete.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({
    state: "disconnected",
    accountLabel: null,
    revocationPending: false,
  });
});

function start(
  origin = "https://example.com",
  body = "reviewedPermissions=yes"
) {
  return new Request("https://example.com/api/connections/google/start", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function callback(
  query = `state=${state}&code=fictional-code`,
  cookie = `plause-google-oauth=${browserToken}`
) {
  return new Request(
    `https://example.com/api/connections/google/callback?${query}`,
    { headers: { cookie } }
  );
}

describe("Google permission review and browser flow", () => {
  it("requires same-origin, a signed-in phone session and explicit permission review before OAuth starts", async () => {
    expect((await POST(start("https://attacker.invalid"))).status).toBe(403);
    expect(
      (await POST(start("https://example.com", "reviewedPermissions=no")))
        .status
    ).toBe(400);
    expect(
      (
        await POST(
          start(
            "https://example.com",
            "reviewedPermissions=yes&reviewedPermissions=no"
          )
        )
      ).status
    ).toBe(400);
    mocks.session.mockResolvedValueOnce(null);
    expect((await POST(start())).status).toBe(401);
    mocks.session.mockResolvedValueOnce({
      user: {
        id: "alice",
        phoneNumber: "+12025550123",
        phoneNumberVerified: true,
      },
    });
    expect((await POST(start())).status).toBe(401);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("binds the reviewed start to the authenticated session and sets a secure browser-only cookie", async () => {
    const response = await POST(start());
    expect(response.status).toBe(303);
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith(
      accessScopeForUser("better-auth:alice"),
      "phone-session"
    );
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/connections/google/callback");
    expect(cookie).toContain("Max-Age=600");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
  });

  it("passes exact callback bindings then clears the browser cookie without exposing authorization data", async () => {
    const response = await GET(callback());
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(
      accessScopeForUser("better-auth:alice"),
      {
        sessionId: "phone-session",
        browserToken,
        state,
        code: "fictional-code",
      }
    );
    expect(response.headers.get("location")).toBe(
      "https://example.com/connections/google?result=connected"
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
  });

  it.each([
    "error=access_denied&error_description=SECRET",
    `state=${state}&state=${state}&code=code`,
    `state=${state}`,
  ])(
    "rejects an incomplete or duplicated callback without a provider exchange",
    async (query) => {
      const response = await GET(callback(query));
      expect(response.headers.get("location")).toBe(
        "https://example.com/connections/google?result=failed"
      );
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(JSON.stringify([...response.headers])).not.toContain("SECRET");
    }
  );

  it("does not echo raw provider errors or tokens on a failed callback", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("SECRET provider response"));
    const response = await GET(callback());
    expect(response.headers.get("location")).toBe(
      "https://example.com/connections/google?result=failed"
    );
    expect(await response.text()).toBe("");
    expect(JSON.stringify([...response.headers])).not.toContain("SECRET");
  });

  it("renders the broader permission review with a required explicit POST consent", async () => {
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({}),
      })
    );
    expect(html).toContain('action="/api/connections/google/start"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="reviewedPermissions"');
    expect(html).toContain('required=""');
    expect(html).toContain("View and download files across your Google Drive");
    expect(html).toContain(
      "Gmail and Calendar write tools remain disabled by default"
    );
    expect(html).toContain("Continue to Google");
    expect(html).not.toContain("client_secret");
  });

  it("shows unknown revocation truthfully without offering another grant", async () => {
    mocks.read.mockResolvedValueOnce({
      state: "disconnected",
      accountLabel: null,
      revocationPending: true,
    });
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({}),
      })
    );
    expect(html).toContain("provider revocation outcome is unconfirmed");
    expect(html).toContain("deployment operator");
    expect(html).not.toContain("Continue to Google");
    expect(html).not.toContain('action="/api/connections/google/start"');
  });
});
