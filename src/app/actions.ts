"use server";

import { redirect } from "next/navigation";

import { db } from "@/db/client";
import { purgeContact, unpurgeIdentifier } from "@/lib/contact-purge";
import { ImportSummary, importGmailHistory, syncGmailHistory } from "@/lib/gmail-import";
import {
  dismissMergeSuggestion,
  undismissMergeSuggestion,
} from "@/lib/merge-dismissals";
import { mergePersons, unmergePerson } from "@/lib/person-merge";

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
