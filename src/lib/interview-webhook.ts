import { eq } from "drizzle-orm";

import { campaignRecipient } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

// The AI-interview tool's completion webhook payload — see
// docs/technical-design-and-milestones.md's M20 section for the full
// contract they specified. `participantTrackingId` is the same value we
// tagged the link with via appendTrackingId (click-tracking.ts) — it's our
// own campaign_recipient.trackingToken, opaque to them.
export interface InterviewCompletionPayload {
  participantTrackingId: string;
  interviewId: string;
  studyId: string;
  status: string;
  completedAt: string;
}

// Pure: validates the shape before touching the DB — a malformed payload
// is a 400 (their spec treats 4xx as non-retryable, so failing fast here
// is exactly what they want for a genuinely bad request, as opposed to an
// unmatched-but-well-formed one, which still acks 2xx — see
// recordCompletion).
export function isValidCompletionPayload(
  value: unknown,
): value is InterviewCompletionPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.participantTrackingId === "string" &&
    v.participantTrackingId.length > 0 &&
    typeof v.interviewId === "string" &&
    typeof v.studyId === "string" &&
    typeof v.status === "string" &&
    typeof v.completedAt === "string"
  );
}

export interface RecordCompletionResult {
  matched: boolean;
}

// DB-only: sets a recipient to "completed" regardless of their current
// status — completion is terminal and reported by the tool as an
// objective fact, not something to second-guess against our own funnel
// state (unlike a click or an open, which we validate against
// shouldRecordClick/status before trusting). An unmatched
// participantTrackingId, or a payload whose status isn't "completed"
// (their spec says it's the only value used today, but future-proofing
// against them adding event types), is a no-op — not an error, since per
// their spec every non-5xx response is treated as delivered.
export async function recordCompletion(
  db: DrizzleDb,
  payload: InterviewCompletionPayload,
): Promise<RecordCompletionResult> {
  if (payload.status !== "completed") {
    return { matched: false };
  }

  const recipient = await db.query.campaignRecipient.findFirst({
    where: eq(campaignRecipient.trackingToken, payload.participantTrackingId),
  });
  if (!recipient) {
    return { matched: false };
  }

  const completedAt = new Date(payload.completedAt);

  await db
    .update(campaignRecipient)
    .set({
      status: "completed",
      completedAt: Number.isNaN(completedAt.getTime()) ? new Date() : completedAt,
    })
    .where(eq(campaignRecipient.id, recipient.id));

  return { matched: true };
}
