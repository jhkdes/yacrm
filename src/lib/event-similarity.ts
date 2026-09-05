import { and, cosineDistance, eq, isNotNull, ne, sql } from "drizzle-orm";

import { event } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

export interface NearestEvent {
  id: number;
  distance: number;
}

// Ranks Events by cosine distance to the given embedding (0 = identical
// direction, 2 = opposite) — the core nearest-neighbor query embeddings
// exist to support. Excludes Events without an embedding, and optionally
// the query Event itself so it doesn't trivially rank as its own nearest
// neighbor.
export async function findNearestEvents(
  db: DrizzleDb,
  embedding: number[],
  limit: number,
  excludeEventId?: number,
): Promise<NearestEvent[]> {
  const distance = sql<number>`${cosineDistance(event.embedding, embedding)}`;

  return db
    .select({ id: event.id, distance })
    .from(event)
    .where(
      excludeEventId === undefined
        ? isNotNull(event.embedding)
        : and(isNotNull(event.embedding), ne(event.id, excludeEventId)),
    )
    .orderBy(distance)
    .limit(limit);
}

export async function findNearestEventsTo(
  db: DrizzleDb,
  eventId: number,
  limit: number,
): Promise<NearestEvent[]> {
  const target = await db.query.event.findFirst({
    where: eq(event.id, eventId),
  });
  if (!target?.embedding) {
    throw new Error(`Event ${eventId} has no embedding`);
  }
  return findNearestEvents(db, target.embedding, limit, eventId);
}
