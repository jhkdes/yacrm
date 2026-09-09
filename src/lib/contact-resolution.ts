import { and, eq, inArray } from "drizzle-orm";

import { contact, event, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

type ContactStatus = "pending" | "active";

// A source-native identity: an email address for gmail/hotmail, a phone
// number for sms, a profile URL for linkedin. Named generically (not
// ParsedAddress/email) because `sourceIdentifier` is not always an email
// address.
export interface ContactIdentity {
  name: string | null;
  identifier: string;
}

export interface ContactResolutionResult {
  contactId: number;
  personId: number;
  wasCreated: boolean;
  // True when an existing "pending" (one-way-only) Contact was promoted to
  // "active" by this call — e.g. a reply just arrived to an old message.
  wasPromoted: boolean;
}

// Finds the existing Contact for a (source, identifier) pair, or creates a new
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
  source: "gmail" | "hotmail" | "linkedin" | "sms" | "google_calendar",
  identity: ContactIdentity,
  status: ContactStatus = "active",
): Promise<ContactResolutionResult> {
  const existing = await db.query.contact.findFirst({
    where: and(
      eq(contact.source, source),
      eq(contact.sourceIdentifier, identity.identifier),
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
    .values({ name: identity.name ?? identity.identifier })
    .returning();
  const [newContact] = await db
    .insert(contact)
    .values({
      personId: newPerson.id,
      source,
      sourceIdentifier: identity.identifier,
      displayName: identity.name,
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

// M24: looks up an existing Contact by email only — no creation, unlike
// findOrCreateContact. Restricted to the two email-shaped sources (gmail,
// hotmail); sms's identifier is a phone number and linkedin's is a profile
// URL, so neither could ever collide with an email anyway, but being
// explicit here is cheap and correct rather than relying on that being
// true by accident. Used by calendar-import.ts to match a meeting attendee
// to a Contact that already exists — an unmatched attendee is M25's job
// (findOrCreateContact with source "google_calendar"), not this one's.
export async function findContactByEmail(
  db: DrizzleDb,
  email: string,
): Promise<{ contactId: number; personId: number } | undefined> {
  const existing = await db.query.contact.findFirst({
    where: and(
      inArray(contact.source, ["gmail", "hotmail"]),
      eq(contact.sourceIdentifier, email.trim().toLowerCase()),
    ),
  });
  if (!existing) return undefined;
  return { contactId: existing.id, personId: existing.personId };
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
