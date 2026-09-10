import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";

import { person, personFunctionEnum, personSeniorityEnum } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

// Classification, not creative writing — a smaller/cheaper model is the
// right call here, unlike draft-generation.ts's DRAFT_MODEL.
const TITLE_CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001";

// How many people's titles go into one Anthropic call. Chunking keeps a
// single prompt/response bounded regardless of CSV size, at the cost of
// more round-trips — this number is a starting guess, not tuned against a
// real export yet (see scripts/classify-titles.ts for that).
const BATCH_SIZE = 30;

// How many batches run concurrently. A ~1,850-row real export produces
// ~62 batches at BATCH_SIZE=30 — running them one at a time (this used to
// be a plain sequential loop) took several minutes; a small concurrency
// pool cuts that roughly proportionally without risking a burst that trips
// Anthropic's rate limits the way full parallelism would.
const CLASSIFY_CONCURRENCY = 5;

export type PersonSeniority = (typeof personSeniorityEnum.enumValues)[number];
export type PersonFunction = (typeof personFunctionEnum.enumValues)[number];

export interface TitleClassificationInput {
  personId: number;
  rawTitle: string;
  rawCompany: string | null;
}

export interface TitleClassificationResult {
  personId: number;
  standardizedTitle: string;
  seniority: PersonSeniority;
  function: PersonFunction;
}

const SENIORITY_VALUES = new Set<string>(personSeniorityEnum.enumValues);
const FUNCTION_VALUES = new Set<string>(personFunctionEnum.enumValues);

const CLASSIFY_TOOL_NAME = "classify_titles";

// This guidance must stay in sync with docs/title-taxonomy.md, the
// canonical source — that doc's tables are quoted verbatim below rather
// than paraphrased, so a doc update should be copied here too.
const SYSTEM_PROMPT = `You classify LinkedIn job titles into a fixed taxonomy for a CRM's campaign-targeting feature. For each person given, produce a standardized title, a seniority value, and a function value.

Three fields come out of one raw title string:
- Standardized title: a short, human-readable canonical title (freeform text, not an enum). Strip qualifiers, scope, and team/product-area detail that don't change the role itself; keep seniority + function words.
- Seniority: one fixed value from the table below.
- Function: one fixed value from the table below.

## Seniority values
- ic: Individual contributor — no reports. Includes "Senior," "Staff," "Principal," "Lead" when "Lead" doesn't denote people management (title-dependent, use judgment).
- manager: First-line or mid-level people management: "Manager," "Team Lead" (people-management sense), "Head of" a small team.
- director: "Director," "Senior Director," "Group Manager."
- vp: "VP," "Vice President," "SVP," "EVP."
- c_level: "Chief *Officer" (CEO, CTO, CPO, CMO, etc.), "President."
- founder: "Founder," "Co-Founder," "Owner" — takes priority over any other seniority signal in the same title.
- unknown: Title present but seniority can't be confidently determined (e.g. just "Consultant," "Advisor," or too vague).

## Function values
- product_management: Product Manager, Product Owner, Head of Product.
- product_marketing: Product Marketing Manager, PMM.
- engineering: Software/Platform/Infrastructure/QA Engineering, Engineering Management.
- design: Product Design, UX/UI, Design Research.
- data_analytics: Data Science, Data Engineering, Analytics, BI.
- sales: Sales, Account Executive, Business Development (revenue-generating, external-facing).
- marketing: Marketing (brand, demand gen, content) — everything marketing except product marketing.
- customer_success: Customer Success, Support, Implementation, Solutions Engineering (post-sale, customer-facing).
- operations: Business Ops, Revenue Ops, Strategy & Ops, general "Operations."
- finance: Finance, Accounting, FP&A.
- people_hr: HR, People, Talent, Recruiting.
- legal: Legal, Compliance.
- it: Internal IT, Security (corporate, not product security).
- executive_general: General management not captured above: CEO acting as generalist, General Manager, Managing Director.
- other: Doesn't fit cleanly, or title is too vague to classify.

## Examples
- "Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy" -> standardizedTitle "Director of Product Management", seniority director, function product_management.
- "Product Team Lead" -> standardizedTitle "Product Team Lead", seniority manager, function product_management.
- "Senior Software Engineer, Payments Infrastructure" -> standardizedTitle "Senior Software Engineer", seniority ic, function engineering.
- "VP, Global Product Marketing" -> standardizedTitle "VP of Product Marketing", seniority vp, function product_marketing.
- "Co-Founder & CEO" -> standardizedTitle "Co-Founder & CEO", seniority founder, function executive_general.
- "Growth Marketing Consultant" -> standardizedTitle "Growth Marketing Consultant", seniority unknown, function marketing.

## Ambiguity rule
When either seniority or function can't be determined with reasonable confidence from the title text alone, use unknown / other rather than guessing. A wrong-but-confident-looking value is worse than a visibly-unclassified one, since it silently corrupts filter results instead of surfacing as a gap.

Classify every person given, in the same order, using the classify_titles tool. Never invent a value outside the fixed lists above.`;

