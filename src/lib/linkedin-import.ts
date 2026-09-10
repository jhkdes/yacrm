import { parse } from "csv-parse/sync";
import { inArray } from "drizzle-orm";

import { companyIndustryCache, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { normalizeCompanyName } from "@/lib/company-normalization";
import {
  attachContactToExistingPerson,
  findContactByEmail,
  findContactBySourceIdentifier,
  findOrCreateContact,
} from "@/lib/contact-resolution";
import { bulkUpdateByKey } from "@/lib/db-bulk-update";
import { inferIndustries } from "@/lib/industry-inference";
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
  industriesInferred: number;
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

// Runs the industry side of a batch: dedupes company names, resolves
// each (cache hit or freshly inferred) via inferIndustries, bulk-writes
// industry onto this batch's own people, then backfills every OTHER
// existing person at each genuinely-newly-inferred company across the
// whole DB (not just this batch) — so two people at the same company
// imported at different times never diverge. The "genuinely new" check
// (querying the cache before calling inferIndustries) means an
// already-known company's backfill isn't redundantly re-run on every
// batch that happens to touch it.
async function runIndustryInference(
  db: DrizzleDb,
  toInferIndustry: { personId: number; normalizedCompanyName: string }[],
): Promise<number> {
  if (toInferIndustry.length === 0) return 0;

  const uniqueNames = [...new Set(toInferIndustry.map((r) => r.normalizedCompanyName))];
  const alreadyCached = await db
    .select({ normalizedCompanyName: companyIndustryCache.normalizedCompanyName })
    .from(companyIndustryCache)
    .where(inArray(companyIndustryCache.normalizedCompanyName, uniqueNames));
  const alreadyCachedSet = new Set(alreadyCached.map((r) => r.normalizedCompanyName));
  const newlyInferredCandidates = uniqueNames.filter((n) => !alreadyCachedSet.has(n));

  const industryByCompany = await inferIndustries(db, uniqueNames);

  await bulkUpdateByKey(db, {
    table: "person",
    keyColumn: "id",
    keyType: "integer",
    setColumns: [{ column: "industry", sqlType: "company_industry" }],
    rows: toInferIndustry
      .filter((r) => industryByCompany.has(r.normalizedCompanyName))
      .map((r) => ({ id: r.personId, industry: industryByCompany.get(r.normalizedCompanyName) })),
  });

  await bulkUpdateByKey(db, {
    table: "person",
    keyColumn: "normalized_company_name",
    keyType: "text",
    setColumns: [{ column: "industry", sqlType: "company_industry" }],
    rows: newlyInferredCandidates
      .filter((name) => industryByCompany.has(name))
      .map((name) => ({ normalized_company_name: name, industry: industryByCompany.get(name) })),
    extraWhere: `t."industry" IS NULL`,
  });

  return toInferIndustry.length;
}

// Imports a parsed connections list: one Contact per row (source
// "linkedin", identifier = profile URL). Re-importing the same connection
// finds the existing Contact via that identifier (no duplicate created).
//
// Each row's raw title/company is diffed against what's already stored on
// the matched Person. Two independent conditions decide whether title
// classification and/or industry inference are needed — a title-unchanged
// row can still need industry work (or vice versa) if only one of the two
// changed. Both use the same bug-class fix: "unchanged" requires the raw
// field to match *and* the derived value (`standardizedTitle`/`industry`)
// to already be set, not just a raw-field match — otherwise a person whose
// raw fields got persisted but never reached classification (e.g. an
// interrupted import) would look identical to one that's actually done,
// and a later re-import would skip them forever since their raw fields
// never change again. A row with no `position` at all has nothing to
// classify and is left out of all further processing (see
// docs/technical-design-and-milestones.md M29 for why this gate isn't
// widened to company-only rows).
//
// findOrCreateContact still runs one row at a time (each row can create a
// new Person, so there's no way around a per-row round-trip there), but
// every write from here on is a single bulk statement (bulkUpdateByKey)
// instead of a per-row/per-company loop, and title classification +
// industry inference run concurrently rather than sequentially — both
// changes target the same real-world cost: with a real ~1,850-row export,
// per-row sequential writes (not LLM latency) were the dominant cost of a
// large import.
export async function importLinkedInConnections(
  db: DrizzleDb,
  rows: LinkedInConnectionRow[],
): Promise<LinkedInImportSummary> {
  const summary: LinkedInImportSummary = {
    rowsProcessed: rows.length,
    rowsSkippedNoUrl: 0,
    contactsCreated: 0,
    titlesClassified: 0,
    industriesInferred: 0,
  };

  const resolved: { personId: number; position: string; company: string | null }[] = [];

  for (const row of rows) {
    const name = `${row.firstName} ${row.lastName}`.trim() || null;

    // M31: before falling through to findOrCreateContact's "create a new
    // solo Person" default, check whether this exact LinkedIn identifier
    // is already resolved (the ordinary re-import fast path), and — only
    // for a genuinely new identifier — whether the row's email exactly
    // matches an existing Gmail/Hotmail contact. An exact email match is
    // unambiguous, so it's safe to attach directly without the manual
    // /merges review that any name-based match still requires.
    const existingLinkedinContact = await findContactBySourceIdentifier(
      db,
      "linkedin",
      row.profileUrl,
    );

    let result: { personId: number; wasCreated: boolean };
    if (existingLinkedinContact) {
      result = { personId: existingLinkedinContact.personId, wasCreated: false };
    } else {
      const emailMatch = row.email ? await findContactByEmail(db, row.email) : undefined;
      result = emailMatch
        ? await attachContactToExistingPerson(
            db,
            "linkedin",
            { identifier: row.profileUrl, name },
            emailMatch.personId,
            "active",
          )
        : await findOrCreateContact(
            db,
            "linkedin",
            { identifier: row.profileUrl, name },
            // A 1st-degree LinkedIn connection is, by definition, a mutual
            // relationship — not a one-way message like an unreplied email.
            "active",
          );
    }
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
      industry: person.industry,
    })
    .from(person)
    .where(inArray(person.id, personIds));
  const existingById = new Map(existingPeople.map((p) => [p.id, p]));

  const rawFieldUpdates: Record<string, unknown>[] = [];
  const toClassify: TitleClassificationInput[] = [];
  const toInferIndustry: { personId: number; normalizedCompanyName: string }[] = [];

  for (const { personId, position, company } of resolved) {
    const existing = existingById.get(personId);

    const titleUnchanged =
      existing?.linkedinRawTitle === position &&
      existing?.linkedinRawCompany === company &&
      existing?.standardizedTitle !== null;

    const normalizedCompany = company ? normalizeCompanyName(company) : null;
    const companyUnchanged =
      existing?.linkedinRawCompany === company &&
      (normalizedCompany === null || existing?.industry !== null);

    if (titleUnchanged && companyUnchanged) continue;

    rawFieldUpdates.push({
      id: personId,
      linkedin_raw_title: position,
      linkedin_raw_company: company,
      normalized_company_name: normalizedCompany,
    });

    if (!titleUnchanged) {
      toClassify.push({ personId, rawTitle: position, rawCompany: company });
    }
    if (!companyUnchanged && normalizedCompany) {
      toInferIndustry.push({ personId, normalizedCompanyName: normalizedCompany });
    }
  }

  await bulkUpdateByKey(db, {
    table: "person",
    keyColumn: "id",
    keyType: "integer",
    setColumns: [
      { column: "linkedin_raw_title", sqlType: "text" },
      { column: "linkedin_raw_company", sqlType: "text" },
      { column: "normalized_company_name", sqlType: "text" },
    ],
    rows: rawFieldUpdates,
  });

  const [titleResult, industryResult] = await Promise.allSettled([
    toClassify.length > 0 ? classifyTitles(db, toClassify) : Promise.resolve([]),
    runIndustryInference(db, toInferIndustry),
  ]);

  if (titleResult.status === "fulfilled") {
    summary.titlesClassified = titleResult.value.length;
  } else {
    console.warn(
      "[linkedin-import] title classification failed, continuing without it",
      titleResult.reason,
    );
  }

  if (industryResult.status === "fulfilled") {
    summary.industriesInferred = industryResult.value;
  } else {
    console.warn(
      "[linkedin-import] industry inference failed, continuing without it",
      industryResult.reason,
    );
  }

  return summary;
}
