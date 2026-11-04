import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneOtpAuthForm } from "@app/sign-in/_components/otp-form";
import SignInPage from "../page";

const configuration = vi.hoisted(() => ({
  local: true,
  provider: "disabled",
  inkboxConfigured: true,
  router:
    vi.fn<
      () => Promise<{ number: string; connectCommand: string; smsLink: string }>
    >(),
  linq: vi.fn<() => Promise<string | undefined>>(),
}));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`Redirect: ${url}`);
  },
}));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: () => ({ user: { id: "phone-user" } }),
}));
vi.mock("@shared/environment", () => ({
  env: {
    get MESSAGING_PROVIDER() {
      return configuration.provider;
    },
    LINQ_API_KEY: "private-linq-key",
    LINQ_PHONE_NUMBER: "+15550100000",
  },
  get localPhoneAuthBypassEnabled() {
    return configuration.local;
  },
}));
vi.mock("@db/services/auth/inkbox", () => ({
  inkboxSignInConfigured: () => configuration.inkboxConfigured,
  readInkboxOnboarding: configuration.router,
}));
vi.mock("@db/services/auth/linq", () => ({
  readLinqOnboardingPhoneNumber: configuration.linq,
}));
vi.mock("@app/sign-in/_components/otp-form", () => ({
  PhoneOtpAuthForm: ({ onboarding }: Parameters<typeof PhoneOtpAuthForm>[0]) =>
    createElement("form", {
      "data-provider": onboarding?.provider,
      "data-number": onboarding?.phoneNumber,
      "data-command":
        onboarding?.provider === "inkbox" ? onboarding.connectCommand : "",
    }),
}));
vi.mock("@app/sign-in/_components/local-form", () => ({
  LocalPhoneAuthForm: ({ callbackUrl }: { readonly callbackUrl: string }) =>
    createElement("form", { action: callbackUrl }),
}));

describe("phone sign-in reauthentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configuration.local = true;
    configuration.provider = "disabled";
    configuration.inkboxConfigured = true;
    configuration.router.mockResolvedValue({
      number: "+12025550123",
      connectCommand: "connect @plause",
      smsLink: "sms:+12025550123?&body=connect%20%40plause",
    });
    configuration.linq.mockResolvedValue("+15550100000");
  });
  it("allows an already signed-in user to verify again and return to Link", async () => {
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({
          reauthenticate: "true",
          callbackUrl: "/link",
        }),
      })
    );

    expect(html).toContain("Sign in again");
    expect(html).toContain('action="/link"');
  });

  it("keeps disabled messaging unavailable even if old Linq credentials remain", async () => {
    configuration.local = false;
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({ reauthenticate: "true" }),
      })
    );
    expect(html).toContain("iMessage sign-in is not configured");
    expect(html).not.toContain("<form");
    expect(configuration.router).not.toHaveBeenCalled();
    expect(configuration.linq).not.toHaveBeenCalled();
  });

  it("resolves the selected Inkbox router without exposing keys or falling back to Linq", async () => {
    configuration.local = false;
    configuration.provider = "inkbox";
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({ reauthenticate: "true" }),
      })
    );
    expect(html).toContain('data-provider="inkbox"');
    expect(html).toContain('data-command="connect @plause"');
    expect(configuration.router).toHaveBeenCalledOnce();
    expect(configuration.linq).not.toHaveBeenCalled();
    expect(html).not.toContain("private-linq-key");
  });

  it("hides the OTP form when router lookup fails and does not reflect its error", async () => {
    configuration.local = false;
    configuration.provider = "inkbox";
    configuration.router.mockRejectedValueOnce(
      new Error("private provider credentials")
    );
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({ reauthenticate: "true" }),
      })
    );
    expect(html).toContain("connection details are temporarily unavailable");
    expect(html).not.toContain("private provider credentials");
    expect(html).not.toContain("<form");
    expect(configuration.linq).not.toHaveBeenCalled();
  });

  it("preserves explicitly selected Linq sign-in and avoids router calls locally", async () => {
    configuration.local = false;
    configuration.provider = "linq";
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({ reauthenticate: "true" }),
      })
    );
    expect(html).toContain('data-provider="linq"');
    expect(configuration.router).not.toHaveBeenCalled();
    configuration.local = true;
    configuration.provider = "inkbox";
    await SignInPage({
      params: Promise.resolve({}),
      searchParams: Promise.resolve({ reauthenticate: "true" }),
    });
    expect(configuration.router).not.toHaveBeenCalled();
  });

  it("still redirects signed-in users outside the reauthentication flow", async () => {
    await expect(
      SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({ callbackUrl: "/link" }),
      })
    ).rejects.toThrow("Redirect: /");
  });

  it.each([
    "//attacker.example",
    "/\\attacker.example",
    "/\n/attacker.example",
    "/\t/attacker.example",
    "/\r/attacker.example",
  ])(
    "keeps the reauthentication callback on this app: %j",
    async (callbackUrl) => {
      const html = renderToStaticMarkup(
        await SignInPage({
          params: Promise.resolve({}),
          searchParams: Promise.resolve({
            reauthenticate: "true",
            callbackUrl,
          }),
        })
      );

      expect(html).toContain('action="/"');
      expect(html).not.toContain("attacker.example");
    }
  );
});
