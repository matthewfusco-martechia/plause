import { z } from "zod";

export const googleWorkspaceAccessSchema = z.enum(["read", "write"]);

const identityScopes = ["openid", "email", "profile"] as const;

export const googleWorkspaceCapabilities = {
  "gmail.read": {
    label: "Read Gmail",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  },
  "gmail.write": {
    label: "Send mail and change Gmail labels",
    scope: "https://www.googleapis.com/auth/gmail.modify",
  },
  "calendar.read": {
    label: "Read Calendar events",
    scope: "https://www.googleapis.com/auth/calendar.events.readonly",
  },
  "calendar.write": {
    label: "Manage Calendar events",
    scope: "https://www.googleapis.com/auth/calendar.events",
  },
  "calendar.availability": {
    label: "Read Calendar availability",
    scope: "https://www.googleapis.com/auth/calendar.freebusy",
  },
  "contacts.read": {
    label: "Read Contacts",
    scope: "https://www.googleapis.com/auth/contacts.readonly",
  },
  "drive.read": {
    label: "Read Drive files",
    scope: "https://www.googleapis.com/auth/drive.readonly",
  },
} as const;

export type GoogleWorkspaceCapability =
  keyof typeof googleWorkspaceCapabilities;

export const googleWorkspaceScopes = [
  ...identityScopes,
  googleWorkspaceCapabilities["gmail.read"].scope,
  googleWorkspaceCapabilities["calendar.read"].scope,
  googleWorkspaceCapabilities["calendar.availability"].scope,
  googleWorkspaceCapabilities["contacts.read"].scope,
  googleWorkspaceCapabilities["drive.read"].scope,
] as const;

export const googleWorkspaceWriteScopes = [
  ...identityScopes,
  googleWorkspaceCapabilities["gmail.write"].scope,
  googleWorkspaceCapabilities["calendar.write"].scope,
  googleWorkspaceCapabilities["calendar.availability"].scope,
  googleWorkspaceCapabilities["contacts.read"].scope,
  googleWorkspaceCapabilities["drive.read"].scope,
] as const;

function normalizedScopes(value: string | null | undefined) {
  return new Set(
    (value ?? "")
      .split(/\s+/u)
      .filter(Boolean)
      .map((scope) => {
        if (scope === "https://www.googleapis.com/auth/userinfo.email")
          return "email";
        if (scope === "https://www.googleapis.com/auth/userinfo.profile")
          return "profile";
        return scope;
      })
  );
}

function scopeGranted(scopes: Set<string>, required: string) {
  return (
    scopes.has(required) ||
    (required === googleWorkspaceCapabilities["gmail.read"].scope &&
      scopes.has(googleWorkspaceCapabilities["gmail.write"].scope)) ||
    (required === googleWorkspaceCapabilities["calendar.read"].scope &&
      scopes.has(googleWorkspaceCapabilities["calendar.write"].scope))
  );
}

export function googleWorkspaceScopesCover(
  value: string | null | undefined,
  required: readonly string[]
) {
  const scopes = normalizedScopes(value);
  return required.every((scope) => scopeGranted(scopes, scope));
}

export function googleWorkspaceGrantedCapabilities(
  value: string | null | undefined
) {
  const scopes = normalizedScopes(value);
  const names = Object.keys(googleWorkspaceCapabilities).filter(
    (name): name is GoogleWorkspaceCapability =>
      Object.hasOwn(googleWorkspaceCapabilities, name)
  );
  return names.filter((name) =>
    scopeGranted(scopes, googleWorkspaceCapabilities[name].scope)
  );
}

export function reviewedGoogleWorkspaceScopes(
  value: string | null | undefined,
  access: z.infer<typeof googleWorkspaceAccessSchema>
) {
  const scopes = normalizedScopes(value);
  return (
    access === "write" ? googleWorkspaceWriteScopes : googleWorkspaceScopes
  ).filter((scope) => scopeGranted(scopes, scope));
}

export function hasGoogleWorkspaceGrant(value: string | null | undefined) {
  return (
    googleWorkspaceScopesCover(value, identityScopes) &&
    googleWorkspaceGrantedCapabilities(value).length > 0
  );
}

export const googleWorkspaceReviewUrl = "/connections/google";
export const googleWorkspaceCallbackPath = "/api/connections/google/callback";
export const googleWorkspaceBrowserCookie = "plause-google-oauth";
