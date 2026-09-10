import { and, eq, ilike, inArray } from "drizzle-orm";

import { contact, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import type { CompanyIndustry } from "@/lib/industry-inference";
import { listPeopleByLastTouched } from "@/lib/last-touched";
import type { PersonFunction, PersonSeniority } from "@/lib/title-extraction";

export interface StructuredFilter {
  titleQuery?: string;
  seniority?: PersonSeniority[];
  function?: PersonFunction[];
  industry?: CompanyIndustry[];
}

export interface FilterResult {
  personId: number;
  name: string;
  standardizedTitle: string | null;
  company: string | null;
  seniority: PersonSeniority | null;
  function: PersonFunction | null;
  industry: CompanyIndustry | null;
  lastInteractionAt: Date | null;
  // Non-nullable: the join key from an INNER JOIN on an active LinkedIn
  // contact, so every returned row has one.
  linkedinProfileUrl: string;
}

// Phase 5/M34: a filter with no criteria at all (or one broad enough to
// match most of the CRM) is a real, unhandled UX gap — the UI warns above
// this many results rather than silently rendering a huge table. A
// placeholder, not tuned against real connection-count data yet.
export const BROAD_RESULT_THRESHOLD = 200;

// Deterministic replacement for campaign-ranking.ts's embedding-based
// loadCandidates (Phase 5/M32) — no semantic ranking, no recency/
// engagement weighting, and (the actual behavior change) no requirement
// that a Person have any message history at all. Eligibility is just
// "has an active LinkedIn contact"; everything else is an optional,
// exact/substring filter that ANDs across fields and ORs within a field's
// array of values.
export async function filterCandidates(
  db: DrizzleDb,
  filter: StructuredFilter,
): Promise<FilterResult[]> {
  const conditions = [eq(contact.source, "linkedin"), eq(contact.status, "active")];

  if (filter.titleQuery?.trim()) {
    conditions.push(ilike(person.standardizedTitle, `%${filter.titleQuery.trim()}%`));
  }
  if (filter.seniority?.length) {
    conditions.push(inArray(person.seniority, filter.seniority));
  }
  if (filter.function?.length) {
    conditions.push(inArray(person.function, filter.function));
  }
  if (filter.industry?.length) {
    conditions.push(inArray(person.industry, filter.industry));
  }

  const rows = await db
    .select({
      personId: person.id,
      name: person.name,
      standardizedTitle: person.standardizedTitle,
      company: person.linkedinRawCompany,
      seniority: person.seniority,
      function: person.function,
      industry: person.industry,
      linkedinProfileUrl: contact.sourceIdentifier,
    })
    .from(person)
    .innerJoin(contact, eq(contact.personId, person.id))
    .where(and(...conditions))
    .orderBy(person.name);

  // Reuses M26's aggregate query rather than re-deriving last-interaction
  // logic here — a Map lookup is cheap even though listPeopleByLastTouched
  // computes it for every Person in the DB, not just this filtered set.
  const lastTouched = await listPeopleByLastTouched(db);
  const lastTouchedByPersonId = new Map(lastTouched.map((p) => [p.personId, p.lastTouchedAt]));

  // person.id is the join key on `contact`, so a Person with multiple
  // active LinkedIn contacts (rare, but not impossible after M31's
  // email-attach path) could otherwise appear more than once.
  const seenPersonIds = new Set<number>();
  const results: FilterResult[] = [];
  for (const row of rows) {
    if (seenPersonIds.has(row.personId)) continue;
    seenPersonIds.add(row.personId);
    results.push({
      ...row,
      lastInteractionAt: lastTouchedByPersonId.get(row.personId) ?? null,
    });
  }

  return results;
}

export type SortField =
  | "name"
  | "title"
  | "company"
  | "seniority"
  | "function"
  | "industry"
  | "lastInteraction";

const SORT_FIELD_TO_KEY: Record<SortField, keyof FilterResult> = {
  name: "name",
  title: "standardizedTitle",
  company: "company",
  seniority: "seniority",
  function: "function",
  industry: "industry",
  lastInteraction: "lastInteractionAt",
};

// Pure. A separate re-sort step from filterCandidates' own SQL ORDER BY —
// lastInteractionAt only exists after that function's JS merge step, so it
// can never be a SQL-sortable column; rather than split sort logic across
// two layers (SQL for some fields, JS for one), every field is sorted
// here, uniformly, only when the caller actually asks for a non-default
// sort. Nulls always sort last, in both directions — consistent with
// last-touched.ts's listPeopleByLastTouched, which the same principle was
// already established for.
export function sortFilterResults(
  results: FilterResult[],
  sort: SortField,
  dir: "asc" | "desc",
): FilterResult[] {
  const key = SORT_FIELD_TO_KEY[sort];
  const sorted = [...results].sort((a, b) => {
    const aVal = a[key];
    const bVal = b[key];
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
    return 0;
  });
  if (dir === "desc") {
    // Reverse the whole thing, then re-partition so nulls stay at the end
    // instead of jumping to the front — a plain .reverse() would put them
    // first, which is wrong in both directions.
    const withValue = sorted.filter((r) => r[key] !== null).reverse();
    const withoutValue = sorted.filter((r) => r[key] === null);
    return [...withValue, ...withoutValue];
  }
  return sorted;
}

export interface CandidateSortUrlParams {
  title?: string;
  seniority: string[];
  function: string[];
  industry: string[];
  goal?: string;
  campaignId?: number | null;
  currentSort?: string;
  currentDir?: string;
}

// Pure — extracted from campaigns/page.tsx specifically so this class of
// bug is unit-testable: a real regression had `title` only included in the
// rebuilt URL when truthy, which silently dropped it whenever a filter had
// been submitted with an empty title (checkboxes only, or no criteria at
// all). The page's shouldFilter check depends on `title`'s *presence* in
// the URL, not its truthiness — omitting it entirely made the whole
// results section (table included) disappear on the very next sort click.
// `title` must always be set, even to "".
export function buildCandidateSortUrl(params: CandidateSortUrlParams, field: SortField): string {
  const usp = new URLSearchParams();
  usp.set("title", params.title ?? "");
  for (const v of params.seniority) usp.append("seniority", v);
  for (const v of params.function) usp.append("function", v);
  for (const v of params.industry) usp.append("industry", v);
  if (params.goal) usp.set("goal", params.goal);
  if (params.campaignId) usp.set("campaignId", String(params.campaignId));
  const isActive = params.currentSort === field;
  const nextDir = isActive && params.currentDir !== "desc" ? "desc" : "asc";
  usp.set("sort", field);
  usp.set("dir", nextDir);
  return `/campaigns?${usp.toString()}`;
}
