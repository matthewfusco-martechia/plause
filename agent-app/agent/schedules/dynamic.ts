import { defineSchedule } from "eve/schedules";
import { dispatchDueWork } from "@agent/lib/schedules/dispatch";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(dispatchDueWork(to));
  },
});
