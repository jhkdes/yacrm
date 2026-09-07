import { eq } from "drizzle-orm";

import { campaignRecipient } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

// Smallest valid transparent GIF (1x1, base64) — what the pixel endpoint
// actually returns, regardless of whether the token was recognized. An
// unknown/invalid token still needs to return a real image (an email
// client that gets a 404 for an <img> just shows a broken-image icon,
// which is a worse signal to leak to a curious recipient than "nothing").
export const TRANSPARENT_GIF_BASE64 =
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

// A pixel load only ever advances "sent" -> "opened" — never "drafted"
// (never sent, so a hit is meaningless/spoofed) and never "clicked" /
// "completed" (opening isn't the engagement signal that matters — see
// docs/outreach-roadmap.md's M23 follow-up skip rule — and it must never
// downgrade a stage a recipient already reached). Re-loading the pixel
// once already "opened" is a no-op, not an error — email clients commonly
// re-fetch images on scroll/re-render.
export async function recordOpen(
  db: DrizzleDb,
  token: string,
): Promise<{ statusUpdated: boolean }> {
  const recipient = await db.query.campaignRecipient.findFirst({
    where: eq(campaignRecipient.trackingToken, token),
  });
  if (!recipient || recipient.status !== "sent") {
    return { statusUpdated: false };
  }

  await db
    .update(campaignRecipient)
    .set({ status: "opened", openedAt: new Date() })
    .where(eq(campaignRecipient.id, recipient.id));

  return { statusUpdated: true };
}
