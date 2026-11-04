import { defineSchedule } from "eve/schedules";
import { processInkboxInbox } from "@agent/lib/inkbox/inbox";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(processInkboxInbox());
  },
});
