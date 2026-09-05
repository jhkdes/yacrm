import { eq } from "drizzle-orm";
import { gmail_v1, google } from "googleapis";

import { db as defaultDb } from "@/db/client";
import { event, oauthAccount } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { AdaptiveThrottle } from "@/lib/adaptive-throttle";
import {
  findOrCreateContact,
  hasOppositeDirectionHistory,
} from "@/lib/contact-resolution";
import { getPurgedIdentifiers } from "@/lib/contact-purge";
import { generateEmbeddings } from "@/lib/embeddings";
import { createOAuthClient } from "@/lib/google";
import {
  CandidateMessage,
  filterToPersonalContacts,
  isBulkOrAutomatedMessage,
} from "@/lib/gmail-filtering";
import {
  extractPlainTextBody,
  getHeader,
  parseFirstAddress,
  toGmailDateQuery,
} from "@/lib/gmail-parsing";
import { updatePersonSummaryEmbedding } from "@/lib/person-embedding";

export interface ImportSummary {
  messagesScanned: number;
  eventsCreated: number;
  eventsSkipped: number;
  eventsSkippedNoAddress: number;
  eventsSkippedSelfAddress: number;
  eventsSkippedDuplicate: number;
  eventsSkippedBulkSender: number;
  eventsSkippedPurged: number;
  contactsCreated: number;
  contactsExcludedBulkSender: number;
  // Addresses with only one-way messages so far — still persisted (not
  // discarded), so a reply arriving in a later sync can promote them.
  contactsPending: number;
  // Addresses whose pending status was resolved to active this run, either
  // because this batch itself is two-way, or because a reply just arrived
  // to complete a conversation whose other half was imported previously.
  contactsPromoted: number;
  // Events that got a real embedding this run. Can be less than
  // eventsCreated if embedding generation failed (e.g. no/invalid
  // VOYAGE_API_KEY) — the import still succeeds without them.
  eventsEmbedded: number;
}

interface MessagePayload {
  messageId: string;
  otherPartyName: string | null;
  subject: string | null;
  bodyText: string;
  occurredAt: Date;
}

export async function loadGmailAccount(db: DrizzleDb, accountId: number) {
  const account = await db.query.oauthAccount.findFirst({
    where: eq(oauthAccount.id, accountId),
  });
  if (!account) {
    throw new Error(`No oauth_account found with id ${accountId}`);
  }
  return account;
}

