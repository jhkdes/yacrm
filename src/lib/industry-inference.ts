import Anthropic from "@anthropic-ai/sdk";
import { inArray } from "drizzle-orm";

import { companyIndustryCache, companyIndustryEnum } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { INDUSTRY_GUIDANCE } from "@/lib/taxonomy-prompts";
import { runWithConcurrency } from "@/lib/title-extraction";

// Classification, not creative writing — matches title-extraction.ts's choice.
const INDUSTRY_MODEL = "claude-haiku-4-5-20251001";

// How many distinct company names go into one Anthropic call, and how many
// batches run concurrently — same values as title-extraction.ts's
// BATCH_SIZE/CLASSIFY_CONCURRENCY, kept as this module's own constants
// rather than importing private ones.
const IND_BATCH_SIZE = 30;
const IND_CONCURRENCY = 5;

export type CompanyIndustry = (typeof companyIndustryEnum.enumValues)[number];

const INDUSTRY_VALUES = new Set<string>(companyIndustryEnum.enumValues);

const CLASSIFY_TOOL_NAME = "classify_industries";

// Must stay in sync with docs/industry-taxonomy.md, the canonical source.
// The value table itself lives in taxonomy-prompts.ts (shared with
// filter-drafting.ts, which needs it alongside the seniority/function
// tables) — this composes it with industry-classification-specific
// framing, examples, and the ambiguity rule.
const SYSTEM_PROMPT = `You classify companies into a fixed industry taxonomy for a CRM's campaign-targeting feature. For each company name given, produce one industry value from the table below.

${INDUSTRY_GUIDANCE}

## Ambiguity rule
If the company can't be confidently classified, use unknown rather than guess. A software company that happens to serve, say, healthcare providers (healthtech) is tech_healthtech; an actual hospital system is healthcare — when that line is genuinely unclear from the company name alone, prefer unknown over picking one arbitrarily.

Classify every company given, in the same order, using the classify_industries tool. Never invent a value outside the fixed list above.`;

export interface IndustryInferencePrompt {
  system: string;
  user: string;
}

// Pure — kept separate from the API call so it's unit testable without a
// real network request (same convention as title-extraction.ts).
export function buildIndustryInferencePrompt(companyNames: string[]): IndustryInferencePrompt {
  const user = companyNames.map((name) => `"${name}"`).join("\n");
  return { system: SYSTEM_PROMPT, user };
}

function buildClassifyTool(): Anthropic.Tool {
  return {
    name: CLASSIFY_TOOL_NAME,
    description: "Record the industry for each company name given.",
    input_schema: {
      type: "object",
      properties: {
        classifications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              companyName: { type: "string" },
              industry: { type: "string", enum: companyIndustryEnum.enumValues },
            },
            required: ["companyName", "industry"],
          },
        },
      },
      required: ["classifications"],
    },
  };
}

// Pure: pulls the tool_use block back apart, keyed by companyName (the
// unit of work here is a distinct company name, not a person — there's no
// id to key by at this layer). Coerces an out-of-taxonomy value to
// "unknown" like title-extraction.ts does, and ALSO fills in "unknown" for
// any requested name the model silently dropped from its response — the
// caller needs an entry for every input name to safely write the cache,
// so a partial response can't be allowed to produce a partial map.
export function parseIndustryInferenceResponse(
  raw: Anthropic.Message,
  requestedNames: string[],
): Map<string, CompanyIndustry> {
  const toolUseBlock = raw.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === CLASSIFY_TOOL_NAME,
  );
  if (!toolUseBlock) {
    throw new Error("Anthropic response contained no classify_industries tool call.");
  }

  const input = toolUseBlock.input as {
    classifications?: { companyName: string; industry: string }[];
  };

  const result = new Map<string, CompanyIndustry>();
  for (const c of input.classifications ?? []) {
    result.set(c.companyName, (INDUSTRY_VALUES.has(c.industry) ? c.industry : "unknown") as CompanyIndustry);
  }
  for (const name of requestedNames) {
    if (!result.has(name)) result.set(name, "unknown");
  }
  return result;
}

async function inferBatch(companyNames: string[]): Promise<Map<string, CompanyIndustry>> {
  const { system, user } = buildIndustryInferencePrompt(companyNames);
  const client = new Anthropic();
  const response = await client.messages.create({
    model: INDUSTRY_MODEL,
    max_tokens: 4000,
    system,
    tools: [buildClassifyTool()],
    tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
    messages: [{ role: "user", content: user }],
  });
  return parseIndustryInferenceResponse(response, companyNames);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Full pipeline: resolves industry for every given normalized company
// name, using the companyIndustryCache table as a persistent, cross-call
// cache (the LinkedIn import runs in small, stateless batches — see
// linkedin-import.ts — so in-memory dedup alone can't prevent re-inferring
// the same company across separate batch calls; only the DB can).
// Not unit tested directly (real network call) — see
// buildIndustryInferencePrompt/parseIndustryInferenceResponse for the
// tested pure pieces, and scripts/classify-industries.ts for real-data
// verification.
export async function inferIndustries(
  db: DrizzleDb,
  normalizedCompanyNames: string[],
): Promise<Map<string, CompanyIndustry>> {
  const uniqueNames = [...new Set(normalizedCompanyNames)];
  if (uniqueNames.length === 0) return new Map();

  const cached = await db
    .select({ normalizedCompanyName: companyIndustryCache.normalizedCompanyName, industry: companyIndustryCache.industry })
    .from(companyIndustryCache)
    .where(inArray(companyIndustryCache.normalizedCompanyName, uniqueNames));

  const result = new Map<string, CompanyIndustry>(cached.map((c) => [c.normalizedCompanyName, c.industry]));
  const missing = uniqueNames.filter((name) => !result.has(name));
  if (missing.length === 0) return result;

  const batchResults = await runWithConcurrency(chunk(missing, IND_BATCH_SIZE), IND_CONCURRENCY, inferBatch);
  const inferred = new Map<string, CompanyIndustry>();
  for (const batch of batchResults) {
    for (const [name, industry] of batch) inferred.set(name, industry);
  }

  // Bulk-insert new rows in one round-trip; ON CONFLICT DO NOTHING so a
  // concurrent batch call inferring the same new company at the same time
  // doesn't throw on the unique constraint — whichever insert wins first
  // is deterministic, rather than a DO UPDATE's last-write-wins.
  const newRows = [...inferred.entries()].map(([normalizedCompanyName, industry]) => ({
    normalizedCompanyName,
    industry,
  }));
  await db.insert(companyIndustryCache).values(newRows).onConflictDoNothing();

  // Re-select the (deduped) set of names that were just inferred — covers
  // both this call's own writes and any that lost a concurrent race to
  // another batch, so the returned map always reflects the DB's actual
  // resolved value rather than this call's local (possibly-losing) guess.
  const resolved = await db
    .select({ normalizedCompanyName: companyIndustryCache.normalizedCompanyName, industry: companyIndustryCache.industry })
    .from(companyIndustryCache)
    .where(inArray(companyIndustryCache.normalizedCompanyName, missing));
  for (const r of resolved) result.set(r.normalizedCompanyName, r.industry);

  return result;
}
