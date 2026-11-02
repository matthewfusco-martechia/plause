import { defineSchedule } from "eve/schedules";
import { processLinqInbox } from "@agent/lib/linq/inbox";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(processLinqInbox());
  },
});
