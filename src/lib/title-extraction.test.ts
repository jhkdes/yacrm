import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  buildTitleExtractionPrompt,
  parseTitleExtractionResponse,
  persistTitleClassifications,
  runWithConcurrency,
} from "@/lib/title-extraction";

function toolUseResponse(
  classifications: unknown[],
): Anthropic.Message {
  return {
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "classify_titles",
        input: { classifications },
      },
    ],
  } as Anthropic.Message;
}

describe("buildTitleExtractionPrompt", () => {
  it("lists every person's raw title (and company, when present) in the user message", () => {
    const { user } = buildTitleExtractionPrompt([
      { personId: 1, rawTitle: "Director of Product Management", rawCompany: "Qlik" },
      { personId: 2, rawTitle: "Product Team Lead", rawCompany: null },
    ]);

    const lines = user.split("\n");
    expect(lines[0]).toBe('personId 1: "Director of Product Management" at Qlik');
    expect(lines[1]).toBe('personId 2: "Product Team Lead"');
  });

  it("returns the same system prompt regardless of input rows", () => {
    const a = buildTitleExtractionPrompt([]);
    const b = buildTitleExtractionPrompt([
      { personId: 1, rawTitle: "CEO", rawCompany: null },
    ]);
    expect(a.system).toBe(b.system);
    expect(a.system).toContain("Ambiguity rule");
  });
});

describe("parseTitleExtractionResponse", () => {
  it("extracts classifications from the tool_use block", () => {
    const results = parseTitleExtractionResponse(
      toolUseResponse([
        {
          personId: 1,
          standardizedTitle: "Director of Product Management",
          seniority: "director",
          function: "product_management",
        },
      ]),
    );
    expect(results).toEqual([
      {
        personId: 1,
        standardizedTitle: "Director of Product Management",
        seniority: "director",
        function: "product_management",
      },
    ]);
  });

  it("coerces an out-of-taxonomy seniority/function to unknown/other rather than trusting or throwing", () => {
    const results = parseTitleExtractionResponse(
      toolUseResponse([
        {
          personId: 1,
          standardizedTitle: "Consultant",
          seniority: "executive", // not a real taxonomy value
          function: "growth", // not a real taxonomy value
        },
      ]),
    );
    expect(results[0].seniority).toBe("unknown");
    expect(results[0].function).toBe("other");
  });

  it("throws when the response has no classify_titles tool call", () => {
    const response = { content: [{ type: "text", text: "sorry, I can't" }] } as Anthropic.Message;
    expect(() => parseTitleExtractionResponse(response)).toThrow();
  });
});

describe("persistTitleClassifications", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("writes standardizedTitle/seniority/function for multiple people in one call", async () => {
    const [alice, bob] = await testDb.db
      .insert(person)
      .values([{ name: "Alice" }, { name: "Bob" }])
      .returning();

    await persistTitleClassifications(testDb.db, [
      { personId: alice.id, standardizedTitle: "CEO", seniority: "c_level", function: "executive_general" },
      { personId: bob.id, standardizedTitle: "Engineer", seniority: "ic", function: "engineering" },
    ]);

    const rows = await testDb.db.query.person.findMany({ orderBy: (p, { asc }) => asc(p.id) });
    expect(rows.find((p) => p.id === alice.id)).toMatchObject({
      standardizedTitle: "CEO",
      seniority: "c_level",
      function: "executive_general",
    });
    expect(rows.find((p) => p.id === bob.id)).toMatchObject({
      standardizedTitle: "Engineer",
      seniority: "ic",
      function: "engineering",
    });
  });

  it("is a no-op on an empty results array", async () => {
    await expect(persistTitleClassifications(testDb.db, [])).resolves.toBeUndefined();
  });
});

describe("runWithConcurrency", () => {
  it("preserves result order regardless of completion order", async () => {
    const items = [30, 10, 20];
    const results = await runWithConcurrency(items, 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it("never runs more than `concurrency` workers at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await runWithConcurrency(items, 3, async (i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return i;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("runs every item exactly once", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (i) => {
      seen.push(i);
      return i;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
