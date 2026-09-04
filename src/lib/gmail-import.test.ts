import { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, oauthAccount, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import { purgeContact } from "@/lib/contact-purge";

import {
  NeverImportedError,
  recordSuccessfulSync,
  resolveSyncStartDate,
  runGmailImport,
} from "./gmail-import";

const OWN_EMAIL = "me@example.com";

function header(name: string, value: string) {
  return { name, value };
}

interface FakeMessageSpec {
  id: string;
  outbound: boolean;
  from: string;
  to: string;
  subject: string;
  body: string;
  internalDate: string;
  extraHeaders?: Record<string, string>;
}

// Builds a fake Gmail client (only the two methods runGmailImport calls)
// backed by an in-memory list of messages — no real network call, no OAuth.
function createFakeGmailClient(messages: FakeMessageSpec[]): gmail_v1.Gmail {
  const fake = {
    users: {
      messages: {
        list: async () => ({
          data: { messages: messages.map((m) => ({ id: m.id })) },
        }),
        get: async ({ id }: { id: string }) => {
          const spec = messages.find((m) => m.id === id);
          if (!spec) throw new Error(`no fake message for id ${id}`);
          const bodyData = Buffer.from(spec.body, "utf-8").toString(
            "base64url",
          );
          return {
            data: {
              id: spec.id,
              labelIds: spec.outbound ? ["SENT"] : ["INBOX"],
              internalDate: spec.internalDate,
              snippet: spec.body.slice(0, 50),
              payload: {
                headers: [
                  header("From", spec.from),
                  header("To", spec.to),
                  header("Subject", spec.subject),
                  ...Object.entries(spec.extraHeaders ?? {}).map(
                    ([name, value]) => header(name, value),
                  ),
                ],
                mimeType: "text/plain",
                body: { data: bodyData },
              },
            } satisfies gmail_v1.Schema$Message,
          };
        },
      },
    },
  };
  return fake as unknown as gmail_v1.Gmail;
}

describe("runGmailImport", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("imports a real two-way conversation as a Contact with both Events", async () => {
    const gmail = createFakeGmailClient([
      {
        id: "msg-1",
        outbound: false,
        from: "Ada Lovelace <ada@example.com>",
        to: OWN_EMAIL,
        subject: "Hi",
        body: "Hello there",
        internalDate: "1000",
      },
      {
        id: "msg-2",
        outbound: true,
        from: OWN_EMAIL,
        to: "Ada Lovelace <ada@example.com>",
        subject: "Re: Hi",
        body: "Hi Ada!",
        internalDate: "2000",
      },
    ]);

    const summary = await runGmailImport(
      testDb.db,
      gmail,
      OWN_EMAIL,
      "2026-01-01",
    );

    expect(summary.eventsCreated).toBe(2);
    expect(summary.contactsCreated).toBe(1);

    const contacts = await testDb.db.select().from(contact);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].sourceIdentifier).toBe("ada@example.com");
  });

  it("never creates a Contact for a purged address, even with a two-way exchange", async () => {
    const gmail = createFakeGmailClient([
      {
        id: "msg-1",
        outbound: false,
        from: "Bob <bob@example.com>",
        to: OWN_EMAIL,
        subject: "Hi",
        body: "Hello",
        internalDate: "1000",
      },
      {
        id: "msg-2",
        outbound: true,
        from: OWN_EMAIL,
        to: "Bob <bob@example.com>",
        subject: "Re: Hi",
        body: "Hey Bob",
        internalDate: "2000",
      },
    ]);

    // Purge Bob before the import runs, the same way the /contacts page
    // would after a previous import created him.
    const [bobPerson] = await testDb.db
      .insert(person)
      .values({ name: "Bob" })
      .returning();
    const [bobContact] = await testDb.db
      .insert(contact)
      .values({
        personId: bobPerson.id,
        source: "gmail",
        sourceIdentifier: "bob@example.com",
        displayName: "Bob",
      })
      .returning();
    await purgeContact(testDb.db, bobContact.id);

    const summary = await runGmailImport(
      testDb.db,
      gmail,
      OWN_EMAIL,
      "2026-01-01",
    );

    expect(summary.eventsCreated).toBe(0);
    expect(summary.eventsSkippedPurged).toBe(2);
    expect(summary.contactsCreated).toBe(0);

    const contacts = await testDb.db.select().from(contact);
    expect(contacts).toHaveLength(0);
  });

  it("persists a one-way (non-bulk) sender as pending instead of discarding it", async () => {
    const gmail = createFakeGmailClient([
      // real two-way contact
      {
        id: "msg-1",
        outbound: false,
        from: "Ada <ada@example.com>",
        to: OWN_EMAIL,
        subject: "Hi",
        body: "Hello",
        internalDate: "1000",
      },
      {
        id: "msg-2",
        outbound: true,
        from: OWN_EMAIL,
        to: "Ada <ada@example.com>",
        subject: "Re: Hi",
        body: "Hi Ada",
        internalDate: "2000",
      },
      // one-way so far — not (yet) a confirmed personal contact, but not
      // bulk/automated either, so it's kept as pending rather than dropped.
      {
        id: "msg-3",
        outbound: false,
        from: "Sales <sales@vendor.com>",
        to: OWN_EMAIL,
        subject: "Special offer",
        body: "Buy now",
        internalDate: "3000",
      },
    ]);

    const summary = await runGmailImport(
      testDb.db,
      gmail,
      OWN_EMAIL,
      "2026-01-01",
    );

    expect(summary.eventsCreated).toBe(3);
    expect(summary.contactsCreated).toBe(2);
    expect(summary.contactsPending).toBe(1);

    const contacts = await testDb.db.select().from(contact);
    const bySource = new Map(contacts.map((c) => [c.sourceIdentifier, c]));
    expect(bySource.get("ada@example.com")?.status).toBe("active");
    expect(bySource.get("sales@vendor.com")?.status).toBe("pending");
  });

  it("still hard-excludes a bulk/automated sender — never persisted at all", async () => {
    const gmail = createFakeGmailClient([
      {
        id: "msg-1",
        outbound: false,
        from: "Newsletter <news@company.com>",
        to: OWN_EMAIL,
        subject: "This week's digest",
        body: "Big news",
        internalDate: "1000",
        extraHeaders: { "List-Unsubscribe": "<mailto:unsub@company.com>" },
      },
    ]);

    const summary = await runGmailImport(
      testDb.db,
      gmail,
      OWN_EMAIL,
      "2026-01-01",
    );

    expect(summary.eventsCreated).toBe(0);
    expect(summary.eventsSkippedBulkSender).toBe(1);
    expect(summary.contactsCreated).toBe(0);
    expect(await testDb.db.select().from(contact)).toHaveLength(0);
  });

  it("promotes a pending contact to active when a reply arrives in a later sync", async () => {
    // First sync: only the inbound "thanks" message exists.
    const firstRun = createFakeGmailClient([
      {
        id: "msg-1",
        outbound: false,
        from: "N. K. <nadia@example.com>",
        to: OWN_EMAIL,
        subject: "Thanks",
        body: "Thanks so much, appreciate it!",
        internalDate: "1000",
      },
    ]);
    const firstSummary = await runGmailImport(
      testDb.db,
      firstRun,
      OWN_EMAIL,
      "2026-01-01",
    );
    expect(firstSummary.contactsPending).toBe(1);

    let contacts = await testDb.db.select().from(contact);
    expect(contacts[0].status).toBe("pending");

    // Later sync: only the outbound reply is in this batch's date window —
    // the original inbound message is now outside it, but its history
    // should still be found in the DB.
    const secondRun = createFakeGmailClient([
      {
        id: "msg-2",
        outbound: true,
        from: OWN_EMAIL,
        to: "N. K. <nadia@example.com>",
        subject: "Re: Thanks",
        body: "Happy to help, anytime!",
        internalDate: "2000",
      },
    ]);
    const secondSummary = await runGmailImport(
      testDb.db,
      secondRun,
      OWN_EMAIL,
      "2026-02-01",
    );
    expect(secondSummary.contactsPromoted).toBe(1);
    expect(secondSummary.eventsCreated).toBe(1);

    contacts = await testDb.db.select().from(contact);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].status).toBe("active");
  });
});

