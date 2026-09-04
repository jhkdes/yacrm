import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import { findOrCreateContact } from "@/lib/contact-resolution";

import {
  ContactNotFoundError,
  getPurgedIdentifiers,
  purgeContact,
  unpurgeIdentifier,
} from "./contact-purge";

describe("purgeContact", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("deletes the Contact, its Events, and the now-empty Person", async () => {
    const { contactId } = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    await testDb.db.insert(event).values({
      contactId,
      direction: "inbound",
      occurredAt: new Date(),
      subject: "Hi",
      bodyText: "Hello",
      sourceMessageId: "msg-1",
    });

    await purgeContact(testDb.db, contactId);

    expect(await testDb.db.select().from(contact)).toHaveLength(0);
    expect(await testDb.db.select().from(event)).toHaveLength(0);
    expect(await testDb.db.select().from(person)).toHaveLength(0);
  });

  it("keeps the Person alive if it still has other Contacts", async () => {
    const { contactId: gmailContactId } = await findOrCreateContact(
      testDb.db,
      "gmail",
      { name: "Ada", email: "ada@example.com" },
    );
    const gmailContact = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, gmailContactId),
    });

    // Simulate a second Contact already merged into the same Person (as
    // M7's merge engine would produce).
    const [linkedinContact] = await testDb.db
      .insert(contact)
      .values({
        personId: gmailContact!.personId,
        source: "linkedin",
        sourceIdentifier: "ada-linkedin",
        displayName: "Ada",
      })
      .returning();

    await purgeContact(testDb.db, gmailContactId);

    expect(await testDb.db.select().from(person)).toHaveLength(1);
    const remainingContacts = await testDb.db.select().from(contact);
    expect(remainingContacts).toHaveLength(1);
    expect(remainingContacts[0].id).toBe(linkedinContact.id);
  });

  it("records the identifier as purged so it can be checked by future imports", async () => {
    const { contactId } = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });

    await purgeContact(testDb.db, contactId);

    const purged = await getPurgedIdentifiers(testDb.db, "gmail");
    expect(purged.has("ada@example.com")).toBe(true);
  });

  it("throws ContactNotFoundError for an unknown contact id", async () => {
    await expect(purgeContact(testDb.db, 999)).rejects.toThrow(
      ContactNotFoundError,
    );
  });

  it("is idempotent to purge the same identifier twice via different re-created contacts", async () => {
    const first = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });
    await purgeContact(testDb.db, first.contactId);

    // Re-creating a Contact for the same address (e.g. a race, or a manual
    // insert bypassing the import's purged-check) should still purge cleanly.
    const second = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });
    await expect(
      purgeContact(testDb.db, second.contactId),
    ).resolves.not.toThrow();

    const purged = await getPurgedIdentifiers(testDb.db, "gmail");
    expect(purged.has("ada@example.com")).toBe(true);
  });
});

describe("unpurgeIdentifier", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("removes the identifier from the purged set", async () => {
    const { contactId } = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });
    await purgeContact(testDb.db, contactId);
    expect(
      (await getPurgedIdentifiers(testDb.db, "gmail")).has("ada@example.com"),
    ).toBe(true);

    await unpurgeIdentifier(testDb.db, "gmail", "ada@example.com");

    expect(
      (await getPurgedIdentifiers(testDb.db, "gmail")).has("ada@example.com"),
    ).toBe(false);
  });

  it("only un-purges the matching source, leaving other sources' purges intact", async () => {
    const { contactId } = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });
    await purgeContact(testDb.db, contactId);
    const { contactId: linkedinContactId } = await findOrCreateContact(
      testDb.db,
      "linkedin",
      { name: "Ada", email: "ada@example.com" },
    );
    await purgeContact(testDb.db, linkedinContactId);

    await unpurgeIdentifier(testDb.db, "gmail", "ada@example.com");

    expect(
      (await getPurgedIdentifiers(testDb.db, "gmail")).has("ada@example.com"),
    ).toBe(false);
    expect(
      (await getPurgedIdentifiers(testDb.db, "linkedin")).has(
        "ada@example.com",
      ),
    ).toBe(true);
  });

  it("does nothing (does not throw) when the identifier was never purged", async () => {
    await expect(
      unpurgeIdentifier(testDb.db, "gmail", "never-purged@example.com"),
    ).resolves.not.toThrow();
  });
});
