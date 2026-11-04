import * as CalendarApi from "@googleapis/calendar";
import * as GmailApi from "@googleapis/gmail";
import type * as EveInstructions from "eve/instructions";
import type * as EveTools from "eve/tools";
import type { ToolContext } from "eve/tools";
import type { z } from "zod";
import type * as GoogleActions from "@db/services/google-actions";
import type * as Environment from "@shared/environment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { toolContextFor } from "@tests/helpers/tool-context";
import { accessScopeForUser } from "@shared/identity/access-scope";

const capability = vi.hoisted(() => ({
  value: "false",
  token: vi.fn<() => Promise<{ token: string; version: number }>>(),
}));

vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: async () => undefined,
}));
vi.mock("@db/services/google-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleActions>()),
  readGoogleActionGrant: async () => 1,
  executeGoogleAction: async <T>(
    _binding: GoogleActions.GoogleActionBinding,
    _version: number,
    _schema: z.ZodType<T>,
    execute: () => Promise<T>
  ) => execute(),
}));

vi.mock("@db/services/google-workspace", () => ({
  getGoogleWorkspaceAccessToken: capability.token,
  assertGoogleWorkspaceVersion: async () => undefined,
  invalidateGoogleWorkspaceConnection: async () => undefined,
  GoogleWorkspaceConnectionRequiredError: class extends Error {},
}));
vi.mock("@shared/environment", async (importOriginal) => ({
  ...(await importOriginal<typeof Environment>()),
  env: {
    get GOOGLE_WORKSPACE_WRITES_ENABLED() {
      return capability.value;
    },
  },
}));
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("eve/instructions", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveInstructions>())
);

import writeInstructions from "@agent/instructions/15-google-workspace-writes";
import {
  checkCalendarAvailability,
  createCalendarEvent,
  listCalendarEvents,
} from "@agent/lib/google-workspace/calendar";
import {
  readGmailThread,
  searchGmail,
  sendGmail,
  updateGmail,
} from "@agent/lib/google-workspace/gmail";
import calendarTools, { calendarCreateEvent } from "@agent/tools/calendar";
import gmailTools, { gmailSend, gmailUpdate } from "@agent/tools/gmail";

const gmailClient = GmailApi.gmail({ version: "v1" });
const calendarClient = CalendarApi.calendar({ version: "v3" });
const gmailFactory = vi.spyOn(GmailApi, "gmail");
const calendarFactory = vi.spyOn(CalendarApi, "calendar");
const send = vi
  .fn<() => Promise<{ data: GmailApi.gmail_v1.Schema$Message }>>()
  .mockResolvedValue({ data: { id: "sent-1" } });
const modify = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const insert = vi
  .fn<() => Promise<{ data: CalendarApi.calendar_v3.Schema$Event }>>()
  .mockResolvedValue({ data: { id: "event-1" } });
const search = vi
  .fn<() => Promise<{ data: GmailApi.gmail_v1.Schema$ListMessagesResponse }>>()
  .mockResolvedValue({ data: { messages: [] } });
const thread = vi
  .fn<() => Promise<{ data: GmailApi.gmail_v1.Schema$Thread }>>()
  .mockResolvedValue({ data: { id: "thread-1", messages: [] } });
const events = vi
  .fn<() => Promise<{ data: CalendarApi.calendar_v3.Schema$Events }>>()
  .mockResolvedValue({ data: { items: [] } });
const freebusy = vi
  .fn<
    () => Promise<{ data: CalendarApi.calendar_v3.Schema$FreeBusyResponse }>
  >()
  .mockResolvedValue({ data: { calendars: {} } });

Object.defineProperty(gmailClient.users.messages, "send", { value: send });
Object.defineProperty(gmailClient.users.messages, "batchModify", {
  value: modify,
});
Object.defineProperty(gmailClient.users.messages, "list", { value: search });
Object.defineProperty(gmailClient.users.threads, "get", { value: thread });
Object.defineProperty(calendarClient.events, "insert", { value: insert });
Object.defineProperty(calendarClient.events, "list", { value: events });
Object.defineProperty(calendarClient.freebusy, "query", { value: freebusy });

