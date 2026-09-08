import { and, eq, isNull, lte, or } from "drizzle-orm";

import { campaign, campaignRecipient, contact, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { fillLinkPlaceholder, generateDraftForPerson } from "@/lib/draft-generation";
import { createGmailClient } from "@/lib/gmail-import";
import { sendGmailMessage } from "@/lib/gmail-send";
import { buildTrackedLinkUrl, requireRedirectBaseUrl } from "@/lib/tracked-link";

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
  personName: string;
  contactId: number;
  channel: "email" | "linkedin";
  contactIdentifier: string;
  campaignId: number;
  campaignName: string;
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
      personName: person.name,
      contactId: campaignRecipient.contactId,
      channel: campaignRecipient.channel,
      status: campaignRecipient.status,
      sentAt: campaignRecipient.sentAt,
      followedUpAt: campaignRecipient.followedUpAt,
      trackingToken: campaignRecipient.trackingToken,
      contactIdentifier: contact.sourceIdentifier,
      campaignId: campaign.id,
      campaignName: campaign.name,
      campaignGoal: campaign.goal,
      destinationUrl: campaign.destinationUrl,
    })
    .from(campaignRecipient)
    .innerJoin(campaign, eq(campaignRecipient.campaignId, campaign.id))
    .innerJoin(contact, eq(campaignRecipient.contactId, contact.id))
    .innerJoin(person, eq(campaignRecipient.personId, person.id))
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
      personName: r.personName,
      contactId: r.contactId,
      channel: r.channel,
      contactIdentifier: r.contactIdentifier,
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      campaignGoal: r.campaignGoal,
      destinationUrl: r.destinationUrl,
      trackingToken: r.trackingToken,
    }));
}

export interface QueuedFollowUp {
  campaignId: number;
  campaignName: string;
  personName: string;
  channel: "email" | "linkedin";
  draftSubject: string | null;
}

export interface PrepareFollowUpsResult {
  queued: QueuedFollowUp[];
  skippedDraftFailed: number;
}

// Full pipeline, but deliberately does NOT send anything — nothing goes out
// to a real person without an explicit, logged-in decision to send it (the
// user's own call: they want to review every outbound message, follow-ups
// included, before it leaves). For every recipient due for a nudge, this
// drafts a short follow-up against the same campaign goal (amended so the
// model writes a brief reminder rather than repeating the original pitch),
// writes it into draftSubject/draftBody, and resets status back to
// "drafted" — which puts it in front of the existing per-recipient "Send"
// button (email) or the M21 copy-assist queue (linkedin) exactly like a
// fresh, never-sent draft. followedUpAt is set regardless of channel so a
// recipient is never re-queued by a later run.
export async function prepareFollowUps(
  db: DrizzleDb,
  now: Date = new Date(),
): Promise<PrepareFollowUpsResult> {
  const result: PrepareFollowUpsResult = { queued: [], skippedDraftFailed: 0 };

  const candidates = await findRecipientsNeedingFollowUp(db, now);
  if (candidates.length === 0) return result;

  // Checked once, up front, for the same reason addRecipients checks it
  // before its per-person loop: a missing REDIRECT_BASE_URL is an
  // environment-level misconfiguration, not a per-recipient condition.
  if (candidates.some((c) => c.destinationUrl)) {
    requireRedirectBaseUrl();
  }

  for (const recipient of candidates) {
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
      result.skippedDraftFailed += 1;
      continue;
    }

    const draftBody = recipient.destinationUrl
      ? fillLinkPlaceholder(
          draft.draft.body,
          buildTrackedLinkUrl(recipient.trackingToken),
        )
      : draft.draft.body;

    await db
      .update(campaignRecipient)
      .set({
        draftSubject: draft.draft.subject,
        draftBody,
        status: "drafted",
        followedUpAt: now,
      })
      .where(eq(campaignRecipient.id, recipient.id));

    result.queued.push({
      campaignId: recipient.campaignId,
      campaignName: recipient.campaignName,
      personName: recipient.personName,
      channel: recipient.channel,
      draftSubject: draft.draft.subject,
    });
  }

  return result;
}

function requireAppBaseUrl(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new Error(
      "APP_BASE_URL must be set to link back to the app from the follow-up review email.",
    );
  }
  return base.replace(/\/+$/, "");
}

// Emails the app owner's own connected Gmail account a plain digest of what
// just got queued, grouped by channel, with a link to each campaign for
// review — nothing here is a "send" to the actual recipient, it's a
// notification to the one person who reviews and sends. Silently does
// nothing if nothing was queued (no reason to email an empty digest every
// day the job runs and finds nothing due).
export async function notifyOwnerOfPendingFollowUps(
  db: DrizzleDb,
  queued: QueuedFollowUp[],
): Promise<{ notified: boolean }> {
  if (queued.length === 0) return { notified: false };

  const account = await db.query.oauthAccount.findFirst({
    where: (o, { eq: eqOp }) => eqOp(o.provider, "gmail"),
    orderBy: (o, { desc }) => desc(o.createdAt),
  });
  if (!account) {
    throw new Error(
      "Can't notify you about pending follow-ups: no Gmail account is connected.",
    );
  }

  const appBaseUrl = requireAppBaseUrl();
  const emailRecipients = queued.filter((r) => r.channel === "email");
  const linkedinRecipients = queued.filter((r) => r.channel === "linkedin");

  const lines = [
    `${queued.length} follow-up${queued.length === 1 ? "" : "s"} ready for review — nothing has been sent. Log in to review and send, individually or in bulk from each campaign's page.`,
    "",
  ];
  if (emailRecipients.length > 0) {
    lines.push(`Ready to send via email (${emailRecipients.length}):`);
    for (const r of emailRecipients) {
      lines.push(
        `- ${r.personName} (${r.campaignName}) — "${r.draftSubject ?? "(no subject)"}" — ${appBaseUrl}/campaigns/${r.campaignId}`,
      );
    }
    lines.push("");
  }
  if (linkedinRecipients.length > 0) {
    lines.push(`Ready to copy-paste on LinkedIn (${linkedinRecipients.length}):`);
    for (const r of linkedinRecipients) {
      lines.push(
        `- ${r.personName} (${r.campaignName}) — ${appBaseUrl}/campaigns/${r.campaignId}/linkedin-queue`,
      );
    }
    lines.push("");
  }

  const { gmail, ownEmail } = await createGmailClient(db, account.id);
  await sendGmailMessage(gmail, {
    from: ownEmail,
    to: ownEmail,
    subject: `${queued.length} follow-up${queued.length === 1 ? "" : "s"} ready for review`,
    body: lines.join("\n"),
  });

  return { notified: true };
}

export interface FollowUpCycleSummary {
  emailQueued: number;
  linkedinQueued: number;
  skippedDraftFailed: number;
  notified: boolean;
}

// The whole daily cycle: prepare today's due follow-ups, then tell the
// owner they're ready. Split into two functions above so each is testable
// on its own (prepareFollowUps' DB writes vs. notifyOwnerOfPendingFollowUps'
// Gmail call), and composed here for the cron route / manual script to call
// as one step.
export async function runFollowUpCycle(
  db: DrizzleDb,
  now: Date = new Date(),
): Promise<FollowUpCycleSummary> {
  const { queued, skippedDraftFailed } = await prepareFollowUps(db, now);
  const { notified } = await notifyOwnerOfPendingFollowUps(db, queued);

  return {
    emailQueued: queued.filter((r) => r.channel === "email").length,
    linkedinQueued: queued.filter((r) => r.channel === "linkedin").length,
    skippedDraftFailed,
    notified,
  };
}
