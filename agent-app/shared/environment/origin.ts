import { env } from "@shared/environment";

export function applicationOrigin() {
  if (env.BETTER_AUTH_URL) return new URL(env.BETTER_AUTH_URL).origin;
  throw new Error("Set BETTER_AUTH_URL to the canonical Plause origin.");
}

export function betterAuthBaseURL() {
  return applicationOrigin();
}
