import { describe, expect, it } from "vitest";
import {
  nextScheduledNotificationTime,
  scheduleNotificationPolicySchema,
} from "./notifications";

const policy = (
  timezone = "America/New_York",
  start = "22:00",
  end = "08:00"
) =>
  scheduleNotificationPolicySchema.parse({
    timezone,
    quietHours: { start, end },
    consentedBy: "better-auth:fixture",
    consentedAt: "2026-11-03T12:00:00Z",
  });

describe("scheduled notification quiet hours", () => {
  it("defers overnight delivery until local morning, allowing the exact end boundary", () => {
    expect(
      nextScheduledNotificationTime(
        policy(),
        new Date("2026-11-04T04:15:37Z")
      ).toISOString()
    ).toBe("2026-11-04T13:00:00.000Z");
    const at = new Date("2026-11-04T13:00:00Z");
    expect(nextScheduledNotificationTime(policy(), at)).toBe(at);
  });
  it("blocks the start boundary and preserves both copies of the fall DST hour", () => {
    expect(
      nextScheduledNotificationTime(
        policy("America/New_York", "01:00", "02:00"),
        new Date("2026-11-01T05:30:00Z")
      ).toISOString()
    ).toBe("2026-11-01T07:00:00.000Z");
    expect(
      nextScheduledNotificationTime(
        policy("America/New_York", "01:00", "02:00"),
        new Date("2026-11-01T06:00:00Z")
      ).toISOString()
    ).toBe("2026-11-01T07:00:00.000Z");
  });
  it("handles a spring DST gap without inventing a nonexistent local time", () => {
    expect(
      nextScheduledNotificationTime(
        policy("America/New_York", "01:00", "03:30"),
        new Date("2027-03-14T06:30:00Z")
      ).toISOString()
    ).toBe("2027-03-14T07:30:00.000Z");
  });
  it("supports daytime quiet periods and an explicit no-quiet-hours preference", () => {
    expect(
      nextScheduledNotificationTime(
        policy("UTC", "12:00", "13:00"),
        new Date("2026-11-03T12:00:00Z")
      ).toISOString()
    ).toBe("2026-11-03T13:00:00.000Z");
    const now = new Date();
    expect(
      nextScheduledNotificationTime({ ...policy(), quietHours: null }, now)
    ).toBe(now);
  });
  it("rejects missing consent, invalid zones, malformed times and a full-day ambiguous window", () => {
    for (const patch of [
      { consentedBy: "" },
      { timezone: "fictional/not-a-zone" },
      { quietHours: { start: "25:00", end: "08:00" } },
      { quietHours: { start: "08:00", end: "08:00" } },
    ])
      expect(
        scheduleNotificationPolicySchema.safeParse({ ...policy(), ...patch })
          .success
      ).toBe(false);
  });
});
