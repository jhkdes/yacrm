import { eq, isNull } from "drizzle-orm";

import { contact, event } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { generateEmbeddings } from "@/lib/embeddings";
import { updatePersonSummaryEmbedding } from "@/lib/person-embedding";

export interface BackfillResult {
  eventsFound: number;
  eventsEmbedded: number;
  personsUpdated: number;
}

// Embeds any existing Event that predates M11 (or whose embedding call
// failed at import time) and recomputes summary embeddings for every
// affected Person. Safe to re-run — only ever touches Events that are still
// missing an embedding.
export async function backfillEmbeddings(
  db: DrizzleDb,
): Promise<BackfillResult> {
  const rows = await db
    .select({
      eventId: event.id,
      bodyText: event.bodyText,
      personId: contact.personId,
    })
    .from(event)
    .innerJoin(contact, eq(event.contactId, contact.id))
    .where(isNull(event.embedding));

  const result: BackfillResult = {
    eventsFound: rows.length,
    eventsEmbedded: 0,
    personsUpdated: 0,
  };
  if (rows.length === 0) return result;

  const embeddings = await generateEmbeddings(rows.map((r) => r.bodyText));

  const affectedPersonIds = new Set<number>();
  for (const [index, row] of rows.entries()) {
    const embedding = embeddings[index];
    if (!embedding) continue;
    await db
      .update(event)
      .set({ embedding })
      .where(eq(event.id, row.eventId));
    result.eventsEmbedded += 1;
    affectedPersonIds.add(row.personId);
  }

  for (const personId of affectedPersonIds) {
    await updatePersonSummaryEmbedding(db, personId);
  }
  result.personsUpdated = affectedPersonIds.size;

  return result;
}
