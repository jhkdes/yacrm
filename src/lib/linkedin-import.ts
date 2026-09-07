import { parse } from "csv-parse/sync";

import { event } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { findOrCreateContact } from "@/lib/contact-resolution";
import { generateEmbeddings } from "@/lib/embeddings";
import { updatePersonSummaryEmbedding } from "@/lib/person-embedding";

export interface LinkedInConnectionRow {
  firstName: string;
  lastName: string;
  profileUrl: string;
  email: string | null;
  company: string | null;
  position: string | null;
  connectedOn: Date | null;
}

export interface LinkedInImportSummary {
  rowsProcessed: number;
  rowsSkippedNoUrl: number;
  contactsCreated: number;
  profileEventsWritten: number;
  eventsEmbedded: number;
}

const HEADER_MARKER = "First Name,Last Name,URL";

// Exported so linkedin-messages-import.ts can match a message's sender/
// recipient profile URL against the same identifier findOrCreateContact
// stores here — LinkedIn URLs sometimes appear with/without a trailing
// slash depending on which export they came from.
export function normalizeProfileUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// LinkedIn's format is "04 Sep 2026" — recognized natively by Date, but
// guarded here since a malformed/empty value should mean "unknown", not an
// Invalid Date silently propagating into the DB.
function parseConnectedOn(value: string | undefined): Date | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// LinkedIn's "Download your data" connections export prepends a Notes:
// preamble (a quoted, possibly multi-line disclaimer) before the actual
// header row. This function is pure — no I/O — so it can be unit tested
// directly against a fixture export.
export function parseConnectionsCsv(csvText: string): {
  rows: LinkedInConnectionRow[];
  rowsSkippedNoUrl: number;
} {
  const headerIndex = csvText.indexOf(HEADER_MARKER);
  if (headerIndex === -1) {
    throw new Error(
      "Unrecognized LinkedIn connections export: couldn't find the header row",
    );
  }

  const records: Record<string, string>[] = parse(
    csvText.slice(headerIndex),
    { columns: true, skip_empty_lines: true, relax_column_count: true },
  );

  const rows: LinkedInConnectionRow[] = [];
  let rowsSkippedNoUrl = 0;

  for (const record of records) {
    const profileUrl = record["URL"]?.trim();
    if (!profileUrl) {
      rowsSkippedNoUrl += 1;
      continue;
    }
    rows.push({
      firstName: record["First Name"]?.trim() ?? "",
      lastName: record["Last Name"]?.trim() ?? "",
      profileUrl: normalizeProfileUrl(profileUrl),
      email: record["Email Address"]?.trim() || null,
      company: record["Company"]?.trim() || null,
      position: record["Position"]?.trim() || null,
      connectedOn: parseConnectedOn(record["Connected On"]),
    });
  }

  return { rows, rowsSkippedNoUrl };
}

function buildProfileBodyText(row: LinkedInConnectionRow): string | null {
  if (!row.position && !row.company) return null;
  if (row.position && row.company) {
    return `${row.position} at ${row.company}`;
  }
  return row.position ?? row.company;
}

// Imports a parsed connections list: one Contact per row (source
// "linkedin", identifier = profile URL), plus a synthetic profile Event
// carrying their current position/company. The profile Event exists purely
// so role-based campaign targeting (Phase 2) has something to embed and
// rank against — a LinkedIn connection with no message history otherwise
// contributes nothing to their Person's summary embedding. Re-importing the
// same connection updates that Event in place (matched on a stable
// per-profile sourceMessageId) rather than duplicating it, so a refreshed
// export just picks up role changes.
export async function importLinkedInConnections(
  db: DrizzleDb,
  rows: LinkedInConnectionRow[],
): Promise<LinkedInImportSummary> {
  const summary: LinkedInImportSummary = {
    rowsProcessed: rows.length,
    rowsSkippedNoUrl: 0,
    contactsCreated: 0,
    profileEventsWritten: 0,
    eventsEmbedded: 0,
  };

  const toEmbed: { contactId: number; bodyText: string; occurredAt: Date }[] =
    [];
  const affectedPersonIds = new Set<number>();

  for (const row of rows) {
    const name = `${row.firstName} ${row.lastName}`.trim() || null;
    const result = await findOrCreateContact(
      db,
      "linkedin",
      { identifier: row.profileUrl, name },
      // A 1st-degree LinkedIn connection is, by definition, a mutual
      // relationship — not a one-way message like an unreplied email.
      "active",
    );
    if (result.wasCreated) summary.contactsCreated += 1;
    affectedPersonIds.add(result.personId);

    const bodyText = buildProfileBodyText(row);
    if (bodyText) {
      toEmbed.push({
        contactId: result.contactId,
        bodyText,
        occurredAt: row.connectedOn ?? new Date(),
      });
    }
  }

  let embeddings: (number[] | null)[] = toEmbed.map(() => null);
  try {
    embeddings = await generateEmbeddings(toEmbed.map((e) => e.bodyText));
  } catch (err) {
    console.warn(
      "[linkedin-import] embedding generation failed, continuing without embeddings",
      err,
    );
  }

  for (const [index, entry] of toEmbed.entries()) {
    const embedding = embeddings[index] ?? null;
    await db
      .insert(event)
      .values({
        contactId: entry.contactId,
        direction: "inbound",
        occurredAt: entry.occurredAt,
        subject: "LinkedIn profile",
        bodyText: entry.bodyText,
        sourceMessageId: `linkedin-profile:${entry.contactId}`,
        embedding,
      })
      .onConflictDoUpdate({
        target: [event.contactId, event.sourceMessageId],
        set: {
          bodyText: entry.bodyText,
          occurredAt: entry.occurredAt,
          embedding,
        },
      });
    summary.profileEventsWritten += 1;
    if (embedding) summary.eventsEmbedded += 1;
  }

  for (const personId of affectedPersonIds) {
    await updatePersonSummaryEmbedding(db, personId);
  }

  return summary;
}
