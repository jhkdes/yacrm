import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { person, personTag } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  listDistinctTags,
  listPersonIdsByTag,
  listTagsForPerson,
  normalizeTag,
  toggleTag,
} from "./person-tags";

describe("normalizeTag", () => {
  it("trims and lowercases", () => {
    expect(normalizeTag("  VIP  ")).toBe("vip");
  });
});

describe("toggleTag", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("adds the tag when the Person doesn't have it yet", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();

    const result = await toggleTag(testDb.db, p.id, "VIP");

    expect(result).toEqual({ tag: "vip", tagged: true });
    const rows = await testDb.db.select().from(personTag);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ personId: p.id, tag: "vip" });
  });

  it("removes the tag on a second call", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    await toggleTag(testDb.db, p.id, "vip");

    const result = await toggleTag(testDb.db, p.id, "vip");

    expect(result).toEqual({ tag: "vip", tagged: false });
    expect(await testDb.db.select().from(personTag)).toHaveLength(0);
  });

  it("treats differently-cased input as the same tag", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    await toggleTag(testDb.db, p.id, "VIP");

    const result = await toggleTag(testDb.db, p.id, "vip");

    expect(result.tagged).toBe(false);
    expect(await testDb.db.select().from(personTag)).toHaveLength(0);
  });

  it("throws for an empty (or whitespace-only) tag", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    await expect(toggleTag(testDb.db, p.id, "   ")).rejects.toThrow();
  });
});

describe("listTagsForPerson / listDistinctTags / listPersonIdsByTag", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("lists a Person's own tags, sorted", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    await toggleTag(testDb.db, p.id, "vip");
    await toggleTag(testDb.db, p.id, "advisor");

    expect(await listTagsForPerson(testDb.db, p.id)).toEqual(["advisor", "vip"]);
  });

  it("lists every distinct tag across all people", async () => {
    const [a] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    const [b] = await testDb.db.insert(person).values({ name: "Bob" }).returning();
    await toggleTag(testDb.db, a.id, "vip");
    await toggleTag(testDb.db, b.id, "vip");
    await toggleTag(testDb.db, b.id, "advisor");

    expect(await listDistinctTags(testDb.db)).toEqual(["advisor", "vip"]);
  });

  it("lists exactly the people carrying a given tag", async () => {
    const [a] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    const [b] = await testDb.db.insert(person).values({ name: "Bob" }).returning();
    const [c] = await testDb.db.insert(person).values({ name: "Carol" }).returning();
    await toggleTag(testDb.db, a.id, "vip");
    await toggleTag(testDb.db, b.id, "vip");
    await toggleTag(testDb.db, c.id, "advisor");

    const ids = await listPersonIdsByTag(testDb.db, "VIP");
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });
});
