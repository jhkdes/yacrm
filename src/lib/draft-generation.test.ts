import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  buildDraftPrompt,
  loadPersonDraftContext,
  parseDraftResponse,
  PersonNotFoundError,
  type PersonDraftContext,
} from "./draft-generation";

describe("loadPersonDraftContext", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("throws PersonNotFoundError for a missing person", async () => {
    await expect(loadPersonDraftContext(testDb.db, 999)).rejects.toThrow(
      PersonNotFoundError,
    );
  });

  it("loads contacts and events in chronological order across merged contacts", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Elaine Cumming" })
      .returning();

    const [workContact] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "elaine@work.com",
        displayName: "Elaine Cumming",
        status: "active",
      })
      .returning();
    const [personalContact] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "elaine.c@gmail.com",
        displayName: "Elaine",
        status: "active",
      })
      .returning();

    await testDb.db.insert(event).values([
      {
        contactId: workContact.id,
        direction: "inbound",
        occurredAt: new Date("2026-03-01"),
        subject: "Re: catching up",
        bodyText: "Later message from the work address",
        sourceMessageId: "m2",
      },
      {
        contactId: personalContact.id,
        direction: "outbound",
        occurredAt: new Date("2026-01-01"),
        subject: "catching up",
        bodyText: "Earlier message to the personal address",
        sourceMessageId: "m1",
      },
    ]);

    const context = await loadPersonDraftContext(testDb.db, p.id);

    expect(context.personName).toBe("Elaine Cumming");
    expect(context.contacts).toHaveLength(2);
    expect(context.contacts.map((c) => c.sourceIdentifier).sort()).toEqual([
      "elaine.c@gmail.com",
      "elaine@work.com",
    ]);

    // Events must interleave across contacts in chronological order, not
    // grouped per-contact.
    expect(context.events.map((e) => e.bodyText)).toEqual([
      "Earlier message to the personal address",
      "Later message from the work address",
    ]);
  });

  it("returns an empty events array for a person with no message history", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "No History" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "nohistory@example.com",
      status: "pending",
    });

    const context = await loadPersonDraftContext(testDb.db, p.id);
    expect(context.events).toEqual([]);
  });
});

describe("buildDraftPrompt", () => {
  function contextFor(overrides: Partial<PersonDraftContext>): PersonDraftContext {
    return {
      personId: 1,
      personName: "Jordan Lee",
      contacts: [
        {
          source: "gmail",
          sourceIdentifier: "jordan@acmecorp.com",
          displayName: "Jordan Lee",
          status: "active",
        },
      ],
      events: [],
      ...overrides,
    };
  }

  it("includes facts unique to this person's actual history", () => {
    const context = contextFor({
      events: [
        {
          direction: "inbound",
          occurredAt: new Date("2026-02-14"),
          subject: "Django migration headaches",
          bodyText: "We're mid-way through migrating our Django monolith to microservices.",
        },
      ],
    });

    const { system, user } = buildDraftPrompt(context, "hiring a senior backend engineer");

    expect(user).toContain("Jordan Lee");
    expect(user).toContain("jordan@acmecorp.com");
    expect(user).toContain("Django migration headaches");
    expect(user).toContain("migrating our Django monolith to microservices");
    expect(user).toContain("hiring a senior backend engineer");

    // Instructs the model not to fabricate facts absent from the given data.
    expect(system).toMatch(/never invent/i);
  });

  it("does not leak another person's facts — different contexts produce disjoint prompts", () => {
    const contextA = contextFor({
      personName: "Person A",
      events: [
        {
          direction: "inbound",
          occurredAt: new Date("2026-01-01"),
          subject: "Rust rewrite",
          bodyText: "Our team just finished rewriting the core in Rust.",
        },
      ],
    });
    const contextB = contextFor({
      personName: "Person B",
      events: [
        {
          direction: "inbound",
          occurredAt: new Date("2026-01-01"),
          subject: "Marketing campaign",
          bodyText: "We're launching a new marketing campaign next quarter.",
        },
      ],
    });

    const promptA = buildDraftPrompt(contextA, "goal");
    const promptB = buildDraftPrompt(contextB, "goal");

    expect(promptA.user).toContain("Rust rewrite");
    expect(promptA.user).not.toContain("Marketing campaign");
    expect(promptB.user).toContain("Marketing campaign");
    expect(promptB.user).not.toContain("Rust rewrite");
  });

  it("tells the model not to fabricate a relationship when there is no history", () => {
    const context = contextFor({ events: [] });
    const { system, user } = buildDraftPrompt(context, "reconnecting");

    expect(user).toContain("no message history on file");
    expect(system).toMatch(/do not fabricate a\s*\n?\s*prior relationship/i);
  });
});

describe("parseDraftResponse", () => {
  it("splits a well-formed Subject/body response", () => {
    const result = parseDraftResponse(
      "Subject: Following up on our chat\n\nHi Jordan,\n\nGreat catching up.",
    );
    expect(result.subject).toBe("Following up on our chat");
    expect(result.body).toBe("Hi Jordan,\n\nGreat catching up.");
  });

  it("falls back to treating the whole response as the body when unformatted", () => {
    const result = parseDraftResponse("Just a plain email with no subject line.");
    expect(result.subject).toBe("");
    expect(result.body).toBe("Just a plain email with no subject line.");
  });
});
