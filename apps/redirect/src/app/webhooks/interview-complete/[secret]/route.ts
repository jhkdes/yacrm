import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db";
import {
  isValidCompletionPayload,
  recordCompletion,
} from "@/interview-webhook";

// The real endpoint the AI-interview tool is configured to call
// (PARTICIPANT_COMPLETION_WEBHOOK_URL on their side) — this is the
// publicly-reachable one; the main app has a matching local-testing
// fallback behind its access gate.
//
// No signature on the payload (per the tool's spec, "treat the URL itself
// as the shared secret") — INTERVIEW_WEBHOOK_SECRET is that secret,
// checked against the [secret] path segment. Wrong/missing secret gets a
// 404, not a 401 — no reason to confirm this route exists to a guesser.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params;
  const expected = process.env.INTERVIEW_WEBHOOK_SECRET;
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!isValidCompletionPayload(payload)) {
    return NextResponse.json({ error: "invalid payload shape" }, { status: 400 });
  }

  await recordCompletion(getPool(), payload);

  return NextResponse.json({ ok: true });
}
