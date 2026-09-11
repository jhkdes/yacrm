import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { campaign, campaignRecipient, contact } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { fillLinkPlaceholder, generateDraftForPerson } from "@/lib/draft-generation";
import { buildTrackedLinkUrl, requireRedirectBaseUrl } from "@/lib/tracked-link";

export type CampaignChannel = "email" | "linkedin";
export type CampaignType = "interview_link" | "intro";

// Which Contact source a channel sends through — the only two sends M17+
// support (see docs/outreach-roadmap.md's funnel table).
const CHANNEL_TO_SOURCE: Record<CampaignChannel, "gmail" | "linkedin"> = {
  email: "gmail",
  linkedin: "linkedin",
};

export class CampaignNotFoundError extends Error {
  constructor(campaignId: number) {
    super(`No Campaign found with id ${campaignId}.`);
  }
}

// Persists a Campaign row. Before this, "campaign" meant only an ephemeral
// ranking pass (src/app/campaigns/page.tsx built a results list from
// rankPeopleForCampaign and threw it away on the next request) — this is
// what M17 fixes: a campaign and its recipients now survive a refresh.
//
// destinationUrl is where a recipient's tracked link (M18) sends them —
// required for an "interview_link" campaign, null for "intro" (which has
// no tracked link at all). Not validated here; the caller (createCampaignAction)
// validates it's a well-formed URL before this is ever reached.
export async function createCampaign(
  db: DrizzleDb,
  name: string,
  goal: string,
  destinationUrl: string | null,
  type: CampaignType = "interview_link",
): Promise<{ campaignId: number }> {
  const [row] = await db
    .insert(campaign)
    .values({ name, goal, destinationUrl, type })
    .returning({ id: campaign.id });
  return { campaignId: row.id };
}

export interface AddRecipientsResult {
  added: number;
  // No active Contact on the requested channel for this Person — e.g. a
  // ranked Person with only a LinkedIn contact when targeting by email.
  skippedNoContactForChannel: number;
  skippedDraftFailed: number;
  skippedAlreadyRecipient: number;
}

// Adds a batch of People to a Campaign as recipients: for each one,
// finds their Contact on the requested channel, generates a personalized
// draft against the Campaign's own persisted goal (not a separately-passed
// goal — keeps every recipient's draft grounded in the same goal the
// Campaign was created with, even if this is called across multiple
// requests), and stores it with a fresh tracking token in "drafted" status.
// A Person already an active recipient of this Campaign is left untouched
// rather than erroring, so re-submitting the same targeting page is
// harmless. A Person who was previously removed (soft-deleted) is revived
// with a fresh draft/token instead of colliding with their dead row — see
// the ON CONFLICT ... WHERE clause below.
//
// When the Campaign has a destinationUrl, the real tracked link is
// substituted into the draft body right here — via fillLinkPlaceholder,
// replacing the {{LINK}} placeholder the draft-generation prompt asks the
// model to use — so what's stored in draftBody is already correct and
// complete for both channels. This is deliberately not deferred to send
// time: LinkedIn's "send" is a manual copy-paste with no send-time
// processing step at all (see M21), so if the link isn't already baked
// into the stored text, it never gets in at all.
export async function addRecipients(
  db: DrizzleDb,
  campaignId: number,
  people: { personId: number }[],
  channel: CampaignChannel,
): Promise<AddRecipientsResult> {
  const [campaignRow] = await db
    .select({ goal: campaign.goal, destinationUrl: campaign.destinationUrl })
    .from(campaign)
    .where(and(eq(campaign.id, campaignId), isNull(campaign.deletedAt)));
  if (!campaignRow) throw new CampaignNotFoundError(campaignId);

  // Checked once, up front, rather than per-person inside the loop below —
  // a missing REDIRECT_BASE_URL is an environment-level misconfiguration,
  // not a per-person condition, so failing the whole call immediately
  // beats burning an LLM call per person before discovering it.
  if (campaignRow.destinationUrl) {
    requireRedirectBaseUrl();
  }

  const result: AddRecipientsResult = {
    added: 0,
    skippedNoContactForChannel: 0,
    skippedDraftFailed: 0,
    skippedAlreadyRecipient: 0,
  };
  const source = CHANNEL_TO_SOURCE[channel];

  for (const p of people) {
    const [targetContact] = await db
      .select({ id: contact.id })
      .from(contact)
      .where(
        and(
          eq(contact.personId, p.personId),
          eq(contact.source, source),
          eq(contact.status, "active"),
        ),
      );
    if (!targetContact) {
      result.skippedNoContactForChannel += 1;
      continue;
    }

    let draft;
    try {
      draft = await generateDraftForPerson(db, p.personId, campaignRow.goal);
    } catch (err) {
      console.warn(
        `[campaigns] draft generation failed for person ${p.personId}`,
        err,
      );
      result.skippedDraftFailed += 1;
      continue;
    }

    // Generated once and reused for both the tracked-link substitution and
    // the stored trackingToken column — those two must always be the exact
    // same value, or the link baked into the draft text would point at a
    // token the DB doesn't recognize.
    const trackingToken = crypto.randomUUID();
    const draftBody = campaignRow.destinationUrl
      ? fillLinkPlaceholder(draft.draft.body, buildTrackedLinkUrl(trackingToken))
      : draft.draft.body;

    const inserted = await db
      .insert(campaignRecipient)
      .values({
        campaignId,
        personId: p.personId,
        contactId: targetContact.id,
        channel,
        status: "drafted",
        draftSubject: draft.draft.subject,
        draftBody,
        trackingToken,
        firstSeenAt: null,
      })
      .onConflictDoUpdate({
        target: [campaignRecipient.campaignId, campaignRecipient.personId],
        set: {
          deletedAt: null,
          contactId: targetContact.id,
          channel,
          status: "drafted",
          draftSubject: draft.draft.subject,
          draftBody,
          trackingToken,
          // A revived recipient gets a brand-new trackingToken (a new
          // link) above, so any grace-window anchor from the old link
          // must not carry over — see click-tracking.ts's recordClick.
          firstSeenAt: null,
        },
        // Only a previously-removed (soft-deleted) row gets revived. An
        // already-active row hits this branch too (same unique key) but the
        // WHERE excludes it, so Postgres treats it as DO NOTHING — no row
        // comes back from .returning(), same as a real conflict no-op.
        where: isNotNull(campaignRecipient.deletedAt),
      })
      .returning({ id: campaignRecipient.id });

    if (inserted.length > 0) result.added += 1;
    else result.skippedAlreadyRecipient += 1;
  }

  return result;
}

