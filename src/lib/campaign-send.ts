import { eq } from "drizzle-orm";

import { campaignRecipient } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { createGmailClient } from "@/lib/gmail-import";
import { recordSentEvent, sendGmailMessage } from "@/lib/gmail-send";
import { buildTrackedLinkUrl, buildTrackingPixelUrl } from "@/lib/tracked-link";

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

  const trackedLinkUrl = buildTrackedLinkUrl(recipient.trackingToken);
  const trackingPixelUrl = buildTrackingPixelUrl(recipient.trackingToken);
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

export interface SendAllDraftedResult {
  sent: number;
  failed: number;
}

// Bulk version of sendCampaignRecipientEmail — every email-channel,
// still-drafted recipient of one Campaign, sent one at a time. Always an
// explicit, logged-in action the owner triggers themselves (never called
// from the follow-up cron job — see docs/technical-design-and-milestones.md's
// M23 note: nothing goes out automatically, review always comes first).
// One recipient's send failing (a transient Gmail error, say) doesn't stop
// the rest — every recipient gets its own attempt, and the caller sees how
// many of each.
export async function sendAllDraftedCampaignEmails(
  db: DrizzleDb,
  accountId: number,
  campaignId: number,
): Promise<SendAllDraftedResult> {
  const recipients = await db.query.campaignRecipient.findMany({
    where: (r, { and, eq: eqOp, isNull }) =>
      and(
        eqOp(r.campaignId, campaignId),
        eqOp(r.channel, "email"),
        eqOp(r.status, "drafted"),
        isNull(r.deletedAt),
      ),
  });

  const result: SendAllDraftedResult = { sent: 0, failed: 0 };
  for (const recipient of recipients) {
    try {
      await sendCampaignRecipientEmail(db, accountId, recipient.id);
      result.sent += 1;
    } catch (err) {
      console.warn(
        `[campaign-send] bulk send failed for recipient ${recipient.id}`,
        err,
      );
      result.failed += 1;
    }
  }

  return result;
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
