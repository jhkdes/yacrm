import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, EMBEDDING_DIMENSIONS, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  computeMeanEmbedding,
  updatePersonSummaryEmbedding,
} from "./person-embedding";

// The embedding column is a fixed vector(512) — zero-padding a short,
// readable test vector out to that length doesn't change its mean (or
// cosine distance) relative to any other equally-padded vector.
function pad(vector: number[]): number[] {
  return [
    ...vector,
    ...Array(EMBEDDING_DIMENSIONS - vector.length).fill(0),
  ];
}

describe("computeMeanEmbedding", () => {
  it("returns null for an empty list", () => {
    expect(computeMeanEmbedding([])).toBeNull();
  });

  it("returns the same vector for a single input", () => {
    expect(computeMeanEmbedding([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it("averages component-wise across multiple vectors", () => {
    expect(
      computeMeanEmbedding([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    ).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
});

describe("updatePersonSummaryEmbedding", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("sets the mean of all the Person's Contacts' embedded Events", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Nadia" })
      .returning();
    const [contactA] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "nadia@gmail.com",
      })
      .returning();
    const [contactB] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "nadia@work.com",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: contactA.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "a",
      sourceMessageId: "msg-a",
      embedding: pad([1, 0]),
    });
    await testDb.db.insert(event).values({
      contactId: contactB.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "b",
      sourceMessageId: "msg-b",
      embedding: pad([0, 1]),
    });

    await updatePersonSummaryEmbedding(testDb.db, p.id);

    const updated = await testDb.db.query.person.findFirst({
      where: (row, { eq }) => eq(row.id, p.id),
    });
    expect(updated?.summaryEmbedding).toEqual(pad([0.5, 0.5]));
  });

  it("ignores Events without an embedding", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Nadia" })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "nadia@gmail.com",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: c.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "a",
      sourceMessageId: "msg-a",
      embedding: pad([1, 1]),
    });
    await testDb.db.insert(event).values({
      contactId: c.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "b",
      sourceMessageId: "msg-b",
      // no embedding
    });

    await updatePersonSummaryEmbedding(testDb.db, p.id);

    const updated = await testDb.db.query.person.findFirst({
      where: (row, { eq }) => eq(row.id, p.id),
    });
    expect(updated?.summaryEmbedding).toEqual(pad([1, 1]));
  });

  it("only includes Events from this Person's own Contacts", async () => {
    const [personA] = await testDb.db
      .insert(person)
      .values({ name: "Nadia" })
      .returning();
    const [contactA] = await testDb.db
      .insert(contact)
      .values({
        personId: personA.id,
        source: "gmail",
        sourceIdentifier: "nadia@gmail.com",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: contactA.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "a",
      sourceMessageId: "msg-a",
      embedding: pad([1, 0]),
    });

    const [personB] = await testDb.db
      .insert(person)
      .values({ name: "Someone Else" })
      .returning();
    const [contactB] = await testDb.db
      .insert(contact)
      .values({
        personId: personB.id,
        source: "gmail",
        sourceIdentifier: "someone@gmail.com",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: contactB.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "b",
      sourceMessageId: "msg-b",
      embedding: pad([0, 100]),
    });

    await updatePersonSummaryEmbedding(testDb.db, personA.id);

    const updated = await testDb.db.query.person.findFirst({
      where: (row, { eq }) => eq(row.id, personA.id),
    });
    expect(updated?.summaryEmbedding).toEqual(pad([1, 0]));
  });
});
