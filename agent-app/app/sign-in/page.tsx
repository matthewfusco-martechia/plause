import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import { PhoneOtpAuthForm } from "@app/sign-in/_components/otp-form";
import type { MessagingOnboarding } from "@app/sign-in/_components/otp-form";
import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { getAuthSession } from "@db/services/auth/session";
import { readLinqOnboardingPhoneNumber } from "@db/services/auth/linq";
import {
  inkboxSignInConfigured,
  readInkboxOnboarding,
} from "@db/services/auth/inkbox";

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const reauthenticate = params.reauthenticate === "true";
  if (!reauthenticate && (await getAuthSession(await headers()))) redirect("/");

  const callbackValue = params.callbackUrl;
  const requestedCallback = Array.isArray(callbackValue)
    ? callbackValue[0]
    : callbackValue;
  const callbackUrl =
    requestedCallback?.startsWith("/") &&
    !requestedCallback.startsWith("//") &&
    // oxlint-disable-next-line eslint/no-control-regex -- URL parsers normalize backslashes and strip controls, which can turn a relative path into an external redirect.
    !/[\\\u0000-\u001f\u007f]/u.test(requestedCallback)
      ? requestedCallback
      : "/";
  let onboarding: MessagingOnboarding | undefined;
  let unavailable =
    "iMessage sign-in is not configured for this deployment. Contact the Plause operator to enable it.";
  if (!localPhoneAuthBypassEnabled) {
    if (env.MESSAGING_PROVIDER === "inkbox" && inkboxSignInConfigured()) {
      try {
        const router = await readInkboxOnboarding();
        onboarding = {
          provider: "inkbox",
          phoneNumber: router.number,
          connectCommand: router.connectCommand,
        };
      } catch {
        unavailable =
          "The Messages connection details are temporarily unavailable. Contact the Plause operator before requesting a code.";
      }
    } else if (
      env.MESSAGING_PROVIDER === "linq" &&
      env.LINQ_API_KEY &&
      env.LINQ_PHONE_NUMBER
    ) {
      const phoneNumber = await readLinqOnboardingPhoneNumber();
      if (phoneNumber) onboarding = { provider: "linq", phoneNumber };
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="type-page-title">
            {reauthenticate ? "Sign in again" : "Sign In"}
          </h1>
          <p className="type-supporting-body text-muted-foreground">
            Enter your phone number to sign in.
          </p>
        </div>
        {!localPhoneAuthBypassEnabled && !onboarding ? (
          <p className="type-supporting-body text-muted-foreground">
            {unavailable}
          </p>
        ) : localPhoneAuthBypassEnabled ? (
          <LocalPhoneAuthForm callbackUrl={callbackUrl} />
        ) : (
          <PhoneOtpAuthForm callbackUrl={callbackUrl} onboarding={onboarding} />
        )}
      </section>
    </main>
  );
}
