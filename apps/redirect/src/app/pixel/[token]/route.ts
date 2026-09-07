import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db";
import { recordOpen, TRANSPARENT_GIF_BASE64 } from "@/open-tracking";

const TRANSPARENT_GIF = Buffer.from(TRANSPARENT_GIF_BASE64, "base64");

// The public open-tracking pixel a real sent email's <img> tag points at.
// Always returns a real 1x1 GIF regardless of whether the token was
// recognized — an email client showing a broken-image icon for an unknown
// token is a worse signal to leak than just quietly doing nothing.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  await recordOpen(getPool(), token);

  return new NextResponse(TRANSPARENT_GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store",
      "Content-Length": String(TRANSPARENT_GIF.length),
    },
  });
}
