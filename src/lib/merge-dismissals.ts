import { and, eq } from "drizzle-orm";

import { dismissedMergeSuggestion } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

function normalizePair(
  personAId: number,
  personBId: number,
): [number, number] {
  return personAId < personBId
    ? [personAId, personBId]
    : [personBId, personAId];
}

export async function dismissMergeSuggestion(
  db: DrizzleDb,
  personAId: number,
  personBId: number,
): Promise<void> {
  const [a, b] = normalizePair(personAId, personBId);
  await db
    .insert(dismissedMergeSuggestion)
    .values({ personAId: a, personBId: b })
    .onConflictDoNothing({
      target: [
        dismissedMergeSuggestion.personAId,
        dismissedMergeSuggestion.personBId,
      ],
    });
}

export async function isMergeSuggestionDismissed(
  db: DrizzleDb,
  personAId: number,
  personBId: number,
): Promise<boolean> {
  const [a, b] = normalizePair(personAId, personBId);
  const existing = await db.query.dismissedMergeSuggestion.findFirst({
    where: and(
      eq(dismissedMergeSuggestion.personAId, a),
      eq(dismissedMergeSuggestion.personBId, b),
    ),
  });
  return Boolean(existing);
}

// One query for filtering a whole list of candidate suggestions, rather
// than one round-trip per pair.
export async function getDismissedPairKeys(
  db: DrizzleDb,
): Promise<Set<string>> {
  const rows = await db
    .select({
      personAId: dismissedMergeSuggestion.personAId,
      personBId: dismissedMergeSuggestion.personBId,
    })
    .from(dismissedMergeSuggestion);
  return new Set(rows.map((row) => `${row.personAId}:${row.personBId}`));
}

// Removes the dismissal so the pair can resurface as a suggestion again on
// the next visit (assuming it still scores above the suggestion threshold).
export async function undismissMergeSuggestion(
  db: DrizzleDb,
  personAId: number,
  personBId: number,
): Promise<void> {
  const [a, b] = normalizePair(personAId, personBId);
  await db
    .delete(dismissedMergeSuggestion)
    .where(
      and(
        eq(dismissedMergeSuggestion.personAId, a),
        eq(dismissedMergeSuggestion.personBId, b),
      ),
    );
}