export interface TitleExtractionPrompt {
  system: string;
  user: string;
}

// Pure prompt construction — kept separate from the API call so it's unit
// testable without a real network request (same convention as
// draft-generation.ts's buildDraftPrompt).
export function buildTitleExtractionPrompt(
  rows: TitleClassificationInput[],
): TitleExtractionPrompt {
  const user = rows
    .map((r) => {
      const company = r.rawCompany ? ` at ${r.rawCompany}` : "";
      return `personId ${r.personId}: "${r.rawTitle}"${company}`;
    })
    .join("\n");

  return { system: SYSTEM_PROMPT, user };
}

function buildClassifyTool(): Anthropic.Tool {
  return {
    name: CLASSIFY_TOOL_NAME,
    description:
      "Record the standardized title, seniority, and function for each person given.",
    input_schema: {
      type: "object",
      properties: {
        classifications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              personId: { type: "integer" },
              standardizedTitle: { type: "string" },
              seniority: { type: "string", enum: personSeniorityEnum.enumValues },
              function: { type: "string", enum: personFunctionEnum.enumValues },
            },
            required: ["personId", "standardizedTitle", "seniority", "function"],
          },
        },
      },
      required: ["classifications"],
    },
  };
}

// Pure: pulls the tool_use block back apart. Anthropic's schema `enum`
// guides the model but isn't a hard server-side guarantee, so any
// out-of-taxonomy value is coerced to the taxonomy's own "couldn't
// classify" value rather than trusted or thrown on — consistent with the
// ambiguity rule (a visible "unknown" beats a silently wrong value, and a
// silently *invalid* value would be worse than either).
export function parseTitleExtractionResponse(
  raw: Anthropic.Message,
): TitleClassificationResult[] {
  const toolUseBlock = raw.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === CLASSIFY_TOOL_NAME,
  );
  if (!toolUseBlock) {
    throw new Error("Anthropic response contained no classify_titles tool call.");
  }

  const input = toolUseBlock.input as {
    classifications?: {
      personId: number;
      standardizedTitle: string;
      seniority: string;
      function: string;
    }[];
  };

  return (input.classifications ?? []).map((c) => ({
    personId: c.personId,
    standardizedTitle: c.standardizedTitle,
    seniority: (SENIORITY_VALUES.has(c.seniority) ? c.seniority : "unknown") as PersonSeniority,
    function: (FUNCTION_VALUES.has(c.function) ? c.function : "other") as PersonFunction,
  }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function classifyBatch(
  rows: TitleClassificationInput[],
): Promise<TitleClassificationResult[]> {
  const { system, user } = buildTitleExtractionPrompt(rows);
  const client = new Anthropic();
  const response = await client.messages.create({
    model: TITLE_CLASSIFICATION_MODEL,
    max_tokens: 4000,
    system,
    tools: [buildClassifyTool()],
    tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
    messages: [{ role: "user", content: user }],
  });
  return parseTitleExtractionResponse(response);
}

// Runs `batches` through `worker` with at most `concurrency` in flight at
// once, preserving each batch's result at its original index — a plain
// `Promise.all(batches.map(worker))` would fire all of them at once
// instead, risking a rate-limit burst.
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) return;
    results[index] = await worker(items[index]);
    await runNext();
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runNext),
  );
  return results;
}

// Full pipeline: classifies every given row (batched, with up to
// CLASSIFY_CONCURRENCY batches in flight at once) and writes the result
// onto `person`. Not unit tested directly (real network call) — see
// buildTitleExtractionPrompt/parseTitleExtractionResponse for the tested
// pieces, and scripts/classify-titles.ts for real-data verification.
export async function classifyTitles(
  db: DrizzleDb,
  rows: TitleClassificationInput[],
): Promise<TitleClassificationResult[]> {
  const batchResults = await runWithConcurrency(
    chunk(rows, BATCH_SIZE),
    CLASSIFY_CONCURRENCY,
    classifyBatch,
  );
  const results = batchResults.flat();

  for (const r of results) {
    await db
      .update(person)
      .set({
        standardizedTitle: r.standardizedTitle,
        seniority: r.seniority,
        function: r.function,
        updatedAt: new Date(),
      })
      .where(eq(person.id, r.personId));
  }

  return results;
}
