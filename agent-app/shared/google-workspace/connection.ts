export const googleWorkspaceScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

export const googleWorkspaceReviewUrl = "/connections/google";
export const googleWorkspaceCallbackPath = "/api/connections/google/callback";
export const googleWorkspaceBrowserCookie = "plause-google-oauth";
