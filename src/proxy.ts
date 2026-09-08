import { NextRequest, NextResponse } from "next/server";

import { ACCESS_GATE_COOKIE_NAME, expectedAccessToken } from "@/lib/access-gate";

export async function proxy(request: NextRequest) {
  const expected = await expectedAccessToken();
  const cookie = request.cookies.get(ACCESS_GATE_COOKIE_NAME)?.value;

  if (expected && cookie === expected) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

// Excludes: the login page itself (or every request to it would redirect
// to itself), Next's static assets, and the favicon. Deliberately does NOT
// exclude /api/r/[token], /api/pixel/[token], /api/webhooks/
// interview-complete/[secret], or the Gmail OAuth callback — this app's
// own tracked-link, pixel, and webhook routes are only local-testing
// fallbacks (apps/redirect is the real public path for all three, from
// M18/M19/M20), and the OAuth callback is only ever hit by the owner's own
// already-authenticated browser mid-flow. A local curl test against this
// app's webhook route needs the access-gate cookie included, same as any
// other route here — that's expected, not a bug.
export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};
