import { and, asc, eq } from "drizzle-orm";

import { personTag } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

// Pure: trims and lowercases so "VIP" and "vip" entered on two different
// occasions land on the same tag instead of silently forking into two —
// there's no fixed vocabulary here (see schema.ts's personTag comment),
// so this normalization is the only thing preventing accidental
// near-duplicates.
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface ToggleTagResult {
  tag: string;
  // true if the tag is now present on the Person, false if this call just
  // removed it.
  tagged: boolean;
}

// Adds the tag if the Person doesn't have it, removes it if they do — a
// single control on the profile page drives both directions, so the
// caller doesn't need to already know the current state.
export async function toggleTag(
  db: DrizzleDb,
  personId: number,
  rawTag: string,
): Promise<ToggleTagResult> {
  const tag = normalizeTag(rawTag);
  if (!tag) {
    throw new Error("Tag can't be empty.");
  }

  const existing = await db.query.personTag.findFirst({
    where: and(eq(personTag.personId, personId), eq(personTag.tag, tag)),
  });

  if (existing) {
    await db.delete(personTag).where(eq(personTag.id, existing.id));
    return { tag, tagged: false };
  }

  await db.insert(personTag).values({ personId, tag });
  return { tag, tagged: true };
}

export async function listTagsForPerson(
  db: DrizzleDb,
  personId: number,
): Promise<string[]> {
  const rows = await db
    .select({ tag: personTag.tag })
    .from(personTag)
    .where(eq(personTag.personId, personId))
    .orderBy(asc(personTag.tag));
  return rows.map((r) => r.tag);
}

// Every tag in use, for the campaigns page's "target a tag" dropdown — a
// free-text field here would let a typo silently produce zero recipients,
// which a dropdown of tags that actually exist can't do.
export async function listDistinctTags(db: DrizzleDb): Promise<string[]> {
  const rows = await db.selectDistinct({ tag: personTag.tag }).from(personTag);
  return rows.map((r) => r.tag).sort();
}

export async function listPersonIdsByTag(
  db: DrizzleDb,
  rawTag: string,
): Promise<number[]> {
  const tag = normalizeTag(rawTag);
  const rows = await db
    .select({ personId: personTag.personId })
    .from(personTag)
    .where(eq(personTag.tag, tag));
  return rows.map((r) => r.personId);
}
