import type { Pool } from "pg";

// Deliberately duplicated from the main app's src/lib/open-tracking.ts —
// see the comment at the top of src/click-tracking.ts in this app for why
// this app keeps its own small raw-SQL copies instead of sharing code with
// the main app's Drizzle-based ones.

export const TRANSPARENT_GIF_BASE64 =
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export type RecipientStatus =
  | "drafted"
  | "sent"
  | "opened"
  | "clicked"
  | "completed";

// A pixel load only ever advances "sent" -> "opened" — never "drafted"
// (never sent, so a hit is meaningless/spoofed) and never "clicked" /
// "completed" (must never downgrade a stage already reached).
export async function recordOpen(
  pool: Pool,
  token: string,
): Promise<{ statusUpdated: boolean }> {
  const { rows } = await pool.query<{ id: number; status: RecipientStatus }>(
    `SELECT id, status FROM campaign_recipient WHERE tracking_token = $1 LIMIT 1`,
    [token],
  );
  const recipient = rows[0];

  if (!recipient || recipient.status !== "sent") {
    return { statusUpdated: false };
  }

  await pool.query(
    `UPDATE campaign_recipient SET status = 'opened', opened_at = now() WHERE id = $1`,
    [recipient.id],
  );

  return { statusUpdated: true };
}
