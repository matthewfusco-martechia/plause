import type { SessionContext } from "eve/context";
import {
  finalizeScheduledReport,
  holdScheduledReport,
  isScheduledReportDeliveryActive,
  releaseScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";

export function scheduledReportFromSession(
  session: Pick<SessionContext, "session">
) {
  return scheduledReportIdentity(session.session.auth);
}

export async function assertScheduledReportDelivery(
  session: Pick<SessionContext, "session">
) {
  const report = scheduledReportFromSession(session);
  if (!report) return;
  const owner = session.session.auth.current ?? session.session.auth.initiator;
  if (owner?.principalType !== "user")
    throw new Error("Scheduled report owner is unavailable.");
  const scope = scopeFromPrincipal(owner);
  await assertEnrolledWorkspaceUser(scope);
  if (
    !(await isScheduledReportDeliveryActive(
      scope,
      report.runId,
      report.leaseToken,
      report.sequence
    ))
  )
    throw new Error("Scheduled report delivery is no longer authorized.");
}

export async function finalizeScheduledReportDelivery(
  session: SessionContext,
  status: "delivered" | "suppressed" = "delivered"
) {
  const report = scheduledReportFromSession(session);
  if (report) {
    const finalized = await finalizeScheduledReport(
      report.runId,
      report.leaseToken,
      status
    );
    if (finalized) {
      console.info("[scheduled-run] report finalized", {
        runId: report.runId,
        sessionId: session.session.id,
        status,
      });
    }
  }
}

export async function releaseScheduledReportDelivery(
  session: SessionContext,
  errorMessage: string
) {
  const report = scheduledReportFromSession(session);
  if (report) {
    const released = await releaseScheduledReport(
      report.runId,
      report.leaseToken,
      errorMessage
    );
    console.warn("[scheduled-run] report turn failed", {
      released,
      runId: report.runId,
      sessionId: session.session.id,
    });
  }
}

export async function holdScheduledReportDelivery(
  session: SessionContext,
  errorMessage: string
) {
  const report = scheduledReportFromSession(session);
  if (report) {
    const held = await holdScheduledReport(
      report.runId,
      report.leaseToken,
      errorMessage
    );
    console.warn("[scheduled-run] report delivery is unresolved", {
      held,
      runId: report.runId,
      sessionId: session.session.id,
    });
  }
}