export async function createGmailClient(db: DrizzleDb, accountId: number) {
  const account = await loadGmailAccount(db, accountId);
  const oauthClient = createOAuthClient();

  oauthClient.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken ?? undefined,
    expiry_date: account.expiresAt.getTime(),
  });

  // googleapis auto-refreshes expired access tokens; persist the refreshed
  // token so future imports don't need to refresh again unnecessarily.
  oauthClient.on("tokens", (tokens) => {
    void db
      .update(oauthAccount)
      .set({
        ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
        ...(tokens.refresh_token
          ? { refreshToken: tokens.refresh_token }
          : {}),
        ...(tokens.expiry_date
          ? { expiresAt: new Date(tokens.expiry_date) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(oauthAccount.id, accountId));
  });

  return {
    gmail: google.gmail({ version: "v1", auth: oauthClient }),
    ownEmail: account.emailAddress.toLowerCase(),
  };
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// Gmail's after: query is day-granular, so periodic sync re-scans from this
// date rather than an exact timestamp — re-scanned messages dedupe
// harmlessly on insert.
export async function recordSuccessfulSync(
  db: DrizzleDb,
  accountId: number,
  date: string,
): Promise<void> {
  await db
    .update(oauthAccount)
    .set({ lastSyncedDate: date, updatedAt: new Date() })
    .where(eq(oauthAccount.id, accountId));
}

export class NeverImportedError extends Error {
  constructor() {
    super(
      "This account has no prior import to sync from. Run an initial import with a start date first.",
    );
  }
}

// Periodic sync continues from the last successful import/sync's date
// automatically, with no user-specified date needed — it requires at least
// one prior import so there's a starting point to continue from.
export function resolveSyncStartDate(lastSyncedDate: string | null): string {
  if (!lastSyncedDate) {
    throw new NeverImportedError();
  }
  return lastSyncedDate;
}

export async function importGmailHistory(
  accountId: number,
  startDate: string,
): Promise<ImportSummary> {
  const { gmail, ownEmail } = await createGmailClient(defaultDb, accountId);
  const summary = await runGmailImport(defaultDb, gmail, ownEmail, startDate);
  await recordSuccessfulSync(defaultDb, accountId, todayDateString());
  return summary;
}

export async function syncGmailHistory(
  accountId: number,
): Promise<ImportSummary> {
  const account = await loadGmailAccount(defaultDb, accountId);
  const startDate = resolveSyncStartDate(account.lastSyncedDate);
  return importGmailHistory(accountId, startDate);
}

// Split out from importGmailHistory so tests can inject a fake Gmail client
// and a real (in-memory) test DB, exercising the actual filtering/dedupe/
// purge logic without a real OAuth account or network call.
export async function runGmailImport(
  db: DrizzleDb,
  gmail: gmail_v1.Gmail,
  ownEmail: string,
  startDate: string,
): Promise<ImportSummary> {
  const throttle = new AdaptiveThrottle({ label: "gmail-import" });

  const messageIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await throttle.run(() =>
      gmail.users.messages.list({
        userId: "me",
        q: toGmailDateQuery(startDate),
        pageToken,
        maxResults: 100,
      }),
    );
    messageIds.push(
      ...(res.data.messages ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id)),
    );
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const summary: ImportSummary = {
    messagesScanned: messageIds.length,
    eventsCreated: 0,
    eventsSkipped: 0,
    eventsSkippedNoAddress: 0,
    eventsSkippedSelfAddress: 0,
    eventsSkippedDuplicate: 0,
    eventsSkippedBulkSender: 0,
    eventsSkippedPurged: 0,
    contactsCreated: 0,
    contactsExcludedBulkSender: 0,
    contactsPending: 0,
    contactsPromoted: 0,
    eventsEmbedded: 0,
  };

  const purgedEmails = await getPurgedIdentifiers(db, "gmail");

  // Phase 1: fetch every message and resolve its other-party address, but
  // don't touch the DB yet — two-way filtering needs to see every message
  // for an address before deciding whether that address is a personal
  // contact at all.
  const candidates: CandidateMessage<MessagePayload>[] = [];
  const importStartedAt = Date.now();
  const PROGRESS_LOG_INTERVAL = 25;

  for (const [index, messageId] of messageIds.entries()) {
    const { data: message } = await throttle.run(() =>
      gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      }),
    );
    await throttle.wait();

    const processedCount = index + 1;
    if (
      processedCount % PROGRESS_LOG_INTERVAL === 0 ||
      processedCount === messageIds.length
    ) {
      const elapsedSeconds = ((Date.now() - importStartedAt) / 1000).toFixed(
        1,
      );
      console.log(
        `[gmail-import] fetched ${processedCount}/${messageIds.length} messages (${elapsedSeconds}s elapsed, throttle ${throttle.currentDelayMs}ms)`,
      );
    }

    const isOutbound = message.labelIds?.includes("SENT") ?? false;
    const fromAddress = parseFirstAddress(getHeader(message, "From"));
    const toAddress = parseFirstAddress(getHeader(message, "To"));
    const otherParty = isOutbound ? toAddress : fromAddress;

    if (!otherParty) {
      summary.eventsSkipped += 1;
      summary.eventsSkippedNoAddress += 1;
      console.warn("[gmail-import] no resolvable address", {
        messageId,
        isOutbound,
        from: getHeader(message, "From"),
        to: getHeader(message, "To"),
      });
      continue;
    }
    if (otherParty.email === ownEmail) {
      summary.eventsSkipped += 1;
      summary.eventsSkippedSelfAddress += 1;
      console.warn("[gmail-import] resolved to own address", {
        messageId,
        isOutbound,
        from: getHeader(message, "From"),
        to: getHeader(message, "To"),
      });
      continue;
    }
    if (purgedEmails.has(otherParty.email)) {
      summary.eventsSkipped += 1;
      summary.eventsSkippedPurged += 1;
      continue;
    }

    const bodyText =
      extractPlainTextBody(message.payload ?? undefined) ??
      message.snippet ??
      "";
    const occurredAt = message.internalDate
      ? new Date(Number(message.internalDate))
      : new Date();

    candidates.push({
      otherPartyEmail: otherParty.email,
      direction: isOutbound ? "outbound" : "inbound",
      isBulkSignal: !isOutbound && isBulkOrAutomatedMessage(message),
      payload: {
        messageId,
        otherPartyName: otherParty.name,
        subject: getHeader(message, "Subject") ?? null,
        bodyText,
        occurredAt,
      },
    });
  }

  // Phase 2: bulk/automated senders are hard-excluded regardless of
  // two-way status. Everything else gets persisted — either "active"
  // (two-way within this batch) or "pending" (one-way so far, but kept so a
  // reply in a later sync can still complete the conversation).
  const { kept, excludedOneWayEmails, excludedBulkEmails } =
    filterToPersonalContacts(candidates);

  summary.contactsExcludedBulkSender = excludedBulkEmails.size;
  for (const candidate of candidates) {
    if (excludedBulkEmails.has(candidate.otherPartyEmail)) {
      summary.eventsSkipped += 1;
      summary.eventsSkippedBulkSender += 1;
    }
  }

  // For each one-way address, check whether a previous run already has the
  // missing direction — resolved once per address, not per message, since
  // every message for a one-way address shares the same direction.
  const oneWayAddressStatus = new Map<string, "pending" | "active">();
  for (const email of excludedOneWayEmails) {
    const batchDirection = candidates.find(
      (c) => c.otherPartyEmail === email,
    )!.direction;
    const alreadyTwoWay = await hasOppositeDirectionHistory(
      db,
      "gmail",
      email,
      batchDirection,
    );
    const status = alreadyTwoWay ? "active" : "pending";
    oneWayAddressStatus.set(email, status);
    if (status === "pending") summary.contactsPending += 1;
    else summary.contactsPromoted += 1;
  }

  const toPersist: { candidate: (typeof candidates)[number]; status: "pending" | "active" }[] =
    [
      ...kept.map((candidate) => ({ candidate, status: "active" as const })),
      ...candidates
        .filter((c) => excludedOneWayEmails.has(c.otherPartyEmail))
        .map((candidate) => ({
          candidate,
          status: oneWayAddressStatus.get(candidate.otherPartyEmail)!,
        })),
    ];

  // Batch-embed everything up front — far cheaper than one API call per
  // message. Resilient to failure: if embedding generation errors (e.g. no
  // VOYAGE_API_KEY configured), the import still proceeds with null
  // embeddings rather than failing outright.
  let embeddings: (number[] | null)[] = toPersist.map(() => null);
  try {
    const generated = await generateEmbeddings(
      toPersist.map(({ candidate }) => candidate.payload.bodyText),
    );
    embeddings = generated;
  } catch (err) {
    console.warn(
      "[gmail-import] embedding generation failed, continuing without embeddings",
      err,
    );
  }

  const contactIdCache = new Map<string, number>();
  const affectedPersonIds = new Set<number>();

  for (const [index, { candidate, status }] of toPersist.entries()) {
    let contactId = contactIdCache.get(candidate.otherPartyEmail);
    if (contactId === undefined) {
      const result = await findOrCreateContact(
        db,
        "gmail",
        {
          email: candidate.otherPartyEmail,
          name: candidate.payload.otherPartyName,
        },
        status,
      );
      contactId = result.contactId;
      contactIdCache.set(candidate.otherPartyEmail, contactId);
      if (result.wasCreated) summary.contactsCreated += 1;
      affectedPersonIds.add(result.personId);
    }

    const embedding = embeddings[index] ?? null;
    const inserted = await db
      .insert(event)
      .values({
        contactId,
        direction: candidate.direction,
        occurredAt: candidate.payload.occurredAt,
        subject: candidate.payload.subject,
        bodyText: candidate.payload.bodyText,
        sourceMessageId: candidate.payload.messageId,
        embedding,
      })
      .onConflictDoNothing({
        target: [event.contactId, event.sourceMessageId],
      })
      .returning({ id: event.id });

    if (inserted.length > 0) {
      summary.eventsCreated += 1;
      if (embedding) summary.eventsEmbedded += 1;
    } else {
      summary.eventsSkipped += 1;
      summary.eventsSkippedDuplicate += 1;
    }
  }

  for (const personId of affectedPersonIds) {
    await updatePersonSummaryEmbedding(db, personId);
  }

  return summary;
}
