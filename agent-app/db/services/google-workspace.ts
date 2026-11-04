import { createHash, randomBytes } from "node:crypto";
import { auth } from "@googleapis/gmail";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  googleWorkspaceConnections,
  googleWorkspaceOAuthStates,
} from "@db";
import {
  googleActionApprovals,
  googleActionDispatches,
} from "@db/schema/google-actions";
import {
  encryptWorkspaceValue,
  decryptWorkspaceValue,
} from "./protected-values";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import {
  googleWorkspaceCallbackPath,
  googleWorkspaceReviewUrl,
  googleWorkspaceScopes,
  googleWorkspaceWriteScopes,
  googleWorkspaceAccessSchema,
  googleWorkspaceCapabilities,
  googleWorkspaceGrantedCapabilities,
  googleWorkspaceScopesCover,
  reviewedGoogleWorkspaceScopes,
  hasGoogleWorkspaceGrant,
  type GoogleWorkspaceCapability,
} from "@shared/google-workspace/connection";

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const revokeEndpoint = "https://oauth2.googleapis.com/revoke";
const certificatesEndpoint = "https://www.googleapis.com/oauth2/v1/certs";
const opaqueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const verifierSchema = z.strictObject({
  verifier: opaqueSchema,
  nonce: opaqueSchema,
  access: googleWorkspaceAccessSchema,
});
const tokensSchema = z.strictObject({
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384),
});
const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.number().int().positive().max(86_400),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string().max(16_384).optional(),
  id_token: z.string().min(1).max(32_768).optional(),
});
const identitySchema = z.object({
  sub: z.string().min(1).max(255),
  aud: z.string(),
  iss: z.enum(["accounts.google.com", "https://accounts.google.com"]),
  nonce: opaqueSchema,
  exp: z.number(),
  azp: z.string().optional(),
  email: z.email().optional(),
  email_verified: z.boolean().optional(),
});

export class GoogleWorkspaceConnectionRequiredError extends Error {
  constructor(capability?: GoogleWorkspaceCapability) {
    super(
      `${capability ? `Review permission to ${googleWorkspaceCapabilities[capability].label.toLowerCase()}` : "Connect Google Workspace"} at ${applicationOrigin()}${googleWorkspaceReviewUrl} before continuing.`
    );
    this.name = "GoogleWorkspaceConnectionRequiredError";
  }
}

function ownedScope(scope: AccessScope) {
  if (
    !scope.userId.startsWith("better-auth:") ||
    accessScopeForUser(scope.userId).workspaceId !== scope.workspaceId
  ) {
    throw new Error("An authenticated workspace owner is required.");
  }
}

