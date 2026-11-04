import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
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
import { ensureScope } from "@db/services/scope";
import * as jobs from "@db/services/scheduled-agent-jobs";
import { accessScopeForUser } from "@shared/identity/access-scope";

const client = new PGlite();
await client.waitReady;
const database = drizzle(client, { schema });
const scope = accessScopeForUser("better-auth:fixture-owner");
const fixtureNow = new Date();

beforeAll(async () => {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  await client.exec(
    (
      await Promise.all(
        names.map((name) => readFile(new URL(name, directory), "utf8"))
      )
    ).join("\n")
  );
});
beforeEach(async () => {
  await client.exec(
    'TRUNCATE TABLE scheduled_agent_jobs, workspaces, "user" CASCADE'
  );
  // SAFETY: Embedded Postgres exercises the actual complete migration chain and service queries.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the database driver changes.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  await database.insert(schema.user).values({
    id: "fixture-owner",
    name: "Fictional Owner",
    email: "fixture@example.invalid",
    phoneNumber: "+15550100011",
    phoneNumberVerified: true,
  });
  await ensureScope(scope);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => client.close());

describe("held scheduled Inkbox reports", () => {
  it("deduplicates a replayed creation and rejects a changed task or delivery permission under the same identity", async () => {
    const id = "00000000-0000-4000-8000-000000000099";
    const input = {
      id,
      conversationChannel: "linq" as const,
      conversationId: "linq:fixture",
      missedRunPolicy: "run_latest" as const,
      prompt: "A fictional reminder",
      timing: {
        kind: "once" as const,
        at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      notificationPolicy: {
        timezone: "UTC",
        quietHours: null,
        consentedBy: scope.userId,
        consentedAt: new Date().toISOString(),
      },
    };
    const first = await jobs.createScheduledAgentJob(scope, input);
    expect(
      (
        await jobs.createScheduledAgentJob(scope, {
          ...input,
          timing: { at: input.timing.at, kind: "once" },
        })
      ).id
    ).toBe(first.id);
    await expect(
      jobs.createScheduledAgentJob(scope, { ...input, prompt: "Changed task" })
    ).rejects.toThrow("identity conflicts");
    await expect(
      jobs.createScheduledAgentJob(scope, {
        ...input,
        notificationPolicy: {
          ...input.notificationPolicy,
          timezone: "America/New_York",
        },
      })
    ).rejects.toThrow("delivery consent");
    expect(
      await database.select().from(schema.scheduledAgentJobs)
    ).toHaveLength(1);
  });
  it("defers a result during quiet hours and rechecks the same policy immediately before delivery", async () => {
    const now = new Date(),
      report = await claimedReport(now),
      lease = report.run.reportLeaseToken;
    if (!lease) throw new Error("Missing fixture lease");
    const end = new Date(now.getTime() + 60 * 60_000);
    end.setUTCSeconds(0, 0);
    await database
      .update(schema.scheduledAgentJobs)
      .set({
        status: "completed",
        nextRunAt: null,
        notificationPolicy: {
          timezone: "UTC",
          quietHours: {
            start: now.toISOString().slice(11, 16),
            end: end.toISOString().slice(11, 16),
          },
          consentedBy: scope.userId,
          consentedAt: now.toISOString(),
        },
      })
      .where(eq(schema.scheduledAgentJobs.id, report.job.id));
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
    await jobs.releaseScheduledReport(report.run.id, lease, "quiet hours");
    expect(await jobs.claimScheduledReport(report.run.id, now)).toBeUndefined();
    expect(await jobs.listRecoverableScheduledReports(now)).toEqual([]);
    expect(await jobs.readNextScheduledWake(now)).toEqual(end);
    expect(await jobs.claimScheduledReport(report.run.id, end)).toMatchObject({
      run: { reportStatus: "queued" },
    });
  });

  it("fails closed for legacy jobs without recorded delivery consent", async () => {
    const report = await claimedReport(),
      lease = report.run.reportLeaseToken;
    if (!lease) throw new Error("Missing fixture lease");
    await database
      .update(schema.scheduledAgentJobs)
      .set({ notificationPolicy: null })
      .where(eq(schema.scheduledAgentJobs.id, report.job.id));
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
    await jobs.releaseScheduledReport(report.run.id, lease, "missing consent");
    expect(await jobs.claimScheduledReport(report.run.id)).toBeUndefined();
    expect(await jobs.readNextScheduledWake()).toBeNull();
  });

  it("invalidates old workers after pause and resume rather than resurrecting their previous revision", async () => {
    const report = await claimedReport(),
      lease = "00000000-0000-4000-8000-000000000001";
    await database
      .update(schema.scheduledAgentRuns)
      .set({
        status: "running",
        leaseToken: lease,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.scheduledAgentRuns.id, report.run.id));
    const { isScheduledAgentRunLeaseActive } =
      await import("@db/services/scheduled-agent-run-leases");
    expect(await isScheduledAgentRunLeaseActive(report.run.id, lease)).toBe(
      true
    );
    const conversation = {
      conversationChannel: "inkbox" as const,
      conversationId: report.job.conversationId,
    };
    await jobs.updateScheduledAgentJob(scope, conversation, report.job.id, {
      status: "paused",
    });
    expect(await isScheduledAgentRunLeaseActive(report.run.id, lease)).toBe(
      false
    );
    await jobs.updateScheduledAgentJob(scope, conversation, report.job.id, {
      status: "active",
    });
    expect(await isScheduledAgentRunLeaseActive(report.run.id, lease)).toBe(
      false
    );
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 60_000,
        limit: 25,
        now: new Date(),
      })
    ).toEqual([]);
  });

  it("expires an accepted worker once without retrying it and stops waking after its report is delivered", async () => {
    const now = new Date(),
      report = await claimedReport(now);
    await database
      .update(schema.scheduledAgentJobs)
      .set({ status: "completed", nextRunAt: null })
      .where(eq(schema.scheduledAgentJobs.id, report.job.id));
    await database
      .update(schema.scheduledAgentRuns)
      .set({
        status: "running",
        workerSessionId: "fictional-worker",
        leaseExpiresAt: new Date(now.getTime() - 1),
        reportStatus: "not_ready",
        reportSequence: 0,
      })
      .where(eq(schema.scheduledAgentRuns.id, report.run.id));
    expect(await jobs.expireScheduledAgentRuns(now)).toHaveLength(1);
    expect(await jobs.expireScheduledAgentRuns(now)).toEqual([]);
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 60_000,
        limit: 25,
        now,
      })
    ).toEqual([]);
    const claimed = await jobs.claimScheduledReport(report.run.id, now);
    if (!claimed?.run.reportLeaseToken)
      throw new Error("Missing timeout report");
    await jobs.finalizeScheduledReport(
      report.run.id,
      claimed.run.reportLeaseToken,
      "delivered"
    );
    expect(await jobs.readNextScheduledWake(now)).toBeNull();
  });
  it("rechecks exact lease, sequence, owner and current job state at dispatch", async () => {
    const report = await claimedReport();
    const lease = report.run.reportLeaseToken;
    if (!lease) throw new Error("Missing report lease");
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(true);
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 2)
    ).toBe(false);
    expect(
      await jobs.isScheduledReportDeliveryActive(
        scope,
        report.run.id,
        "90000000-0000-4000-8000-000000000001",
        1
      )
    ).toBe(false);
    expect(
      await jobs.isScheduledReportDeliveryActive(
        accessScopeForUser("better-auth:other-owner"),
        report.run.id,
        lease,
        1
      )
    ).toBe(false);
    await jobs.updateScheduledAgentJob(
      scope,
      {
        conversationChannel: "inkbox",
        conversationId: report.job.conversationId,
      },
      report.job.id,
      { status: "paused" }
    );
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
    await database
      .update(schema.scheduledAgentJobs)
      .set({ status: "completed", nextRunAt: null })
      .where(eq(schema.scheduledAgentJobs.id, report.job.id));
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false); // Changing status cannot resurrect a report from an older job revision.
    await jobs.updateScheduledAgentJob(
      scope,
      {
        conversationChannel: "inkbox",
        conversationId: report.job.conversationId,
      },
      report.job.id,
      { status: "deleted" }
    );
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
  });

  it("rejects expired or held report leases and revoked or erased account ownership", async () => {
    const report = await claimedReport();
    const lease = report.run.reportLeaseToken;
    if (!lease) throw new Error("Missing report lease");
    await database
      .update(schema.scheduledAgentRuns)
      .set({ reportLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.scheduledAgentRuns.id, report.run.id));
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
    await database
      .update(schema.scheduledAgentRuns)
      .set({ reportLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.scheduledAgentRuns.id, report.run.id));
    await database
      .update(schema.user)
      .set({ phoneNumberVerified: false })
      .where(eq(schema.user.id, "fixture-owner"));
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
    await database
      .update(schema.user)
      .set({ phoneNumberVerified: true })
      .where(eq(schema.user.id, "fixture-owner"));
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(true);
    await jobs.holdScheduledReport(report.run.id, lease, "provider unknown");
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
    await database
      .delete(schema.user)
      .where(eq(schema.user.id, "fixture-owner"));
    expect(
      await jobs.isScheduledReportDeliveryActive(scope, report.run.id, lease, 1)
    ).toBe(false);
  });
  it("retains uncertainty and its lease receipt without suppression, release, or automatic recovery", async () => {
    const report = await claimedReport();
    const lease = report.run.reportLeaseToken;
    if (!lease) throw new Error("Missing report lease");
    expect(
      await jobs.holdScheduledReport(
        report.run.id,
        "90000000-0000-4000-8000-000000000001",
        "wrong lease"
      )
    ).toBe(false);
    expect(
      await jobs.holdScheduledReport(
        report.run.id,
        lease,
        "provider outcome unknown"
      )
    ).toBe(true);
    expect(
      await jobs.releaseScheduledReport(report.run.id, lease, "late failure")
    ).toBe(false);
    expect(
      await jobs.finalizeScheduledReport(report.run.id, lease, "suppressed")
    ).toBe(false);
    expect(
      await jobs.finalizeScheduledReport(report.run.id, lease, "delivered")
    ).toBe(false);
    const [stored] = await database
      .select()
      .from(schema.scheduledAgentRuns)
      .where(eq(schema.scheduledAgentRuns.id, report.run.id));
    expect(stored).toMatchObject({
      reportStatus: "unknown",
      reportLeaseToken: lease,
      reportLeaseExpiresAt: report.run.reportLeaseExpiresAt,
      reportSequence: 1,
      lastError: "provider outcome unknown",
    });
    const future = new Date(fixtureNow.getTime() + 8 * 86_400_000);
    expect(await jobs.listRecoverableScheduledReports(future)).toEqual([]);
    expect(
      await jobs.claimScheduledReport(report.run.id, future)
    ).toBeUndefined();
  });

  it("rejects stale lease callbacks and preserves legacy queued release and delivery", async () => {
    const first = await claimedReport();
    const oldLease = first.run.reportLeaseToken;
    if (!oldLease) throw new Error("Missing report lease");
    const later = new Date(fixtureNow.getTime() + 300_001);
    expect(await jobs.listRecoverableScheduledReports(later)).toHaveLength(1);
    const second = await jobs.claimScheduledReport(first.run.id, later);
    const currentLease = second?.run.reportLeaseToken;
    if (!currentLease) throw new Error("Missing replacement lease");
    expect(currentLease).not.toBe(oldLease);
    expect(
      await jobs.holdScheduledReport(
        first.run.id,
        oldLease,
        "late old callback"
      )
    ).toBe(false);
    expect(
      await jobs.releaseScheduledReport(
        first.run.id,
        currentLease,
        "known unattempted failure"
      )
    ).toBe(true);
    const third = await jobs.claimScheduledReport(first.run.id, later);
    const deliveredLease = third?.run.reportLeaseToken;
    if (!deliveredLease) throw new Error("Missing final report lease");
    expect(
      await jobs.finalizeScheduledReport(
        first.run.id,
        deliveredLease,
        "delivered"
      )
    ).toBe(true);
    expect(
      await jobs.listRecoverableScheduledReports(
        new Date(later.getTime() + 86_400_000)
      )
    ).toEqual([]);
  });
});

async function claimedReport(at = fixtureNow) {
  const job = await jobs.createScheduledAgentJob(
    scope,
    {
      conversationChannel: "inkbox",
      conversationId:
        "inkbox:10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000001:30000000-0000-4000-8000-000000000001",
      notificationPolicy: {
        timezone: "UTC",
        quietHours: null,
        consentedBy: scope.userId,
        consentedAt: at.toISOString(),
      },
      missedRunPolicy: "run_latest",
      prompt: "Send the fictional task result.",
      timing: {
        kind: "interval",
        anchoredAt: at.toISOString(),
        everyMinutes: 60,
      },
    },
    at
  );
  const [run] = await database
    .insert(schema.scheduledAgentRuns)
    .values({
      jobId: job.id,
      scheduledFor: at,
      status: "completed",
      reportStatus: "pending",
      reportSequence: 1,
      outcome: {
        kind: "result",
        summary: "Fictional result",
        urgency: "normal",
      },
    })
    .returning();
  if (!run) throw new Error("Missing scheduled run");
  const report = await jobs.claimScheduledReport(run.id, at);
  if (!report) throw new Error("Missing claimed report");
  return report;
}
