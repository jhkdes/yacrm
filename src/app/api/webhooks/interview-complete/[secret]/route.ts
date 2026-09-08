import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  isValidCompletionPayload,
  recordCompletion,
} from "@/lib/interview-webhook";

// Local-testing fallback, same as this app's other tracking routes — the
// real endpoint the interview tool is actually configured to call lives in
// apps/redirect (see its matching route), since this app sits behind the
// access gate in src/proxy.ts.
//
// There's no signature on the payload (per the tool's own spec, "treat the
// URL itself as the shared secret") — INTERVIEW_WEBHOOK_SECRET is that
// secret, checked against the [secret] path segment. An unknown/wrong
// secret gets a 404, not a 401 — no reason to confirm to a guesser that
// this route exists at all.
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

  await recordCompletion(db, payload);

  return NextResponse.json({ ok: true });
}