function googleWorkspaceConfigured() {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function callbackUrl() {
  const origin = new URL(applicationOrigin());
  if (
    origin.protocol !== "https:" &&
    !(
      env.NODE_ENV !== "production" &&
      origin.protocol === "http:" &&
      origin.hostname === "localhost"
    )
  ) {
    throw new Error("Google Workspace requires a secure application origin.");
  }
  return new URL(googleWorkspaceCallbackPath, origin).href;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function connectionOwner(scope: AccessScope) {
  return and(
    eq(googleWorkspaceConnections.workspaceId, scope.workspaceId),
    eq(googleWorkspaceConnections.userId, scope.userId)
  );
}

async function retireGoogleActions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scope: AccessScope
) {
  await tx
    .update(googleActionApprovals)
    .set({ state: "revoked", encryptedInput: null })
    .where(eq(googleActionApprovals.workspaceId, scope.workspaceId));
  await tx
    .update(googleActionDispatches)
    .set({
      encryptedResult: null,
      state: sql`CASE WHEN ${googleActionDispatches.state} = 'started' THEN 'unknown' ELSE ${googleActionDispatches.state} END`,
    })
    .where(eq(googleActionDispatches.workspaceId, scope.workspaceId));
}

function storedTokens(value: string) {
  try {
    return tokensSchema.parse(JSON.parse(value));
  } catch {
    throw new Error(
      "Stored Google credentials are unavailable. Review the connection."
    );
  }
}

export async function readGoogleWorkspaceConnection(scope: AccessScope) {
  ownedScope(scope);
  if (!googleWorkspaceConfigured())
    return {
      state: "unavailable" as const,
      accountLabel: null,
      revocationPending: false,
      capabilities: [],
    };
  const [connection] = await db
    .select()
    .from(googleWorkspaceConnections)
    .where(connectionOwner(scope))
    .limit(1);
  return {
    accountLabel:
      connection?.status === "connected" ? connection.accountLabel : null,
    state:
      connection?.status === "connected"
        ? ("connected" as const)
        : ("disconnected" as const),
    revocationPending: connection?.revocationPending ?? false,
    capabilities:
      connection?.status === "connected"
        ? googleWorkspaceGrantedCapabilities(connection.grantedScopes)
        : [],
  };
}

export async function beginGoogleWorkspaceOAuth(
  scope: AccessScope,
  sessionId: string,
  access: z.infer<typeof googleWorkspaceAccessSchema> = "read"
) {
  ownedScope(scope);
  if (!googleWorkspaceConfigured())
    throw new GoogleWorkspaceConnectionRequiredError();
  const redirectUri = callbackUrl();
  access = googleWorkspaceAccessSchema.parse(access);
  const session = z.string().min(1).max(1024).parse(sessionId);
  const state = randomBytes(32).toString("base64url");
  const browserToken = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const encryptedVerifier = await encryptWorkspaceValue(
    scope,
    "google-oauth-state",
    JSON.stringify({ verifier, nonce, access })
  );
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.transaction(async (tx) => {
    await tx
      .insert(googleWorkspaceConnections)
      .values({
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        status: "disconnected",
      })
      .onConflictDoNothing();
    const [current] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(connectionOwner(scope))
      .for("update");
    if (!current || current.revocationPending)
      throw new Error(
        "Google revocation must be reconciled before reconnecting."
      );
    const version = current.version + 1;
    await retireGoogleActions(tx, scope);
    await tx
      .update(googleWorkspaceConnections)
      .set({
        status: "pending",
        version,
        encryptedTokens: null,
        accessExpiresAt: null,
        accountSubject: null,
        accountLabel: null,
        grantedScopes: null,
        updatedAt: new Date(),
      })
      .where(connectionOwner(scope));
    await tx
      .delete(googleWorkspaceOAuthStates)
      .where(eq(googleWorkspaceOAuthStates.workspaceId, scope.workspaceId));
    await tx.insert(googleWorkspaceOAuthStates).values({
      id: digest(state),
      browserHash: digest(browserToken),
      sessionHash: digest(session),
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      connectionVersion: version,
      encryptedVerifier,
      expiresAt,
    });
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: (access === "write"
      ? googleWorkspaceWriteScopes
      : googleWorkspaceScopes
    ).join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    state,
    nonce,
    code_challenge: digestBase64(verifier),
    code_challenge_method: "S256",
    include_granted_scopes: "false",
  }).toString();
  return { authorizationUrl: url.href, browserToken, expiresAt };
}

function digestBase64(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

async function providerResponse(
  url:
    | typeof tokenEndpoint
    | typeof revokeEndpoint
    | typeof certificatesEndpoint,
  body?: URLSearchParams,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    const response = await fetch(url, {
      body,
      method: body ? "POST" : "GET",
      headers: body
        ? { "content-type": "application/x-www-form-urlencoded" }
        : undefined,
      redirect: "manual",
      signal: requestSignal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("Google Workspace request failed.");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      if (url === revokeEndpoint) return "";
      throw new Error("Google Workspace returned no response.");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      /* oxlint-disable eslint/no-await-in-loop -- Provider responses are streamed under one strict byte bound. */
      for (;;) {
        requestSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 128 * 1024) {
          await reader.cancel();
          throw new Error("Google Workspace response is too large.");
        }
        chunks.push(value);
      }
      /* oxlint-enable eslint/no-await-in-loop */
    } finally {
      reader.releaseLock();
    }
    requestSignal.throwIfAborted();
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Google Workspace request failed. Review the connection before retrying."
    );
  }
}