// Soft-removes one recipient from a Campaign, regardless of their current
// status — including an already-sent one. Reversible via restoreRecipient;
// nothing is actually deleted.
export async function removeRecipient(
  db: DrizzleDb,
  campaignId: number,
  recipientId: number,
): Promise<{ removed: boolean }> {
  const updated = await db
    .update(campaignRecipient)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(campaignRecipient.id, recipientId),
        eq(campaignRecipient.campaignId, campaignId),
        isNull(campaignRecipient.deletedAt),
      ),
    )
    .returning({ id: campaignRecipient.id });

  return { removed: updated.length > 0 };
}

export async function restoreRecipient(
  db: DrizzleDb,
  campaignId: number,
  recipientId: number,
): Promise<{ restored: boolean }> {
  const updated = await db
    .update(campaignRecipient)
    .set({ deletedAt: null })
    .where(
      and(
        eq(campaignRecipient.id, recipientId),
        eq(campaignRecipient.campaignId, campaignId),
        isNotNull(campaignRecipient.deletedAt),
      ),
    )
    .returning({ id: campaignRecipient.id });

  return { restored: updated.length > 0 };
}

// Lets the user fix up a generated draft before it goes out. Restricted to
// `status = 'drafted'` rows — the WHERE clause is the enforcement point:
// once a recipient has moved past drafted (sent, or advanced by a click —
// see markLinkedInRecipientSent's comment on why that can happen before an
// explicit send too), the message already went out for real, so editing
// draftBody at that point wouldn't change anything and would be misleading
// to show as live. Matches zero rows (and so reports `updated: false`)
// rather than throwing, so a stale tab that raced an actual send just
// fails quietly instead of erroring.
export async function updateRecipientDraft(
  db: DrizzleDb,
  campaignId: number,
  recipientId: number,
  draft: { draftSubject: string; draftBody: string },
): Promise<{ updated: boolean }> {
  const updated = await db
    .update(campaignRecipient)
    .set({ draftSubject: draft.draftSubject, draftBody: draft.draftBody })
    .where(
      and(
        eq(campaignRecipient.id, recipientId),
        eq(campaignRecipient.campaignId, campaignId),
        eq(campaignRecipient.status, "drafted"),
        isNull(campaignRecipient.deletedAt),
      ),
    )
    .returning({ id: campaignRecipient.id });

  return { updated: updated.length > 0 };
}

// Soft-deletes a Campaign — its recipients are left untouched and simply
// become unreachable through it until restoreCampaign brings it back.
// Reversible; nothing is actually deleted.
export async function deleteCampaign(
  db: DrizzleDb,
  campaignId: number,
): Promise<{ deleted: boolean }> {
  const updated = await db
    .update(campaign)
    .set({ deletedAt: new Date() })
    .where(and(eq(campaign.id, campaignId), isNull(campaign.deletedAt)))
    .returning({ id: campaign.id });

  return { deleted: updated.length > 0 };
}

export async function restoreCampaign(
  db: DrizzleDb,
  campaignId: number,
): Promise<{ restored: boolean }> {
  const updated = await db
    .update(campaign)
    .set({ deletedAt: null })
    .where(and(eq(campaign.id, campaignId), isNotNull(campaign.deletedAt)))
    .returning({ id: campaign.id });

  return { restored: updated.length > 0 };
}
