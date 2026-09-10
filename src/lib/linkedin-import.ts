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

// A real ~1,850-row import hit Vercel's 300s serverless timeout running as
// one long request — MAX_CONNECTIONS_ROWS caps how large a single upload
// can be at all, and CONNECTIONS_BATCH_SIZE is how the caller (the batch
// Server Action in actions.ts) chunks a file under that cap into many
// small, independent requests instead.
export const MAX_CONNECTIONS_ROWS = 10_000;
export const CONNECTIONS_BATCH_SIZE = 120;

export class TooManyRowsError extends Error {
  constructor(public readonly rowCount: number) {
    super(
      `This file has ${rowCount} connections, which is more than the ${MAX_CONNECTIONS_ROWS}-row limit. Split it into smaller files and import them separately.`,
    );
    this.name = "TooManyRowsError";
  }
}

// Pure — throws rather than returning a boolean so the caller can't
// forget to check a return value; the batch action catches this
// specifically to build its "too_many_rows" result.
export function assertRowCountAllowed(rowCount: number): void {
  if (rowCount > MAX_CONNECTIONS_ROWS) {
    throw new TooManyRowsError(rowCount);
  }
}

// Pure — kept separate from the action so the off-by-one edge cases (exact
// multiples of CONNECTIONS_BATCH_SIZE, 0 rows) are unit testable without a
// DB or FormData. Math.max(1, ...) so a 0-row file still reports 1
// (trivially-completing) batch rather than a "batch 0 of 0" client state.
export function computeBatchPlan(totalRows: number): { totalBatches: number } {
  return { totalBatches: Math.max(1, Math.ceil(totalRows / CONNECTIONS_BATCH_SIZE)) };
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
// the matched Person (`linkedinRawTitle`/`linkedinRawCompany`) — a row only
// counts as "unchanged" (skipped entirely, no LLM call) when those fields
// match *and* `standardizedTitle` is already set; a match on raw fields
// alone isn't enough, since a person whose raw fields got persisted but
// never reached classification (e.g. an interrupted import) would
// otherwise look identical to one that's actually done, and a later
// re-import would skip them forever. Changed, first-seen, or
// never-actually-classified rows are batched into classifyTitles (Phase
// 5/M28), which derives and persists a standardized title, seniority, and
// function (see docs/title-taxonomy.md). A row with no `position` at all
// has nothing to classify and is left alone.
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
      standardizedTitle: person.standardizedTitle,
    })
    .from(person)
    .where(inArray(person.id, personIds));
  const existingById = new Map(existingPeople.map((p) => [p.id, p]));

  const toClassify: TitleClassificationInput[] = [];

  for (const { personId, position, company } of resolved) {
    const existing = existingById.get(personId);
    // "Unchanged" must also mean "already classified" — otherwise a person
    // whose raw title got persisted but never reached classification (e.g.
    // an interrupted import) looks identical to one that's fully done, and
    // a later re-import would skip them forever since their raw fields
    // never change again.
    const unchanged =
      existing?.linkedinRawTitle === position &&
      existing?.linkedinRawCompany === company &&
      existing?.standardizedTitle !== null;
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
