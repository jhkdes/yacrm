import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contact, event } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  importLinkedInMessages,
  parseMessagesCsv,
  resolveMessageDirection,
} from "@/lib/linkedin-messages-import";

const OWN_PROFILE_URL = "https://www.linkedin.com/in/jaehkim";

// The exact export shape LinkedIn produces, including a genuinely
// multi-line quoted CONTENT field — this is the case a naive line-split
// parser (rather than a real CSV parser) would corrupt.
const SAMPLE_EXPORT = `"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS"
"convo-1","","Jae Kim","https://www.linkedin.com/in/jaehkim","Jorge Alcantara","https://www.linkedin.com/in/jorgeakairos","2026-09-04 18:12:23 UTC","","Just tried the link. It was easy to follow.","INBOX",""
"convo-1","","Jorge Alcantara","https://www.linkedin.com/in/jorgeakairos","Jae Kim","https://www.linkedin.com/in/jaehkim","2026-09-04 14:09:28 UTC","","Hey Jae, let's change to this thread

Here's a link to try out that interview as well

Talk soon!","INBOX",""
"convo-1","","Jorge Alcantara","https://www.linkedin.com/in/jorgeakairos","Jae Kim","https://www.linkedin.com/in/jaehkim","2025-10-21 15:32:55 UTC","","Great, sent. See you in a few days!","INBOX",""
`;

describe("parseMessagesCsv", () => {
  it("parses each row, preserving embedded newlines in a quoted CONTENT field", () => {
    const { rows, rowsSkippedEmptyContent, rowsSkippedBadDate } =
      parseMessagesCsv(SAMPLE_EXPORT);

    expect(rowsSkippedEmptyContent).toBe(0);
    expect(rowsSkippedBadDate).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows[1].content).toBe(
      "Hey Jae, let's change to this thread\n\nHere's a link to try out that interview as well\n\nTalk soon!",
    );
  });

  it("parses the DATE column into a UTC Date", () => {
    const { rows } = parseMessagesCsv(SAMPLE_EXPORT);
    expect(rows[0].occurredAt.toISOString()).toBe("2026-09-04T18:12:23.000Z");
  });

  it("skips a row with empty content", () => {
    const csv =
      SAMPLE_EXPORT +
      '"convo-1","","Jorge Alcantara","https://www.linkedin.com/in/jorgeakairos","Jae Kim","https://www.linkedin.com/in/jaehkim","2025-10-01 00:00:00 UTC","","","INBOX",""\n';
    const { rows, rowsSkippedEmptyContent } = parseMessagesCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rowsSkippedEmptyContent).toBe(1);
  });

  it("throws on a file with no recognizable header row", () => {
    expect(() => parseMessagesCsv("not,a,linkedin,export\n1,2,3,4")).toThrow();
  });
});

describe("resolveMessageDirection", () => {
  it("resolves an outbound message when the sender is the account owner", () => {
    const { rows } = parseMessagesCsv(SAMPLE_EXPORT);
    const result = resolveMessageDirection(rows[0], OWN_PROFILE_URL);

    expect(result).toMatchObject({
      direction: "outbound",
      otherPartyProfileUrl: "https://www.linkedin.com/in/jorgeakairos",
    });
  });

  it("resolves an inbound message when the recipient is the account owner", () => {
    const { rows } = parseMessagesCsv(SAMPLE_EXPORT);
    const result = resolveMessageDirection(rows[1], OWN_PROFILE_URL);

    expect(result).toMatchObject({
      direction: "inbound",
      otherPartyProfileUrl: "https://www.linkedin.com/in/jorgeakairos",
      otherPartyName: "Jorge Alcantara",
    });
  });

  it("skips a group conversation (more than one recipient)", () => {
    const { rows } = parseMessagesCsv(SAMPLE_EXPORT);
    const groupRow = {
      ...rows[0],
      recipientProfileUrls:
        "https://www.linkedin.com/in/jorgeakairos,https://www.linkedin.com/in/someoneelse",
    };
    expect(resolveMessageDirection(groupRow, OWN_PROFILE_URL)).toEqual({
      skippedReason: "group",
    });
  });

  it("skips a row where neither side is the account owner", () => {
    const { rows } = parseMessagesCsv(SAMPLE_EXPORT);
    const strangeRow = { ...rows[0], senderProfileUrl: "https://www.linkedin.com/in/someone-else" };
    expect(
      resolveMessageDirection(strangeRow, OWN_PROFILE_URL),
    ).toEqual({ skippedReason: "unresolvable" });
  });
});

describe("importLinkedInMessages", () => {
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
            data: body.input.map((_text: string, index: number) => ({
              embedding: Array(512).fill(0),
              index,
            })),
          }),
        };
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await testDb.client.close();
  });

  it("creates one Contact for the other party and one Event per message", async () => {
    const { rows } = parseMessagesCsv(SAMPLE_EXPORT);
    const summary = await importLinkedInMessages(testDb.db, rows, OWN_PROFILE_URL);

    expect(summary.contactsCreated).toBe(1);
    expect(summary.eventsCreated).toBe(3);

    const jorge = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) =>
        eq(c.sourceIdentifier, "https://www.linkedin.com/in/jorgeakairos"),
    });
    expect(jorge?.status).toBe("active");

    const events = await testDb.db.query.event.findMany({
      where: (e, { eq }) => eq(e.contactId, jorge!.id),
    });
    expect(events).toHaveLength(3);
    expect(events.filter((e) => e.direction === "outbound")).toHaveLength(1);
    expect(events.filter((e) => e.direction === "inbound")).toHaveLength(2);
  });

  it("marks a contact pending when this batch only sees one direction and no prior history exists", async () => {
    const oneWayOnly = `"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS"
"convo-2","","Someone New","https://www.linkedin.com/in/someone-new","Jae Kim","https://www.linkedin.com/in/jaehkim","2026-09-01 00:00:00 UTC","","Hi, would love to connect!","INBOX",""
`;
    const { rows } = parseMessagesCsv(oneWayOnly);
    await importLinkedInMessages(testDb.db, rows, OWN_PROFILE_URL);

    const someoneNew = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) =>
        eq(c.sourceIdentifier, "https://www.linkedin.com/in/someone-new"),
    });
    expect(someoneNew?.status).toBe("pending");
  });

  it("is idempotent: re-importing the same rows doesn't duplicate Events", async () => {
    const { rows } = parseMessagesCsv(SAMPLE_EXPORT);
    await importLinkedInMessages(testDb.db, rows, OWN_PROFILE_URL);
    const second = await importLinkedInMessages(testDb.db, rows, OWN_PROFILE_URL);

    expect(second.eventsCreated).toBe(0);
    expect(second.eventsSkippedDuplicate).toBe(3);

    const allEvents = await testDb.db.select().from(event);
    const allContacts = await testDb.db.select().from(contact);
    expect(allEvents).toHaveLength(3);
    expect(allContacts).toHaveLength(1);
  });
});