export async function completeGoogleWorkspaceOAuth(
  scope: AccessScope,
  input: {
    sessionId: string;
    browserToken: string;
    state: string;
    code: string;
  }
) {
  ownedScope(scope);
  const state = opaqueSchema.parse(input.state);
  const browser = opaqueSchema.parse(input.browserToken);
  const code = z.string().min(1).max(4096).parse(input.code);
  const [pending] = await db
    .delete(googleWorkspaceOAuthStates)
    .where(
      and(
        eq(googleWorkspaceOAuthStates.id, digest(state)),
        eq(googleWorkspaceOAuthStates.browserHash, digest(browser)),
        eq(googleWorkspaceOAuthStates.sessionHash, digest(input.sessionId)),
        eq(googleWorkspaceOAuthStates.workspaceId, scope.workspaceId),
        eq(googleWorkspaceOAuthStates.userId, scope.userId),
        gt(googleWorkspaceOAuthStates.expiresAt, sql`now()`)
      )
    )
    .returning();
  if (!pending)
    throw new Error(
      "Google authorization expired or belongs to another session."
    );
  const [current] = await db
    .select()
    .from(googleWorkspaceConnections)
    .where(
      and(
        connectionOwner(scope),
        eq(googleWorkspaceConnections.version, pending.connectionVersion),
        eq(googleWorkspaceConnections.status, "pending")
      )
    )
    .limit(1);
  if (!current || current.revocationPending)
    throw new Error(
      "Google connection changed. Start again from its review page."
    );
  const verifier = verifierSchema.parse(
    JSON.parse(
      await decryptWorkspaceValue(
        scope,
        "google-oauth-state",
        pending.encryptedVerifier
      )
    )
  );
  const tokenBody = await providerResponse(
    tokenEndpoint,
    new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      code,
      code_verifier: verifier.verifier,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(),
    })
  );
  const tokens = tokenResponseSchema.parse(JSON.parse(tokenBody));
  const effectiveScopes = reviewedGoogleWorkspaceScopes(
    tokens.scope,
    verifier.access
  ).join(" ");
  if (
    !tokens.id_token ||
    !tokens.refresh_token ||
    !hasGoogleWorkspaceGrant(effectiveScopes)
  )
    throw new Error(
      "Google did not grant a reviewed service and offline access."
    );
  const certificates = z
    .record(z.string(), z.string())
    .parse(JSON.parse(await providerResponse(certificatesEndpoint)));
  const ticket = await new auth.OAuth2().verifySignedJwtWithCertsAsync(
    tokens.id_token,
    certificates,
    env.GOOGLE_CLIENT_ID,
    ["https://accounts.google.com", "accounts.google.com"]
  );
  const identity = identitySchema.parse(ticket.getPayload());
  if (
    identity.nonce !== verifier.nonce ||
    identity.aud !== env.GOOGLE_CLIENT_ID ||
    (identity.azp !== undefined && identity.azp !== env.GOOGLE_CLIENT_ID) ||
    identity.exp <= Date.now() / 1000
  )
    throw new Error("Google account verification failed.");
  const encryptedTokens = await encryptWorkspaceValue(
    scope,
    "google-workspace-tokens",
    JSON.stringify({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    })
  );
  const rows = await db
    .update(googleWorkspaceConnections)
    .set({
      status: "connected",
      accountSubject: identity.sub,
      accountLabel: identity.email_verified
        ? (identity.email ?? "Google account")
        : "Google account",
      encryptedTokens,
      accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      grantedScopes: effectiveScopes,
      updatedAt: new Date(),
    })
    .where(
      and(
        connectionOwner(scope),
        eq(googleWorkspaceConnections.version, pending.connectionVersion),
        eq(googleWorkspaceConnections.status, "pending"),
        eq(googleWorkspaceConnections.revocationPending, false)
      )
    )
    .returning({ version: googleWorkspaceConnections.version });
  if (rows.length !== 1)
    throw new Error(
      "Google connection changed before authorization completed."
    );
}

