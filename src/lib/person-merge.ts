import { eq } from "drizzle-orm";

import { contact, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import type { CompanyIndustry } from "@/lib/industry-inference";
import type { PersonFunction, PersonSeniority } from "@/lib/title-extraction";

export class PersonNotFoundError extends Error {
  constructor(personId: number) {
    super(`No person found with id ${personId}`);
  }
}

export interface MergeResult {
  survivingPersonId: number;
  absorbedPersonId: number;
  mergedContactCount: number;
}

// The LinkedIn-derived fields (Phase 5, M28/M29) that would otherwise be
// silently lost when the Person carrying them happens to be the absorbed
// (deleted) side of a merge — mergePersonFields exists specifically to
// stop that.
export interface MergeablePersonFields {
  linkedinRawTitle: string | null;
  linkedinRawCompany: string | null;
  standardizedTitle: string | null;
  seniority: PersonSeniority | null;
  function: PersonFunction | null;
  normalizedCompanyName: string | null;
  industry: CompanyIndustry | null;
}

// Pure — the survivor's own non-null value wins for each field
// independently; only a field the survivor has never set (null) falls
// back to the absorbed Person's value. Without this, mergePersons picking
// a survivor by name length could delete the one Person who actually had
// LinkedIn-derived data (title, industry, etc.), silently losing it.
// Written out field-by-field rather than looping over the key list —
// TypeScript can't verify a generic `merged[key] = survivor[key] ?? ...`
// assignment is type-safe across a union of differently-typed fields.
export function mergePersonFields(
  survivor: MergeablePersonFields,
  absorbed: MergeablePersonFields,
): MergeablePersonFields {
  return {
    linkedinRawTitle: survivor.linkedinRawTitle ?? absorbed.linkedinRawTitle,
    linkedinRawCompany: survivor.linkedinRawCompany ?? absorbed.linkedinRawCompany,
    standardizedTitle: survivor.standardizedTitle ?? absorbed.standardizedTitle,
    seniority: survivor.seniority ?? absorbed.seniority,
    function: survivor.function ?? absorbed.function,
    normalizedCompanyName: survivor.normalizedCompanyName ?? absorbed.normalizedCompanyName,
    industry: survivor.industry ?? absorbed.industry,
  };
}

// Merges two Persons into one: every Contact (and its Events, by relation)
// moves to the surviving Person, and the absorbed Person row is deleted.
// The surviving Person keeps whichever of the two names is longer — a
// cheap but effective heuristic for "more complete" (e.g. "Vitaly
// Obernikhin" over "V. O.") — and, per mergePersonFields above, whichever
// side actually has LinkedIn-derived data for each field, independent of
// which side "won" the name.
export async function mergePersons(
  db: DrizzleDb,
  personAId: number,
  personBId: number,
): Promise<MergeResult> {
  if (personAId === personBId) {
    throw new Error("Cannot merge a Person with itself");
  }

  const [personA, personB] = await Promise.all([
    db.query.person.findFirst({ where: eq(person.id, personAId) }),
    db.query.person.findFirst({ where: eq(person.id, personBId) }),
  ]);
  if (!personA) throw new PersonNotFoundError(personAId);
  if (!personB) throw new PersonNotFoundError(personBId);

  const survivor = personA.name.length >= personB.name.length ? personA : personB;
  const absorbed = survivor.id === personA.id ? personB : personA;

  const movedContacts = await db
    .update(contact)
    .set({ personId: survivor.id, updatedAt: new Date() })
    .where(eq(contact.personId, absorbed.id))
    .returning({ id: contact.id });

  const mergedFields = mergePersonFields(survivor, absorbed);
  await db
    .update(person)
    .set({ ...mergedFields, updatedAt: new Date() })
    .where(eq(person.id, survivor.id));

  await db.delete(person).where(eq(person.id, absorbed.id));

  return {
    survivingPersonId: survivor.id,
    absorbedPersonId: absorbed.id,
    mergedContactCount: movedContacts.length,
  };
}

export class NothingToUnmergeError extends Error {
  constructor(personId: number) {
    super(`Person ${personId} has only one Contact — nothing to un-merge`);
  }
}

export interface UnmergeResult {
  // The Person id for each Contact that was under the original Person,
  // in the same order. The first one reuses the original Person's id and
  // takes that Contact's own name; the rest are newly created solo Persons.
  resultingPersonIds: number[];
}

// Splits every Contact under a Person back into its own solo Person — the
// full reverse of one or more accumulated merges. There's no stored
// "which merge produced this grouping" history (a merge just reassigns
// personId), so this ungroups everything at once rather than undoing a
// single specific merge; Events never move here since they belong to
// Contacts, not Persons, and Contacts keep their own id throughout.
export async function unmergePerson(
  db: DrizzleDb,
  personId: number,
): Promise<UnmergeResult> {
  const existingPerson = await db.query.person.findFirst({
    where: eq(person.id, personId),
  });
  if (!existingPerson) throw new PersonNotFoundError(personId);

  const contacts = await db.query.contact.findMany({
    where: eq(contact.personId, personId),
  });
  if (contacts.length <= 1) {
    throw new NothingToUnmergeError(personId);
  }

  // The first Contact keeps the original Person id, renamed to reflect
  // that it's no longer the merged identity.
  const [first, ...rest] = contacts;
  await db
    .update(person)
    .set({ name: first.displayName ?? first.sourceIdentifier, updatedAt: new Date() })
    .where(eq(person.id, personId));

  const resultingPersonIds = [personId];
  for (const c of rest) {
    const [newPerson] = await db
      .insert(person)
      .values({ name: c.displayName ?? c.sourceIdentifier })
      .returning();
    await db
      .update(contact)
      .set({ personId: newPerson.id, updatedAt: new Date() })
      .where(eq(contact.id, c.id));
    resultingPersonIds.push(newPerson.id);
  }

  return { resultingPersonIds };
}
