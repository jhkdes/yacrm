import type { Pool } from "pg";

// Deliberately duplicated from the main app's src/lib/click-tracking.ts
// rather than shared — this app has no dependency on the main app's
// Drizzle schema/ORM (kept intentionally lightweight: just `pg`), and the
// query surface here is small and stable enough that keeping two copies in
// sync by hand is cheaper than the coupling a shared package would add.
// If this drifts from the main app's copy, the tests in both places are
// what would catch it.

export type RecipientStatus =
  | "drafted"
  | "sent"
  | "opened"
  | "clicked"
  | "completed";

// Pure: a click only ever moves a recipient forward to "clicked" — never
// backward, and never past "completed" (terminal). Re-clicking an
// already-"clicked" link is a no-op rather than resetting clicked_at.
export function shouldRecordClick(status: RecipientStatus): boolean {
  return status !== "clicked" && status !== "completed";
}

export interface ClickResolution {
  redirectUrl: string;
  statusUpdated: boolean;
}

interface RecipientRow {
  id: number;
  status: RecipientStatus;
  destination_url: string | null;
}

// Looks up the recipient by their tracking token, advances their status if
// shouldRecordClick says to, and returns where to send them. Never throws
// on a bad/unknown token or a campaign with no destination_url — both just
// mean "redirect to the fallback, nothing to update."
export async function recordClick(
  pool: Pool,
  token: string,
  fallbackUrl: string,
): Promise<ClickResolution> {
  const { rows } = await pool.query<RecipientRow>(
    `SELECT cr.id, cr.status, c.destination_url
     FROM campaign_recipient cr
     JOIN campaign c ON c.id = cr.campaign_id
     WHERE cr.tracking_token = $1
     LIMIT 1`,
    [token],
  );
  const recipient = rows[0];

  if (!recipient || !recipient.destination_url) {
    return { redirectUrl: fallbackUrl, statusUpdated: false };
  }

  if (!shouldRecordClick(recipient.status)) {
    return { redirectUrl: recipient.destination_url, statusUpdated: false };
  }

  await pool.query(
    `UPDATE campaign_recipient SET status = 'clicked', clicked_at = now() WHERE id = $1`,
    [recipient.id],
  );

  return { redirectUrl: recipient.destination_url, statusUpdated: true };
}
