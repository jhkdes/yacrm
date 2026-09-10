import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  buildFilterDraftPrompt,
  parseFilterDraftResponse,
} from "@/lib/filter-drafting";

function toolUseResponse(input: unknown): Anthropic.Message {
  return {
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "draft_filter",
        input,
      },
    ],
  } as Anthropic.Message;
}

describe("buildFilterDraftPrompt", () => {
  it("includes the goal in the user message", () => {
    const { user } = buildFilterDraftPrompt("hiring enterprise PMs");
    expect(user).toContain("hiring enterprise PMs");
  });

  it("includes both the seniority/function and industry taxonomy tables", () => {
    const { system } = buildFilterDraftPrompt("");
    expect(system).toContain("director");
    expect(system).toContain("product_management");
    expect(system).toContain("tech_healthtech");
  });

  it("instructs that an omitted dimension is a valid answer", () => {
    const { system } = buildFilterDraftPrompt("");
    expect(system).toMatch(/no filter on this/i);
  });
});

describe("parseFilterDraftResponse", () => {
  it("extracts a filter with all four dimensions", () => {
    const filter = parseFilterDraftResponse(
      toolUseResponse({
        titleQuery: "product manager",
        seniority: ["director", "vp"],
        function: ["product_management"],
        industry: ["tech_enterprise_software"],
      }),
    );
    expect(filter).toEqual({
      titleQuery: "product manager",
      seniority: ["director", "vp"],
      function: ["product_management"],
      industry: ["tech_enterprise_software"],
    });
  });

  it("omits a dimension entirely when the model returns an empty array, rather than including it as empty", () => {
    const filter = parseFilterDraftResponse(
      toolUseResponse({ seniority: [], function: ["engineering"] }),
    );
    expect(filter.seniority).toBeUndefined();
    expect(filter.function).toEqual(["engineering"]);
    expect(filter.industry).toBeUndefined();
    expect(filter.titleQuery).toBeUndefined();
  });

  it("drops an out-of-taxonomy value from an array rather than substituting a fallback", () => {
    const filter = parseFilterDraftResponse(
      toolUseResponse({ seniority: ["director", "not_a_real_value"] }),
    );
    expect(filter.seniority).toEqual(["director"]);
  });

  it("omits the dimension entirely when every value in it is invalid", () => {
    const filter = parseFilterDraftResponse(
      toolUseResponse({ industry: ["not_a_real_industry"] }),
    );
    expect(filter.industry).toBeUndefined();
  });

  it("trims and keeps a non-empty titleQuery", () => {
    const filter = parseFilterDraftResponse(toolUseResponse({ titleQuery: "  product manager  " }));
    expect(filter.titleQuery).toBe("product manager");
  });

  it("omits titleQuery when blank", () => {
    const filter = parseFilterDraftResponse(toolUseResponse({ titleQuery: "   " }));
    expect(filter.titleQuery).toBeUndefined();
  });

  it("returns a fully empty filter when the model proposes nothing", () => {
    const filter = parseFilterDraftResponse(toolUseResponse({}));
    expect(filter).toEqual({});
  });

  it("throws when the response has no draft_filter tool call", () => {
    const response = { content: [{ type: "text", text: "sorry" }] } as Anthropic.Message;
    expect(() => parseFilterDraftResponse(response)).toThrow();
  });
});
