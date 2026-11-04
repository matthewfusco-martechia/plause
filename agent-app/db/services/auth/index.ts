import { createHash } from "node:crypto";
import { link } from "@stripe/link-integrations-better-auth";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { account, db, session, user, verification } from "@db";
import { betterAuthBaseURL } from "@shared/environment/origin";
import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { LinqDeliveryError, sendLinqText } from "./linq";
import { sendInkboxPhoneCode } from "./inkbox";
import { isE164PhoneNumber } from "@shared/identity/phone-number";
import { isPhoneEnrollmentAllowed } from "@shared/identity/enrollment";

let authPromise: ReturnType<typeof initializeAuth> | undefined;

export function getAuth() {
  authPromise ??= initializeAuthWithRetry();
  return authPromise;
}

async function initializeAuthWithRetry() {
  try {
    return await initializeAuth();
  } catch (error) {
    authPromise = undefined;
    throw error;
  }
}

async function initializeAuth() {
  const { betterAuthSecret } = await getInstallationSecrets();
  const { LINK_CLIENT_ID, LINK_CLIENT_SECRET, STRIPE_PUBLISHABLE_KEY } = env;
  return betterAuth({
    appName: "Plause",
    baseURL: betterAuthBaseURL(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { account, session, user, verification },
    }),
    disabledPaths: [
      "/change-email",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/send-verification-email",
      "/sign-in/email",
      "/sign-in/social",
      "/sign-up/email",
      "/verify-email",
      // Wallet disconnection must revoke the Link grant through its plugin.
      "/unlink-account",
    ],
    account: {
      encryptOAuthTokens: true,
      additionalFields: {
        issuer: {
          type: "string",
          required: true,
          input: false,
          defaultValue: "better-auth",
        },
      },
      accountLinking: {
        trustedProviders: ["link"],
        allowDifferentEmails: true,
        // Phone verification signs users in independently of OAuth accounts.
        allowUnlinkingAll: true,
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (value) => {
            if (value.providerId === "link") {
              const [existing] = await db
                .select({ id: account.id })
                .from(account)
                .where(
                  and(
                    eq(account.userId, value.userId),
                    eq(account.providerId, "link")
                  )
                )
                .limit(1);
              // Reauthorization updates the same account. Replacing it requires
              // disconnecting first so the previous grant is revoked.
              if (existing) return false;
            }
            return { data: { ...value, issuer: value.providerId } };
          },
        },
      },
    },
    plugins: [
      ...(LINK_CLIENT_ID && LINK_CLIENT_SECRET && STRIPE_PUBLISHABLE_KEY
        ? [
            link({
              clientId: LINK_CLIENT_ID,
              clientSecret: LINK_CLIENT_SECRET,
              publishableKey: STRIPE_PUBLISHABLE_KEY,
            }),
          ]
        : []),
      phoneNumber({
        allowedAttempts: 3,
        expiresIn: 300,
        phoneNumberValidator: isPhoneEnrollmentAllowed,
        requireVerification: true,
        sendOTP: localPhoneAuthBypassEnabled
          ? () => undefined
          : ({ code, phoneNumber: to }) => sendPhoneCode({ code, to }),
        signUpOnVerification: {
          getTempEmail: (phoneNumberValue) =>
            `phone-${createHash("sha256")
              .update(phoneNumberValue)
              .digest("hex")}@local-vault.invalid`,
          getTempName: () => "Phone user",
        },
        verifyOTP: localPhoneAuthBypassEnabled
          ? ({ phoneNumber: value }) => isE164PhoneNumber(value)
          : undefined,
      }),
    ],
    secret: betterAuthSecret,
  });
}

export async function sendPhoneCode({
  code,
  to,
}: {
  readonly code: string;
  readonly to: string;
}) {
  if (!isPhoneEnrollmentAllowed(to)) {
    throw new APIError("FORBIDDEN", {
      code: "PRIVATE_ENROLLMENT_REQUIRED",
      message:
        "This private Plause installation is not accepting this phone number.",
    });
  }
  if (!/^\d{6}$/u.test(code))
    throw new APIError("BAD_REQUEST", {
      code: "INVALID_SIGN_IN_CODE",
      message: "A valid sign-in code is required.",
    });
  const idempotencyKey = `auth-otp-${createHash("sha256")
    .update(
      JSON.stringify([
        env.MESSAGING_PROVIDER,
        env.MESSAGING_PROVIDER === "inkbox"
          ? env.INKBOX_IDENTITY_ID
          : env.LINQ_PHONE_NUMBER,
        to,
        code,
      ])
    )
    .digest("hex")}`;
  if (env.MESSAGING_PROVIDER === "inkbox")
    return sendInkboxPhoneCode({ to, code, idempotencyKey });
  if (env.MESSAGING_PROVIDER !== "linq")
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "MESSAGING_DISABLED",
      message: "iMessage sign-in is disabled for this deployment.",
    });
  if (!env.LINQ_API_KEY || !env.LINQ_PHONE_NUMBER) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "MESSAGING_NOT_CONFIGURED",
      message: "iMessage sign-in is not configured for this deployment.",
    });
  }

  try {
    await sendLinqText({
      idempotencyKey,
      message: `Plause sign-in code: ${code}. Expires in 5 minutes.`,
      to,
    });
  } catch (error) {
    if (error instanceof LinqDeliveryError) {
      throw new APIError("BAD_GATEWAY", {
        code:
          error.code === 2008
            ? "MESSAGING_CONNECT_REQUIRED"
            : error.code === 2024
              ? "MESSAGING_OPTED_OUT"
              : "MESSAGING_UNAVAILABLE",
        message:
          error.code === 2008
            ? "Complete the Messages connection steps, then send hi to Plause from this phone before requesting a code."
            : error.code === 2024
              ? "This phone has opted out of messages. Re-enable messages before requesting a sign-in code."
              : "The messaging line is unavailable. Review its connection before requesting another code.",
      });
    }

    throw new APIError("BAD_GATEWAY", {
      code: "MESSAGING_CODE_UNCONFIRMED",
      message:
        "Plause could not confirm delivery of the sign-in code. Review the Messages connection before requesting another code.",
    });
  }
}
