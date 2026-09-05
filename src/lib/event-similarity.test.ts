import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, EMBEDDING_DIMENSIONS, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import { findNearestEvents, findNearestEventsTo } from "./event-similarity";

// The embedding column is a fixed vector(512) — zero-padding a short,
// readable test vector out to that length doesn't change its cosine
// distance to any other equally-padded vector, so tests can use short
// vectors like pad([1, 0.1, 0]) without needing 512 real numbers.
function pad(vector: number[]): number[] {
  return [
    ...vector,
    ...Array(EMBEDDING_DIMENSIONS - vector.length).fill(0),
  ];
}

describe("findNearestEvents / findNearestEventsTo", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function seedEventWithEmbedding(
    sourceMessageId: string,
    embedding: number[],
  ) {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: sourceMessageId })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: `${sourceMessageId}@example.com`,
      })
      .returning();
    const [e] = await testDb.db
      .insert(event)
      .values({
        contactId: c.id,
        direction: "inbound",
        occurredAt: new Date(),
        bodyText: sourceMessageId,
        sourceMessageId,
        embedding,
      })
      .returning();
    return e;
  }

  it("ranks a known-similar pair closer than a known-dissimilar Event", async () => {
    // Two "similar topic" events point in nearly the same direction; the
    // "dissimilar topic" event points in an orthogonal direction.
    const similarA = await seedEventWithEmbedding("similar-a", pad([1, 0.1, 0]));
    const similarB = await seedEventWithEmbedding("similar-b", pad([0.9, 0.2, 0]));
    const dissimilar = await seedEventWithEmbedding("dissimilar", pad([0, 0, 1]));

    const nearestToA = await findNearestEventsTo(testDb.db, similarA.id, 2);

    expect(nearestToA.map((n) => n.id)).toEqual([similarB.id, dissimilar.id]);
    expect(nearestToA[0].distance).toBeLessThan(nearestToA[1].distance);
  });

  it("excludes Events without an embedding", async () => {
    const withEmbedding = await seedEventWithEmbedding(
      "has-embedding",
      pad([1, 0, 0]),
    );

    const [p] = await testDb.db
      .insert(person)
      .values({ name: "no-embedding" })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "no-embedding@example.com",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: c.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "no embedding",
      sourceMessageId: "no-embedding",
      // embedding intentionally omitted (null)
    });

    const results = await findNearestEvents(testDb.db, pad([1, 0, 0]), 10);

    expect(results.map((r) => r.id)).toEqual([withEmbedding.id]);
  });

  it("throws a clear error when asked for neighbors of an Event with no embedding", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "no-embedding" })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "no-embedding@example.com",
      })
      .returning();
    const [e] = await testDb.db
      .insert(event)
      .values({
        contactId: c.id,
        direction: "inbound",
        occurredAt: new Date(),
        bodyText: "no embedding",
        sourceMessageId: "no-embedding",
      })
      .returning();

    await expect(findNearestEventsTo(testDb.db, e.id, 5)).rejects.toThrow(
      /no embedding/,
    );
  });
});
