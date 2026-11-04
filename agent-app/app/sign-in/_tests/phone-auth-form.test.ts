import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import {
  PhoneOtpAuthForm,
  phoneOtpErrorMessage,
} from "@app/sign-in/_components/otp-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn<() => void>(),
    replace: vi.fn<(href: string) => void>(),
  }),
}));

const renderForm = (form: ReactElement) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, form)
  );

describe("phone OTP errors", () => {
  it("shows fixed actionable connection errors without echoing server text", () => {
    expect(
      phoneOtpErrorMessage({
        code: "MESSAGING_CONNECT_REQUIRED",
        message: "raw private provider secret",
      })
    ).toBe(
      "Complete the Messages connection steps, then send hi to Plause from this phone before requesting a code."
    );
  });

  it("does not expose unrelated server errors", () => {
    expect(
      phoneOtpErrorMessage({
        code: "INTERNAL_SERVER_ERROR",
        message: "database connection string",
      })
    ).toBe("Unable to send a code. Please try again.");
  });

  it("explains and links the required first-time Messages flow", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        onboarding: { provider: "linq", phoneNumber: "+12025550123" },
      })
    );

    expect(html).toContain("First time signing in?");
    expect(html).toContain(
      "A Messages connection alone does not create your Plause account"
    );
    expect(html).toContain("hi</code>");
    expect(html).toContain("Return here and select Send code");
    expect(html).toContain('href="sms:+12025550123"');
    expect(html).toContain("Open Messages");
  });

  it("keeps the required flow visible when the number cannot be resolved", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        onboarding: undefined,
      })
    );

    expect(html).toContain("First time signing in?");
    expect(html).toContain("Connection details are unavailable");
    expect(html).not.toContain("Vercel");
    expect(html).not.toContain("sms:");
    const error = phoneOtpErrorMessage({
      code: "MESSAGING_UNAVAILABLE",
      message:
        "No Linq line is currently eligible. Complete the first-time sign-in steps above or review line health in Linq.",
    });
    expect(error).toContain("Review the Messages connection");
    expect(error).not.toContain("button");
  });

  it("shows the Inkbox router connect command followed by hi in the connected conversation", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        onboarding: {
          provider: "inkbox",
          phoneNumber: "+12025550123",
          connectCommand: "connect @plause",
        },
      })
    );
    expect(html).toContain("connect @plause");
    expect(html).toContain(
      "then send <code>hi</code> to the connected Plause conversation"
    );
    expect(html).toContain("sms:+12025550123?&amp;body=connect%20%40plause");
    expect(html).toContain("Return here and select Send code");
    expect(html).not.toContain("Linq");
  });

  it("does not show Linq setup during local sign-in", () => {
    const html = renderForm(
      createElement(LocalPhoneAuthForm, { callbackUrl: "/" })
    );

    expect(html).not.toContain("First time signing in?");
    expect(html).toContain("Continue");
  });
});
