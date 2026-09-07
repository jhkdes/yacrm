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

export interface ClickResolution {
  redirectUrl: string;
  statusUpdated: boolean;
}

// DB-only: looks up the recipient by their tracking token, advances their
// status if shouldRecordClick says to, and returns where to send them.
// Never throws on a bad/unknown token — that's just treated as "redirect to
// the fallback, nothing to update."
export async function recordClick(
  db: DrizzleDb,
  token: string,
): Promise<ClickResolution> {
  const recipient = await db.query.campaignRecipient.findFirst({
    where: eq(campaignRecipient.trackingToken, token),
    with: { campaign: true },
  });

  if (!recipient || !recipient.campaign.destinationUrl) {
    return { redirectUrl: FALLBACK_REDIRECT_PATH, statusUpdated: false };
  }

  if (!shouldRecordClick(recipient.status)) {
    return { redirectUrl: recipient.campaign.destinationUrl, statusUpdated: false };
  }

  await db
    .update(campaignRecipient)
    .set({ status: "clicked", clickedAt: new Date() })
    .where(eq(campaignRecipient.id, recipient.id));

  return { redirectUrl: recipient.campaign.destinationUrl, statusUpdated: true };
}
