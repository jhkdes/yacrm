import { and, eq } from "drizzle-orm";

import { contact, event, person, purgedContact } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

export class ContactNotFoundError extends Error {
  constructor(contactId: number) {
    super(`No contact found with id ${contactId}`);
  }
}

// Deletes a Contact and its Events, and records its (source, identifier) as
// permanently excluded so future imports never recreate it. If the Contact
// was its Person's only Contact, the now-empty Person is deleted too.
export async function purgeContact(
  db: DrizzleDb,
  contactId: number,
): Promise<void> {
  const target = await db.query.contact.findFirst({
    where: eq(contact.id, contactId),
  });
  if (!target) {
    throw new ContactNotFoundError(contactId);
  }

  await db
    .insert(purgedContact)
    .values({
      source: target.source,
      sourceIdentifier: target.sourceIdentifier,
    })
    .onConflictDoNothing({
      target: [purgedContact.source, purgedContact.sourceIdentifier],
    });

  await db.delete(event).where(eq(event.contactId, contactId));
  await db.delete(contact).where(eq(contact.id, contactId));

  const remainingSiblingContacts = await db.query.contact.findMany({
    where: eq(contact.personId, target.personId),
  });
  if (remainingSiblingContacts.length === 0) {
    await db.delete(person).where(eq(person.id, target.personId));
  }
}

// Gmail import (and future sources) check this before ever creating a
// Contact for an address, so a purge sticks across re-imports.
export async function getPurgedIdentifiers(
  db: DrizzleDb,
  source: "gmail" | "hotmail" | "linkedin" | "sms",
): Promise<Set<string>> {
  const rows = await db
    .select({ sourceIdentifier: purgedContact.sourceIdentifier })
    .from(purgedContact)
    .where(eq(purgedContact.source, source));
  return new Set(rows.map((row) => row.sourceIdentifier));
}

// Removes the exclusion. This does not restore any previously deleted
// Contact/Events — those were hard-deleted by purgeContact — but since the
// underlying messages still exist at the source (e.g. Gmail), the next
// import for that address will recreate them from scratch.
export async function unpurgeIdentifier(
  db: DrizzleDb,
  source: "gmail" | "hotmail" | "linkedin" | "sms",
  sourceIdentifier: string,
): Promise<void> {
  await db
    .delete(purgedContact)
    .where(
      and(
        eq(purgedContact.source, source),
        eq(purgedContact.sourceIdentifier, sourceIdentifier),
      ),
    );
}
