import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import { bulkUpdateByKey } from "@/lib/db-bulk-update";

describe("bulkUpdateByKey", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function seedPeople(names: string[]) {
    const rows = await testDb.db.insert(person).values(names.map((name) => ({ name }))).returning();
    return rows;
  }

  it("writes each row's own values without cross-contamination", async () => {
    const [alice, bob, carol] = await seedPeople(["Alice", "Bob", "Carol"]);

    await bulkUpdateByKey(testDb.db, {
      table: "person",
      keyColumn: "id",
      keyType: "integer",
      setColumns: [
        { column: "standardized_title", sqlType: "text" },
        { column: "seniority", sqlType: "person_seniority" },
        { column: "function", sqlType: "person_function" },
      ],
      rows: [
        { id: alice.id, standardized_title: "CEO", seniority: "c_level", function: "executive_general" },
        { id: bob.id, standardized_title: "Engineer", seniority: "ic", function: "engineering" },
        { id: carol.id, standardized_title: "VP Sales", seniority: "vp", function: "sales" },
      ],
    });

    const updated = await testDb.db.query.person.findMany({
      orderBy: (p, { asc }) => asc(p.id),
    });

    expect(updated.find((p) => p.id === alice.id)).toMatchObject({
      standardizedTitle: "CEO",
      seniority: "c_level",
      function: "executive_general",
    });
    expect(updated.find((p) => p.id === bob.id)).toMatchObject({
      standardizedTitle: "Engineer",
      seniority: "ic",
      function: "engineering",
    });
    expect(updated.find((p) => p.id === carol.id)).toMatchObject({
      standardizedTitle: "VP Sales",
      seniority: "vp",
      function: "sales",
    });
  });

  it("writes SQL NULL correctly when a row's value is null", async () => {
    const [alice] = await seedPeople(["Alice"]);

    await bulkUpdateByKey(testDb.db, {
      table: "person",
      keyColumn: "id",
      keyType: "integer",
      setColumns: [{ column: "linkedin_raw_company", sqlType: "text" }],
      rows: [{ id: alice.id, linkedin_raw_company: null }],
    });

    const updated = await testDb.db.query.person.findFirst({ where: (p, { eq }) => eq(p.id, alice.id) });
    expect(updated?.linkedinRawCompany).toBeNull();
  });

  it("respects extraWhere, excluding rows that don't match it", async () => {
    const [alice, bob] = await seedPeople(["Alice", "Bob"]);
    // Alice already has an industry set; Bob doesn't.
    await testDb.db.update(person).set({ industry: "tech_fintech" }).where(eq(person.id, alice.id));

    await bulkUpdateByKey(testDb.db, {
      table: "person",
      keyColumn: "id",
      keyType: "integer",
      setColumns: [{ column: "industry", sqlType: "company_industry" }],
      rows: [
        { id: alice.id, industry: "tech_enterprise_software" },
        { id: bob.id, industry: "tech_enterprise_software" },
      ],
      extraWhere: `t."industry" IS NULL`,
    });

    const updated = await testDb.db.query.person.findMany({ orderBy: (p, { asc }) => asc(p.id) });
    // Alice's pre-existing value is untouched (extraWhere excluded her); Bob's got set.
    expect(updated.find((p) => p.id === alice.id)?.industry).toBe("tech_fintech");
    expect(updated.find((p) => p.id === bob.id)?.industry).toBe("tech_enterprise_software");
  });

  it("is a no-op on an empty rows array", async () => {
    await expect(
      bulkUpdateByKey(testDb.db, {
        table: "person",
        keyColumn: "id",
        keyType: "integer",
        setColumns: [{ column: "standardized_title", sqlType: "text" }],
        rows: [],
      }),
    ).resolves.toBeUndefined();
  });
});
