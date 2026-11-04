import { createHash } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@db";
import {
  googleActionApprovals,
  googleActionDispatches,
} from "@db/schema/google-actions";
import { googleWorkspaceConnections } from "@db/schema/google-workspace";
import {
  googleWorkspaceGrantedCapabilities,
  hasGoogleWorkspaceGrant,
} from "@shared/google-workspace/connection";
import { assertEnrolledWorkspaceUser } from "./auth/phone-user";
import {
  lockRootActionClaims,
  hasUnresolvedRootAction,
} from "./root-action-claims";
import {
  decryptWorkspaceValue,
  encryptWorkspaceValue,
} from "./protected-values";

const jsonSchema = z.json();
const bindingSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(300),
  rootSessionId: z.string().min(1).max(300),
  callId: z.string().min(1).max(300),
  toolName: z.enum(["gmail-send", "gmail-update", "calendar-create-event"]),
  principalHash: z.string().regex(/^[a-f0-9]{64}$/u),
  input: jsonSchema,
});

export type GoogleActionBinding = z.infer<typeof bindingSchema>;

export class GoogleActionApprovalError extends Error {
  constructor() {
    super(
      "This exact Google action needs a current approval from the workspace owner. Review the connection and exact action before continuing."
    );
    this.name = "GoogleActionApprovalError";
  }
}

