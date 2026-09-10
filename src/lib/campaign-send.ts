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

// A LinkedIn recipient's tracked link is plain text pasted into a real
// LinkedIn message, sent entirely outside this app — so by the time this
// runs, the actual send already happened. That leaves a window where the
// recipient (or, far more commonly, LinkedIn's own link-preview-unfurl bot
// fetching the URL to build a rich preview card the moment the message
// goes out) hits the tracked link and advances status straight from
// "drafted" to "opened"/"clicked" before the operator gets back here to
// mark it sent — see docs/glossary.md's "Tracked link" entry. Those aren't
// a reason to reject marking sent; they're proof it already went out.
// Only a recipient already at "sent"/"completed" (already marked, or a
// genuinely finished funnel) is rejected as not sendable.
// Exported so the copy-assist queue page's query can list the same
// recipients this allows marking sent — otherwise one advanced by a click
// before the operator gets back to it would vanish from the queue instead
// of just needing "Mark sent" clicked on it.
export const LINKEDIN_SENDABLE_STATUSES = ["drafted", "opened", "clicked"] as const;
const ALREADY_SENDABLE_LINKEDIN_STATUSES = new Set<string>(LINKEDIN_SENDABLE_STATUSES);

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
  if (!ALREADY_SENDABLE_LINKEDIN_STATUSES.has(recipient.status)) {
    throw new CampaignRecipientNotSendableError(
      recipientId,
      `status is "${recipient.status}", not "drafted"`,
    );
  }

  // Don't regress a status the click/open tracking already advanced past
  // "sent" — only "drafted" actually needs bumping forward.
  await db
    .update(campaignRecipient)
    .set({
      status: recipient.status === "drafted" ? "sent" : recipient.status,
      sentAt: recipient.sentAt ?? new Date(),
    })
    .where(eq(campaignRecipient.id, recipientId));
}
