"use client";

import { useMutation } from "@tanstack/react-query";
import { MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { SubmitEvent } from "react";
import { authClient } from "@web/auth/client";
import { formValue, verifyPhoneNumber } from "@app/sign-in/_lib/phone-auth";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import { PhoneNumberField } from "./phone-field";

export type MessagingOnboarding =
  | {
      readonly provider: "inkbox";
      readonly phoneNumber: string;
      readonly connectCommand: string;
    }
  | { readonly provider: "linq"; readonly phoneNumber: string };

export function PhoneOtpAuthForm({
  callbackUrl,
  onboarding,
}: {
  readonly callbackUrl: string;
  readonly onboarding?: MessagingOnboarding;
}) {
  const sendOtp = useMutation({
    mutationFn: async (phoneNumberValue: string) => {
      const phoneNumber = normalizeAuthPhoneNumber(phoneNumberValue);
      if (!phoneNumber) throw new Error("Enter a valid phone number.");

      const result = await authClient.phoneNumber
        .sendOtp({ phoneNumber })
        .catch(() => {
          throw new Error("Unable to send a code. Please try again.");
        });
      if (result.error) throw new Error(phoneOtpErrorMessage(result.error));
      return phoneNumber;
    },
  });

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    sendOtp.mutate(formValue(event.currentTarget, "phone-number"));
  }

  if (sendOtp.isSuccess) {
    return (
      <VerificationCodeForm
        callbackUrl={callbackUrl}
        onUseDifferentNumber={sendOtp.reset}
        phoneNumber={sendOtp.data}
      />
    );
  }

  return (
    <>
      <FirstTimeMessagesSetup onboarding={onboarding} />
      <form
        className="mt-4"
        onSubmit={(event) => {
          submit(event);
        }}
      >
        <FieldGroup>
          <PhoneNumberField />
          <FieldError errors={sendOtp.error ? [sendOtp.error] : undefined} />
          <Button className="w-full" disabled={sendOtp.isPending} type="submit">
            {sendOtp.isPending ? "Sending…" : "Send code"}
          </Button>
        </FieldGroup>
      </form>
    </>
  );
}

function VerificationCodeForm({
  callbackUrl,
  onUseDifferentNumber,
  phoneNumber,
}: {
  readonly callbackUrl: string;
  readonly onUseDifferentNumber: () => void;
  readonly phoneNumber: string;
}) {
  const router = useRouter();
  const verifyCode = useMutation({
    mutationFn: async (code: string) => {
      if (!/^\d{6}$/.test(code)) {
        throw new Error("Enter the six-digit code.");
      }

      await verifyPhoneNumber({
        code,
        errorMessage:
          "That code could not be verified. Request a new code and try again.",
        phoneNumber,
      });
    },
    onSuccess: () => {
      router.replace(callbackUrl);
      router.refresh();
    },
  });

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    verifyCode.mutate(formValue(event.currentTarget, "code").trim());
  }

  return (
    <form
      className="mt-6"
      onSubmit={(event) => {
        submit(event);
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="code">Verification Code</FieldLabel>
          <Input
            autoComplete="one-time-code"
            id="code"
            inputMode="numeric"
            maxLength={6}
            name="code"
            pattern="[0-9]{6}"
            required
          />
        </Field>
        <FieldError
          errors={verifyCode.error ? [verifyCode.error] : undefined}
        />
        <Button
          className="w-full"
          disabled={verifyCode.isPending}
          type="submit"
        >
          {verifyCode.isPending ? "Verifying…" : "Verify code"}
        </Button>
        <Button
          className="w-full"
          disabled={verifyCode.isPending}
          onClick={onUseDifferentNumber}
          type="button"
          variant="ghost"
        >
          Use a different number
        </Button>
      </FieldGroup>
    </form>
  );
}

function FirstTimeMessagesSetup({
  onboarding,
}: {
  readonly onboarding?: MessagingOnboarding;
}) {
  const href = onboarding
    ? onboarding.provider === "inkbox"
      ? `sms:${onboarding.phoneNumber}?&body=${encodeURIComponent(onboarding.connectCommand)}`
      : `sms:${onboarding.phoneNumber}`
    : undefined;
  return (
    <Alert className="mt-6" variant="information">
      <MessageSquareIcon />
      <AlertTitle>First time signing in?</AlertTitle>
      <AlertDescription>
        <p>
          Connect with Plause in Messages from the phone number you will enter
          below. A Messages connection alone does not create your Plause
          account; you still need the sign-in code.
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          {onboarding?.provider === "inkbox" ? (
            <>
              <li>
                Open Messages to the connection router and send{" "}
                <code>{onboarding.connectCommand}</code>.
              </li>
              <li>
                Follow the router instructions, then send <code>hi</code> to the
                connected Plause conversation.
              </li>
            </>
          ) : (
            <>
              <li>Open Messages to the Plause number.</li>
              <li>
                Send <code>hi</code> from the phone number you will enter below.
              </li>
            </>
          )}
          <li>Return here and select Send code.</li>
        </ol>
        {href ? (
          <Button
            className="mt-3 w-full"
            nativeButton={false}
            render={<a aria-label="Connect Plause in Messages" href={href} />}
            variant="outline"
          >
            Open Messages
          </Button>
        ) : (
          <p className="mt-2">
            Connection details are unavailable. Ask the Plause operator for the
            Messages setup steps before requesting a code.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function phoneOtpErrorMessage(error: {
  readonly code?: string;
  readonly message?: string;
}) {
  switch (error.code) {
    case "MESSAGING_CONNECT_REQUIRED":
      return "Complete the Messages connection steps, then send hi to Plause from this phone before requesting a code.";
    case "MESSAGING_OPTED_OUT":
      return "This phone has opted out of messages. Re-enable messages before requesting a sign-in code.";
    case "MESSAGING_DISABLED":
    case "MESSAGING_NOT_CONFIGURED":
      return "iMessage sign-in is unavailable for this deployment. Contact the Plause operator.";
    case "MESSAGING_CODE_UNCONFIRMED":
    case "MESSAGING_UNAVAILABLE":
      return "The sign-in code could not be confirmed. Review the Messages connection before requesting another code.";
    case "PRIVATE_ENROLLMENT_REQUIRED":
      return "This private Plause installation is not accepting this phone number.";
    default:
      return "Unable to send a code. Please try again.";
  }
}
