import { describe, expect, it } from "vitest";
import { estimateContainerCost } from "./cost.mjs";

describe("published Cloudflare usage estimate", () => {
  it("includes the account plan and bills allocated memory/disk even when CPU is idle", () => {
    expect(estimateContainerCost({ hours: 720 }).total).toBeCloseTo(
      11.93036,
      5
    );
    expect(estimateContainerCost({ hours: 90 }).total).toBeCloseTo(5.62532, 5);
  });
  it("charges CPU only beyond the shared allowance", () => {
    expect(estimateContainerCost({ hours: 0, activeVcpuHours: 6.25 }).cpu).toBe(
      0
    );
    expect(
      estimateContainerCost({ hours: 0, activeVcpuHours: 7.25 }).cpu
    ).toBeCloseTo(0.072, 6);
  });
  it("does not assume another app's account allowances remain available", () => {
    const usage = estimateContainerCost({
      hours: 720,
      includePlan: false,
      allowancesAvailable: false,
    });
    expect(usage.plan).toBe(0);
    expect(usage.total).toBeCloseTo(7.20576, 5);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 745])(
    "rejects invalid monthly duration %s",
    (hours) => {
      expect(() => estimateContainerCost({ hours })).toThrow(/Usage|Estimate/u);
    }
  );
});