export async function assertGoogleWorkspaceVersion(
  scope: AccessScope,
  version: number,
  capability: GoogleWorkspaceCapability
) {
  ownedScope(scope);
  if (!googleWorkspaceConfigured())
    throw new GoogleWorkspaceConnectionRequiredError();
  const [row] = await db
    .select({
      version: googleWorkspaceConnections.version,
      grantedScopes: googleWorkspaceConnections.grantedScopes,
    })
    .from(googleWorkspaceConnections)
    .where(
      and(
        connectionOwner(scope),
        eq(googleWorkspaceConnections.version, version),
        eq(googleWorkspaceConnections.status, "connected"),
        eq(googleWorkspaceConnections.revocationPending, false)
      )
    )
    .limit(1);
  if (
    !row ||
    !hasGoogleWorkspaceGrant(row.grantedScopes) ||
    !googleWorkspaceGrantedCapabilities(row.grantedScopes).includes(capability)
  )
    throw new GoogleWorkspaceConnectionRequiredError(capability);
}

export async function readGoogleWorkspaceGrantVersion(
  scope: AccessScope,
  capability: GoogleWorkspaceCapability
) {
  ownedScope(scope);
  if (!googleWorkspaceConfigured())
    throw new GoogleWorkspaceConnectionRequiredError();
  const [row] = await db
    .select()
    .from(googleWorkspaceConnections)
    .where(
      and(
        connectionOwner(scope),
        eq(googleWorkspaceConnections.status, "connected"),
        eq(googleWorkspaceConnections.revocationPending, false)
      )
    )
    .limit(1);
  if (
    !row?.encryptedTokens ||
    !hasGoogleWorkspaceGrant(row.grantedScopes) ||
    !googleWorkspaceGrantedCapabilities(row.grantedScopes).includes(capability)
  )
    throw new GoogleWorkspaceConnectionRequiredError(capability);
  return row.version;
}

