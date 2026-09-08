"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  ACCESS_GATE_COOKIE_NAME,
  computeAccessToken,
} from "@/lib/access-gate";
import { db } from "@/db/client";
import { purgeContact, unpurgeIdentifier } from "@/lib/contact-purge";
import { ImportSummary, importGmailHistory, syncGmailHistory } from "@/lib/gmail-import";
import { approveAndSendDraft } from "@/lib/gmail-send";
import {
  importLinkedInConnections,
  parseConnectionsCsv,
} from "@/lib/linkedin-import";
import {
  importLinkedInMessages,
  parseMessagesCsv,
} from "@/lib/linkedin-messages-import";
import {
  addRecipients,
  CampaignChannel,
  createCampaign,
  deleteCampaign,
  removeRecipient,
  restoreCampaign,
  restoreRecipient,
} from "@/lib/campaigns";
import {
  markLinkedInRecipientSent,
  sendAllDraftedCampaignEmails,
  sendCampaignRecipientEmail,
} from "@/lib/campaign-send";
import {
  dismissMergeSuggestion,
  undismissMergeSuggestion,
} from "@/lib/merge-dismissals";
import { mergePersons, unmergePerson } from "@/lib/person-merge";

const ONE_MONTH_SECONDS = 60 * 60 * 24 * 30;

export async function loginAction(formData: FormData) {
  const password = formData.get("password");
  const next = formData.get("next");
  const nextPath =
    typeof next === "string" && next.startsWith("/") ? next : "/";
  const expected = process.env.APP_PASSWORD;

  if (
    typeof password !== "string" ||
    !password ||
    !expected ||
    password !== expected
  ) {
    redirect(
      `/login?${new URLSearchParams({ error: "invalid_password", next: nextPath }).toString()}`,
    );
  }

  const token = await computeAccessToken(expected);
  const cookieStore = await cookies();
  cookieStore.set(ACCESS_GATE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: ONE_MONTH_SECONDS,
    path: "/",
  });

  redirect(nextPath);
}

export async function logoutAction() {
  const cookieStore = await cookies();
  cookieStore.delete(ACCESS_GATE_COOKIE_NAME);
  redirect("/login");
}

function summaryToSearchParams(summary: ImportSummary): URLSearchParams {
  return new URLSearchParams({
    import_scanned: String(summary.messagesScanned),
    import_created: String(summary.eventsCreated),
    import_skipped: String(summary.eventsSkipped),
    import_skipped_no_address: String(summary.eventsSkippedNoAddress),
    import_skipped_self: String(summary.eventsSkippedSelfAddress),
    import_skipped_duplicate: String(summary.eventsSkippedDuplicate),
    import_skipped_bulk: String(summary.eventsSkippedBulkSender),
    import_skipped_purged: String(summary.eventsSkippedPurged),
    import_contacts: String(summary.contactsCreated),
    import_contacts_excluded_bulk: String(summary.contactsExcludedBulkSender),
    import_contacts_pending: String(summary.contactsPending),
    import_contacts_promoted: String(summary.contactsPromoted),
    import_events_embedded: String(summary.eventsEmbedded),
  });
}

async function findGmailAccount() {
  return db.query.oauthAccount.findFirst({
    where: (oauthAccount, { eq }) => eq(oauthAccount.provider, "gmail"),
    orderBy: (oauthAccount, { desc }) => desc(oauthAccount.createdAt),
  });
}

