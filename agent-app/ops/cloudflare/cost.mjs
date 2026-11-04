// Public list prices checked 2026-11-03. Account-wide allowances may be consumed
// by other applications; this is an estimate, never an invoice or spending cap.
export function estimateContainerCost({
  hours,
  memoryGiB = 1,
  diskGB = 4,
  activeVcpuHours = 0,
  includePlan = true,
  allowancesAvailable = true,
}) {
  for (const value of [hours, memoryGiB, diskGB, activeVcpuHours]) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error("Usage must contain finite nonnegative numbers.");
  }
  if (hours > 744) throw new Error("Estimate at most one 31-day month.");
  const memory =
    Math.max(0, hours * memoryGiB - (allowancesAvailable ? 25 : 0)) *
    3600 *
    0.0000025;
  const disk =
    Math.max(0, hours * diskGB - (allowancesAvailable ? 200 : 0)) *
    3600 *
    0.00000007;
  const cpu =
    Math.max(0, activeVcpuHours - (allowancesAvailable ? 6.25 : 0)) *
    3600 *
    0.00002;
  const plan = includePlan ? 5 : 0;
  return { plan, memory, disk, cpu, total: plan + memory + disk + cpu };
}
