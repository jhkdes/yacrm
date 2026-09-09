import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, event, meeting, meetingAttendee, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import { computeLastTouched, listPeopleByLastTouched } from "./last-touched";

describe("computeLastTouched", () => {
  it("returns null when there are neither events nor meetings", () => {
    expect(computeLastTouched([], [])).toBeNull();
  });

  it("returns the max occurredAt when there are only events", () => {
    const result = computeLastTouched(
      [
        { occurredAt: new Date("2026-01-01") },
        { occurredAt: new Date("2026-03-01") },
        { occurredAt: new Date("2026-02-01") },
      ],
      [],
    );
    expect(result).toEqual(new Date("2026-03-01"));
  });

  it("returns the max startTime when there are only meetings", () => {
    const result = computeLastTouched(
      [],
      [
        { startTime: new Date("2026-01-01") },
        { startTime: new Date("2026-04-01") },
      ],
    );
    expect(result).toEqual(new Date("2026-04-01"));
  });

  it("returns the max across both events and meetings, whichever is later", () => {
    const result = computeLastTouched(
      [{ occurredAt: new Date("2026-05-01") }],
      [{ startTime: new Date("2026-06-01") }],
    );
    expect(result).toEqual(new Date("2026-06-01"));
  });

  it("prefers a later event over an earlier meeting", () => {
    const result = computeLastTouched(
      [{ occurredAt: new Date("2026-06-01") }],
      [{ startTime: new Date("2026-01-01") }],
    );
    expect(result).toEqual(new Date("2026-06-01"));
  });
});

describe("listPeopleByLastTouched", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("sorts people most-recently-touched first, across events and meetings", async () => {
    const [alice] = await testDb.db.insert(person).values({ name: "Alice" }).returning();
    const [bob] = await testDb.db.insert(person).values({ name: "Bob" }).returning();
    // Carol has no history at all — inserted but never referenced again.
    await testDb.db.insert(person).values({ name: "Carol" });

    const [aliceContact] = await testDb.db
      .insert(contact)
      .values({
        personId: alice.id,
        source: "gmail",
        sourceIdentifier: "alice@example.com",
        status: "active",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: aliceContact.id,
      direction: "inbound",
      occurredAt: new Date("2026-01-01"),
      bodyText: "old message",
      sourceMessageId: "m1",
    });

    const [bobContact] = await testDb.db
      .insert(contact)
      .values({
        personId: bob.id,
        source: "gmail",
        sourceIdentifier: "bob@example.com",
        status: "active",
      })
      .returning();
    const [meetingRow] = await testDb.db
      .insert(meeting)
      .values({
        googleEventId: "evt-1",
        title: "Catch up",
        startTime: new Date("2026-06-01"),
      })
      .returning();
    await testDb.db
      .insert(meetingAttendee)
      .values({ meetingId: meetingRow.id, contactId: bobContact.id });

    const results = await listPeopleByLastTouched(testDb.db);

    expect(results.map((r) => r.name)).toEqual(["Bob", "Alice", "Carol"]);
    expect(results[0].lastTouchedAt).toEqual(new Date("2026-06-01"));
    expect(results[1].lastTouchedAt).toEqual(new Date("2026-01-01"));
    expect(results[2].lastTouchedAt).toBeNull();
  });

  it("uses the later of two events for a Person with multiple", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Dana" }).returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "dana@example.com",
        status: "active",
      })
      .returning();
    await testDb.db.insert(event).values([
      {
        contactId: c.id,
        direction: "inbound",
        occurredAt: new Date("2026-01-01"),
        bodyText: "old",
        sourceMessageId: "m1",
      },
      {
        contactId: c.id,
        direction: "outbound",
        occurredAt: new Date("2026-05-01"),
        bodyText: "recent",
        sourceMessageId: "m2",
      },
    ]);

    const results = await listPeopleByLastTouched(testDb.db);
    expect(results[0].lastTouchedAt).toEqual(new Date("2026-05-01"));
  });
});
