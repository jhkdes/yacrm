import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  dismissMergeSuggestion,
  getDismissedPairKeys,
  isMergeSuggestionDismissed,
  undismissMergeSuggestion,
} from "./merge-dismissals";

describe("merge dismissals", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let personAId: number;
  let personBId: number;

  beforeEach(async () => {
    testDb = await createTestDb();
    const [a] = await testDb.db.insert(person).values({ name: "A" }).returning();
    const [b] = await testDb.db.insert(person).values({ name: "B" }).returning();
    personAId = a.id;
    personBId = b.id;
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("is not dismissed before any dismissal is recorded", async () => {
    expect(
      await isMergeSuggestionDismissed(testDb.db, personAId, personBId),
    ).toBe(false);
  });

  it("is dismissed after recording, regardless of argument order", async () => {
    await dismissMergeSuggestion(testDb.db, personAId, personBId);

    expect(
      await isMergeSuggestionDismissed(testDb.db, personAId, personBId),
    ).toBe(true);
    expect(
      await isMergeSuggestionDismissed(testDb.db, personBId, personAId),
    ).toBe(true);
  });

  it("is idempotent to dismiss the same pair twice", async () => {
    await dismissMergeSuggestion(testDb.db, personAId, personBId);
    await expect(
      dismissMergeSuggestion(testDb.db, personBId, personAId),
    ).resolves.not.toThrow();
  });

  it("getDismissedPairKeys returns a normalized (smaller:larger) key", async () => {
    await dismissMergeSuggestion(testDb.db, Math.max(personAId, personBId), Math.min(personAId, personBId));

    const keys = await getDismissedPairKeys(testDb.db);
    expect(keys.has(`${Math.min(personAId, personBId)}:${Math.max(personAId, personBId)}`)).toBe(true);
  });

  it("undismissMergeSuggestion removes the dismissal, regardless of argument order", async () => {
    await dismissMergeSuggestion(testDb.db, personAId, personBId);
    expect(
      await isMergeSuggestionDismissed(testDb.db, personAId, personBId),
    ).toBe(true);

    await undismissMergeSuggestion(testDb.db, personBId, personAId);

    expect(
      await isMergeSuggestionDismissed(testDb.db, personAId, personBId),
    ).toBe(false);
  });

  it("undismissMergeSuggestion is a no-op when nothing was dismissed", async () => {
    await expect(
      undismissMergeSuggestion(testDb.db, personAId, personBId),
    ).resolves.not.toThrow();
  });
});
