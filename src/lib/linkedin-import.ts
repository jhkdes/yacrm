import { parse } from "csv-parse/sync";
import { eq, inArray } from "drizzle-orm";

import { person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { findOrCreateContact } from "@/lib/contact-resolution";
import {
  classifyTitles,
  type TitleClassificationInput,
} from "@/lib/title-extraction";

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
  titlesClassified: number;
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

// Imports a parsed connections list: one Contact per row (source
// "linkedin", identifier = profile URL). Re-importing the same connection
// finds the existing Contact via that identifier (no duplicate created).
//
// Each row's raw title/company is diffed against what's already stored on
// the matched Person (`linkedinRawTitle`/`linkedinRawCompany`) — unchanged
// rows are skipped entirely (no LLM call), changed or first-seen rows are
// batched into classifyTitles (Phase 5/M28), which derives and persists a
// standardized title, seniority, and function (see
// docs/title-taxonomy.md). A row with no `position` at all has nothing to
// classify and is left alone.
//
// findOrCreateContact still runs one row at a time (each row can create a
// new Person, so there's no way around a per-row round-trip there), but the
// diff check is batched into a single query across every resolved Person
// instead of one `findFirst` per row — with a real ~1,850-row export this
// was the difference between ~1,850 sequential DB round-trips and 1.
export async function importLinkedInConnections(
  db: DrizzleDb,
  rows: LinkedInConnectionRow[],
): Promise<LinkedInImportSummary> {
  const summary: LinkedInImportSummary = {
    rowsProcessed: rows.length,
    rowsSkippedNoUrl: 0,
    contactsCreated: 0,
    titlesClassified: 0,
  };

  const resolved: { personId: number; position: string; company: string | null }[] = [];

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

    if (row.position) {
      resolved.push({ personId: result.personId, position: row.position, company: row.company });
    }
  }

  if (resolved.length === 0) return summary;

  const personIds = [...new Set(resolved.map((r) => r.personId))];
  const existingPeople = await db
    .select({
      id: person.id,
      linkedinRawTitle: person.linkedinRawTitle,
      linkedinRawCompany: person.linkedinRawCompany,
    })
    .from(person)
    .where(inArray(person.id, personIds));
  const existingById = new Map(existingPeople.map((p) => [p.id, p]));

  const toClassify: TitleClassificationInput[] = [];

  for (const { personId, position, company } of resolved) {
    const existing = existingById.get(personId);
    const unchanged =
      existing?.linkedinRawTitle === position && existing?.linkedinRawCompany === company;
    if (unchanged) continue;

    await db
      .update(person)
      .set({
        linkedinRawTitle: position,
        linkedinRawCompany: company,
        updatedAt: new Date(),
      })
      .where(eq(person.id, personId));

    toClassify.push({ personId, rawTitle: position, rawCompany: company });
  }

  if (toClassify.length > 0) {
    try {
      const classified = await classifyTitles(db, toClassify);
      summary.titlesClassified = classified.length;
    } catch (err) {
      console.warn(
        "[linkedin-import] title classification failed, continuing without it",
        err,
      );
    }
  }

  return summary;
}
