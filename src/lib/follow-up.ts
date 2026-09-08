import { and, eq, isNull, lte, or } from "drizzle-orm";

import { campaign, campaignRecipient, contact } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { fillLinkPlaceholder, generateDraftForPerson } from "@/lib/draft-generation";
import { createGmailClient } from "@/lib/gmail-import";
import { recordSentEvent, sendGmailMessage } from "@/lib/gmail-send";
import {
  buildTrackedLinkUrl,
  buildTrackingPixelUrl,
  requireRedirectBaseUrl,
} from "@/lib/tracked-link";

const FOLLOW_UP_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

export interface FollowUpEligibility {
  status: "drafted" | "sent" | "opened" | "clicked" | "completed";
  sentAt: Date | null;
  followedUpAt: Date | null;
}

// Pure: true iff a recipient is due for a follow-up nudge — sent (or opened,
// which isn't a strong enough engagement signal to skip the nudge; only a
// click or completion is — see campaignRecipientStatusEnum in schema.ts),
// at least 3 days ago, and never followed up before. followedUpAt is a
// one-shot flag: once set, a recipient is never picked up by this check
// again, so this job only ever nudges once.
export function needsFollowUp(
  recipient: FollowUpEligibility,
  now: Date,
): boolean {
  if (recipient.status !== "sent" && recipient.status !== "opened") {
    return false;
  }
  if (recipient.followedUpAt) return false;
  if (!recipient.sentAt) return false;
  return recipient.sentAt.getTime() <= now.getTime() - FOLLOW_UP_DELAY_MS;
}

export interface FollowUpCandidate {
  id: number;
  personId: number;
  contactId: number;
  channel: "email" | "linkedin";
  contactIdentifier: string;
  campaignGoal: string;
  destinationUrl: string | null;
  trackingToken: string;
}

// DB-only: narrows down in SQL (cheap, index-friendly), then re-checks each
// row against needsFollowUp for the exact boundary logic — SQL and JS date
// math are both trustworthy here, but keeping the real decision in one pure
// function means the boundary can't silently drift between the query and
// the tests that cover it.
export async function findRecipientsNeedingFollowUp(
  db: DrizzleDb,
  now: Date = new Date(),
): Promise<FollowUpCandidate[]> {
  const cutoff = new Date(now.getTime() - FOLLOW_UP_DELAY_MS);

  const rows = await db
    .select({
      id: campaignRecipient.id,
      personId: campaignRecipient.personId,
      contactId: campaignRecipient.contactId,
      channel: campaignRecipient.channel,
      status: campaignRecipient.status,
      sentAt: campaignRecipient.sentAt,
      followedUpAt: campaignRecipient.followedUpAt,
      trackingToken: campaignRecipient.trackingToken,
      contactIdentifier: contact.sourceIdentifier,
      campaignGoal: campaign.goal,
      destinationUrl: campaign.destinationUrl,
    })
    .from(campaignRecipient)
    .innerJoin(campaign, eq(campaignRecipient.campaignId, campaign.id))
    .innerJoin(contact, eq(campaignRecipient.contactId, contact.id))
    .where(
      and(
        isNull(campaignRecipient.deletedAt),
        isNull(campaign.deletedAt),
        isNull(campaignRecipient.followedUpAt),
        or(
          eq(campaignRecipient.status, "sent"),
          eq(campaignRecipient.status, "opened"),
        ),
        lte(campaignRecipient.sentAt, cutoff),
      ),
    );

  return rows
    .filter((r) => needsFollowUp(r, now))
    .map((r) => ({
      id: r.id,
      personId: r.personId,
      contactId: r.contactId,
      channel: r.channel,
      contactIdentifier: r.contactIdentifier,
      campaignGoal: r.campaignGoal,
      destinationUrl: r.destinationUrl,
      trackingToken: r.trackingToken,
    }));
}

