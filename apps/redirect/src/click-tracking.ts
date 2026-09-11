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

// Deliberately duplicated from the main app's src/lib/click-tracking.ts —
// see that file's comment for the full rationale. UA matching alone isn't
// enough: a real production log showed this app's own deployment receive
// a self-identifying LinkedInBot fetch, then a second, ordinary-looking
// Chrome/Mac request 23s later from a different network path — almost
// certainly a headless-browser safety scan that deliberately doesn't
// self-identify. Timing catches what identity can't: any request after a
// token's first-ever hit, within this window of it, is treated as
// automated regardless of its UA.
export const CLICK_GRACE_WINDOW_MS = 2 * 60 * 1000;

export interface ClickResolution {
  redirectUrl: string;
  statusUpdated: boolean;
}

interface RecipientRow {
  id: number;
  status: RecipientStatus;
  destination_url: string | null;
  first_seen_at: string | null;
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
// shouldRecordClick (and the bot/grace-window checks below) say to, and
// returns where to send them. Never throws on a bad/unknown token or a
// campaign with no destination_url — both just mean "redirect to the
// fallback, nothing to update." A known link-preview-unfurl bot's user
// agent, or any request within CLICK_GRACE_WINDOW_MS of this token's
// first-ever hit, still gets redirected normally but never advances the
// recipient's status.
export async function recordClick(
  pool: Pool,
  token: string,
  fallbackUrl: string,
  userAgent: string | null = null,
): Promise<ClickResolution> {
  const { rows } = await pool.query<RecipientRow>(
    `SELECT cr.id, cr.status, c.destination_url, cr.first_seen_at
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
  const now = new Date();

  // The very first hit this token has ever received sets the anchor —
  // but is still evaluated normally (not auto-suppressed), so a single
  // genuinely fast real click with no preceding bot fetch is still
  // recorded. Only a *later* hit close behind it is treated as automated.
  const isFirstHitEver = recipient.first_seen_at === null;
  if (isFirstHitEver) {
    await pool.query(`UPDATE campaign_recipient SET first_seen_at = $1 WHERE id = $2`, [
      now,
      recipient.id,
    ]);
  }
  const withinGraceOfFirstHit =
    !isFirstHitEver &&
    recipient.first_seen_at !== null &&
    now.getTime() - new Date(recipient.first_seen_at).getTime() < CLICK_GRACE_WINDOW_MS;

  if (!shouldRecordClick(recipient.status) || isLinkPreviewBot(userAgent) || withinGraceOfFirstHit) {
    return { redirectUrl, statusUpdated: false };
  }

  await pool.query(
    `UPDATE campaign_recipient SET status = 'clicked', clicked_at = $2 WHERE id = $1`,
    [recipient.id, now],
  );

  return { redirectUrl, statusUpdated: true };
}
