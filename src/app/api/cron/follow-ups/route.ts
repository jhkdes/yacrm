import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { runFollowUpCycle } from "@/lib/follow-up";

// Vercel Cron always invokes a scheduled endpoint with GET, never POST —
// confirmed against Vercel's own docs (docs/cron-jobs/manage-cron-jobs),
// not assumed. It also only auto-attaches an Authorization: Bearer header
// when the project env var is named exactly CRON_SECRET — a differently
// named var (this route used to check FOLLOW_UP_CRON_SECRET) never gets
// sent, since Vercel Cron has no way to attach a custom header at all. See
// vercel.json for the schedule.
//
// This never sends anything to a real recipient — runFollowUpCycle only
// drafts follow-ups and emails the owner a review digest. Actually sending
// is always a separate, logged-in, explicit action.
export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const summary = await runFollowUpCycle(db);
  return NextResponse.json(summary);
}
