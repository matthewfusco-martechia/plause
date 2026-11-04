/* oxlint-disable eslint/no-await-in-loop -- Apply the actual Google table migrations in schema order. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import type * as Environment from "@shared/environment";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  googleWorkspaceScopes,
  googleWorkspaceWriteScopes,
  googleWorkspaceCapabilities,
} from "@shared/google-workspace/connection";
import { decryptWorkspaceValue } from "@db/services/protected-values";
import * as service from "@db/services/google-workspace";

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof Environment>();
  return {
    ...original,
    env: {
      ...original.env,
      GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "fixture-client-secret",
    },
  };
});

const database = new PGlite();
await database.waitReady;
const alice = accessScopeForUser("better-auth:alice");
const bob = accessScopeForUser("better-auth:bob");
const sessionId = "fictional-browser-session";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
let authorization: URL;
let tokenScopes = googleWorkspaceScopes.join(" ");
let nonceOverride: string | undefined;
let audienceOverride: string | undefined;

beforeAll(async () => {
  const migration = await readFile(
    "db/migrations/0015_direct_providers.sql",
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.includes('CREATE TABLE "google_workspace_'))
      await database.exec(statement);
  }
  await database.exec(
    (
      await readFile("db/migrations/0016_google_action_authority.sql", "utf8")
    ).replaceAll("--> statement-breakpoint", "")
  );
  const fixture = drizzle(database, { schema });
  // SAFETY: The fixture retains the exact production schema/query-builder contract and replaces only the Postgres driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite supplies the exercised Drizzle transaction surface.
  vi.spyOn(Database, "db", "get").mockReturnValue(fixture as never);
});

beforeEach(async () => {
  await database.exec(
    "DELETE FROM google_action_dispatches; DELETE FROM google_action_approvals; DELETE FROM google_workspace_oauth_states; DELETE FROM google_workspace_connections"
  );
  tokenScopes = googleWorkspaceScopes.join(" ");
  nonceOverride = undefined;
  audienceOverride = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(providerFetch);
});

afterEach(() => {
  vi.mocked(globalThis.fetch).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await database.close();
});

async function providerFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
) {
  const url =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  expect(init?.redirect).toBe("manual");
  if (url === "https://oauth2.googleapis.com/token") return tokenResponse();
  if (url === "https://www.googleapis.com/oauth2/v1/certs")
    return Response.json({ "fixture-key": publicKey });
  if (url === "https://oauth2.googleapis.com/revoke")
    return new Response("", { status: 200 });
  throw new Error("Unexpected provider request.");
}

function tokenResponse() {
  const payload = {
    iss: "https://accounts.google.com",
    aud: audienceOverride ?? "fixture.apps.googleusercontent.com",
    sub: "fixture-google-subject",
    nonce: nonceOverride ?? authorization.searchParams.get("nonce"),
    email: "fictional@example.com",
    email_verified: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "fixture-key" })
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${body}`),
    keys.privateKey
  ).toString("base64url");
  return Response.json({
    access_token: "fixture-access-token",
    refresh_token: "fixture-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: tokenScopes,
    id_token: `${header}.${body}.${signature}`,
  });
}

async function start(access: "read" | "write" = "read") {
  const result = await service.beginGoogleWorkspaceOAuth(
    alice,
    sessionId,
    access
  );
  authorization = new URL(result.authorizationUrl);
  return {
    ...result,
    input: {
      browserToken: result.browserToken,
      sessionId,
      state: authorization.searchParams.get("state") ?? "",
      code: "fictional-code",
    },
  };
}

async function connected() {
  const result = await start();
  await service.completeGoogleWorkspaceOAuth(alice, result.input);
  return result;
}

describe("direct Google Workspace authorization", () => {
  it("accepts a Calendar-only grant and keeps declined services unavailable", async () => {
    tokenScopes = [
      "openid",
      "email",
      "profile",
      googleWorkspaceCapabilities["calendar.read"].scope,
    ].join(" ");
    await connected();
    expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
      state: "connected",
      capabilities: ["calendar.read"],
    });
    vi.mocked(globalThis.fetch).mockClear();
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "calendar.read")
    ).resolves.toMatchObject({ token: "fixture-access-token" });
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "gmail.read")
    ).rejects.toThrow("read gmail");
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "calendar.availability")
    ).rejects.toThrow("availability");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not grant writes when Google returns an older broader grant to a read-only review", async () => {
    tokenScopes = googleWorkspaceWriteScopes.join(" ");
    await connected();
    const state = await service.readGoogleWorkspaceConnection(alice);
    expect(state.capabilities).toContain("gmail.read");
    expect(state.capabilities).not.toContain("gmail.write");
    expect(state.capabilities).not.toContain("calendar.write");
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "gmail.write")
    ).rejects.toThrow("permission");
    await expect(
      service.readGoogleWorkspaceGrantVersion(alice, "calendar.write")
    ).rejects.toThrow("permission");
  });

  it("binds an explicit write review to encrypted OAuth state", async () => {
    const begun = await start("write");
    expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
      ...googleWorkspaceWriteScopes,
    ]);
    tokenScopes = googleWorkspaceWriteScopes.join(" ");
    await service.completeGoogleWorkspaceOAuth(alice, begun.input);
    expect(
      (await service.readGoogleWorkspaceConnection(alice)).capabilities
    ).toEqual(expect.arrayContaining(["gmail.write", "calendar.write"]));
    await expect(
      service.readGoogleWorkspaceGrantVersion(alice, "gmail.write")
    ).resolves.toBeGreaterThan(0);
  });

  it("never expands reviewed permissions when a refresh returns broader scopes", async () => {
    await connected();
    await Database.db
      .update(Database.googleWorkspaceConnections)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) });
    tokenScopes = googleWorkspaceWriteScopes.join(" ");
    await service.getGoogleWorkspaceAccessToken(alice, "gmail.read");
    expect(
      (await service.readGoogleWorkspaceConnection(alice)).capabilities
    ).not.toContain("gmail.write");
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "gmail.write")
    ).rejects.toThrow("permission");
  });

  it("fences the connection when refresh removes a previously available permission", async () => {
    await connected();
    const before = await service.getGoogleWorkspaceAccessToken(
      alice,
      "drive.read"
    );
    await Database.db
      .update(Database.googleWorkspaceConnections)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) });
    tokenScopes = [
      "openid",
      "email",
      "profile",
      googleWorkspaceCapabilities["calendar.read"].scope,
    ].join(" ");
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "drive.read")
    ).rejects.toThrow("/connections/google");
    await expect(
      service.assertGoogleWorkspaceVersion(alice, before.version, "drive.read")
    ).rejects.toThrow("/connections/google");
    expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
      state: "disconnected",
      capabilities: [],
    });
  });

  it("stores only hashed browser/state/session bindings and an encrypted PKCE verifier", async () => {
    const result = await start();
    expect(authorization.origin + authorization.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://example.com/api/connections/google/callback"
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256"
    );
    expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
      ...googleWorkspaceScopes,
    ]);
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    const [state] = await Database.db
      .select()
      .from(Database.googleWorkspaceOAuthStates);
    if (!state) throw new Error("Expected pending state.");
    expect(state.id).toBe(
      createHash("sha256").update(result.input.state).digest("hex")
    );
    expect(state.browserHash).not.toBe(result.browserToken);
    expect(state.sessionHash).not.toBe(sessionId);
    expect(state.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    const verifier = z
      .object({ verifier: z.string(), nonce: z.string() })
      .parse(
        JSON.parse(
          await decryptWorkspaceValue(
            alice,
            "google-oauth-state",
            state.encryptedVerifier
          )
        )
      );
    expect(authorization.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier.verifier).digest("base64url")
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("verifies a signed synthetic identity and scopes without merging phone accounts", async () => {
    await connected();
    expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
      state: "connected",
      accountLabel: "fictional@example.com",
    });
    expect(await service.readGoogleWorkspaceConnection(bob)).toMatchObject({
      state: "disconnected",
      accountLabel: null,
    });
    const [row] = await Database.db
      .select()
      .from(Database.googleWorkspaceConnections);
    expect(row?.encryptedTokens).not.toContain("fixture-access-token");
    expect(row?.encryptedTokens).not.toContain("fixture-refresh-token");
    expect(row?.accountSubject).toBe("fixture-google-subject");
    expect(
      await service.readGoogleWorkspaceGrantVersion(alice, "gmail.read")
    ).toBe(row?.version);
    expect(
      await service.getGoogleWorkspaceAccessToken(alice, "gmail.read")
    ).toEqual({
      token: "fixture-access-token",
      version: row?.version,
    });
    await expect(
      service.getGoogleWorkspaceAccessToken(bob, "gmail.read")
    ).rejects.toThrow("/connections/google");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects wrong user, browser and session before exchanging a code, then consumes exactly once", async () => {
    const result = await start();
    await expect(
      service.completeGoogleWorkspaceOAuth(bob, result.input)
    ).rejects.toThrow("another session");
    await expect(
      service.completeGoogleWorkspaceOAuth(alice, {
        ...result.input,
        sessionId: "different-session",
      })
    ).rejects.toThrow("another session");
    await expect(
      service.completeGoogleWorkspaceOAuth(alice, {
        ...result.input,
        browserToken: "b".repeat(43),
      })
    ).rejects.toThrow("another session");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await service.completeGoogleWorkspaceOAuth(alice, result.input);
    await expect(
      service.completeGoogleWorkspaceOAuth(alice, result.input)
    ).rejects.toThrow("expired");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("expires state before any provider call", async () => {
    const result = await start();
    await Database.db
      .update(Database.googleWorkspaceOAuthStates)
      .set({ expiresAt: new Date(Date.now() - 1_000) });
    await expect(
      service.completeGoogleWorkspaceOAuth(alice, result.input)
    ).rejects.toThrow("expired");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["nonce", "audience", "scope"])(
    "rejects an unreviewed %s grant",
    async (failure) => {
      const result = await start();
      if (failure === "nonce") nonceOverride = "x".repeat(43);
      if (failure === "audience")
        audienceOverride = "another.apps.googleusercontent.com";
      if (failure === "scope") tokenScopes = "openid email profile";
      await expect(
        service.completeGoogleWorkspaceOAuth(alice, result.input)
      ).rejects.toThrow(/verification|audience|grant/u);
      expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
        state: "disconnected",
      });
      const [row] = await Database.db
        .select()
        .from(Database.googleWorkspaceConnections);
      expect(row?.encryptedTokens).toBeNull();
    }
  );

  it("does not resurrect a callback that finishes after local disconnect", async () => {
    const result = await start();
    const held = Promise.withResolvers<Response>();
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => held.promise);
    const completing = service.completeGoogleWorkspaceOAuth(
      alice,
      result.input
    );
    const rejected = completing.then(
      () => false,
      () => true
    );
    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    await service.disconnectGoogleWorkspace(alice);
    held.resolve(tokenResponse());
    expect(await rejected).toBe(true);
    expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
      state: "disconnected",
    });
  });

  it("serializes refreshes so two expired-token callers dispatch one refresh", async () => {
    await connected();
    await Database.db
      .update(Database.googleWorkspaceConnections)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) });
    vi.mocked(globalThis.fetch).mockClear();
    const tokens = await Promise.all([
      service.getGoogleWorkspaceAccessToken(alice, "gmail.read"),
      service.getGoogleWorkspaceAccessToken(alice, "gmail.read"),
    ]);
    expect(tokens[0]).toEqual(tokens[1]);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(
      z.instanceof(URLSearchParams).parse(request?.body).get("grant_type")
    ).toBe("refresh_token");
  });

  it("removes a failed refresh locally and never retries it automatically", async () => {
    await connected();
    await Database.db
      .update(Database.googleWorkspaceConnections)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) });
    vi.mocked(globalThis.fetch)
      .mockClear()
      .mockResolvedValueOnce(
        Response.json({ error: "invalid_grant" }, { status: 400 })
      );
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "gmail.read")
    ).rejects.toThrow("/connections/google");
    await expect(
      service.getGoogleWorkspaceAccessToken(alice, "gmail.read")
    ).rejects.toThrow("/connections/google");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
      state: "disconnected",
    });
  });

  it("removes local access before revoke, keeps an unknown-outcome fence and refuses reconnect", async () => {
    await connected();
    const before = await service.getGoogleWorkspaceAccessToken(
      alice,
      "gmail.read"
    );
    vi.mocked(globalThis.fetch)
      .mockClear()
      .mockImplementationOnce(async () => {
        expect(
          await service.readGoogleWorkspaceConnection(alice)
        ).toMatchObject({ state: "disconnected", revocationPending: true });
        throw new Error("Provider connection lost");
      });
    await service.disconnectGoogleWorkspace(alice);
    await expect(
      service.assertGoogleWorkspaceVersion(alice, before.version, "gmail.read")
    ).rejects.toThrow("/connections/google");
    await expect(
      service.beginGoogleWorkspaceOAuth(alice, sessionId)
    ).rejects.toThrow("reconciled");
    await service.disconnectGoogleWorkspace(alice);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
      state: "disconnected",
      revocationPending: true,
    });
  });

  it("clears the fence only after confirmed revoke and permits a new explicit connection", async () => {
    await connected();
    await service.disconnectGoogleWorkspace(alice);
    expect(await service.readGoogleWorkspaceConnection(alice)).toMatchObject({
      state: "disconnected",
      revocationPending: false,
    });
    await start();
    expect(
      await Database.db.select().from(Database.googleWorkspaceOAuthStates)
    ).toHaveLength(1);
  });

  it("rejects a forged workspace binding without reaching Google", async () => {
    await expect(
      service.beginGoogleWorkspaceOAuth(
        { ...alice, workspaceId: bob.workspaceId },
        sessionId
      )
    ).rejects.toThrow("workspace owner");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects redirects without following their location or sending secrets to it", async () => {
    const result = await start();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/collect" },
      })
    );
    await expect(
      service.completeGoogleWorkspaceOAuth(alice, result.input)
    ).rejects.toThrow("request failed");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(
      z.string().parse(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])
    ).toBe("https://oauth2.googleapis.com/token");
  });
});
