import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { recordClick } from "@/lib/click-tracking";

// The tracked link embedded in a recipient's draft (see docs/glossary.md's
// "Tracked link" entry). Records a click, then forwards to the Campaign's
// destinationUrl — or a same-origin fallback for an unknown/invalid token,
// so a stale or tampered link never dead-ends the visitor with an error.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const { redirectUrl } = await recordClick(db, token, request.headers.get("user-agent"));

  return NextResponse.redirect(new URL(redirectUrl, request.url));
}
