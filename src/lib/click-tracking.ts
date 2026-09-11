import { eq } from "drizzle-orm";

import { campaignRecipient } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

// Where an unknown/invalid token, or a recipient whose Campaign has no
// destinationUrl, sends the visitor — a stale or tampered link shouldn't
// dead-end them with an error page.
export const FALLBACK_REDIRECT_PATH = "/";

type RecipientStatus =
  | "drafted"
  | "sent"
  | "opened"
  | "clicked"
  | "completed";

// Pure: a click only ever moves a recipient forward to "clicked" — never
// backward, and never past "completed" (terminal, per the funnel table in
// docs/outreach-roadmap.md). Re-clicking an already-"clicked" link is a
// no-op rather than resetting clickedAt to the second click's time.
export function shouldRecordClick(status: RecipientStatus): boolean {
  return status !== "clicked" && status !== "completed";
}

// A tracked link pasted as plain text into a LinkedIn (or email) message
// gets fetched by the sending platform's own link-preview-unfurl bot the
// moment the message goes out, to build a rich preview card — not by the
// actual recipient. Substring match against known unfurl-bot user agents,
// case-insensitive; deliberately conservative (only bots we've actually
// seen hit this, not a general bot blocklist) since a false positive here
// just means a real click goes unrecorded, which is the safer failure mode
// for a metric that only matters as a rough engagement signal.
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

// UA matching alone isn't enough — real production logs show LinkedIn
// following its self-identifying LinkedInBot preview fetch with a second,
// unrelated-looking request (ordinary Chrome/Mac UA, different network
// path) seconds later, almost certainly a headless-browser safety scan
// that deliberately doesn't self-identify to dodge UA blocklists. A real
// recipient can't plausibly read a message and click within seconds of it
// being sent, so timing catches what identity can't: any request after a
// token's first-ever hit, within this window of it, is treated as
// automated regardless of its UA. A real tradeoff, not free — a
// genuinely fast real click inside this window also goes unrecorded.
export const CLICK_GRACE_WINDOW_MS = 2 * 60 * 1000;

export interface ClickResolution {
  redirectUrl: string;
  statusUpdated: boolean;
}

// Pure: tags the destination with our tracking token as a `tracking_id`
// query param — the AI-interview tool's own webhook contract (M20, see
// docs/technical-design-and-milestones.md) echoes this back verbatim on
// completion, and it's how a completion event gets matched back to this
// specific recipient. An interview link visited without this param never
// triggers their webhook at all, per their spec — so this is required, not
// optional, for completion tracking to work.
export function appendTrackingId(destinationUrl: string, token: string): string {
  const url = new URL(destinationUrl);
  url.searchParams.set("tracking_id", token);
  return url.toString();
}

// DB-only: looks up the recipient by their tracking token, advances their
// status if shouldRecordClick (and the bot/grace-window checks below) say
// to, and returns where to send them. Never throws on a bad/unknown token
// — that's just treated as "redirect to the fallback, nothing to update."
// A known link-preview-unfurl bot's user agent, or any request within
// CLICK_GRACE_WINDOW_MS of this token's first-ever hit, still gets
// redirected normally (its preview card should still work, and a real
// recipient's click still lands them on the destination either way) but
// never advances the recipient's status.
export async function recordClick(
  db: DrizzleDb,
  token: string,
  userAgent: string | null = null,
): Promise<ClickResolution> {
  const recipient = await db.query.campaignRecipient.findFirst({
    where: eq(campaignRecipient.trackingToken, token),
    with: { campaign: true },
  });

  if (!recipient || !recipient.campaign.destinationUrl) {
    return { redirectUrl: FALLBACK_REDIRECT_PATH, statusUpdated: false };
  }

  const redirectUrl = appendTrackingId(recipient.campaign.destinationUrl, token);
  const now = new Date();

  // The very first hit this token has ever received sets the anchor —
  // but is still evaluated normally (not auto-suppressed), so a single
  // genuinely fast real click with no preceding bot fetch is still
  // recorded. Only a *later* hit close behind it is treated as automated.
  const isFirstHitEver = recipient.firstSeenAt === null;
  if (isFirstHitEver) {
    await db
      .update(campaignRecipient)
      .set({ firstSeenAt: now })
      .where(eq(campaignRecipient.id, recipient.id));
  }
  const withinGraceOfFirstHit =
    !isFirstHitEver &&
    recipient.firstSeenAt !== null &&
    now.getTime() - recipient.firstSeenAt.getTime() < CLICK_GRACE_WINDOW_MS;

  if (!shouldRecordClick(recipient.status) || isLinkPreviewBot(userAgent) || withinGraceOfFirstHit) {
    return { redirectUrl, statusUpdated: false };
  }

  await db
    .update(campaignRecipient)
    .set({ status: "clicked", clickedAt: now })
    .where(eq(campaignRecipient.id, recipient.id));

  return { redirectUrl, statusUpdated: true };
}
