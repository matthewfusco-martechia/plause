import { beforeEach, describe, expect, it, vi } from "vitest";

/* oxlint-disable unicorn/consistent-function-scoping -- Vitest hoists this isolated fixture before module imports. */
const fixture = vi.hoisted(() => {
  const findOne = async () => ({
    id: "user-1",
    phoneNumberVerified: true,
    phoneNumber: "+12025550123",
  });
  const getSession = async () => ({
    user: {
      id: "user-1",
      phoneNumber: "+12025550123",
      phoneNumberVerified: true,
    },
  });
  const getAuth = async () => ({
    api: { getSession },
    $context: Promise.resolve({ adapter: { findOne } }),
  });
  return {
    bypass: false,
    env: { PRIVATE_ALLOWED_PHONE_NUMBERS: "+12025550123" },
    findOne: vi.fn<typeof findOne>(findOne),
    getSession: vi.fn<typeof getSession>(getSession),
    getAuth: vi.fn<typeof getAuth>(getAuth),
  };
});
/* oxlint-enable unicorn/consistent-function-scoping */
vi.mock("@shared/environment", () => ({
  env: fixture.env,
  get localPhoneAuthBypassEnabled() {
    return fixture.bypass;
  },
}));
vi.mock("@db/services/auth", () => ({ getAuth: fixture.getAuth }));

import { isPhoneEnrollmentAllowed } from "@shared/identity/enrollment";
import { getAuthSession } from "@db/services/auth/session";
import {
  assertEnrolledWorkspaceUser,
  findVerifiedAuthUserIdByPhoneNumber,
} from "@db/services/auth/phone-user";
import { accessScopeForUser } from "@shared/identity/access-scope";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.bypass = false;
  fixture.env.PRIVATE_ALLOWED_PHONE_NUMBERS = "+12025550123";
  fixture.getAuth.mockResolvedValue({
    api: { getSession: fixture.getSession },
    $context: Promise.resolve({ adapter: { findOne: fixture.findOne } }),
  });
});

describe("private phone enrollment", () => {
  it("denies an empty list and exact-number mismatches", () => {
    fixture.env.PRIVATE_ALLOWED_PHONE_NUMBERS = "";
    expect(isPhoneEnrollmentAllowed("+12025550123")).toBe(false);
    fixture.env.PRIVATE_ALLOWED_PHONE_NUMBERS = "+12025550123";
    expect(isPhoneEnrollmentAllowed("+12025550123")).toBe(true);
    expect(isPhoneEnrollmentAllowed("+12025550124")).toBe(false);
    expect(isPhoneEnrollmentAllowed("2025550123")).toBe(false);
  });

  it("blocks inbound user lookup before touching the database", async () => {
    await expect(
      findVerifiedAuthUserIdByPhoneNumber("+12025550124")
    ).resolves.toBeUndefined();
    expect(fixture.getAuth).not.toHaveBeenCalled();
  });

  it("requires both enrollment and an actually verified phone identity", async () => {
    fixture.findOne.mockResolvedValue({
      id: "user-1",
      phoneNumber: "+12025550123",
      phoneNumberVerified: false,
    });
    await expect(
      findVerifiedAuthUserIdByPhoneNumber("+12025550123")
    ).resolves.toBeUndefined();
    fixture.findOne.mockResolvedValue({
      id: "user-1",
      phoneNumber: "+12025550123",
      phoneNumberVerified: true,
    });
    await expect(
      findVerifiedAuthUserIdByPhoneNumber("+12025550123")
    ).resolves.toBe("user-1");
  });

  it("invalidates an existing account session when the number is removed", async () => {
    fixture.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        phoneNumber: "+12025550123",
        phoneNumberVerified: true,
      },
    });
    await expect(getAuthSession(new Headers())).resolves.not.toBeNull();
    fixture.env.PRIVATE_ALLOWED_PHONE_NUMBERS = "";
    await expect(getAuthSession(new Headers())).resolves.toBeNull();
  });

  it("keeps the explicit loopback development exception limited to valid phone syntax", () => {
    fixture.bypass = true;
    fixture.env.PRIVATE_ALLOWED_PHONE_NUMBERS = "";
    expect(isPhoneEnrollmentAllowed("+12025550124")).toBe(true);
    expect(isPhoneEnrollmentAllowed("arbitrary")).toBe(false);
  });

  it("fences queued operations against current enrollment and account ownership", async () => {
    fixture.findOne.mockResolvedValue({
      id: "user-1",
      phoneNumber: "+12025550123",
      phoneNumberVerified: true,
    });
    const scope = accessScopeForUser("better-auth:user-1");
    await expect(assertEnrolledWorkspaceUser(scope)).resolves.toBe(
      "+12025550123"
    );
    fixture.env.PRIVATE_ALLOWED_PHONE_NUMBERS = "";
    await expect(assertEnrolledWorkspaceUser(scope)).rejects.toThrow(
      "Private Plause access is unavailable"
    );
    await expect(
      assertEnrolledWorkspaceUser({ ...scope, workspaceId: "other-workspace" })
    ).rejects.toThrow("Private Plause access is unavailable");
  });
});