export class GoogleActionUnknownError extends Error {
  constructor() {
    super(
      "A Google write in this conversation has an unconfirmed outcome. It will not be retried automatically. Check Gmail or Calendar and ask an operator to reconcile the action before another write."
    );
    this.name = "GoogleActionUnknownError";
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: z.infer<typeof jsonSchema>, depth = 0): string {
  if (depth > 20) throw new GoogleActionApprovalError();
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (value !== null && value instanceof Object) {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function details(value: GoogleActionBinding) {
  const binding = bindingSchema.parse(value);
  const input = canonical(binding.input);
  // The complete payload must fit the approval prompt. Never approve an excerpt.
  if (input.length > 3_000) throw new GoogleActionApprovalError();
  return {
    ...binding,
    input,
    inputHash: digest(input),
    id: digest(
      JSON.stringify([
        "google-action-v1",
        binding.workspaceId,
        binding.userId,
        binding.sessionId,
        binding.callId,
        binding.toolName,
      ])
    ),
  };
}

function owner(binding: GoogleActionBinding) {
  return and(
    eq(googleWorkspaceConnections.workspaceId, binding.workspaceId),
    eq(googleWorkspaceConnections.userId, binding.userId)
  );
}

function matchingApproval(
  binding: ReturnType<typeof details>,
  grantVersion: number
) {
  return and(
    eq(googleActionApprovals.id, binding.id),
    eq(googleActionApprovals.workspaceId, binding.workspaceId),
    eq(googleActionApprovals.userId, binding.userId),
    eq(googleActionApprovals.sessionId, binding.sessionId),
    eq(googleActionApprovals.rootSessionId, binding.rootSessionId),
    eq(googleActionApprovals.callId, binding.callId),
    eq(googleActionApprovals.toolName, binding.toolName),
    eq(googleActionApprovals.inputHash, binding.inputHash),
    eq(googleActionApprovals.principalHash, binding.principalHash),
    eq(googleActionApprovals.grantVersion, grantVersion)
  );
}

export async function requestGoogleActionApproval(
  value: GoogleActionBinding,
  grantVersion: number
) {
  const binding = details(value);
  await assertEnrolledWorkspaceUser(binding);
  const encryptedInput = await encryptWorkspaceValue(
    binding,
    `google-action-input:${binding.id}`,
    binding.input
  );
  return db.transaction(async (tx) => {
    await lockRootActionClaims(tx, binding);
    const [connection] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(owner(binding))
      .for("update");
    if (
      connection?.status !== "connected" ||
      connection.revocationPending ||
      connection.version !== grantVersion ||
      !hasGoogleWorkspaceGrant(connection.grantedScopes) ||
      !googleWorkspaceGrantedCapabilities(connection.grantedScopes).includes(
        googleActionCapability(binding.toolName)
      )
    )
      throw new GoogleActionApprovalError();
    if (await hasUnresolvedRootAction(tx, binding))
      throw new GoogleActionUnknownError();
    await tx
      .insert(googleActionApprovals)
      .values({
        ...binding,
        encryptedInput,
        grantVersion,
        state: "pending",
        expiresAt: sql`now() + interval '5 minutes'`,
      })
      .onConflictDoNothing();
    const [approval] = await tx
      .select()
      .from(googleActionApprovals)
      .where(
        and(
          matchingApproval(binding, grantVersion),
          inArray(googleActionApprovals.state, ["pending", "approved"]),
          gt(googleActionApprovals.expiresAt, sql`clock_timestamp()`)
        )
      )
      .limit(1);
    if (!approval) throw new GoogleActionApprovalError();
  });
}

export async function respondGoogleActionApproval(
  value: GoogleActionBinding,
  grantVersion: number,
  interactionId: string,
  decision: "approve" | "deny"
) {
  const binding = details(value);
  await assertEnrolledWorkspaceUser(binding);
  const interaction = z.string().min(1).max(300).parse(interactionId);
  return db.transaction(async (tx) => {
    await lockRootActionClaims(tx, binding);
    const [connection] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(owner(binding))
      .for("update");
    if (
      connection?.status !== "connected" ||
      connection.revocationPending ||
      connection.version !== grantVersion ||
      !hasGoogleWorkspaceGrant(connection.grantedScopes) ||
      !googleWorkspaceGrantedCapabilities(connection.grantedScopes).includes(
        googleActionCapability(binding.toolName)
      )
    )
      throw new GoogleActionApprovalError();
    const [approval] = await tx
      .select()
      .from(googleActionApprovals)
      .where(
        and(
          matchingApproval(binding, grantVersion),
          gt(googleActionApprovals.expiresAt, sql`clock_timestamp()`)
        )
      )
      .for("update");
    const state = decision === "approve" ? "approved" : "denied";
    if (
      !approval ||
      (approval.state !== "pending" &&
        !(approval.state === state && approval.interactionId === interaction))
    )
      throw new GoogleActionApprovalError();
    await tx
      .update(googleActionApprovals)
      .set({ state, interactionId: interaction })
      .where(eq(googleActionApprovals.id, binding.id));
  });
}

export async function readGoogleActionGrant(value: GoogleActionBinding) {
  const binding = details(value);
  await assertEnrolledWorkspaceUser(binding);
  const [approval] = await db
    .select()
    .from(googleActionApprovals)
    .where(
      and(
        eq(googleActionApprovals.id, binding.id),
        eq(googleActionApprovals.state, "approved")
      )
    )
    .limit(1);
  if (!approval?.interactionId) throw new GoogleActionApprovalError();
  const [matched] = await db
    .select()
    .from(googleActionApprovals)
    .where(matchingApproval(binding, approval.grantVersion))
    .limit(1);
  if (!matched) throw new GoogleActionApprovalError();
  await assertCurrentGrant(binding, approval.grantVersion);
  return approval.grantVersion;
}

export async function executeGoogleAction<T>(
  value: GoogleActionBinding,
  grantVersion: number,
  resultSchema: z.ZodType<T>,
  execute: () => Promise<T>
) {
  const binding = details(value);
  await assertEnrolledWorkspaceUser(binding);
  const claim = await db.transaction(async (tx) => {
    await lockRootActionClaims(tx, binding);
    const [connection] = await tx
      .select()
      .from(googleWorkspaceConnections)
      .where(owner(binding))
      .for("update");
    if (
      connection?.status !== "connected" ||
      connection.revocationPending ||
      connection.version !== grantVersion ||
      !hasGoogleWorkspaceGrant(connection.grantedScopes) ||
      !googleWorkspaceGrantedCapabilities(connection.grantedScopes).includes(
        googleActionCapability(binding.toolName)
      )
    )
      throw new GoogleActionApprovalError();
    const [approval] = await tx
      .select()
      .from(googleActionApprovals)
      .where(
        and(
          matchingApproval(binding, grantVersion),
          eq(googleActionApprovals.state, "approved")
        )
      )
      .for("update");
    if (!approval?.interactionId) throw new GoogleActionApprovalError();
    const [existing] = await tx
      .select()
      .from(googleActionDispatches)
      .where(eq(googleActionDispatches.approvalId, binding.id))
      .limit(1);
    if (existing?.state === "completed" && existing.encryptedResult)
      return { cached: existing.encryptedResult };
    if (existing) throw new GoogleActionUnknownError();
    const [unexpired] = await tx
      .select({ id: googleActionApprovals.id })
      .from(googleActionApprovals)
      .where(
        and(
          eq(googleActionApprovals.id, binding.id),
          gt(googleActionApprovals.expiresAt, sql`clock_timestamp()`)
        )
      )
      .limit(1);
    if (!unexpired) throw new GoogleActionApprovalError();
    if (await hasUnresolvedRootAction(tx, binding))
      throw new GoogleActionUnknownError();
    await tx.insert(googleActionDispatches).values({
      approvalId: binding.id,
      workspaceId: binding.workspaceId,
      userId: binding.userId,
      rootSessionId: binding.rootSessionId,
      grantVersion,
      state: "started",
    });
    return { cached: null };
  });
  if (claim.cached !== null) {
    let result: T;
    try {
      result = resultSchema.parse(
        JSON.parse(
          await decryptWorkspaceValue(
            binding,
            `google-action-result:${binding.id}`,
            claim.cached
          )
        )
      );
    } catch {
      throw new GoogleActionUnknownError();
    }
    await assertEnrolledWorkspaceUser(binding);
    await assertCurrentGrant(binding, grantVersion);
    return result;
  }
  try {
    // The durable receipt already exists. Recheck immediately before the one provider call.
    await assertEnrolledWorkspaceUser(binding);
    await assertCurrentGrant(binding, grantVersion);
    // Locks and account checks may wait. Use the current DB clock, not the
    // transaction-start clock, immediately before the single provider dispatch.
    const [freshApproval] = await db
      .select({ id: googleActionApprovals.id })
      .from(googleActionApprovals)
      .where(
        and(
          matchingApproval(binding, grantVersion),
          eq(googleActionApprovals.state, "approved"),
          gt(googleActionApprovals.expiresAt, sql`clock_timestamp()`)
        )
      )
      .limit(1);
    if (!freshApproval) throw new GoogleActionApprovalError();
    const result = resultSchema.parse(await execute());
    const serialized = JSON.stringify(result);
    if (serialized.length > 65_536) throw new GoogleActionUnknownError();
    const encryptedResult = await encryptWorkspaceValue(
      binding,
      `google-action-result:${binding.id}`,
      serialized
    );
    await db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(googleWorkspaceConnections)
        .where(owner(binding))
        .for("update");
      // Retain outcome metadata after disconnect, but never restore purged private output.
      const current =
        connection?.status === "connected" &&
        !connection.revocationPending &&
        connection.version === grantVersion &&
        hasGoogleWorkspaceGrant(connection.grantedScopes) &&
        googleWorkspaceGrantedCapabilities(connection.grantedScopes).includes(
          googleActionCapability(binding.toolName)
        );
      await tx
        .update(googleActionDispatches)
        .set({
          state: "completed",
          encryptedResult: current ? encryptedResult : null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(googleActionDispatches.approvalId, binding.id),
            eq(googleActionDispatches.state, "started")
          )
        );
    });
    await assertEnrolledWorkspaceUser(binding);
    await assertCurrentGrant(binding, grantVersion);
    return result;
  } catch {
    await db
      .update(googleActionDispatches)
      .set({ state: "unknown" })
      .where(
        and(
          eq(googleActionDispatches.approvalId, binding.id),
          eq(googleActionDispatches.state, "started")
        )
      );
    throw new GoogleActionUnknownError();
  }
}

async function assertCurrentGrant(
  binding: GoogleActionBinding,
  version: number
) {
  const [row] = await db
    .select({
      version: googleWorkspaceConnections.version,
      grantedScopes: googleWorkspaceConnections.grantedScopes,
    })
    .from(googleWorkspaceConnections)
    .where(
      and(
        owner(binding),
        eq(googleWorkspaceConnections.version, version),
        eq(googleWorkspaceConnections.status, "connected"),
        eq(googleWorkspaceConnections.revocationPending, false)
      )
    )
    .limit(1);
  if (
    !row ||
    !hasGoogleWorkspaceGrant(row.grantedScopes) ||
    !googleWorkspaceGrantedCapabilities(row.grantedScopes).includes(
      googleActionCapability(binding.toolName)
    )
  )
    throw new GoogleActionApprovalError();
}

export function googleActionCapability(
  toolName: GoogleActionBinding["toolName"]
) {
  return toolName === "gmail-send" || toolName === "gmail-update"
    ? "gmail.write"
    : "calendar.write";
}