export interface FollowUpSummary {
  emailsSent: number;
  // LinkedIn sending is always manual (see docs/outreach-roadmap.md's
  // decision to stay within LinkedIn's terms of service) — there's no
  // automated "send" to do here. What this job does for a LinkedIn
  // recipient is generate the nudge and put it back in the M21 copy-assist
  // queue (status: "drafted") for the user to actually send.
  linkedinQueued: number;
  skippedDraftFailed: number;
  skippedNoGmailAccount: number;
}

// Full pipeline: finds every recipient due for a nudge, drafts a short
// follow-up against the same campaign goal (amended so the model writes a
// brief reminder rather than repeating the original pitch), sends it
// (email) or re-queues it (linkedin), and marks followedUpAt so it's never
// picked up twice.
export async function sendFollowUps(
  db: DrizzleDb,
  now: Date = new Date(),
): Promise<FollowUpSummary> {
  const summary: FollowUpSummary = {
    emailsSent: 0,
    linkedinQueued: 0,
    skippedDraftFailed: 0,
    skippedNoGmailAccount: 0,
  };

  const candidates = await findRecipientsNeedingFollowUp(db, now);
  if (candidates.length === 0) return summary;

  // Checked once, up front, for the same reason addRecipients checks it
  // before its per-person loop: a missing REDIRECT_BASE_URL is an
  // environment-level misconfiguration, not a per-recipient condition.
  if (candidates.some((c) => c.destinationUrl)) {
    requireRedirectBaseUrl();
  }

  // One Gmail account for the whole app (same lookup as
  // findGmailAccount in actions.ts) — resolved once, and only if an
  // email-channel candidate actually needs it.
  let gmailAccountId: number | null = null;
  if (candidates.some((c) => c.channel === "email")) {
    const account = await db.query.oauthAccount.findFirst({
      where: (o, { eq: eqOp }) => eqOp(o.provider, "gmail"),
      orderBy: (o, { desc }) => desc(o.createdAt),
    });
    gmailAccountId = account?.id ?? null;
  }

  for (const recipient of candidates) {
    if (recipient.channel === "email" && gmailAccountId === null) {
      summary.skippedNoGmailAccount += 1;
      continue;
    }

    let draft;
    try {
      draft = await generateDraftForPerson(
        db,
        recipient.personId,
        `${recipient.campaignGoal} — brief follow-up reminder`,
      );
    } catch (err) {
      console.warn(
        `[follow-up] draft generation failed for recipient ${recipient.id}`,
        err,
      );
      summary.skippedDraftFailed += 1;
      continue;
    }

    const draftBody = recipient.destinationUrl
      ? fillLinkPlaceholder(
          draft.draft.body,
          buildTrackedLinkUrl(recipient.trackingToken),
        )
      : draft.draft.body;

    if (recipient.channel === "email") {
      const { gmail, ownEmail } = await createGmailClient(db, gmailAccountId!);
      const sent = await sendGmailMessage(gmail, {
        from: ownEmail,
        to: recipient.contactIdentifier,
        subject: draft.draft.subject,
        body: draftBody,
        trackedLinkUrl: recipient.destinationUrl
          ? buildTrackedLinkUrl(recipient.trackingToken)
          : undefined,
        trackingPixelUrl: recipient.destinationUrl
          ? buildTrackingPixelUrl(recipient.trackingToken)
          : undefined,
      });
      await recordSentEvent(
        db,
        recipient.contactId,
        recipient.personId,
        sent,
        draft.draft.subject,
        draftBody,
      );
      summary.emailsSent += 1;
    } else {
      await db
        .update(campaignRecipient)
        .set({
          draftSubject: draft.draft.subject,
          draftBody,
          status: "drafted",
        })
        .where(eq(campaignRecipient.id, recipient.id));
      summary.linkedinQueued += 1;
    }

    await db
      .update(campaignRecipient)
      .set({ followedUpAt: now })
      .where(eq(campaignRecipient.id, recipient.id));
  }

  return summary;
}
