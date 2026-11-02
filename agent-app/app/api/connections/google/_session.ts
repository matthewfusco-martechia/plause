import { z } from "zod";
import { getAuthSession } from "@db/services/auth/session";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  googleWorkspaceBrowserCookie,
  googleWorkspaceCallbackPath,
} from "@shared/google-workspace/connection";
import { applicationOrigin } from "@shared/environment/origin";

const sessionSchema = z.object({
  session: z.object({ id: z.string().min(1).max(1024) }),
});

export async function readGoogleBrowserSession(request: Request) {
  const session = await getAuthSession(request.headers);
  const proof = sessionSchema.safeParse(session);
  return session && proof.success
    ? {
        scope: accessScopeForUser(`better-auth:${session.user.id}`),
        sessionId: proof.data.session.id,
      }
    : null;
}

export function googleBrowserCookie(value: string, clear = false) {
  const secure =
    new URL(applicationOrigin()).protocol === "https:" ? "; Secure" : "";
  return `${googleWorkspaceBrowserCookie}=${value}; Path=${googleWorkspaceCallbackPath}; HttpOnly; SameSite=Lax; Max-Age=${clear ? "0" : "600"}${secure}`;
}

export function readGoogleBrowserCookie(request: Request) {
  const entries = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${googleWorkspaceBrowserCookie}=`));
  return entries.length === 1
    ? (entries[0]?.slice(googleWorkspaceBrowserCookie.length + 1) ?? "")
    : "";
}
