import { describe, expect, it } from "vitest";
import { toolContextFor } from "@tests/helpers/tool-context";
import { parseCalendarAvailability } from "@agent/lib/google-workspace/calendar";
import { gmailUpdateLabels } from "@agent/lib/google-workspace/gmail";
import { calendarCreateEvent } from "@agent/tools/calendar";
import { gmailSend, gmailUpdate } from "@agent/tools/gmail";
import {
  googleWorkspaceScopes,
  googleWorkspaceReviewUrl,
} from "@shared/google-workspace/connection";

describe("Google Workspace", () => {
  it("uses one explicit least-privilege scope set", () => {
    expect(googleWorkspaceScopes).not.toContain("*");
    expect(googleWorkspaceScopes).not.toContain("https://mail.google.com/");
    expect(googleWorkspaceScopes).toContain(
      "https://www.googleapis.com/auth/drive.readonly"
    );
    expect(googleWorkspaceReviewUrl).toBe("/connections/google");
  });

  it("maps reversible Gmail actions", () => {
    expect(gmailUpdateLabels("archive")).toEqual({
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });
    expect(gmailUpdateLabels("mark_unread")).toEqual({
      addLabelIds: ["UNREAD"],
      removeLabelIds: [],
    });
  });

  it.each([
    { name: "Gmail update", tool: gmailUpdate },
    { name: "Gmail send", tool: gmailSend },
    { name: "Calendar create", tool: calendarCreateEvent },
  ])("requires approval for each $name call", async ({ tool }) => {
    const approval = tool.approval;
    if (!approval) {
      throw new Error(
        "Google Workspace writes need a per-call approval policy."
      );
    }
    const policy = "request" in approval ? approval.request : approval;
    const context = toolContextFor({
      callId: "write-1",
      sessionId: "session-1",
      toolName: "google-workspace-write",
    });
    expect(await policy(context)).toMatchObject({ type: "denied" });
    expect(await policy({ ...context, callId: "write-2" })).toMatchObject({
      type: "denied",
    });
  });

  it("does not treat calendar API errors as availability", () => {
    expect(() =>
      parseCalendarAvailability({
        calendars: {
          "missing@example.com": {
            errors: [{ domain: "global", reason: "notFound" }],
          },
        },
      })
    ).toThrow(/missing@example\.com: notFound/u);
  });
});
