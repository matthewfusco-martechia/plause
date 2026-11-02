import { beginGoogleWorkspaceOAuth } from "@db/services/google-workspace";
import { applicationOrigin } from "@shared/environment/origin";
import { googleBrowserCookie, readGoogleBrowserSession } from "../_session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const privateHeaders = { "cache-control": "private, no-store" };
  if (request.headers.get("origin") !== applicationOrigin())
    return Response.json(
      { error: "origin_required" },
      { headers: privateHeaders, status: 403 }
    );
  const session = await readGoogleBrowserSession(request);
  if (!session)
    return Response.json(
      { error: "sign_in_required" },
      { headers: privateHeaders, status: 401 }
    );
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    return Response.json(
      { error: "permission_review_required" },
      { headers: privateHeaders, status: 400 }
    );
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Review required.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      /* oxlint-disable eslint/no-await-in-loop -- Read the small consent form under one strict byte bound. */
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2048) {
          await reader.cancel();
          throw new Error("Review required.");
        }
        chunks.push(value);
      }
      /* oxlint-enable eslint/no-await-in-loop */
    } finally {
      reader.releaseLock();
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (
      form.getAll("reviewedPermissions").length !== 1 ||
      form.get("reviewedPermissions") !== "yes"
    )
      return Response.json(
        { error: "permission_review_required" },
        { headers: privateHeaders, status: 400 }
      );
    const started = await beginGoogleWorkspaceOAuth(
      session.scope,
      session.sessionId
    );
    return new Response(null, {
      status: 303,
      headers: {
        ...privateHeaders,
        location: started.authorizationUrl,
        "set-cookie": googleBrowserCookie(started.browserToken),
      },
    });
  } catch {
    return Response.json(
      { error: "google_connection_unavailable" },
      { headers: privateHeaders, status: 409 }
    );
  }
}
