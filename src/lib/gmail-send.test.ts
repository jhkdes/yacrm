import { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contact, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  buildRawEmail,
  listActiveGmailContacts,
  recordSentEvent,
  sendGmailMessage,
} from "./gmail-send";

describe("buildRawEmail", () => {
  function decode(raw: string): { headers: Record<string, string>; body: string } {
    const text = Buffer.from(raw, "base64url").toString("utf-8");
    const [headerBlock, ...bodyParts] = text.split("\r\n\r\n");
    const body = bodyParts.join("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split("\r\n")) {
      const idx = line.indexOf(": ");
      headers[line.slice(0, idx)] = line.slice(idx + 2);
    }
    return { headers, body };
  }

  it("round-trips a plain-ASCII message", () => {
    const raw = buildRawEmail({
      from: "me@example.com",
      to: "ada@example.com",
      subject: "Following up",
      body: "Hi Ada,\n\nGreat catching up.",
    });

    const { headers, body } = decode(raw);
    expect(headers["From"]).toBe("me@example.com");
    expect(headers["To"]).toBe("ada@example.com");
    expect(headers["Subject"]).toBe("Following up");
    expect(headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(body).toBe("Hi Ada,\n\nGreat catching up.");
  });

  it("MIME-encodes a non-ASCII subject rather than corrupting it", () => {
    const raw = buildRawEmail({
      from: "me@example.com",
      to: "someone@example.com",
      subject: "Café follow-up",
      body: "body",
    });

    const { headers } = decode(raw);
    expect(headers["Subject"]).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    const encoded = headers["Subject"].match(/^=\?UTF-8\?B\?(.+)\?=$/)![1];
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toBe(
      "Café follow-up",
    );
  });
});

describe("sendGmailMessage", () => {
  it("sends the built raw message and returns the resulting id/threadId", async () => {
    let capturedRaw: string | undefined;
    const fakeGmail = {
      users: {
        messages: {
          send: async ({ requestBody }: { requestBody: { raw: string } }) => {
            capturedRaw = requestBody.raw;
            return { data: { id: "sent-1", threadId: "thread-1" } };
          },
        },
      },
    } as unknown as gmail_v1.Gmail;

    const result = await sendGmailMessage(fakeGmail, {
      from: "me@example.com",
      to: "ada@example.com",
      subject: "Hi",
      body: "Hello",
    });

    expect(result).toEqual({ messageId: "sent-1", threadId: "thread-1" });
    expect(capturedRaw).toBeDefined();
    expect(Buffer.from(capturedRaw!, "base64url").toString("utf-8")).toContain(
      "Hello",
    );
  });

  it("throws if the Gmail API response is missing an id or threadId", async () => {
    const fakeGmail = {
      users: { messages: { send: async () => ({ data: {} }) } },
    } as unknown as gmail_v1.Gmail;

    await expect(
      sendGmailMessage(fakeGmail, {
        from: "me@example.com",
        to: "ada@example.com",
        subject: "Hi",
        body: "Hello",
      }),
    ).rejects.toThrow();
  });
});

describe("listActiveGmailContacts", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("returns only active gmail contacts, excluding pending and other sources", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Ada" })
      .returning();

    await testDb.db.insert(contact).values([
      {
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "ada@example.com",
        displayName: "Ada",
        status: "active",
      },
      {
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "ada-pending@example.com",
        displayName: "Ada (pending)",
        status: "pending",
      },
      {
        personId: p.id,
        source: "linkedin",
        sourceIdentifier: "ada-linkedin",
        displayName: "Ada LI",
        status: "active",
      },
    ]);

    const contacts = await listActiveGmailContacts(testDb.db, p.id);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBe("ada@example.com");
  });
});

describe("recordSentEvent", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url, options) => {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            data: body.input.map((_t: string, index: number) => ({
              embedding: Array(512).fill(0),
              index,
            })),
          }),
        };
      }),
    );
  });

  afterEach(async () => {
    await testDb.client.close();
    vi.unstubAllGlobals();
  });

  it("inserts a new outbound Event carrying the Gmail message id", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Ada" })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "ada@example.com",
        status: "active",
      })
      .returning();

    await recordSentEvent(
      testDb.db,
      c.id,
      p.id,
      { messageId: "sent-msg-1", threadId: "thread-1" },
      "Following up",
      "Great catching up!",
    );

    const events = await testDb.db.select().from(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      contactId: c.id,
      direction: "outbound",
      subject: "Following up",
      bodyText: "Great catching up!",
      sourceMessageId: "sent-msg-1",
    });
  });
});
