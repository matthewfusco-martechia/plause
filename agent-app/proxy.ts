import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@db/services/auth/session";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/sign-in" ||
    // The contact route verifies its signed URL; Linq downloads without cookies.
    pathname === "/contacts/openinstinct.vcf" ||
    pathname.startsWith("/api/auth/") ||
    // These handlers enforce account/session ownership themselves. Preserve
    // their API errors and let OAuth discard codes before any sign-in redirect.
    pathname.startsWith("/eve/v1/") ||
    pathname === "/api/connections/google/start" ||
    pathname === "/api/connections/google/callback" ||
    pathname.startsWith("/internal/scheduled-run/")
  ) {
    return NextResponse.next();
  }

  if (await getAuthSession(request.headers)) return NextResponse.next();

  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set(
    "callbackUrl",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|fonts|favicon.ico|icon\\.svg$|apple-icon\\.png$|opengraph-image\\.png$).*)",
  ],
};
