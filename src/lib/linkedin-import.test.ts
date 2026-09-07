import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contact, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  importLinkedInConnections,
  parseConnectionsCsv,
} from "@/lib/linkedin-import";
import { generateMergeSuggestions } from "@/lib/merge-suggestions";

const SAMPLE_EXPORT = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,,Qlik,"Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy",04 Sep 2026
Charu,Agrawal,https://www.linkedin.com/in/charu-technologyleader,,Enertia Software,Product Team Lead,02 Sep 2026
Rohit,Arora,https://www.linkedin.com/in/rohitar,,Egnyte,"Senior Product Manager, AEC",01 Sep 2026
`;

describe("parseConnectionsCsv", () => {
  it("skips the Notes: preamble and parses each connection row", () => {
    const { rows, rowsSkippedNoUrl } = parseConnectionsCsv(SAMPLE_EXPORT);

    expect(rowsSkippedNoUrl).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      firstName: "Jeffrey",
      lastName: "Goldberg",
      profileUrl: "https://www.linkedin.com/in/goldbergjeffrey",
      email: null,
      company: "Qlik",
      position:
        "Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy",
      connectedOn: new Date("04 Sep 2026"),
    });
  });

  it("preserves a comma embedded in a quoted Position field", () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    const rohit = rows.find((r) => r.firstName === "Rohit");
    expect(rohit?.position).toBe("Senior Product Manager, AEC");
  });

  it("keeps a present email address when the export includes one", () => {
    const csv = SAMPLE_EXPORT.replace(
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,,Qlik",
      "Jeffrey,Goldberg,https://www.linkedin.com/in/goldbergjeffrey,jeffrey@example.com,Qlik",
    );
    const { rows } = parseConnectionsCsv(csv);
    expect(rows[0].email).toBe("jeffrey@example.com");
  });

  it("skips a row with no profile URL rather than throwing", () => {
    const csv = SAMPLE_EXPORT + "Anon,Person,,,,,\n";
    const { rows, rowsSkippedNoUrl } = parseConnectionsCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rowsSkippedNoUrl).toBe(1);
  });

  it("normalizes a trailing slash on the profile URL", () => {
    const csv = SAMPLE_EXPORT.replace(
      "https://www.linkedin.com/in/goldbergjeffrey,",
      "https://www.linkedin.com/in/goldbergjeffrey/,",
    );
    const { rows } = parseConnectionsCsv(csv);
    expect(rows[0].profileUrl).toBe(
      "https://www.linkedin.com/in/goldbergjeffrey",
    );
  });

  it("throws on a file with no recognizable header row", () => {
    expect(() => parseConnectionsCsv("not,a,linkedin,export\n1,2,3,4")).toThrow();
  });
});

describe("importLinkedInConnections", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    // Stub the Voyage embeddings call the same way gmail-import's tests do —
    // real network calls have no place in a unit/integration test.
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

  it("creates one active Contact per connection, with a profile Event", async () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    const summary = await importLinkedInConnections(testDb.db, rows);

    expect(summary.contactsCreated).toBe(3);
    expect(summary.profileEventsWritten).toBe(3);

    const contacts = await testDb.db.query.contact.findMany({
      where: (c, { eq }) => eq(c.source, "linkedin"),
    });
    expect(contacts).toHaveLength(3);
    expect(contacts.every((c) => c.status === "active")).toBe(true);

    const jeffrey = contacts.find(
      (c) => c.sourceIdentifier === "https://www.linkedin.com/in/goldbergjeffrey",
    );
    const jeffreyEvent = await testDb.db.query.event.findFirst({
      where: (e, { eq }) => eq(e.contactId, jeffrey!.id),
    });
    expect(jeffreyEvent?.bodyText).toBe(
      "Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy at Qlik",
    );
  });

  it("is idempotent: re-importing the same rows doesn't duplicate Contacts or Events", async () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);
    const second = await importLinkedInConnections(testDb.db, rows);

    expect(second.contactsCreated).toBe(0);

    const contacts = await testDb.db.select().from(contact);
    const events = await testDb.db.select().from(event);
    expect(contacts).toHaveLength(3);
    expect(events).toHaveLength(3);
  });

  it("updates the profile Event body when a re-import shows a new position", async () => {
    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);

    const updatedRows = rows.map((r) =>
      r.firstName === "Charu" ? { ...r, position: "VP of Product" } : r,
    );
    await importLinkedInConnections(testDb.db, updatedRows);

    const charu = await testDb.db.query.contact.findFirst({
      where: (c, { eq }) =>
        eq(c.sourceIdentifier, "https://www.linkedin.com/in/charu-technologyleader"),
    });
    const charuEvent = await testDb.db.query.event.findFirst({
      where: (e, { eq }) => eq(e.contactId, charu!.id),
    });
    expect(charuEvent?.bodyText).toBe("VP of Product at Enertia Software");
  });

  it("flows into the source-agnostic merge-suggestion engine like any other Contact", async () => {
    // Simulate an existing Gmail contact who is also a LinkedIn connection
    // under the same name but a different identifier.
    const gmailPerson = await testDb.db
      .insert(person)
      .values({ name: "Jeffrey Goldberg" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: gmailPerson[0].id,
      source: "gmail",
      sourceIdentifier: "jgoldberg@example.com",
      displayName: "Jeffrey Goldberg",
      status: "active",
    });

    const { rows } = parseConnectionsCsv(SAMPLE_EXPORT);
    await importLinkedInConnections(testDb.db, rows);

    const allContacts = await testDb.db.query.contact.findMany();
    const forMatching = allContacts.map((c) => ({
      contactId: c.id,
      personId: c.personId,
      source: c.source,
      sourceIdentifier: c.sourceIdentifier,
      displayName: c.displayName,
    }));

    const suggestions = generateMergeSuggestions(forMatching);
    expect(
      suggestions.some(
        (s) =>
          [s.personAId, s.personBId].includes(gmailPerson[0].id) &&
          [s.personAId, s.personBId].includes(
            allContacts.find(
              (c) =>
                c.sourceIdentifier ===
                "https://www.linkedin.com/in/goldbergjeffrey",
            )!.personId,
          ),
      ),
    ).toBe(true);
  });
});
