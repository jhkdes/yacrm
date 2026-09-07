import { parse } from "csv-parse/sync";

import { event } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import {
  findOrCreateContact,
  hasOppositeDirectionHistory,
} from "@/lib/contact-resolution";
import { generateEmbeddings } from "@/lib/embeddings";
import { normalizeProfileUrl } from "@/lib/linkedin-import";
import { updatePersonSummaryEmbedding } from "@/lib/person-embedding";

export interface LinkedInMessageRow {
  conversationId: string;
  senderName: string | null;
  senderProfileUrl: string;
  // Raw field as LinkedIn exports it — usually one URL, but named plural
  // because a group conversation lists several, comma-separated.
  recipientProfileUrls: string;
  occurredAt: Date;
  subject: string | null;
  content: string;
}

export interface ResolvedLinkedInMessage {
  conversationId: string;
  direction: "inbound" | "outbound";
  otherPartyProfileUrl: string;
  otherPartyName: string | null;
  occurredAt: Date;
  subject: string | null;
  content: string;
}

export interface LinkedInMessagesImportSummary {
  rowsProcessed: number;
  rowsSkippedEmptyContent: number;
  rowsSkippedGroupConversation: number;
  rowsSkippedUnresolvable: number;
  eventsCreated: number;
  eventsSkippedDuplicate: number;
  contactsCreated: number;
  contactsPending: number;
  contactsPromoted: number;
  eventsEmbedded: number;
}

// Includes the opening quote — LinkedIn quotes every header field, so
// slicing from a bare "CONVERSATION ID" match would cut off that leading
// quote and corrupt the first field.
const HEADER_MARKER = '"CONVERSATION ID"';

