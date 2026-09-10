import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { companyIndustryCache } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  buildIndustryInferencePrompt,
  inferIndustries,
  parseIndustryInferenceResponse,
} from "@/lib/industry-inference";

// inferIndustries' full pipeline calls the real Anthropic API for
// cache-miss names — mocking the client here (module-level, since
// Anthropic's `.messages` is an instance property set in its constructor,
// not something spy-able off the class prototype) lets the cache-hit/miss
// DB logic be exercised for real via pglite without a network call, the
// same tradeoff linkedin-import.test.ts makes mocking classifyTitles.
// vi.mock is hoisted above this file's imports, so mockCreate (prefixed
// with "mock" per Vitest's hoisting exception) is safe to reference here.
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

function toolUseResponse(classifications: unknown[]): Anthropic.Message {
  return {
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "classify_industries",
        input: { classifications },
      },
    ],
  } as Anthropic.Message;
}

describe("buildIndustryInferencePrompt", () => {
  it("lists every company name in the user message", () => {
    const { user } = buildIndustryInferencePrompt(["Qlik", "Stripe"]);
    expect(user.split("\n")).toEqual(['"Qlik"', '"Stripe"']);
  });

  it("returns a stable system prompt containing the taxonomy guidance", () => {
    const { system } = buildIndustryInferencePrompt([]);
    expect(system).toContain("tech_healthtech");
    expect(system).toContain("Ambiguity rule");
  });
});

describe("parseIndustryInferenceResponse", () => {
  it("extracts a map keyed by company name", () => {
    const result = parseIndustryInferenceResponse(
      toolUseResponse([{ companyName: "Qlik", industry: "tech_enterprise_software" }]),
      ["Qlik"],
    );
    expect(result.get("Qlik")).toBe("tech_enterprise_software");
  });

  it("coerces an out-of-taxonomy industry value to unknown", () => {
    const result = parseIndustryInferenceResponse(
      toolUseResponse([{ companyName: "Acme", industry: "not_a_real_value" }]),
      ["Acme"],
    );
    expect(result.get("Acme")).toBe("unknown");
  });

  it("fills in unknown for a requested name the model silently omitted", () => {
    const result = parseIndustryInferenceResponse(
      toolUseResponse([{ companyName: "Qlik", industry: "tech_enterprise_software" }]),
      ["Qlik", "MysteryCo"],
    );
    expect(result.get("Qlik")).toBe("tech_enterprise_software");
    expect(result.get("MysteryCo")).toBe("unknown");
  });

  it("throws when the response has no classify_industries tool call", () => {
    const response = { content: [{ type: "text", text: "sorry" }] } as Anthropic.Message;
    expect(() => parseIndustryInferenceResponse(response, [])).toThrow();
  });
});

describe("inferIndustries", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    mockCreate.mockReset();
    await testDb.client.close();
  });

  it("makes no LLM call when every requested name is already cached", async () => {
    await testDb.db.insert(companyIndustryCache).values([
      { normalizedCompanyName: "Qlik", industry: "tech_enterprise_software" },
    ]);

    const result = await inferIndustries(testDb.db, ["Qlik"]);

    expect(result.get("Qlik")).toBe("tech_enterprise_software");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("infers, caches, and returns a cache-miss name", async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse([{ companyName: "Stripe", industry: "tech_fintech" }]),
    );

    const result = await inferIndustries(testDb.db, ["Stripe"]);
    expect(result.get("Stripe")).toBe("tech_fintech");

    const cached = await testDb.db.query.companyIndustryCache.findFirst({
      where: (c, { eq }) => eq(c.normalizedCompanyName, "Stripe"),
    });
    expect(cached?.industry).toBe("tech_fintech");
  });

  it("resolves a mix of cached and newly-inferred names", async () => {
    await testDb.db.insert(companyIndustryCache).values([
      { normalizedCompanyName: "Qlik", industry: "tech_enterprise_software" },
    ]);
    mockCreate.mockResolvedValue(
      toolUseResponse([{ companyName: "Stripe", industry: "tech_fintech" }]),
    );

    const result = await inferIndustries(testDb.db, ["Qlik", "Stripe"]);

    expect(result.get("Qlik")).toBe("tech_enterprise_software");
    expect(result.get("Stripe")).toBe("tech_fintech");
    // Only the cache-miss name was sent to the LLM.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns an empty map for an empty input without calling the LLM", async () => {
    const result = await inferIndustries(testDb.db, []);
    expect(result.size).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("resolves a concurrent race inferring the same new company without a unique-constraint error", async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse([{ companyName: "Notion", industry: "tech_enterprise_software" }]),
    );

    const [a, b] = await Promise.all([
      inferIndustries(testDb.db, ["Notion"]),
      inferIndustries(testDb.db, ["Notion"]),
    ]);

    expect(a.get("Notion")).toBe("tech_enterprise_software");
    expect(b.get("Notion")).toBe("tech_enterprise_software");

    const rows = await testDb.db.query.companyIndustryCache.findMany({
      where: (c, { eq }) => eq(c.normalizedCompanyName, "Notion"),
    });
    expect(rows).toHaveLength(1);
  });
});
