import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  mergePersons,
  NothingToUnmergeError,
  PersonNotFoundError,
  unmergePerson,
} from "./person-merge";

async function seedTwoPeople(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [personA] = await db
    .insert(person)
    .values({ name: "N. K." })
    .returning();
  const [contactA] = await db
    .insert(contact)
    .values({
      personId: personA.id,
      source: "gmail",
      sourceIdentifier: "nadia.kowalski@gmail.com",
      displayName: "N. K.",
    })
    .returning();
  await db.insert(event).values({
    contactId: contactA.id,
    direction: "inbound",
    occurredAt: new Date("2026-01-01"),
    subject: "Hi",
    bodyText: "Hello from Gmail",
    sourceMessageId: "msg-a",
  });

  const [personB] = await db
    .insert(person)
    .values({ name: "Nadia Kowalski" })
    .returning();
  const [contactB] = await db
    .insert(contact)
    .values({
      personId: personB.id,
      source: "gmail",
      sourceIdentifier: "nkowalski@work.com",
      displayName: "Nadia Kowalski",
    })
    .returning();
  await db.insert(event).values({
    contactId: contactB.id,
    direction: "outbound",
    occurredAt: new Date("2026-01-02"),
    subject: "Re: Hi",
    bodyText: "Hello from work",
    sourceMessageId: "msg-b",
  });

  return { personA, contactA, personB, contactB };
}

describe("mergePersons", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("moves both Contacts under one surviving Person, keeping all Events", async () => {
    const { personA, personB } = await seedTwoPeople(testDb.db);

    const result = await mergePersons(testDb.db, personA.id, personB.id);

    const remainingPeople = await testDb.db.select().from(person);
    expect(remainingPeople).toHaveLength(1);
    expect(remainingPeople[0].id).toBe(result.survivingPersonId);

    const remainingContacts = await testDb.db.select().from(contact);
    expect(remainingContacts).toHaveLength(2);
    expect(remainingContacts.every((c) => c.personId === result.survivingPersonId)).toBe(true);

    const allEvents = await testDb.db.select().from(event);
    expect(allEvents).toHaveLength(2);
  });

  it("keeps the longer (more complete-looking) name", async () => {
    const { personA, personB } = await seedTwoPeople(testDb.db);

    const result = await mergePersons(testDb.db, personA.id, personB.id);

    // personB has the longer name ("Nadia Kowalski" vs "N. K.").
    expect(result.survivingPersonId).toBe(personB.id);
    const survivor = await testDb.db.query.person.findFirst({
      where: (p, { eq }) => eq(p.id, result.survivingPersonId),
    });
    expect(survivor?.name).toBe("Nadia Kowalski");
  });

  it("works regardless of argument order", async () => {
    const { personA, personB } = await seedTwoPeople(testDb.db);

    const result = await mergePersons(testDb.db, personB.id, personA.id);

    expect(result.survivingPersonId).toBe(personB.id);
    expect(result.absorbedPersonId).toBe(personA.id);
  });

  it("throws PersonNotFoundError for an unknown person id", async () => {
    const { personA } = await seedTwoPeople(testDb.db);
    await expect(mergePersons(testDb.db, personA.id, 999999)).rejects.toThrow(
      PersonNotFoundError,
    );
  });

  it("throws when asked to merge a Person with itself", async () => {
    const { personA } = await seedTwoPeople(testDb.db);
    await expect(mergePersons(testDb.db, personA.id, personA.id)).rejects.toThrow();
  });
});

describe("unmergePerson", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("restores each Contact's Event count exactly, with no loss or cross-contamination", async () => {
    const { personA, personB, contactA, contactB } = await seedTwoPeople(
      testDb.db,
    );
    const beforeEventsA = await testDb.db
      .select()
      .from(event)
      .where(eq(event.contactId, contactA.id));
    const beforeEventsB = await testDb.db
      .select()
      .from(event)
      .where(eq(event.contactId, contactB.id));

    const mergeResult = await mergePersons(testDb.db, personA.id, personB.id);

    const unmergeResult = await unmergePerson(
      testDb.db,
      mergeResult.survivingPersonId,
    );

    expect(unmergeResult.resultingPersonIds).toHaveLength(2);

    const afterEventsA = await testDb.db
      .select()
      .from(event)
      .where(eq(event.contactId, contactA.id));
    const afterEventsB = await testDb.db
      .select()
      .from(event)
      .where(eq(event.contactId, contactB.id));

    expect(afterEventsA).toHaveLength(beforeEventsA.length);
    expect(afterEventsB).toHaveLength(beforeEventsB.length);

    // Each Contact ended up under a different Person again.
    const contactAAfter = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, contactA.id),
    });
    const contactBAfter = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, contactB.id),
    });
    expect(contactAAfter?.personId).not.toBe(contactBAfter?.personId);
    expect(unmergeResult.resultingPersonIds).toContain(contactAAfter?.personId);
    expect(unmergeResult.resultingPersonIds).toContain(contactBAfter?.personId);
  });

  it("results in exactly two Persons, each with exactly one Contact", async () => {
    const { personA, personB } = await seedTwoPeople(testDb.db);
    const { survivingPersonId } = await mergePersons(
      testDb.db,
      personA.id,
      personB.id,
    );

    await unmergePerson(testDb.db, survivingPersonId);

    const allPeople = await testDb.db.select().from(person);
    expect(allPeople).toHaveLength(2);

    for (const p of allPeople) {
      const contactsForPerson = await testDb.db
        .select()
        .from(contact)
        .where(eq(contact.personId, p.id));
      expect(contactsForPerson).toHaveLength(1);
    }
  });

  it("names the resulting Persons after their own Contact, not the old merged name", async () => {
    const { personA, personB } = await seedTwoPeople(testDb.db);
    const { survivingPersonId } = await mergePersons(
      testDb.db,
      personA.id,
      personB.id,
    );

    await unmergePerson(testDb.db, survivingPersonId);

    const names = (await testDb.db.select().from(person)).map((p) => p.name);
    expect(names.sort()).toEqual(["N. K.", "Nadia Kowalski"].sort());
  });

  it("throws PersonNotFoundError for an unknown person id", async () => {
    await expect(unmergePerson(testDb.db, 999999)).rejects.toThrow(
      PersonNotFoundError,
    );
  });

  it("throws NothingToUnmergeError when the Person has only one Contact", async () => {
    const [solo] = await testDb.db
      .insert(person)
      .values({ name: "Solo Person" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: solo.id,
      source: "gmail",
      sourceIdentifier: "solo@example.com",
      displayName: "Solo Person",
    });

    await expect(unmergePerson(testDb.db, solo.id)).rejects.toThrow(
      NothingToUnmergeError,
    );
  });
});
