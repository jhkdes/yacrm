import { NextRequest, NextResponse } from "next/server";

import { recordClick } from "@/click-tracking";
import { getPool } from "@/db";

// The public tracked link a real recipient clicks from an actual sent
// email/LinkedIn message. Records the click against the same
// campaign_recipient row the main yaCRM app created, then forwards to the
// campaign's destination URL.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const fallbackUrl = new URL("/", request.url).toString();

  const { redirectUrl } = await recordClick(
    getPool(),
    token,
    fallbackUrl,
    request.headers.get("user-agent"),
  );

  return NextResponse.redirect(redirectUrl);
}
