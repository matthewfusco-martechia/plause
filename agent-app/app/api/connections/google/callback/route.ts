import { completeGoogleWorkspaceOAuth } from "@db/services/google-workspace";
import { applicationOrigin } from "@shared/environment/origin";
import { googleWorkspaceReviewUrl } from "@shared/google-workspace/connection";
import {
  googleBrowserCookie,
  readGoogleBrowserCookie,
  readGoogleBrowserSession,
} from "../_session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let result = "failed";
  try {
    const session = await readGoogleBrowserSession(request);
    const params = new URL(request.url).searchParams;
    if (
      !session ||
      params.has("error") ||
      params.getAll("state").length !== 1 ||
      params.getAll("code").length !== 1
    )
      throw new Error("Google callback unavailable.");
    await completeGoogleWorkspaceOAuth(session.scope, {
      sessionId: session.sessionId,
      browserToken: readGoogleBrowserCookie(request),
      state: params.get("state") ?? "",
      code: params.get("code") ?? "",
    });
    result = "connected";
  } catch {
    /* Callback errors must never echo codes, tokens, raw provider errors, or account data. */
  }
  return new Response(null, {
    status: 303,
    headers: {
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": googleBrowserCookie("", true),
      location: new URL(
        `${googleWorkspaceReviewUrl}?result=${result}`,
        applicationOrigin()
      ).href,
    },
  });
}
