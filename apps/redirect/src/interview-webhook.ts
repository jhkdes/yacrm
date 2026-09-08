import type { Pool } from "pg";

// Deliberately duplicated from the main app's src/lib/interview-webhook.ts
// — see the comment at the top of click-tracking.ts in this app for why.

export interface InterviewCompletionPayload {
  participantTrackingId: string;
  interviewId: string;
  studyId: string;
  status: string;
  completedAt: string;
}

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

// Sets a recipient to "completed" regardless of their current status —
// completion is terminal and reported by the tool as an objective fact.
// An unmatched participantTrackingId, or a non-"completed" status (their
// spec says it's the only value used today, but future-proofing), is a
// no-op, not an error.
export async function recordCompletion(
  pool: Pool,
  payload: InterviewCompletionPayload,
): Promise<RecordCompletionResult> {
  if (payload.status !== "completed") {
    return { matched: false };
  }

  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM campaign_recipient WHERE tracking_token = $1 LIMIT 1`,
    [payload.participantTrackingId],
  );
  const recipient = rows[0];
  if (!recipient) {
    return { matched: false };
  }

  const completedAt = new Date(payload.completedAt);
  const validCompletedAt = Number.isNaN(completedAt.getTime())
    ? new Date()
    : completedAt;

  await pool.query(
    `UPDATE campaign_recipient SET status = 'completed', completed_at = $2 WHERE id = $1`,
    [recipient.id, validCompletedAt.toISOString()],
  );

  return { matched: true };
}