export async function importGmailAction(formData: FormData) {
  const startDate = formData.get("startDate");
  if (typeof startDate !== "string" || !startDate) {
    redirect("/?import_error=missing_start_date");
  }

  const account = await findGmailAccount();
  if (!account) {
    redirect("/?import_error=no_gmail_account");
  }

  let redirectTarget: string;
  try {
    const summary = await importGmailHistory(account.id, startDate);
    redirectTarget = `/?${summaryToSearchParams(summary).toString()}`;
  } catch (err) {
    console.error("Gmail import failed", err);
    redirectTarget = `/?import_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function syncGmailAction() {
  const account = await findGmailAccount();
  if (!account) {
    redirect("/?import_error=no_gmail_account");
  }

  let redirectTarget: string;
  try {
    const summary = await syncGmailHistory(account.id);
    redirectTarget = `/?${summaryToSearchParams(summary).toString()}`;
  } catch (err) {
    console.error("Gmail sync failed", err);
    redirectTarget = `/?import_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function importLinkedInConnectionsAction(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/import/linkedin?import_error=missing_file");
  }

  let redirectTarget: string;
  try {
    const csvText = await (file as File).text();
    const { rows, rowsSkippedNoUrl } = parseConnectionsCsv(csvText);
    const summary = await importLinkedInConnections(db, rows);
    redirectTarget = `/import/linkedin?${new URLSearchParams({
      rows_processed: String(summary.rowsProcessed),
      rows_skipped_no_url: String(rowsSkippedNoUrl),
      contacts_created: String(summary.contactsCreated),
      profile_events_written: String(summary.profileEventsWritten),
      events_embedded: String(summary.eventsEmbedded),
    }).toString()}`;
  } catch (err) {
    console.error("LinkedIn connections import failed", err);
    redirectTarget = `/import/linkedin?import_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function importLinkedInMessagesAction(formData: FormData) {
  const file = formData.get("file");
  const ownProfileUrl = formData.get("ownProfileUrl");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/import/linkedin?messages_import_error=missing_file");
  }
  if (typeof ownProfileUrl !== "string" || !ownProfileUrl.trim()) {
    redirect("/import/linkedin?messages_import_error=missing_own_profile_url");
  }

  let redirectTarget: string;
  try {
    const csvText = await (file as File).text();
    const { rows, rowsSkippedEmptyContent, rowsSkippedBadDate } =
      parseMessagesCsv(csvText);
    const summary = await importLinkedInMessages(
      db,
      rows,
      ownProfileUrl as string,
    );
    redirectTarget = `/import/linkedin?${new URLSearchParams({
      msg_rows_processed: String(summary.rowsProcessed),
      msg_rows_skipped_empty: String(rowsSkippedEmptyContent),
      msg_rows_skipped_bad_date: String(rowsSkippedBadDate),
      msg_rows_skipped_group: String(summary.rowsSkippedGroupConversation),
      msg_rows_skipped_unresolvable: String(summary.rowsSkippedUnresolvable),
      msg_contacts_created: String(summary.contactsCreated),
      msg_contacts_pending: String(summary.contactsPending),
      msg_contacts_promoted: String(summary.contactsPromoted),
      msg_events_created: String(summary.eventsCreated),
      msg_events_skipped_duplicate: String(summary.eventsSkippedDuplicate),
      msg_events_embedded: String(summary.eventsEmbedded),
    }).toString()}`;
  } catch (err) {
    console.error("LinkedIn messages import failed", err);
    redirectTarget = `/import/linkedin?messages_import_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

const SOURCES = ["gmail", "hotmail", "linkedin", "sms"] as const;
type Source = (typeof SOURCES)[number];

function isSource(value: unknown): value is Source {
  return SOURCES.includes(value as Source);
}

export async function unpurgeAction(formData: FormData) {
  const source = formData.get("source");
  const sourceIdentifier = formData.get("sourceIdentifier");

  if (!isSource(source) || typeof sourceIdentifier !== "string") {
    redirect("/contacts?purge_error=invalid_unpurge_request");
  }

  let redirectTarget: string;
  try {
    await unpurgeIdentifier(db, source, sourceIdentifier);
    redirectTarget = "/contacts?unpurged=1";
  } catch (err) {
    console.error("Contact un-purge failed", err);
    redirectTarget = `/contacts?purge_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function purgeContactAction(formData: FormData) {
  const contactId = Number(formData.get("contactId"));
  if (!Number.isInteger(contactId)) {
    redirect("/contacts?purge_error=invalid_contact_id");
  }

  let redirectTarget: string;
  try {
    await purgeContact(db, contactId);
    redirectTarget = "/contacts?purged=1";
  } catch (err) {
    console.error("Contact purge failed", err);
    redirectTarget = `/contacts?purge_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

function parsePersonPair(formData: FormData): [number, number] | null {
  const personAId = Number(formData.get("personAId"));
  const personBId = Number(formData.get("personBId"));
  if (!Number.isInteger(personAId) || !Number.isInteger(personBId)) {
    return null;
  }
  return [personAId, personBId];
}

export async function acceptMergeAction(formData: FormData) {
  const pair = parsePersonPair(formData);
  if (!pair) {
    redirect("/merges?merge_error=invalid_person_pair");
  }

  let redirectTarget: string;
  try {
    await mergePersons(db, pair[0], pair[1]);
    redirectTarget = "/merges?merged=1";
  } catch (err) {
    console.error("Merge failed", err);
    redirectTarget = `/merges?merge_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function rejectMergeAction(formData: FormData) {
  const pair = parsePersonPair(formData);
  if (!pair) {
    redirect("/merges?merge_error=invalid_person_pair");
  }

  let redirectTarget: string;
  try {
    await dismissMergeSuggestion(db, pair[0], pair[1]);
    redirectTarget = "/merges?rejected=1";
  } catch (err) {
    console.error("Reject failed", err);
    redirectTarget = `/merges?merge_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function undismissMergeAction(formData: FormData) {
  const pair = parsePersonPair(formData);
  if (!pair) {
    redirect("/merges?merge_error=invalid_person_pair");
  }

  let redirectTarget: string;
  try {
    await undismissMergeSuggestion(db, pair[0], pair[1]);
    redirectTarget = "/merges?undismissed=1";
  } catch (err) {
    console.error("Undismiss failed", err);
    redirectTarget = `/merges?merge_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function acceptAllMergesAction(formData: FormData) {
  const raw = formData.get("pairs");
  let redirectTarget: string;
  try {
    if (typeof raw !== "string") {
      throw new Error("Missing pairs");
    }
    const pairs = JSON.parse(raw) as [number, number][];

    // A batch can contain chains (e.g. (1,2) then (2,3)) where an earlier
    // merge in the same batch already absorbed one side of a later pair —
    // resolve each id to its current surviving Person before merging.
    const redirectMap = new Map<number, number>();
    const resolve = (id: number): number => {
      let current = id;
      while (redirectMap.has(current)) current = redirectMap.get(current)!;
      return current;
    };

    for (const [rawA, rawB] of pairs) {
      const a = resolve(rawA);
      const b = resolve(rawB);
      if (a === b) continue;
      const result = await mergePersons(db, a, b);
      const absorbed =
        result.survivingPersonId === a ? b : a;
      redirectMap.set(absorbed, result.survivingPersonId);
    }

    redirectTarget = "/merges?merged=1";
  } catch (err) {
    console.error("Bulk merge failed", err);
    redirectTarget = `/merges?merge_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function sendDraftAction(formData: FormData) {
  const personId = Number(formData.get("personId"));
  const contactId = Number(formData.get("contactId"));
  const subject = formData.get("subject");
  const body = formData.get("body");
  const goal = formData.get("goal");
  const personName = formData.get("personName");

  const draftUrl = (extra: Record<string, string>) =>
    `/campaigns/draft?${new URLSearchParams({
      personId: String(personId),
      goal: typeof goal === "string" ? goal : "",
      ...extra,
    }).toString()}`;

  if (
    !Number.isInteger(personId) ||
    !Number.isInteger(contactId) ||
    typeof subject !== "string" ||
    !subject ||
    typeof body !== "string" ||
    !body ||
    typeof goal !== "string" ||
    !goal
  ) {
    redirect(draftUrl({ sendError: "invalid_send_request" }));
  }

  const account = await findGmailAccount();
  if (!account) {
    redirect(draftUrl({ sendError: "no_gmail_account" }));
  }

  let redirectTarget: string;
  try {
    await approveAndSendDraft(
      account.id,
      contactId,
      personId,
      subject as string,
      body as string,
    );
    redirectTarget = `/campaigns?${new URLSearchParams({
      goal: goal as string,
      sent: typeof personName === "string" ? personName : "1",
    }).toString()}`;
  } catch (err) {
    console.error("Draft send failed", err);
    redirectTarget = draftUrl({
      sendError: err instanceof Error ? err.message : "unknown_error",
    });
  }

  redirect(redirectTarget);
}

function isCampaignChannel(value: unknown): value is CampaignChannel {
  return value === "email" || value === "linkedin";
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function createCampaignAction(formData: FormData) {
  const name = formData.get("name");
  const goal = formData.get("goal");
  const channel = formData.get("channel");
  const destinationUrl = formData.get("destinationUrl");
  const personIds = formData
    .getAll("personIds")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n));

  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof goal !== "string" ||
    !goal.trim() ||
    !isCampaignChannel(channel) ||
    typeof destinationUrl !== "string" ||
    !isValidHttpUrl(destinationUrl) ||
    personIds.length === 0
  ) {
    redirect(
      `/campaigns?${new URLSearchParams({
        goal: typeof goal === "string" ? goal : "",
        error: "invalid_campaign_request",
      }).toString()}`,
    );
  }

  let redirectTarget: string;
  try {
    const { campaignId } = await createCampaign(
      db,
      name as string,
      goal as string,
      destinationUrl as string,
    );
    const result = await addRecipients(
      db,
      campaignId,
      personIds.map((personId) => ({ personId })),
      channel as CampaignChannel,
    );
    redirectTarget = `/campaigns/${campaignId}?${new URLSearchParams({
      added: String(result.added),
      skipped_no_contact: String(result.skippedNoContactForChannel),
      skipped_draft_failed: String(result.skippedDraftFailed),
    }).toString()}`;
  } catch (err) {
    console.error("Campaign creation failed", err);
    redirectTarget = `/campaigns?${new URLSearchParams({
      goal: goal as string,
      error: err instanceof Error ? err.message : "unknown_error",
    }).toString()}`;
  }

  redirect(redirectTarget);
}

export async function addRecipientsToCampaignAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const channel = formData.get("channel");
  const personIds = formData
    .getAll("personIds")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n));

  if (
    !Number.isInteger(campaignId) ||
    !isCampaignChannel(channel) ||
    personIds.length === 0
  ) {
    redirect(`/campaigns/${campaignId}?error=invalid_add_request`);
  }

  let redirectTarget: string;
  try {
    const result = await addRecipients(
      db,
      campaignId,
      personIds.map((personId) => ({ personId })),
      channel as CampaignChannel,
    );
    redirectTarget = `/campaigns/${campaignId}?${new URLSearchParams({
      added: String(result.added),
      skipped_no_contact: String(result.skippedNoContactForChannel),
      skipped_draft_failed: String(result.skippedDraftFailed),
      skipped_already: String(result.skippedAlreadyRecipient),
    }).toString()}`;
  } catch (err) {
    console.error("Adding recipients to campaign failed", err);
    redirectTarget = `/campaigns/${campaignId}?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function removeCampaignRecipientAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const recipientId = Number(formData.get("recipientId"));

  if (!Number.isInteger(campaignId) || !Number.isInteger(recipientId)) {
    redirect(`/campaigns/${campaignId}?error=invalid_remove_request`);
  }

  let redirectTarget: string;
  try {
    const { removed } = await removeRecipient(db, campaignId, recipientId);
    // undo_recipient_id drives a one-shot "Undo" link on the campaign page —
    // present only on this redirect, so it disappears the moment the user
    // navigates anywhere else (no persistent "recently removed" list).
    redirectTarget = removed
      ? `/campaigns/${campaignId}?removed=1&undo_recipient_id=${recipientId}`
      : `/campaigns/${campaignId}?error=recipient_not_found`;
  } catch (err) {
    console.error("Removing campaign recipient failed", err);
    redirectTarget = `/campaigns/${campaignId}?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function restoreCampaignRecipientAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const recipientId = Number(formData.get("recipientId"));

  if (!Number.isInteger(campaignId) || !Number.isInteger(recipientId)) {
    redirect(`/campaigns/${campaignId}?error=invalid_restore_request`);
  }

  let redirectTarget: string;
  try {
    const { restored } = await restoreRecipient(db, campaignId, recipientId);
    redirectTarget = `/campaigns/${campaignId}?${
      restored ? "restored=1" : "error=recipient_not_found"
    }`;
  } catch (err) {
    console.error("Restoring campaign recipient failed", err);
    redirectTarget = `/campaigns/${campaignId}?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function sendCampaignRecipientAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const recipientId = Number(formData.get("recipientId"));

  if (!Number.isInteger(campaignId) || !Number.isInteger(recipientId)) {
    redirect(`/campaigns/${campaignId}?error=invalid_send_request`);
  }

  const account = await findGmailAccount();
  if (!account) {
    redirect(`/campaigns/${campaignId}?error=no_gmail_account`);
  }

  let redirectTarget: string;
  try {
    await sendCampaignRecipientEmail(db, account.id, recipientId);
    redirectTarget = `/campaigns/${campaignId}?sent_recipient=1`;
  } catch (err) {
    console.error("Campaign recipient send failed", err);
    redirectTarget = `/campaigns/${campaignId}?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

// Sends every still-drafted email-channel recipient of one Campaign in one
// click — the bulk counterpart to sendCampaignRecipientAction, for
// reviewing a batch (e.g. a day's worth of follow-ups queued by the M23
// cron job) and sending it all at once instead of one at a time.
export async function sendAllCampaignRecipientsAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));

  if (!Number.isInteger(campaignId)) {
    redirect(`/campaigns/${campaignId}?error=invalid_send_request`);
  }

  const account = await findGmailAccount();
  if (!account) {
    redirect(`/campaigns/${campaignId}?error=no_gmail_account`);
  }

  let redirectTarget: string;
  try {
    const { sent, failed } = await sendAllDraftedCampaignEmails(
      db,
      account.id,
      campaignId,
    );
    redirectTarget = `/campaigns/${campaignId}?sent_all=${sent}&sent_all_failed=${failed}`;
  } catch (err) {
    console.error("Campaign bulk send failed", err);
    redirectTarget = `/campaigns/${campaignId}?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function markLinkedinRecipientSentAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const recipientId = Number(formData.get("recipientId"));
  const queueUrl = `/campaigns/${campaignId}/linkedin-queue`;

  if (!Number.isInteger(campaignId) || !Number.isInteger(recipientId)) {
    redirect(`${queueUrl}?error=invalid_request`);
  }

  let redirectTarget: string;
  try {
    await markLinkedInRecipientSent(db, recipientId);
    redirectTarget = `${queueUrl}?sent=1`;
  } catch (err) {
    console.error("Marking LinkedIn recipient sent failed", err);
    redirectTarget = `${queueUrl}?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function deleteCampaignAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  if (!Number.isInteger(campaignId)) {
    redirect("/campaigns?error=invalid_delete_request");
  }

  let redirectTarget: string;
  try {
    const { deleted } = await deleteCampaign(db, campaignId);
    // Same one-shot pattern as recipient removal — undo_campaign_id only
    // rides along on this redirect.
    redirectTarget = deleted
      ? `/campaigns?campaign_deleted=1&undo_campaign_id=${campaignId}`
      : "/campaigns?error=campaign_not_found";
  } catch (err) {
    console.error("Deleting campaign failed", err);
    redirectTarget = `/campaigns?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function restoreCampaignAction(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  if (!Number.isInteger(campaignId)) {
    redirect("/campaigns?error=invalid_restore_request");
  }

  let redirectTarget: string;
  try {
    const { restored } = await restoreCampaign(db, campaignId);
    redirectTarget = restored
      ? `/campaigns/${campaignId}?campaign_restored=1`
      : "/campaigns?error=campaign_not_found";
  } catch (err) {
    console.error("Restoring campaign failed", err);
    redirectTarget = `/campaigns?error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}

export async function unmergePersonAction(formData: FormData) {
  const personId = Number(formData.get("personId"));
  if (!Number.isInteger(personId)) {
    redirect("/people?unmerge_error=invalid_person_id");
  }

  let redirectTarget: string;
  try {
    await unmergePerson(db, personId);
    redirectTarget = "/people?unmerged=1";
  } catch (err) {
    console.error("Un-merge failed", err);
    redirectTarget = `/people?unmerge_error=${encodeURIComponent(
      err instanceof Error ? err.message : "unknown_error",
    )}`;
  }

  redirect(redirectTarget);
}
