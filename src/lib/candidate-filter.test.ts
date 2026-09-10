import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import { filterCandidates, sortFilterResults, type FilterResult } from "@/lib/candidate-filter";

describe("filterCandidates", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function seedPerson(opts: {
    name: string;
    standardizedTitle?: string;
    seniority?: "ic" | "manager" | "director" | "vp" | "c_level" | "founder" | "unknown";
    function?: string;
    industry?: string;
    company?: string;
    contactStatus?: "active" | "pending";
    withEvent?: boolean;
  }) {
    const [p] = await testDb.db
      .insert(person)
      .values({
        name: opts.name,
        standardizedTitle: opts.standardizedTitle ?? null,
        seniority: opts.seniority ?? null,
        function: (opts.function as never) ?? null,
        industry: (opts.industry as never) ?? null,
        linkedinRawCompany: opts.company ?? null,
      })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "linkedin",
        sourceIdentifier: `https://www.linkedin.com/in/${opts.name.replace(/\s+/g, "-").toLowerCase()}`,
        displayName: opts.name,
        status: opts.contactStatus ?? "active",
      })
      .returning();
    if (opts.withEvent) {
      await testDb.db.insert(event).values({
        contactId: c.id,
        direction: "inbound",
        occurredAt: new Date("2026-01-01"),
        subject: "Hi",
        bodyText: "hello",
        sourceMessageId: `msg-${p.id}`,
      });
    }
    return p;
  }

  it("returns every person with an active LinkedIn contact, including one with zero events", async () => {
    const withEvents = await seedPerson({ name: "Ann Hasmessages", withEvent: true });
    const noEvents = await seedPerson({ name: "Bob Nomessages", withEvent: false });

    const results = await filterCandidates(testDb.db, {});

    const ids = results.map((r) => r.personId);
    expect(ids).toContain(withEvents.id);
    expect(ids).toContain(noEvents.id); // the actual M32 behavior change
  });

  it("excludes a person whose only LinkedIn contact is pending", async () => {
    await seedPerson({ name: "Pending Person", contactStatus: "pending" });

    const results = await filterCandidates(testDb.db, {});
    expect(results.map((r) => r.name)).not.toContain("Pending Person");
  });

  it("excludes a person with no LinkedIn contact at all", async () => {
    await testDb.db.insert(person).values({ name: "No LinkedIn" });

    const results = await filterCandidates(testDb.db, {});
    expect(results.map((r) => r.name)).not.toContain("No LinkedIn");
  });

  it("filters by title substring, case-insensitively", async () => {
    await seedPerson({ name: "Dana PM", standardizedTitle: "Director of Product Management" });
    await seedPerson({ name: "Eli Eng", standardizedTitle: "Software Engineer" });

    const results = await filterCandidates(testDb.db, { titleQuery: "product" });
    expect(results.map((r) => r.name)).toEqual(["Dana PM"]);
  });

  it("filters by seniority, ORing multiple values", async () => {
    await seedPerson({ name: "Frank Director", seniority: "director" });
    await seedPerson({ name: "Grace VP", seniority: "vp" });
    await seedPerson({ name: "Hank IC", seniority: "ic" });

    const results = await filterCandidates(testDb.db, { seniority: ["director", "vp"] });
    expect(results.map((r) => r.name).sort()).toEqual(["Frank Director", "Grace VP"]);
  });

  it("filters by function", async () => {
    await seedPerson({ name: "Ivy Eng", function: "engineering" });
    await seedPerson({ name: "Jan Sales", function: "sales" });

    const results = await filterCandidates(testDb.db, { function: ["engineering"] });
    expect(results.map((r) => r.name)).toEqual(["Ivy Eng"]);
  });

  it("filters by industry", async () => {
    await seedPerson({ name: "Kim Fintech", industry: "tech_fintech" });
    await seedPerson({ name: "Leo Healthcare", industry: "healthcare" });

    const results = await filterCandidates(testDb.db, { industry: ["tech_fintech"] });
    expect(results.map((r) => r.name)).toEqual(["Kim Fintech"]);
  });

  it("ANDs across fields", async () => {
    await seedPerson({ name: "Match", seniority: "director", function: "product_management" });
    await seedPerson({ name: "WrongFunction", seniority: "director", function: "sales" });
    await seedPerson({ name: "WrongSeniority", seniority: "ic", function: "product_management" });

    const results = await filterCandidates(testDb.db, {
      seniority: ["director"],
      function: ["product_management"],
    });
    expect(results.map((r) => r.name)).toEqual(["Match"]);
  });

  it("sorts by name by default", async () => {
    await seedPerson({ name: "Zed" });
    await seedPerson({ name: "Anna" });
    await seedPerson({ name: "Mike" });

    const results = await filterCandidates(testDb.db, {});
    expect(results.map((r) => r.name)).toEqual(["Anna", "Mike", "Zed"]);
  });

  it("populates lastInteractionAt from events, and leaves it null when there's no history", async () => {
    const withEvent = await seedPerson({ name: "Has History", withEvent: true });
    const noEvent = await seedPerson({ name: "No History", withEvent: false });

    const results = await filterCandidates(testDb.db, {});
    const historyResult = results.find((r) => r.personId === withEvent.id);
    const noHistoryResult = results.find((r) => r.personId === noEvent.id);

    expect(historyResult?.lastInteractionAt).toEqual(new Date("2026-01-01"));
    expect(noHistoryResult?.lastInteractionAt).toBeNull();
  });

  it("returns an empty array when nothing matches", async () => {
    await seedPerson({ name: "Someone", seniority: "ic" });
    const results = await filterCandidates(testDb.db, { seniority: ["c_level"] });
    expect(results).toEqual([]);
  });

  it("populates linkedinProfileUrl from the person's LinkedIn contact identifier", async () => {
    const p = await seedPerson({ name: "Has Profile" });
    const results = await filterCandidates(testDb.db, {});
    const result = results.find((r) => r.personId === p.id);
    expect(result?.linkedinProfileUrl).toBe("https://www.linkedin.com/in/has-profile");
  });
});

