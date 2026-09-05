import { and, eq } from "drizzle-orm";

import { contact, event, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import type { ParsedAddress } from "@/lib/gmail-parsing";

type ContactStatus = "pending" | "active";

export interface ContactResolutionResult {
  contactId: number;
  personId: number;
  wasCreated: boolean;
  // True when an existing "pending" (one-way-only) Contact was promoted to
  // "active" by this call — e.g. a reply just arrived to an old message.
  wasPromoted: boolean;
}

// Finds the existing Contact for a (source, email) pair, or creates a new
// solo Person + Contact for it. Every Contact belongs to exactly one Person
// from the moment it's created — merging later reassigns personId rather
// than ever leaving a Contact orphaned.
//
// `status` defaults to "active" (the historical behavior, and what
// tests/seed scripts want) — the import pipeline explicitly passes
// "pending" for addresses that are currently one-way-only. If an existing
// Contact is "pending" and this call passes "active", it's promoted;
// "active" Contacts are never downgraded back to "pending".
export async function findOrCreateContact(
  db: DrizzleDb,
  source: "gmail" | "hotmail" | "linkedin" | "sms",
  address: ParsedAddress,
  status: ContactStatus = "active",
): Promise<ContactResolutionResult> {
  const existing = await db.query.contact.findFirst({
    where: and(
      eq(contact.source, source),
      eq(contact.sourceIdentifier, address.email),
    ),
  });
  if (existing) {
    if (existing.status === "pending" && status === "active") {
      await db
        .update(contact)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(contact.id, existing.id));
      return {
        contactId: existing.id,
        personId: existing.personId,
        wasCreated: false,
        wasPromoted: true,
      };
    }
    return {
      contactId: existing.id,
      personId: existing.personId,
      wasCreated: false,
      wasPromoted: false,
    };
  }

  const [newPerson] = await db
    .insert(person)
    .values({ name: address.name ?? address.email })
    .returning();
  const [newContact] = await db
    .insert(contact)
    .values({
      personId: newPerson.id,
      source,
      sourceIdentifier: address.email,
      displayName: address.name,
      status,
    })
    .returning();

  return {
    contactId: newContact.id,
    personId: newPerson.id,
    wasCreated: true,
    wasPromoted: false,
  };
}

// Two-way detection for a single import batch can't see across batches: an
// old one-way message and a much-later reply can each look one-way on their
// own. This checks whether a Contact already has an Event in the opposite
// direction from a *previous* run, so a new one-way batch can be correctly
// recognized as completing a two-way conversation instead of staying
// pending forever just because both sides never landed in the same import.
export async function hasOppositeDirectionHistory(
  db: DrizzleDb,
  source: "gmail" | "hotmail" | "linkedin" | "sms",
  sourceIdentifier: string,
  batchDirection: "inbound" | "outbound",
): Promise<boolean> {
  const existing = await db.query.contact.findFirst({
    where: and(
      eq(contact.source, source),
      eq(contact.sourceIdentifier, sourceIdentifier),
    ),
  });
  if (!existing) return false;

  const oppositeDirection =
    batchDirection === "inbound" ? "outbound" : "inbound";
  const oppositeEvent = await db.query.event.findFirst({
    where: and(
      eq(event.contactId, existing.id),
      eq(event.direction, oppositeDirection),
    ),
  });
  return Boolean(oppositeEvent);
}
