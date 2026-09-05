import { and, eq, isNotNull } from "drizzle-orm";

import { contact, event, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

// The Person's summary embedding is the mean of all their Events'
// embeddings across every Contact — a cheap, no-extra-API-call way to
// derive "what does this person's history look like overall" from
// per-Event embeddings that already exist.
export function computeMeanEmbedding(
  vectors: number[][],
): number[] | null {
  if (vectors.length === 0) return null;

  const dimensions = vectors[0].length;
  const sum = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dimensions; i += 1) {
      sum[i] += vector[i];
    }
  }
  return sum.map((total) => total / vectors.length);
}

// Recomputes and persists a Person's summary embedding from all of their
// Contacts' Events that currently have an embedding. Call after any import
// that adds new embedded Events for this Person.
export async function updatePersonSummaryEmbedding(
  db: DrizzleDb,
  personId: number,
): Promise<void> {
  const rows = await db
    .select({ embedding: event.embedding })
    .from(event)
    .innerJoin(contact, eq(event.contactId, contact.id))
    .where(and(eq(contact.personId, personId), isNotNull(event.embedding)));

  const vectors = rows
    .map((row) => row.embedding)
    .filter((v): v is number[] => v !== null);

  const summaryEmbedding = computeMeanEmbedding(vectors);

  await db
    .update(person)
    .set({ summaryEmbedding, updatedAt: new Date() })
    .where(eq(person.id, personId));
}
