import Anthropic from "@anthropic-ai/sdk";

import { companyIndustryEnum, personFunctionEnum, personSeniorityEnum } from "@/db/schema";
import type { StructuredFilter } from "@/lib/candidate-filter";
import { INDUSTRY_GUIDANCE, SENIORITY_FUNCTION_GUIDANCE } from "@/lib/taxonomy-prompts";

// Classification-adjacent, not creative writing — matches title-extraction.ts
// and industry-inference.ts's model choice.
const FILTER_DRAFT_MODEL = "claude-haiku-4-5-20251001";

const SENIORITY_VALUES = new Set<string>(personSeniorityEnum.enumValues);
const FUNCTION_VALUES = new Set<string>(personFunctionEnum.enumValues);
const INDUSTRY_VALUES = new Set<string>(companyIndustryEnum.enumValues);

const DRAFT_TOOL_NAME = "draft_filter";

const SYSTEM_PROMPT = `You draft a structured candidate filter for a CRM's campaign-targeting feature from a free-text campaign goal. The user reviews and edits whatever you propose before it runs — you are drafting a starting point, not making a final decision — so favor a reasonable, editable guess over refusing to propose anything.

A filter has four independent dimensions. Propose only the dimensions the goal actually implies something about — an omitted or empty dimension means "no filter on this," which is a normal, often-correct answer, not a failure. Do not fill in a dimension just to have an opinion about it.

- titleQuery: a short, freeform substring to match against a person's standardized job title (e.g. "product manager"). Omit if the goal doesn't imply a specific title.
- seniority: zero or more fixed values from the table below.
- function: zero or more fixed values from the table below.
- industry: zero or more fixed values from the table below.

${SENIORITY_FUNCTION_GUIDANCE}

${INDUSTRY_GUIDANCE}

## Examples
- "hiring a senior backend engineer" -> seniority [ic], function [engineering] (senior is still an individual-contributor level, not people management) — no industry, no titleQuery beyond what function already captures.
- "reconnecting with people at my old company" -> no seniority, no function, no industry, no titleQuery — this goal isn't about role or company type at all, so every dimension is correctly empty.
- "hiring enterprise PMs at mid-size B2B software companies" -> function [product_management], industry [tech_enterprise_software] — no seniority implied (any level could be "a PM"), titleQuery "product manager" optional/redundant with function.
- "VPs and directors of engineering at fintech startups" -> seniority [vp, director], function [engineering], industry [tech_fintech].

Never invent a value outside the fixed lists above. Use the draft_filter tool.`;

export interface FilterDraftPrompt {
  system: string;
  user: string;
}

// Pure — kept separate from the API call so it's unit testable without a
// real network request, same convention as title-extraction.ts/
// industry-inference.ts.
export function buildFilterDraftPrompt(goal: string): FilterDraftPrompt {
  return { system: SYSTEM_PROMPT, user: `Campaign goal: ${goal}` };
}

function buildDraftFilterTool(): Anthropic.Tool {
  return {
    name: DRAFT_TOOL_NAME,
    description: "Record the drafted structured filter for this campaign goal.",
    input_schema: {
      type: "object",
      properties: {
        titleQuery: { type: "string" },
        seniority: { type: "array", items: { type: "string", enum: personSeniorityEnum.enumValues } },
        function: { type: "array", items: { type: "string", enum: personFunctionEnum.enumValues } },
        industry: { type: "array", items: { type: "string", enum: companyIndustryEnum.enumValues } },
      },
    },
  };
}

// Pure: pulls the tool_use block back apart. Unlike title-extraction.ts/
// industry-inference.ts, an out-of-taxonomy value here is dropped from its
// array rather than substituted with a fallback — a filter has no
// "unknown" concept; a dimension the model isn't confident about should
// come back empty (no filter on it), not populated with a bogus value
// that would only match people already tagged unknown/other.
export function parseFilterDraftResponse(raw: Anthropic.Message): StructuredFilter {
  const toolUseBlock = raw.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === DRAFT_TOOL_NAME,
  );
  if (!toolUseBlock) {
    throw new Error("Anthropic response contained no draft_filter tool call.");
  }

  const input = toolUseBlock.input as {
    titleQuery?: string;
    seniority?: string[];
    function?: string[];
    industry?: string[];
  };

  const filter: StructuredFilter = {};
  if (input.titleQuery?.trim()) filter.titleQuery = input.titleQuery.trim();

  const seniority = (input.seniority ?? []).filter((v) => SENIORITY_VALUES.has(v));
  if (seniority.length > 0) filter.seniority = seniority as StructuredFilter["seniority"];

  const func = (input.function ?? []).filter((v) => FUNCTION_VALUES.has(v));
  if (func.length > 0) filter.function = func as StructuredFilter["function"];

  const industry = (input.industry ?? []).filter((v) => INDUSTRY_VALUES.has(v));
  if (industry.length > 0) filter.industry = industry as StructuredFilter["industry"];

  return filter;
}

// Full pipeline: not unit tested directly (real network call) — see
// buildFilterDraftPrompt/parseFilterDraftResponse for the tested pieces,
// and scripts/draft-filter.ts for real-data verification.
export async function draftFilterFromGoal(goal: string): Promise<StructuredFilter> {
  const { system, user } = buildFilterDraftPrompt(goal);
  const client = new Anthropic();
  const response = await client.messages.create({
    model: FILTER_DRAFT_MODEL,
    max_tokens: 1000,
    system,
    tools: [buildDraftFilterTool()],
    tool_choice: { type: "tool", name: DRAFT_TOOL_NAME },
    messages: [{ role: "user", content: user }],
  });
  return parseFilterDraftResponse(response);
}
