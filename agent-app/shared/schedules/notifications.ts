import { z } from "zod";
import { localTimeSchema, timezoneSchema } from "./timing";

export const scheduleNotificationPreferencesSchema = z.strictObject({
  timezone: timezoneSchema,
  quietHours: z
    .strictObject({ start: localTimeSchema, end: localTimeSchema })
    .refine(
      ({ start, end }) => start !== end,
      "Quiet hours must have different start and end times."
    )
    .nullable(),
});

export const scheduleNotificationPolicySchema =
  scheduleNotificationPreferencesSchema.extend({
    consentedBy: z.string().min(1),
    consentedAt: z.iso.datetime(),
  });

export function nextScheduledNotificationTime(
  policy: z.infer<typeof scheduleNotificationPolicySchema>,
  now: Date
) {
  if (!policy.quietHours) return now;
  const start = minute(policy.quietHours.start),
    end = minute(policy.quietHours.end);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: policy.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const quiet = (at: Date) => {
    const parts = format.formatToParts(at);
    const local =
      Number(parts.find((p) => p.type === "hour")?.value) * 60 +
      Number(parts.find((p) => p.type === "minute")?.value);
    return start < end
      ? local >= start && local < end
      : local >= start || local < end;
  };
  if (!quiet(now)) return now;
  // Walk instants rather than offsets: both copies of a repeated DST hour
  // remain quiet, and a nonexistent wall time never produces an early send.
  for (let offset = 1; offset <= 48 * 60; offset += 1) {
    const candidate = new Date(
      Math.floor(now.getTime() / 60_000) * 60_000 + offset * 60_000
    );
    if (!quiet(candidate)) return candidate;
  }
  throw new Error("The next notification window could not be resolved.");
}

function minute(time: string) {
  const [hour = 0, minutes = 0] = time.split(":").map(Number);
  return hour * 60 + minutes;
}
