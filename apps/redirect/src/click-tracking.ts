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

// Deliberately duplicated from the main app's src/lib/click-tracking.ts —
// see that file's comment for the full rationale (LinkedIn's own
// link-preview-unfurl bot fetches a tracked link the moment a message goes
// out, to build a rich preview card, and that fetch shouldn't count as
// real recipient engagement). Confirmed via a real production log: this
// app's deployment received a request with User-Agent
// "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient
// +http://www.linkedin.com)" for a tracked link seconds after it was sent.
const LINK_PREVIEW_BOT_USER_AGENT_SUBSTRINGS = [
  "linkedinbot",
  "facebookexternalhit",
  "slackbot",
  "twitterbot",
  "whatsapp",
  "telegrambot",
  "discordbot",
  "redditbot",
  "skypeuripreview",
  "embedly",
];

export function isLinkPreviewBot(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return LINK_PREVIEW_BOT_USER_AGENT_SUBSTRINGS.some((substring) => lower.includes(substring));
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

// Tags the destination with our tracking token as a `tracking_id` query
// param — the AI-interview tool's webhook contract (M20) echoes this back
// verbatim on completion, and it's how a completion event gets matched
// back to this recipient. A link visited without this param never
// triggers their webhook at all, per their spec.
export function appendTrackingId(destinationUrl: string, token: string): string {
  const url = new URL(destinationUrl);
  url.searchParams.set("tracking_id", token);
  return url.toString();
}

// Looks up the recipient by their tracking token, advances their status if
// shouldRecordClick says to, and returns where to send them. Never throws
// on a bad/unknown token or a campaign with no destination_url — both just
// mean "redirect to the fallback, nothing to update." A known link-
// preview-unfurl bot's user agent still gets redirected normally (its
// preview card should still work) but never advances the recipient's
// status.
export async function recordClick(
  pool: Pool,
  token: string,
  fallbackUrl: string,
  userAgent: string | null = null,
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

  const redirectUrl = appendTrackingId(recipient.destination_url, token);

  if (!shouldRecordClick(recipient.status) || isLinkPreviewBot(userAgent)) {
    return { redirectUrl, statusUpdated: false };
  }

  await pool.query(
    `UPDATE campaign_recipient SET status = 'clicked', clicked_at = now() WHERE id = $1`,
    [recipient.id],
  );

  return { redirectUrl, statusUpdated: true };
}
