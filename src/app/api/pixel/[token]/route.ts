import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { recordOpen, TRANSPARENT_GIF_BASE64 } from "@/lib/open-tracking";

const TRANSPARENT_GIF = Buffer.from(TRANSPARENT_GIF_BASE64, "base64");

// Local-testing fallback, same as this app's own /api/r/[token] from M18 —
// the real, publicly-reachable pixel endpoint a sent email actually points
// at lives in apps/redirect (see its src/app/pixel/[token]/route.ts),
// since this app sits behind the access gate in src/proxy.ts and isn't
// reachable by a real recipient.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  await recordOpen(db, token);

  return new NextResponse(TRANSPARENT_GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store",
      "Content-Length": String(TRANSPARENT_GIF.length),
    },
  });
}
