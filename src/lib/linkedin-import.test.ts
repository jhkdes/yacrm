import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { companyIndustryCache, contact, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  assertRowCountAllowed,
  computeBatchPlan,
  CONNECTIONS_BATCH_SIZE,
  importLinkedInConnections,
  MAX_CONNECTIONS_ROWS,
  parseConnectionsCsv,
  TooManyRowsError,
} from "@/lib/linkedin-import";
import { generateMergeSuggestions } from "@/lib/merge-suggestions";

// classifyTitles' full pipeline calls the real Anthropic API and is
// deliberately left untested at that layer (see title-extraction.ts) —
// mocking it here lets importLinkedInConnections' own DB logic (diff
// detection, raw-field persistence, skip-if-unchanged) be exercised
// without a real network call, the same tradeoff campaigns.test.ts makes
// mocking generateDraftForPerson. The mock still writes standardizedTitle
// back onto `person`, matching the real function's contract — the
// skip-if-unchanged check depends on standardizedTitle being non-null to
// tell "already classified" apart from "raw fields happen to match but
// classification never actually ran" (see the real-import incident this
// distinction was added for), so a mock that only returns values without
// persisting them would make every test see everyone as unclassified.
vi.mock("@/lib/title-extraction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/title-extraction")>();
  return {
    ...actual,
    classifyTitles: vi.fn(async (db, rows) => {
      const results = rows.map((r: { personId: number }) => ({
        personId: r.personId,
        standardizedTitle: `Standardized ${r.personId}`,
        seniority: "ic",
        function: "other",
      }));
      for (const r of results) {
        await db
          .update(person)
          .set({ standardizedTitle: r.standardizedTitle, seniority: r.seniority, function: r.function })
          .where(eq(person.id, r.personId));
      }
      return results;
    }),
  };
});

// Same rationale as the title-extraction mock above, applied to industry
// inference: writes real rows into companyIndustryCache (cache-hit-first,
// like the real function) so downstream dedup/backfill behavior is
// exercised for real, not just assumed.
vi.mock("@/lib/industry-inference", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-inference")>();
  return {
    ...actual,
    inferIndustries: vi.fn(async (db, names: string[]) => {
      const unique = [...new Set(names)];
      const cachedRows = await db
        .select()
        .from(companyIndustryCache)
        .where(inArray(companyIndustryCache.normalizedCompanyName, unique));
      const result = new Map(
        cachedRows.map((r: { normalizedCompanyName: string; industry: string }) => [
          r.normalizedCompanyName,
          r.industry,
        ]),
      );
      const missing = unique.filter((n) => !result.has(n));
      if (missing.length > 0) {
        const newRows = missing.map((name) => ({
          normalizedCompanyName: name,
          industry: "tech_enterprise_software" as const,
        }));
        await db.insert(companyIndustryCache).values(newRows).onConflictDoNothing();
        for (const r of newRows) result.set(r.normalizedCompanyName, r.industry);
      }
      return result;
    }),
  };
});

