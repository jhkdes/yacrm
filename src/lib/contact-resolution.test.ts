import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb } from "@/db/test-utils";
import { contact, event, person } from "@/db/schema";
import {
  findOrCreateContact,
  hasOppositeDirectionHistory,
} from "@/lib/contact-resolution";

describe("findOrCreateContact", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("creates a new solo Person + Contact when the address is unseen", async () => {
    const result = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });

    expect(result.wasCreated).toBe(true);

    const contactRow = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, result.contactId),
      with: { person: true },
    });
    expect(contactRow?.sourceIdentifier).toBe("ada@example.com");
    expect(contactRow?.person.name).toBe("Ada Lovelace");
  });

  it("returns the existing Contact on a second call with the same address", async () => {
    const first = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    const second = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada Lovelace (updated display name)",
      email: "ada@example.com",
    });

    expect(second.wasCreated).toBe(false);
    expect(second.contactId).toBe(first.contactId);

    const allContacts = await testDb.db.select().from(contact);
    expect(allContacts).toHaveLength(1);
    const allPersons = await testDb.db.select().from(person);
    expect(allPersons).toHaveLength(1);
  });

  it("treats the same email under different sources as different Contacts", async () => {
    const gmailContact = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });
    const linkedinContact = await findOrCreateContact(testDb.db, "linkedin", {
      name: "Ada",
      email: "ada@example.com",
    });

    expect(linkedinContact.contactId).not.toBe(gmailContact.contactId);
  });

  it("defaults to active status when no status is passed", async () => {
    const { contactId } = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });
    const contactRow = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, contactId),
    });
    expect(contactRow?.status).toBe("active");
  });

  it("creates a pending Contact when status is explicitly pending", async () => {
    const { contactId } = await findOrCreateContact(
      testDb.db,
      "gmail",
      { name: "Ada", email: "ada@example.com" },
      "pending",
    );
    const contactRow = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, contactId),
    });
    expect(contactRow?.status).toBe("pending");
  });

  it("promotes an existing pending Contact to active", async () => {
    const first = await findOrCreateContact(
      testDb.db,
      "gmail",
      { name: "Ada", email: "ada@example.com" },
      "pending",
    );
    expect(first.wasPromoted).toBe(false);

    const second = await findOrCreateContact(
      testDb.db,
      "gmail",
      { name: "Ada", email: "ada@example.com" },
      "active",
    );

    expect(second.wasCreated).toBe(false);
    expect(second.wasPromoted).toBe(true);
    expect(second.contactId).toBe(first.contactId);

    const contactRow = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, first.contactId),
    });
    expect(contactRow?.status).toBe("active");
  });

  it("never downgrades an active Contact back to pending", async () => {
    const first = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });

    const second = await findOrCreateContact(
      testDb.db,
      "gmail",
      { name: "Ada", email: "ada@example.com" },
      "pending",
    );

    expect(second.wasPromoted).toBe(false);
    const contactRow = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) => eq(c.id, first.contactId),
    });
    expect(contactRow?.status).toBe("active");
  });
});

describe("event uniqueness constraint", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("silently skips inserting a duplicate (contactId, sourceMessageId) Event", async () => {
    const { contactId } = await findOrCreateContact(testDb.db, "gmail", {
      name: "Ada",
      email: "ada@example.com",
    });

    const eventValues = {
      contactId,
      direction: "inbound" as const,
      occurredAt: new Date("2026-01-15T10:00:00Z"),
      subject: "Hello",
      bodyText: "Hi there",
      sourceMessageId: "gmail-msg-001",
    };

    const first = await testDb.db
      .insert(event)
      .values(eventValues)
      .onConflictDoNothing({ target: [event.contactId, event.sourceMessageId] })
      .returning({ id: event.id });
    const second = await testDb.db
      .insert(event)
      .values(eventValues)
      .onConflictDoNothing({ target: [event.contactId, event.sourceMessageId] })
      .returning({ id: event.id });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);

    const allEvents = await testDb.db.select().from(event);
    expect(allEvents).toHaveLength(1);
  });
});

describe("hasOppositeDirectionHistory", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("returns false when the Contact doesn't exist yet", async () => {
    expect(
      await hasOppositeDirectionHistory(
        testDb.db,
        "gmail",
        "unknown@example.com",
        "inbound",
      ),
    ).toBe(false);
  });

  it("returns false when only the same-direction history exists", async () => {
    const { contactId } = await findOrCreateContact(
      testDb.db,
      "gmail",
      { name: "Nadia", email: "nadia@example.com" },
      "pending",
    );
    await testDb.db.insert(event).values({
      contactId,
      direction: "inbound",
      occurredAt: new Date(),
      subject: "Thanks",
      bodyText: "Thanks, all the best!",
      sourceMessageId: "msg-1",
    });

    expect(
      await hasOppositeDirectionHistory(
        testDb.db,
        "gmail",
        "nadia@example.com",
        "inbound",
      ),
    ).toBe(false);
  });

  it("returns true when a prior opposite-direction Event exists — the old-message-plus-later-reply case", async () => {
    const { contactId } = await findOrCreateContact(
      testDb.db,
      "gmail",
      { name: "Nadia", email: "nadia@example.com" },
      "pending",
    );
    await testDb.db.insert(event).values({
      contactId,
      direction: "inbound",
      occurredAt: new Date("2026-09-02"),
      subject: "Thanks",
      bodyText: "Thanks, all the best!",
      sourceMessageId: "msg-1",
    });

    // A new batch containing only the reply (outbound) should see that
    // inbound history already exists and report a match.
    expect(
      await hasOppositeDirectionHistory(
        testDb.db,
        "gmail",
        "nadia@example.com",
        "outbound",
      ),
    ).toBe(true);
  });
});