describe("sortFilterResults", () => {
  function makeResult(overrides: Partial<FilterResult> & { personId: number }): FilterResult {
    return {
      name: `Person ${overrides.personId}`,
      standardizedTitle: null,
      company: null,
      seniority: null,
      function: null,
      industry: null,
      lastInteractionAt: null,
      linkedinProfileUrl: `https://www.linkedin.com/in/person-${overrides.personId}`,
      ...overrides,
    };
  }

  it("sorts ascending by name", () => {
    const results = [
      makeResult({ personId: 1, name: "Zed" }),
      makeResult({ personId: 2, name: "Anna" }),
    ];
    expect(sortFilterResults(results, "name", "asc").map((r) => r.name)).toEqual(["Anna", "Zed"]);
  });

  it("sorts descending by name", () => {
    const results = [
      makeResult({ personId: 1, name: "Anna" }),
      makeResult({ personId: 2, name: "Zed" }),
    ];
    expect(sortFilterResults(results, "name", "desc").map((r) => r.name)).toEqual(["Zed", "Anna"]);
  });

  it("sorts by lastInteraction, most recent first when descending", () => {
    const results = [
      makeResult({ personId: 1, lastInteractionAt: new Date("2026-01-01") }),
      makeResult({ personId: 2, lastInteractionAt: new Date("2026-03-01") }),
    ];
    const sorted = sortFilterResults(results, "lastInteraction", "desc");
    expect(sorted.map((r) => r.personId)).toEqual([2, 1]);
  });

  it("sorts nulls last regardless of direction", () => {
    const results = [
      makeResult({ personId: 1, standardizedTitle: null }),
      makeResult({ personId: 2, standardizedTitle: "Engineer" }),
      makeResult({ personId: 3, standardizedTitle: "Manager" }),
    ];

    const asc = sortFilterResults(results, "title", "asc");
    expect(asc[asc.length - 1].personId).toBe(1);

    const desc = sortFilterResults(results, "title", "desc");
    expect(desc[desc.length - 1].personId).toBe(1);
  });

  it("puts an all-null field in its original relative order without throwing", () => {
    const results = [
      makeResult({ personId: 1, industry: null }),
      makeResult({ personId: 2, industry: null }),
    ];
    expect(sortFilterResults(results, "industry", "asc")).toHaveLength(2);
    expect(sortFilterResults(results, "industry", "desc")).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const results = [makeResult({ personId: 1, name: "Zed" }), makeResult({ personId: 2, name: "Anna" })];
    const original = [...results];
    sortFilterResults(results, "name", "asc");
    expect(results).toEqual(original);
  });
});