const SAMPLE_EXPORT = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,,Qlik,"Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy",04 Sep 2026
Charu,Agrawal,https://www.linkedin.com/in/charu-technologyleader,,Enertia Software,Product Team Lead,02 Sep 2026
Rohit,Arora,https://www.linkedin.com/in/rohitar,,Egnyte,"Senior Product Manager, AEC",01 Sep 2026
`;

describe("parseConnectionsCsv", () => {
  it("skips the Notes: preamble and parses each connection row", () => {
    const { rows, rowsSkippedNoUrl } = parseConnectionsCsv(SAMPLE_EXPORT);

    expect(rowsSkippedNoUrl).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      firstName: "Jeffrey",
      lastName: "Goldberg",
      profileUrl: "https://www.linkedin.com/in/goldbergjeffrey",
      email: null,
      company: "Qlik",
      position:
        "Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy",
      connectedOn: new Date("04 Sep 2026"),
    });
  });

  it("preserves a comma embedded in a quoted Position field", () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    const rohit = rows.find((r) => r.firstName === "Rohit");
    expect(rohit?.position).toBe("Senior Product Manager, AEC");
  });

  it("keeps a present email address when the export includes one", () => {
    const csv = SAMPLE_EXPORT.replace(
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,,Qlik",
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,jeffrey@example.com,Qlik",
    );
    const { rows } = parseConnectionsCsv(csv);
    expect(rows[0].email).toBe("jeffrey@example.com");
  });

  it("skips a row with no profile URL rather than throwing", () => {
    const csv = SAMPLE_EXPORT + "Anon,Person,,,,,\n";
    const { rows, rowsSkippedNoUrl } = parseConnectionsCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rowsSkippedNoUrl).toBe(1);
  });

  it("normalizes a trailing slash on the profile URL", () => {
    const csv = SAMPLE_EXPORT.replace(
      "https://www.linkedin.com/in/goldbergjeffrey,",
      "https://www.linkedin.com/in/goldbergjeffrey/,",
    );
    const { rows } = parseConnectionsCsv(csv);
    expect(rows[0].profileUrl).toBe(
      "https://www.linkedin.com/in/goldbergjeffrey",
    );
  });

  it("throws on a file with no recognizable header row", () => {
    expect(() => parseConnectionsCsv("not,a,linkedin,export\n1,2,3,4")).toThrow();
  });
});

describe("computeBatchPlan", () => {
  it("reports 1 batch for an empty file rather than 0", () => {
    expect(computeBatchPlan(0)).toEqual({ totalBatches: 1 });
  });

  it("reports 1 batch for exactly one batch's worth of rows", () => {
    expect(computeBatchPlan(CONNECTIONS_BATCH_SIZE)).toEqual({ totalBatches: 1 });
  });

  it("rounds up when rows spill one over a batch boundary", () => {
    expect(computeBatchPlan(CONNECTIONS_BATCH_SIZE + 1)).toEqual({ totalBatches: 2 });
  });

  it("matches the requirement's own 1,920-row example (16 batches of 120)", () => {
    expect(computeBatchPlan(16 * CONNECTIONS_BATCH_SIZE)).toEqual({ totalBatches: 16 });
  });

  it("computes the batch count at the max allowed row count", () => {
    expect(computeBatchPlan(MAX_CONNECTIONS_ROWS)).toEqual({
      totalBatches: Math.ceil(MAX_CONNECTIONS_ROWS / CONNECTIONS_BATCH_SIZE),
    });
  });
});

describe("assertRowCountAllowed", () => {
  it("allows exactly the maximum row count", () => {
    expect(() => assertRowCountAllowed(MAX_CONNECTIONS_ROWS)).not.toThrow();
  });

  it("rejects one row over the maximum, with the row count in the message", () => {
    expect(() => assertRowCountAllowed(MAX_CONNECTIONS_ROWS + 1)).toThrow(TooManyRowsError);

    let caught: unknown;
    try {
      assertRowCountAllowed(MAX_CONNECTIONS_ROWS + 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TooManyRowsError);
    expect((caught as TooManyRowsError).rowCount).toBe(MAX_CONNECTIONS_ROWS + 1);
    expect((caught as Error).message).toContain(String(MAX_CONNECTIONS_ROWS + 1));
  });
});

describe("importLinkedInConnections", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await testDb.client.close();
  });

  it("creates one active Contact per connection, and stores raw title/company on their Person", async () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    const summary = await importLinkedInConnections(testDb.db, rows);

    expect(summary.contactsCreated).toBe(3);
    expect(summary.titlesClassified).toBe(3);
    expect(summary.industriesInferred).toBe(3);

    const contacts = await testDb.db.query.contact.findMany({
      where: (c, { eq }) => eq(c.source, "linkedin"),
    });
    expect(contacts).toHaveLength(3);
    expect(contacts.every((c) => c.status === "active")).toBe(true);

    const jeffrey = contacts.find(
      (c) => c.sourceIdentifier === "https://www.linkedin.com/in/goldbergjeffrey",
    );
    const jeffreyPerson = await testDb.db.query.person.findFirst({
      where: (p, { eq }) => eq(p.id, jeffrey!.personId),
    });
    expect(jeffreyPerson?.linkedinRawTitle).toBe(
      "Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy",
    );
    expect(jeffreyPerson?.normalizedCompanyName).toBe("Qlik");
    expect(jeffreyPerson?.industry).toBe("tech_enterprise_software");
    expect(jeffreyPerson?.linkedinRawCompany).toBe("Qlik");
  });

  it("is idempotent: re-importing the same rows doesn't duplicate Contacts or re-classify", async () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);
    vi.clearAllMocks();
    const second = await importLinkedInConnections(testDb.db, rows);

    expect(second.contactsCreated).toBe(0);
    // Nothing changed since the first import, so no row should have been
    // queued for (re-)classification or (re-)industry-inference.
    expect(second.titlesClassified).toBe(0);
    expect(second.industriesInferred).toBe(0);

    const contacts = await testDb.db.select().from(contact);
    expect(contacts).toHaveLength(3);
  });

  it("re-classifies only the rows whose raw title/company changed on re-import", async () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);
    vi.clearAllMocks();

    const updatedRows = rows.map((r) =>
      r.firstName === "Charu" ? { ...r, position: "VP of Product" } : r,
    );
    const second = await importLinkedInConnections(testDb.db, updatedRows);

    expect(second.titlesClassified).toBe(1);

    const charu = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) =>
        eq(c.sourceIdentifier, "https://www.linkedin.com/in/charu-technologyleader"),
    });
    const charuPerson = await testDb.db.query.person.findFirst({
      where: (p, { eq }) => eq(p.id, charu!.personId),
    });
    expect(charuPerson?.linkedinRawTitle).toBe("VP of Product");
  });

  it("re-classifies a person whose raw title/company are unchanged but was never actually classified", async () => {
    // Reproduces the real incident this check exists for: an earlier run
    // persisted linkedinRawTitle/linkedinRawCompany but got interrupted
    // before classification ran (e.g. a killed request), leaving
    // standardizedTitle null. A naive "raw fields unchanged" skip would
    // treat that person as done and never retry them.
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);

    const jeffrey = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) =>
        eq(c.sourceIdentifier, "https://www.linkedin.com/in/goldbergjeffrey"),
    });
    await testDb.db
      .update(person)
      .set({ standardizedTitle: null, seniority: null, function: null })
      .where(eq(person.id, jeffrey!.personId));

    vi.clearAllMocks();
    const second = await importLinkedInConnections(testDb.db, rows);

    expect(second.titlesClassified).toBe(1);

    const jeffreyPerson = await testDb.db.query.person.findFirst({
      where: (p, { eq }) => eq(p.id, jeffrey!.personId),
    });
    expect(jeffreyPerson?.standardizedTitle).not.toBeNull();
  });

  it("re-infers industry for a person whose linkedinRawCompany is unchanged but industry was never set", async () => {
    // Same bug-class as the title regression above, applied to industry:
    // an interrupted import could persist linkedinRawCompany but never
    // reach industry inference, leaving industry null forever under a
    // naive "raw company unchanged" skip.
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);

    const jeffrey = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) =>
        eq(c.sourceIdentifier, "https://www.linkedin.com/in/goldbergjeffrey"),
    });
    await testDb.db.update(person).set({ industry: null }).where(eq(person.id, jeffrey!.personId));

    vi.clearAllMocks();
    const second = await importLinkedInConnections(testDb.db, rows);

    expect(second.industriesInferred).toBe(1);
    const jeffreyPerson = await testDb.db.query.person.findFirst({
      where: (p, { eq }) => eq(p.id, jeffrey!.personId),
    });
    expect(jeffreyPerson?.industry).not.toBeNull();
  });

  it("infers a company's industry once and backfills it onto other people at that company across separate import calls", async () => {
    const csvA = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Ann,One,https://www.linkedin.com/in/annone,,Qlik,Product Manager,01 Sep 2026
`;
    const csvB = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Bob,Two,https://www.linkedin.com/in/bobtwo,,Qlik,Engineer,01 Sep 2026