const email = {
  bcc: [],
  body: "A proposed update.",
  cc: [],
  subject: "Update",
  to: ["recipient@example.com"],
};
const event = {
  attendees: ["recipient@example.com"],
  calendarId: "primary",
  end: "2026-12-01T11:00:00Z",
  start: "2026-12-01T10:00:00Z",
  summary: "Planning",
  timezone: "UTC",
};
const writeCases = [
  { name: "Gmail send", run: (ctx: ToolContext) => sendGmail(ctx, email) },
  {
    name: "Gmail state update",
    run: (ctx: ToolContext) => updateGmail(ctx, ["message-1"], "archive"),
  },
  {
    name: "Calendar insert",
    run: (ctx: ToolContext) => createCalendarEvent(ctx, event),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  capability.value = "false";
  capability.token
    .mockReset()
    .mockResolvedValue({ token: "fixture-token", version: 1 });
  gmailFactory.mockReturnValue(gmailClient);
  calendarFactory.mockReturnValue(calendarClient);
});

describe("Google Workspace write capability", () => {
  it.each(writeCases)(
    "blocks $name before authorization or provider work by default",
    async ({ run }) => {
      const ctx = context();
      await expect(run(ctx)).rejects.toThrow("writes are disabled");
      expect(ctx.getToken).not.toHaveBeenCalled();
      expect(gmailFactory).not.toHaveBeenCalled();
      expect(calendarFactory).not.toHaveBeenCalled();
      expectNoWrites();
    }
  );

  it("also blocks direct execution of previously offered write tools", async () => {
    const ctx = context();
    await expect(gmailSend.execute(email, ctx)).rejects.toThrow(
      "writes are disabled"
    );
    await expect(
      gmailUpdate.execute({ messageIds: ["message-1"], update: "archive" }, ctx)
    ).rejects.toThrow("writes are disabled");
    await expect(calendarCreateEvent.execute(event, ctx)).rejects.toThrow(
      "writes are disabled"
    );
    expect(ctx.getToken).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("keeps Gmail and Calendar reads available while writes are disabled", async () => {
    const ctx = context();
    const range = {
      timeMax: "2026-12-02T00:00:00Z",
      timeMin: "2026-12-01T00:00:00Z",
    };
    await searchGmail(ctx, "in:inbox", 10);
    await readGmailThread(ctx, "thread-1");
    await listCalendarEvents(ctx, {
      ...range,
      calendarId: "primary",
      maxResults: 10,
    });
    await checkCalendarAvailability(ctx, {
      ...range,
      calendars: ["primary"],
      timezone: "UTC",
    });
    expect(search).toHaveBeenCalledOnce();
    expect(thread).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledOnce();
    expect(freebusy).toHaveBeenCalledOnce();
    expect(ctx.getToken).not.toHaveBeenCalled();
    expect(capability.token).toHaveBeenCalledTimes(4);
    expectNoWrites();
  });

  it("requires owner approval in addition to deployment opt-in", async () => {
    capability.value = "true";
    const ctx = context();
    await expect(sendGmail(ctx, email)).rejects.toThrow("exact Google action");
    expectNoWrites();
    await sendGmail(approvedContext("gmail-send"), email);
    await updateGmail(
      approvedContext("gmail-update"),
      ["message-1"],
      "archive"
    );
    await createCalendarEvent(approvedContext("calendar-create-event"), event);
    expect(send).toHaveBeenCalledOnce();
    expect(modify).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
  });

  it.each([
    ["scheduled-worker", undefined],
    ["scheduled-result", undefined],
    ["linq-message", "scheduled-worker"],
    ["linq-message", "scheduled-result"],
  ])(
    "keeps %s / %s read-only even with deployment opt-in",
    async (current, initiator) => {
      capability.value = "true";
      const ctx = context(current, initiator);
      await Promise.all(
        writeCases.map(({ run }) =>
          expect(run(ctx)).rejects.toThrow(
            "Scheduled Google Workspace access is read-only"
          )
        )
      );
      expect(ctx.getToken).not.toHaveBeenCalled();
      expectNoWrites();
    }
  );

  it.each(writeCases)(
    "rechecks $name after token resolution before writing",
    async ({ run, name }) => {
      capability.value = "true";
      const ctx = approvedContext(
        name === "Gmail send"
          ? "gmail-send"
          : name === "Gmail state update"
            ? "gmail-update"
            : "calendar-create-event"
      );
      capability.token.mockImplementationOnce(async () => {
        capability.value = "false";
        return { token: "fixture-token", version: 1 };
      });
      await expect(run(ctx)).rejects.toThrow(
        "Google Workspace operation failed"
      );
      expect(capability.token).toHaveBeenCalledOnce();
      expectNoWrites();
    }
  );

  it("hides write tools by default while exposing read tools", async () => {
    expect(await names(gmailTools)).toEqual([
      "gmail-read-draft",
      "gmail-read-thread",
      "gmail-search",
    ]);
    expect(await names(calendarTools)).toEqual([
      "calendar-check-availability",
      "calendar-list-events",
    ]);
    capability.value = "true";
    expect(await names(gmailTools)).toContain("gmail-send");
    expect(await names(gmailTools)).toContain("gmail-update");
    expect(await names(calendarTools)).toContain("calendar-create-event");
  });

  it.each(["scheduled-worker", "scheduled-result"])(
    "never exposes write tools to %s",
    async (authenticator) => {
      capability.value = "true";
      const selectedGroups = await Promise.all(
        [gmailTools, calendarTools].map((tools) => names(tools, authenticator))
      );
      for (const selected of selectedGroups) {
        expect(selected).not.toContain("gmail-send");
        expect(selected).not.toContain("gmail-update");
        expect(selected).not.toContain("calendar-create-event");
      }
    }
  );

  it("instructs blocked sessions to avoid browser or delegated write bypasses", async () => {
    const selected = await evaluateDynamic(
      writeInstructions,
      dynamicContextFor({ auth: context().session.auth })
    );
    expect(selected?.content).toContain("read-only");
    expect(selected?.content).toContain("Do not bypass");
    expect(selected?.content).toContain("do not claim it was saved or sent");
    capability.value = "true";
    const enabled = await evaluateDynamic(
      writeInstructions,
      dynamicContextFor({ auth: context().session.auth })
    );
    expect(enabled?.content).toContain("separate per-call approval");
    const scheduled = await evaluateDynamic(
      writeInstructions,
      dynamicContextFor({ auth: context("scheduled-worker").session.auth })
    );
    expect(scheduled?.content).toContain("read-only");
  });
});

function principal(authenticator: string) {
  return {
    attributes: {
      workspaceId: accessScopeForUser("better-auth:user-1").workspaceId,
    },
    authenticator,
    principalId: "better-auth:user-1",
    principalType: "user" as const,
  };
}

function approvedContext(toolName: string): ToolContext {
  const ctx = context();
  return {
    ...ctx,
    toolName,
    approval: {
      responder: { ...principal("linq-message"), getToken: ctx.getToken },
    },
  };
}

function context(current = "linq-message", initiator?: string) {
  return {
    ...toolContextFor({
      auth: {
        current: principal(current),
        initiator: initiator ? principal(initiator) : null,
      },
    }),
    getToken: vi
      .fn<ToolContext["getToken"]>()
      .mockResolvedValue({ token: "fixture-token" }),
  };
}

async function names(
  definition: typeof gmailTools,
  authenticator = "linq-message"
) {
  const selected = await evaluateDynamic(
    definition,
    dynamicContextFor({ auth: context(authenticator).session.auth })
  );
  return selected ? Object.keys(selected).toSorted() : [];
}

function expectNoWrites() {
  expect(send).not.toHaveBeenCalled();
  expect(modify).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
}
