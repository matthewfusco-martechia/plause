import { vi } from "vitest";
import { installUnitTestNetworkBoundary } from "./helpers/no-network";

installUnitTestNetworkBoundary();

const testEnvironment = {
  SCHEDULED_TASKS_ENABLED: "true",
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://example.com",
  R2_ACCOUNT_ID: "00000000000000000000000000000000",
  R2_ACCESS_KEY_ID: "test-r2-access",
  R2_SECRET_ACCESS_KEY: "test-r2-secret",
  R2_BUCKET: "plause-test-artifacts",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  INTERNAL_SERVICE_SECRET: "test-internal-service-secret-0123456789abcdef",
  KERNEL_API_KEY: "test-kernel-key",
  // Fictional fixture numbers only. Production defaults to an empty, closed list.
  PRIVATE_ALLOWED_PHONE_NUMBERS:
    "+12025550123,+12025550124,+12025550456,+12125550123,+15550100000,+15550100011,+15550100022,+15550100099,+15550100999,+15555550100,+15555550123,+15555550124",
  SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
};

for (const [name, value] of Object.entries(testEnvironment)) {
  vi.stubEnv(name, value);
}
