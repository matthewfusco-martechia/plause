import { defineDynamic, defineTool } from "eve/tools";
import { gmailSearch, gmailReadThread } from "@agent/tools/gmail";
import { driveReadText } from "@agent/tools/drive";
import { calendarCheckAvailability } from "@agent/tools/calendar";

// Test-only execution with production input contracts. No provider client runs.
export default defineDynamic(() => ({
  "gmail-search": defineTool({
    description: "Search fictional mail in the offline planning fixture.",
    inputSchema: gmailSearch.inputSchema,
    execute: () => ({
      messages: [{ id: "fixture-message", threadId: "fixture-thread-42" }],
    }),
  }),
  "gmail-read-thread": defineTool({
    description: "Read the fictional mail thread returned by the prior search.",
    inputSchema: gmailReadThread.inputSchema,
    execute(input) {
      if (input.threadId !== "fixture-thread-42")
        throw new Error("The thread did not come from the search result.");
      return {
        thread: {
          messages: [{ body: "Fictional picnic notes:fixture_notes" }],
        },
      };
    },
  }),
  "drive-read-text": defineTool({
    description: "Read the fictional notes ID supplied by the prior thread.",
    inputSchema: driveReadText.inputSchema,
    execute(input) {
      if (input.fileId !== "fixture_notes")
        throw new Error("The file did not come from the mail thread.");
      return {
        text: JSON.stringify({
          items: ["lunch", "water"],
          timeMin: "2026-11-04T15:00:00Z",
          timeMax: "2026-11-04T16:00:00Z",
        }),
        untrustedContent: true,
      };
    },
  }),
  "calendar-check-availability": defineTool({
    description: "Check the fictional time range supplied by the prior notes.",
    inputSchema: calendarCheckAvailability.inputSchema,
    execute(input) {
      if (
        input.timeMin !== "2026-11-04T15:00:00Z" ||
        input.timeMax !== "2026-11-04T16:00:00Z"
      )
        throw new Error("The time range did not come from the notes.");
      return { calendars: { primary: { busy: [] } } };
    },
  }),
}));
