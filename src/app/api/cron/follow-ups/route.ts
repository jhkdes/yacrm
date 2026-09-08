import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { sendFollowUps } from "@/lib/follow-up";

// Cron-triggered — the codebase has no built-in scheduler (see M23 in
// docs/technical-design-and-milestones.md), so this is a plain
// bearer-secret-gated endpoint that can be driven by whatever's available
// at deploy time (Vercel Cron, an OS-level scheduled task, or a one-line
// curl in a cron job) without coupling the app to one scheduler. Fails
// closed: an unset or wrong secret is rejected, same convention as the
// interview-completion webhook (src/app/api/webhooks/interview-complete).
export async function POST(request: NextRequest) {
  const expected = process.env.FOLLOW_UP_CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const summary = await sendFollowUps(db);
  return NextResponse.json(summary);
}
