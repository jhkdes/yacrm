import { eq } from "drizzle-orm";

import { campaignRecipient } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { createGmailClient } from "@/lib/gmail-import";
import { recordSentEvent, sendGmailMessage } from "@/lib/gmail-send";

export class CampaignRecipientNotFoundError extends Error {
  constructor(recipientId: number) {
    super(`No Campaign Recipient found with id ${recipientId}.`);
  }
}

export class CampaignRecipientNotSendableError extends Error {
  constructor(recipientId: number, reason: string) {
    super(`Campaign Recipient ${recipientId} can't be sent: ${reason}`);
  }
}

// A relative "/api/r/[token]" (this app's own local-testing fallback route
// from M18) is useless inside an actual sent email — there's no browser
// origin for a mail client to resolve it against. Unlike the campaign
// detail page's display-only fallback, a real send has no safe fallback:
// this app's own route isn't reachable by a real recipient anyway (it's
// behind the access gate — see src/proxy.ts), so failing loudly here beats
// silently emailing someone a broken or gated link.
function requireRedirectBaseUrl(): string {
  const base = process.env.REDIRECT_BASE_URL;
  if (!base) {
    throw new Error(
      "REDIRECT_BASE_URL must be set to send a real campaign email — without it, the tracked link and open pixel would point somewhere a real recipient can't reach.",
    );
  }
  return base.replace(/\/+$/, "");
}

// Sends one email-channel Campaign Recipient's already-generated draft for
// real via Gmail, with the M18 tracked link and M19 open-tracking pixel
// embedded, then advances them to "sent" and records the usual outbound
// Event (recordSentEvent) so the send shows up on the Person's timeline
// exactly like any other sent email — a campaign send isn't a separate
// kind of history from the app's point of view.
export async function sendCampaignRecipientEmail(
  db: DrizzleDb,
  accountId: number,
  recipientId: number,
): Promise<void> {
  const recipient = await db.query.campaignRecipient.findFirst({
    where: eq(campaignRecipient.id, recipientId),
    with: { contact: true },
  });
  if (!recipient) throw new CampaignRecipientNotFoundError(recipientId);
  if (recipient.channel !== "email") {
    throw new CampaignRecipientNotSendableError(
      recipientId,
      `channel is "${recipient.channel}", not "email"`,
    );
  }
  if (recipient.status !== "drafted") {
    throw new CampaignRecipientNotSendableError(
      recipientId,
      `status is "${recipient.status}", not "drafted"`,
    );
  }

  const baseUrl = requireRedirectBaseUrl();
  const trackedLinkUrl = `${baseUrl}/${recipient.trackingToken}`;
  const trackingPixelUrl = `${baseUrl}/pixel/${recipient.trackingToken}`;
  const subject = recipient.draftSubject ?? "";

  const { gmail, ownEmail } = await createGmailClient(db, accountId);
  const sent = await sendGmailMessage(gmail, {
    from: ownEmail,
    to: recipient.contact.sourceIdentifier,
    subject,
    body: recipient.draftBody,
    trackedLinkUrl,
    trackingPixelUrl,
  });

  await recordSentEvent(
    db,
    recipient.contactId,
    recipient.personId,
    sent,
    subject,
    recipient.draftBody,
  );

  await db
    .update(campaignRecipient)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(campaignRecipient.id, recipientId));
}

// M21's LinkedIn "send": there's no API to actually deliver the message
// (see docs/outreach-roadmap.md's decision to stay within LinkedIn's terms
// of service — this app never automates a LinkedIn send), so this just
// records that the user did it themselves after copy-pasting the draft
// from the copy-assist queue. No pixel, no event recorded on the Person's
// timeline the way an email send gets one — a LinkedIn message sent
// outside this app isn't something we have the actual content or a
// message id for, unlike a Gmail send.
export async function markLinkedInRecipientSent(
  db: DrizzleDb,
  recipientId: number,
): Promise<void> {
  const recipient = await db.query.campaignRecipient.findFirst({
    where: eq(campaignRecipient.id, recipientId),
  });
  if (!recipient) throw new CampaignRecipientNotFoundError(recipientId);
  if (recipient.channel !== "linkedin") {
    throw new CampaignRecipientNotSendableError(
      recipientId,
      `channel is "${recipient.channel}", not "linkedin"`,
    );
  }
  if (recipient.status !== "drafted") {
    throw new CampaignRecipientNotSendableError(
      recipientId,
      `status is "${recipient.status}", not "drafted"`,
    );
  }

  await db
    .update(campaignRecipient)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(campaignRecipient.id, recipientId));
}
