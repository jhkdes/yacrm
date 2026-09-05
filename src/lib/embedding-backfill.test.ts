import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contact, EMBEDDING_DIMENSIONS, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import { backfillEmbeddings } from "./embedding-backfill";

function pad(vector: number[]): number[] {
  return [...vector, ...Array(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
}

function fakeVoyageFetch() {
  return vi.fn().mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        data: body.input.map((text: string, index: number) => ({
          // Deterministic fake embedding derived from text length, so tests
          // don't depend on real Voyage output.
          embedding: pad([text.length, 0]),
          index,
        })),
      }),
    };
  });
}

describe("backfillEmbeddings", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    process.env.VOYAGE_API_KEY = "test-key";
  });

  afterEach(async () => {
    await testDb.client.close();
    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });

  it("embeds Events missing an embedding and recomputes the affected Person's summary", async () => {
    vi.stubGlobal("fetch", fakeVoyageFetch());

    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Nadia" })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "nadia@example.com",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: c.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "hello",
      sourceMessageId: "msg-1",
      // no embedding
    });

    const result = await backfillEmbeddings(testDb.db);

    expect(result).toEqual({
      eventsFound: 1,
      eventsEmbedded: 1,
      personsUpdated: 1,
    });

    const updatedEvent = await testDb.db.query.event.findFirst({
      where: (e, { eq }) => eq(e.sourceMessageId, "msg-1"),
    });
    expect(updatedEvent?.embedding).not.toBeNull();

    const updatedPerson = await testDb.db.query.person.findFirst({
      where: (row, { eq }) => eq(row.id, p.id),
    });
    expect(updatedPerson?.summaryEmbedding).not.toBeNull();
  });

  it("does not touch Events that already have an embedding", async () => {
    const fetchMock = fakeVoyageFetch();
    vi.stubGlobal("fetch", fetchMock);

    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Nadia" })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "nadia@example.com",
      })
      .returning();
    const existingEmbedding = Array(512).fill(0.5);
    await testDb.db.insert(event).values({
      contactId: c.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "already embedded",
      sourceMessageId: "msg-1",
      embedding: existingEmbedding,
    });

    const result = await backfillEmbeddings(testDb.db);

    expect(result).toEqual({
      eventsFound: 0,
      eventsEmbedded: 0,
      personsUpdated: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const unchanged = await testDb.db.query.event.findFirst({
      where: (e, { eq }) => eq(e.sourceMessageId, "msg-1"),
    });
    expect(unchanged?.embedding).toEqual(existingEmbedding);
  });

  it("is a no-op when there are no Events at all", async () => {
    vi.stubGlobal("fetch", fakeVoyageFetch());

    const result = await backfillEmbeddings(testDb.db);

    expect(result).toEqual({
      eventsFound: 0,
      eventsEmbedded: 0,
      personsUpdated: 0,
    });
  });
});