describe("resolveSyncStartDate", () => {
  it("returns the last synced date when one exists", () => {
    expect(resolveSyncStartDate("2026-01-15")).toBe("2026-01-15");
  });

  it("throws NeverImportedError when there is no prior sync", () => {
    expect(() => resolveSyncStartDate(null)).toThrow(NeverImportedError);
  });
});

describe("recordSuccessfulSync", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("sets lastSyncedDate on the account", async () => {
    const [account] = await testDb.db
      .insert(oauthAccount)
      .values({
        provider: "gmail",
        emailAddress: OWN_EMAIL,
        accessToken: "token",
        expiresAt: new Date(),
      })
      .returning();
    expect(account.lastSyncedDate).toBeNull();

    await recordSuccessfulSync(testDb.db, account.id, "2026-02-20");

    const updated = await testDb.db.query.oauthAccount.findFirst({
      where: (a, { eq }) => eq(a.id, account.id),
    });
    expect(updated?.lastSyncedDate).toBe("2026-02-20");
  });

  it("overwrites a previously recorded date on a later sync", async () => {
    const [account] = await testDb.db
      .insert(oauthAccount)
      .values({
        provider: "gmail",
        emailAddress: OWN_EMAIL,
        accessToken: "token",
        expiresAt: new Date(),
        lastSyncedDate: "2026-01-01",
      })
      .returning();

    await recordSuccessfulSync(testDb.db, account.id, "2026-02-20");

    const updated = await testDb.db.query.oauthAccount.findFirst({
      where: (a, { eq }) => eq(a.id, account.id),
    });
    expect(updated?.lastSyncedDate).toBe("2026-02-20");
  });
});