`;

    await importLinkedInConnections(testDb.db, parseConnectionsCsv(csvA).rows);
    await importLinkedInConnections(testDb.db, parseConnectionsCsv(csvB).rows);

    const cacheRows = await testDb.db.query.companyIndustryCache.findMany({
      where: (c, { eq }) => eq(c.normalizedCompanyName, "Qlik"),
    });
    // One cache row, not two — the second call's company was already
    // cached, so no fresh inference (and no duplicate row) happened.
    expect(cacheRows).toHaveLength(1);

    const bothPeople = await testDb.db.query.contact.findMany({
      where: (c, { eq }) => eq(c.source, "linkedin"),
      with: { person: true },
    });
    expect(bothPeople).toHaveLength(2);
    expect(bothPeople.every((c) => c.person?.industry === "tech_enterprise_software")).toBe(true);
  });

  it("attaches to an existing Person when the row's email matches an existing Gmail contact, without creating a new Person", async () => {
    const gmailPerson = await testDb.db
      .insert(person)
      .values({ name: "Jeffrey Goldberg" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: gmailPerson[0].id,
      source: "gmail",
      sourceIdentifier: "jeffrey@example.com",
      displayName: "Jeffrey Goldberg",
      status: "active",
    });

    const csv = SAMPLE_EXPORT.replace(
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,,Qlik",
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,jeffrey@example.com,Qlik",
    );
    const { rows } = parseConnectionsCsv(csv);
    const summary = await importLinkedInConnections(testDb.db, rows);

    // A new Contact was created (the LinkedIn one), but no new Person —
    // it attached to the existing Gmail-sourced Person.
    expect(summary.contactsCreated).toBe(3);
    const allPeople = await testDb.db.select().from(person);
    expect(allPeople).toHaveLength(3); // Jeffrey (pre-existing) + Charu + Rohit (new)

    const linkedinContact = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.sourceIdentifier, "https://www.linkedin.com/in/goldbergjeffrey"),
    });
    expect(linkedinContact?.personId).toBe(gmailPerson[0].id);

    // The LinkedIn-derived fields landed on the pre-existing Person, not
    // some other newly-created one.
    const jeffreyPerson = await testDb.db.query.person.findFirst({
      where: (p, { eq }) => eq(p.id, gmailPerson[0].id),
    });
    expect(jeffreyPerson?.linkedinRawCompany).toBe("Qlik");
  });

  it("falls back to creating a new Person when the row's email doesn't match any existing Contact", async () => {
    const csv = SAMPLE_EXPORT.replace(
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,,Qlik",
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,unmatched@example.com,Qlik",
    );
    const { rows } = parseConnectionsCsv(csv);
    const summary = await importLinkedInConnections(testDb.db, rows);

    expect(summary.contactsCreated).toBe(3);
    const allPeople = await testDb.db.select().from(person);
    expect(allPeople).toHaveLength(3);
  });

  it("flows into the source-agnostic merge-suggestion engine like any other Contact", async () => {
    // Simulate an existing Gmail contact who is also a LinkedIn connection
    // under the same name but a different identifier.
    const gmailPerson = await testDb.db
      .insert(person)
      .values({ name: "Jeffrey Goldberg" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: gmailPerson[0].id,
      source: "gmail",
      sourceIdentifier: "jgoldberg@example.com",
      displayName: "Jeffrey Goldberg",
      status: "active",
    });

    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);

    const allContacts = await testDb.db.query.contact.findMany();
    const forMatching = allContacts.map((c) => ({
      contactId: c.id,
      personId: c.personId,
      source: c.source,
      sourceIdentifier: c.sourceIdentifier,
      displayName: c.displayName,
    }));

    const suggestions = generateMergeSuggestions(forMatching);
    expect(
      suggestions.some(
        (s) =>
          [s.personAId, s.personBId].includes(gmailPerson[0].id) &&
          [s.personAId, s.personBId].includes(
            allContacts.find(
              (c) =>
                c.sourceIdentifier ===
                "https://www.linkedin.com/in/goldbergjeffrey",
            )!.personId,
          ),
      ),
    ).toBe(true);
  });

  it("produces the same end state whether rows arrive in one call or split across several (chunking is invariant)", async () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);

    // Split arbitrarily (not at CONNECTIONS_BATCH_SIZE, which is too large
    // to exercise meaningfully against a 3-row fixture) — the property
    // under test is that chunking itself doesn't change the outcome, which
    // doesn't depend on the real batch size.
    await importLinkedInConnections(testDb.db, rows.slice(0, 2));
    await importLinkedInConnections(testDb.db, rows.slice(2));

    const chunkedContacts = await testDb.db.query.contact.findMany({
      where: (c, { eq }) => eq(c.source, "linkedin"),
      orderBy: (c, { asc }) => asc(c.sourceIdentifier),
    });
    const chunkedPeople = await Promise.all(
      chunkedContacts.map((c) =>
        testDb.db.query.person.findFirst({ where: (p, { eq }) => eq(p.id, c.personId) }),
      ),
    );

    const freshDb = await createTestDb();
    try {
      await importLinkedInConnections(freshDb.db, rows);
      const singleShotContacts = await freshDb.db.query.contact.findMany({
        where: (c, { eq }) => eq(c.source, "linkedin"),
        orderBy: (c, { asc }) => asc(c.sourceIdentifier),
      });
      const singleShotPeople = await Promise.all(
        singleShotContacts.map((c) =>
          freshDb.db.query.person.findFirst({ where: (p, { eq }) => eq(p.id, c.personId) }),
        ),
      );

      expect(chunkedContacts.map((c) => c.sourceIdentifier)).toEqual(
        singleShotContacts.map((c) => c.sourceIdentifier),
      );
      expect(
        chunkedPeople.map((p) => ({
          linkedinRawTitle: p?.linkedinRawTitle,
          standardizedTitle: p?.standardizedTitle,
          seniority: p?.seniority,
          function: p?.function,
          normalizedCompanyName: p?.normalizedCompanyName,
          industry: p?.industry,
        })),
      ).toEqual(
        singleShotPeople.map((p) => ({
          linkedinRawTitle: p?.linkedinRawTitle,
          standardizedTitle: p?.standardizedTitle,
          seniority: p?.seniority,
          function: p?.function,
          normalizedCompanyName: p?.normalizedCompanyName,
          industry: p?.industry,
        })),
      );
    } finally {
      await freshDb.client.close();
    }
  });
});