function parseMessageDate(value: string): Date | null {
  // LinkedIn's format is "2026-09-04 18:12:23 UTC" — reshape into a form
  // Date parses unambiguously rather than relying on its lenient fallback
  // parser for a non-ISO string.
  const isoLike = value.trim().replace(" ", "T").replace(/\s*UTC$/, "Z");
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Pure CSV parsing only — no notion yet of which party is "you" (that
// requires the separate ownProfileUrl input resolved in
// resolveMessageDirection, since nothing in the file itself says which
// side is the account owner).
export function parseMessagesCsv(csvText: string): {
  rows: LinkedInMessageRow[];
  rowsSkippedEmptyContent: number;
  rowsSkippedBadDate: number;
} {
  const headerIndex = csvText.indexOf(HEADER_MARKER);
  if (headerIndex === -1) {
    throw new Error(
      "Unrecognized LinkedIn messages export: couldn't find the header row",
    );
  }

  const records: Record<string, string>[] = parse(
    csvText.slice(headerIndex),
    { columns: true, skip_empty_lines: true, relax_column_count: true },
  );

  const rows: LinkedInMessageRow[] = [];
  let rowsSkippedEmptyContent = 0;
  let rowsSkippedBadDate = 0;

  for (const record of records) {
    const content = record["CONTENT"]?.trim();
    if (!content) {
      rowsSkippedEmptyContent += 1;
      continue;
    }
    const occurredAt = parseMessageDate(record["DATE"] ?? "");
    if (!occurredAt) {
      rowsSkippedBadDate += 1;
      continue;
    }

    rows.push({
      conversationId: record["CONVERSATION ID"]?.trim() ?? "",
      senderName: record["FROM"]?.trim() || null,
      senderProfileUrl: normalizeProfileUrl(
        record["SENDER PROFILE URL"]?.trim() ?? "",
      ),
      recipientProfileUrls: record["RECIPIENT PROFILE URLS"]?.trim() ?? "",
      occurredAt,
      subject: record["SUBJECT"]?.trim() || null,
      content,
    });
  }

  return { rows, rowsSkippedEmptyContent, rowsSkippedBadDate };
}

// Pure: given one row and the account owner's own profile URL, decides
// which side is "the other party" and which direction the message went.
// Returns null for anything this import doesn't support — a group
// conversation (more than one recipient), or a row where neither side is
// the account owner (shouldn't happen in a personal export, but a
// malformed row shouldn't crash the whole import).
export function resolveMessageDirection(
  row: LinkedInMessageRow,
  ownProfileUrl: string,
): ResolvedLinkedInMessage | { skippedReason: "group" | "unresolvable" } {
  const recipients = row.recipientProfileUrls
    .split(",")
    .map((url) => normalizeProfileUrl(url))
    .filter(Boolean);

  if (recipients.length > 1) {
    return { skippedReason: "group" };
  }

  const recipientProfileUrl = recipients[0] ?? "";
  const ownNormalized = normalizeProfileUrl(ownProfileUrl);

  if (row.senderProfileUrl === ownNormalized) {
    return {
      conversationId: row.conversationId,
      direction: "outbound",
      otherPartyProfileUrl: recipientProfileUrl,
      otherPartyName: null,
      occurredAt: row.occurredAt,
      subject: row.subject,
      content: row.content,
    };
  }
  if (recipientProfileUrl === ownNormalized) {
    return {
      conversationId: row.conversationId,
      direction: "inbound",
      otherPartyProfileUrl: row.senderProfileUrl,
      otherPartyName: row.senderName,
      occurredAt: row.occurredAt,
      subject: row.subject,
      content: row.content,
    };
  }
  return { skippedReason: "unresolvable" };
}

// Imports a parsed messages export against a known ownProfileUrl (the
// account owner's own LinkedIn profile URL — LinkedIn's export has no
// OAuth-account-style "whose mailbox is this" concept the way Gmail does,
// so it has to be supplied explicitly rather than inferred; inferring it
// from message frequency is fragile — a single-conversation export or an
// unusually active correspondent can tie or beat the true owner, and
// guessing wrong would silently flip every inbound/outbound direction).
export async function importLinkedInMessages(
  db: DrizzleDb,
  rows: LinkedInMessageRow[],
  ownProfileUrl: string,
): Promise<LinkedInMessagesImportSummary> {
  const summary: LinkedInMessagesImportSummary = {
    rowsProcessed: rows.length,
    rowsSkippedEmptyContent: 0,
    rowsSkippedGroupConversation: 0,
    rowsSkippedUnresolvable: 0,
    eventsCreated: 0,
    eventsSkippedDuplicate: 0,
    contactsCreated: 0,
    contactsPending: 0,
    contactsPromoted: 0,
    eventsEmbedded: 0,
  };

  const resolved: ResolvedLinkedInMessage[] = [];
  for (const row of rows) {
    const result = resolveMessageDirection(row, ownProfileUrl);
    if ("skippedReason" in result) {
      if (result.skippedReason === "group") {
        summary.rowsSkippedGroupConversation += 1;
      } else {
        summary.rowsSkippedUnresolvable += 1;
      }
      continue;
    }
    resolved.push(result);
  }

  // Same two-way-detection shape as gmail-import: within this batch, an
  // other-party address with both directions present is clearly active;
  // one-way-only falls back to checking prior-run history before landing
  // on "pending".
  const directionsByParty = new Map<string, Set<"inbound" | "outbound">>();
  for (const message of resolved) {
    const set = directionsByParty.get(message.otherPartyProfileUrl) ?? new Set();
    set.add(message.direction);
    directionsByParty.set(message.otherPartyProfileUrl, set);
  }

  const statusByParty = new Map<string, "pending" | "active">();
  for (const [profileUrl, directions] of directionsByParty) {
    if (directions.size === 2) {
      statusByParty.set(profileUrl, "active");
      continue;
    }
    const onlyDirection = [...directions][0];
    const alreadyTwoWay = await hasOppositeDirectionHistory(
      db,
      "linkedin",
      profileUrl,
      onlyDirection,
    );
    const status = alreadyTwoWay ? "active" : "pending";
    statusByParty.set(profileUrl, status);
    if (status === "pending") summary.contactsPending += 1;
    else summary.contactsPromoted += 1;
  }

  let embeddings: (number[] | null)[] = resolved.map(() => null);
  try {
    embeddings = await generateEmbeddings(resolved.map((m) => m.content));
  } catch (err) {
    console.warn(
      "[linkedin-messages-import] embedding generation failed, continuing without embeddings",
      err,
    );
  }

  const contactIdCache = new Map<string, number>();
  const affectedPersonIds = new Set<number>();
  const messageIndexWithinConversation = new Map<string, number>();

  for (const [index, message] of resolved.entries()) {
    let contactId = contactIdCache.get(message.otherPartyProfileUrl);
    if (contactId === undefined) {
      const result = await findOrCreateContact(
        db,
        "linkedin",
        {
          identifier: message.otherPartyProfileUrl,
          name: message.otherPartyName,
        },
        statusByParty.get(message.otherPartyProfileUrl) ?? "active",
      );
      contactId = result.contactId;
      contactIdCache.set(message.otherPartyProfileUrl, contactId);
      if (result.wasCreated) summary.contactsCreated += 1;
      affectedPersonIds.add(result.personId);
    }

    // LinkedIn's export has no per-message id, only a per-conversation one
    // — disambiguate messages that land in the same second (rare but
    // possible in a fast back-and-forth) with a running counter.
    const dedupeKey = `${message.conversationId}:${message.occurredAt.toISOString()}`;
    const occurrence = messageIndexWithinConversation.get(dedupeKey) ?? 0;
    messageIndexWithinConversation.set(dedupeKey, occurrence + 1);
    const sourceMessageId = `linkedin-msg:${dedupeKey}:${occurrence}`;

    const embedding = embeddings[index] ?? null;
    const inserted = await db
      .insert(event)
      .values({
        contactId,
        direction: message.direction,
        occurredAt: message.occurredAt,
        subject: message.subject,
        bodyText: message.content,
        sourceMessageId,
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
      summary.eventsSkippedDuplicate += 1;
    }
  }

  for (const personId of affectedPersonIds) {
    await updatePersonSummaryEmbedding(db, personId);
  }

  return summary;
}