export async function getGoogleWorkspaceAccessToken(
  scope: AccessScope,
  capability: GoogleWorkspaceCapability,
  signal?: AbortSignal
) {
  ownedScope(scope);
  if (!googleWorkspaceConfigured())
    throw new GoogleWorkspaceConnectionRequiredError();
  signal?.throwIfAborted();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(connectionOwner(scope))
      .for("update");
    if (
      row?.status !== "connected" ||
      row.revocationPending ||
      !row.encryptedTokens ||
      !hasGoogleWorkspaceGrant(row.grantedScopes)
    )
      return null;
    if (
      !googleWorkspaceGrantedCapabilities(row.grantedScopes).includes(
        capability
      )
    )
      throw new GoogleWorkspaceConnectionRequiredError(capability);
    const tokens = storedTokens(
      await decryptWorkspaceValue(
        scope,
        "google-workspace-tokens",
        row.encryptedTokens
      )
    );
    signal?.throwIfAborted();
    if (
      row.accessExpiresAt &&
      row.accessExpiresAt.getTime() > Date.now() + 60_000
    )
      return { token: tokens.accessToken, version: row.version };
    try {
      const response = tokenResponseSchema.parse(
        JSON.parse(
          await providerResponse(
            tokenEndpoint,
            new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID ?? "",
              client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
              grant_type: "refresh_token",
              refresh_token: tokens.refreshToken,
            }),
            signal
          )
        )
      );
      if (
        response.scope &&
        !googleWorkspaceScopesCover(
          response.scope,
          (row.grantedScopes ?? "").split(/\s+/u)
        )
      )
        throw new Error("Google permissions changed.");
      const encryptedTokens = await encryptWorkspaceValue(
        scope,
        "google-workspace-tokens",
        JSON.stringify({
          accessToken: response.access_token,
          refreshToken: response.refresh_token ?? tokens.refreshToken,
        })
      );
      signal?.throwIfAborted();
      await tx
        .update(googleWorkspaceConnections)
        .set({
          encryptedTokens,
          accessExpiresAt: new Date(Date.now() + response.expires_in * 1000),
          updatedAt: new Date(),
        })
        .where(
          and(
            connectionOwner(scope),
            eq(googleWorkspaceConnections.version, row.version),
            eq(googleWorkspaceConnections.status, "connected")
          )
        );
      return { token: response.access_token, version: row.version };
    } catch {
      await retireGoogleActions(tx, scope);
      await tx
        .update(googleWorkspaceConnections)
        .set({
          status: "disconnected",
          version: row.version + 1,
          encryptedTokens: null,
          accessExpiresAt: null,
          accountSubject: null,
          accountLabel: null,
          grantedScopes: null,
          updatedAt: new Date(),
        })
        .where(connectionOwner(scope));
      return null;
    }
  });
  signal?.throwIfAborted();
  if (!result) throw new GoogleWorkspaceConnectionRequiredError();
  return result;
}

export async function invalidateGoogleWorkspaceConnection(
  scope: AccessScope,
  version: number
) {
  ownedScope(scope);
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(
        and(
          connectionOwner(scope),
          eq(googleWorkspaceConnections.version, version)
        )
      )
      .for("update");
    if (!current) return;
    await retireGoogleActions(tx, scope);
    await tx
      .update(googleWorkspaceConnections)
      .set({
        status: "disconnected",
        version: version + 1,
        encryptedTokens: null,
        accessExpiresAt: null,
        accountSubject: null,
        accountLabel: null,
        grantedScopes: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          connectionOwner(scope),
          eq(googleWorkspaceConnections.version, version)
        )
      );
  });
}

export async function disconnectGoogleWorkspace(scope: AccessScope) {
  ownedScope(scope);
  const revocation = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(connectionOwner(scope))
      .for("update");
    if (!row || row.revocationPending) return null;
    let token: string | undefined;
    if (row.encryptedTokens) {
      try {
        token = storedTokens(
          await decryptWorkspaceValue(
            scope,
            "google-workspace-tokens",
            row.encryptedTokens
          )
        ).refreshToken;
      } catch {
        /* Local removal must work even when stored credentials are corrupt. */
      }
    }
    const version = row.version + 1;
    await retireGoogleActions(tx, scope);
    await tx
      .update(googleWorkspaceConnections)
      .set({
        status: "disconnected",
        version,
        encryptedTokens: null,
        accountSubject: null,
        accountLabel: null,
        grantedScopes: null,
        accessExpiresAt: null,
        revocationPending: Boolean(token),
        updatedAt: new Date(),
      })
      .where(connectionOwner(scope));
    await tx
      .delete(googleWorkspaceOAuthStates)
      .where(eq(googleWorkspaceOAuthStates.workspaceId, scope.workspaceId));
    return token ? { token, version } : null;
  });
  if (!revocation) return;
  try {
    await providerResponse(
      revokeEndpoint,
      new URLSearchParams({ token: revocation.token })
    );
    await db
      .update(googleWorkspaceConnections)
      .set({ revocationPending: false })
      .where(
        and(
          connectionOwner(scope),
          eq(googleWorkspaceConnections.version, revocation.version),
          eq(googleWorkspaceConnections.status, "disconnected")
        )
      );
  } catch {
    /* Keep the fence on unknown provider outcomes; never automatically resend revocation. */
  }
}
