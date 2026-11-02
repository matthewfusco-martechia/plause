import { z } from "zod";
import { getAuth } from "@db/services/auth";
import { isPhoneEnrollmentAllowed } from "@shared/identity/enrollment";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";

const verifiedPhoneUserSchema = z.object({
  id: z.string().min(1),
  phoneNumberVerified: z.literal(true),
});

export async function findVerifiedAuthUserIdByPhoneNumber(phoneNumber: string) {
  if (!isPhoneEnrollmentAllowed(phoneNumber)) return undefined;
  const auth = await getAuth();
  const context = await auth.$context;
  const user = await context.adapter.findOne({
    model: "user",
    where: [{ field: "phoneNumber", value: phoneNumber }],
  });
  const parsed = verifiedPhoneUserSchema.safeParse(user);
  return parsed.success ? parsed.data.id : undefined;
}

const enrolledUserSchema = verifiedPhoneUserSchema.extend({
  phoneNumber: z.string().min(1),
});

export async function assertEnrolledWorkspaceUser(scope: AccessScope) {
  if (
    !scope.userId.startsWith("better-auth:") ||
    accessScopeForUser(scope.userId).workspaceId !== scope.workspaceId
  ) {
    throw new Error("Private Plause access is unavailable for this account.");
  }
  const auth = await getAuth();
  const context = await auth.$context;
  const user = enrolledUserSchema.safeParse(
    await context.adapter.findOne({
      model: "user",
      where: [
        { field: "id", value: scope.userId.slice("better-auth:".length) },
      ],
    })
  );
  if (
    !user.success ||
    user.data.id !== scope.userId.slice("better-auth:".length) ||
    !isPhoneEnrollmentAllowed(user.data.phoneNumber)
  ) {
    throw new Error("Private Plause access is unavailable for this account.");
  }
}
