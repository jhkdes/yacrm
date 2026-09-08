import type { calendar_v3 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, meeting, meetingAttendee, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  importCalendarEvents,
  parseCalendarEvent,
  type ParsedMeeting,
} from "./calendar-import";

function fixtureEvent(
  overrides: Partial<calendar_v3.Schema$Event>,
): calendar_v3.Schema$Event {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Coffee chat",
    start: { dateTime: "2026-03-10T15:00:00-08:00" },
    end: { dateTime: "2026-03-10T15:30:00-08:00" },
    attendees: [
      { email: "me@example.com", self: true },
      { email: "ada@example.com", displayName: "Ada Lovelace" },
    ],
    ...overrides,
  };
}

describe("parseCalendarEvent", () => {
  it("extracts title/start/end/attendees, excluding the calendar owner (self)", () => {
    const result = parseCalendarEvent(fixtureEvent({}));

    expect(result).toEqual({
      googleEventId: "evt-1",
      title: "Coffee chat",
      startTime: new Date("2026-03-10T15:00:00-08:00"),
      endTime: new Date("2026-03-10T15:30:00-08:00"),
      attendees: [{ email: "ada@example.com", name: "Ada Lovelace" }],
    });
  });

  it("returns null for an event with no attendees besides the owner", () => {
    const result = parseCalendarEvent(
      fixtureEvent({ attendees: [{ email: "me@example.com", self: true }] }),
    );
    expect(result).toBeNull();
  });

  it("returns null for an event with no attendees field at all", () => {
    const result = parseCalendarEvent(fixtureEvent({ attendees: undefined }));
    expect(result).toBeNull();
  });

  it("returns null for a cancelled event", () => {
    const result = parseCalendarEvent(fixtureEvent({ status: "cancelled" }));
    expect(result).toBeNull();
  });

  it("returns null for an event with no id", () => {
    const result = parseCalendarEvent(fixtureEvent({ id: undefined }));
    expect(result).toBeNull();
  });

  it("excludes a room/resource attendee", () => {
    const result = parseCalendarEvent(
      fixtureEvent({
        attendees: [
          { email: "me@example.com", self: true },
          { email: "ada@example.com", displayName: "Ada Lovelace" },
          { email: "room-12b@resource.calendar.google.com", resource: true },
        ],
      }),
    );
    expect(result?.attendees).toEqual([
      { email: "ada@example.com", name: "Ada Lovelace" },
    ]);
  });

  it("handles an attendee with no displayName", () => {
    const result = parseCalendarEvent(
      fixtureEvent({
        attendees: [
          { email: "me@example.com", self: true },
          { email: "noname@example.com" },
        ],
      }),
    );
    expect(result?.attendees).toEqual([{ email: "noname@example.com", name: null }]);
  });

  it("treats an all-day event's date field as midnight UTC", () => {
    const result = parseCalendarEvent(
      fixtureEvent({
        start: { date: "2026-03-10" },
        end: { date: "2026-03-11" },
      }),
    );
    expect(result?.startTime).toEqual(new Date("2026-03-10T00:00:00.000Z"));
    expect(result?.endTime).toEqual(new Date("2026-03-11T00:00:00.000Z"));
  });

  it("returns null when neither dateTime nor date is present on start", () => {
    const result = parseCalendarEvent(fixtureEvent({ start: {} }));
    expect(result).toBeNull();
  });

  it("lowercases attendee emails", () => {
    const result = parseCalendarEvent(
      fixtureEvent({
        attendees: [{ email: "Ada@Example.COM", displayName: "Ada" }],
      }),
    );
    expect(result?.attendees[0].email).toBe("ada@example.com");
  });
});

describe("importCalendarEvents", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  function parsedMeeting(overrides: Partial<ParsedMeeting>): ParsedMeeting {
    return {
      googleEventId: "evt-1",
      title: "Coffee chat",
      startTime: new Date("2026-03-10T15:00:00.000Z"),
      endTime: new Date("2026-03-10T15:30:00.000Z"),
      attendees: [{ email: "ada@example.com", name: "Ada Lovelace" }],
      ...overrides,
    };
  }

  it("creates a meeting and links an attendee whose email matches an existing Contact", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada Lovelace" }).returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "ada@example.com",
        status: "active",
      })
      .returning();

    const summary = await importCalendarEvents(testDb.db, [parsedMeeting({})]);

    expect(summary).toMatchObject({
      eventsProcessed: 1,
      meetingsCreated: 1,
      meetingsUpdated: 0,
      attendeesLinked: 1,
      attendeesSkippedNoContact: 0,
    });

    const meetingRows = await testDb.db.select().from(meeting);
    expect(meetingRows).toHaveLength(1);
    expect(meetingRows[0]).toMatchObject({
      googleEventId: "evt-1",
      title: "Coffee chat",
    });

    const attendeeRows = await testDb.db.select().from(meetingAttendee);
    expect(attendeeRows).toHaveLength(1);
    expect(attendeeRows[0]).toMatchObject({
      meetingId: meetingRows[0].id,
      contactId: c.id,
    });
  });

  it("skips an attendee with no matching Contact, without failing the whole import", async () => {
    const summary = await importCalendarEvents(testDb.db, [parsedMeeting({})]);

    expect(summary).toMatchObject({ attendeesLinked: 0, attendeesSkippedNoContact: 1 });
    expect(await testDb.db.select().from(meeting)).toHaveLength(1);
    expect(await testDb.db.select().from(meetingAttendee)).toHaveLength(0);
  });

  it("updates an existing meeting on re-import instead of duplicating it", async () => {
    await importCalendarEvents(testDb.db, [parsedMeeting({ title: "Coffee chat" })]);
    const summary = await importCalendarEvents(
      testDb.db,
      [parsedMeeting({ title: "Coffee chat (rescheduled)" })],
    );

    expect(summary).toMatchObject({ meetingsCreated: 0, meetingsUpdated: 1 });
    const meetingRows = await testDb.db.select().from(meeting);
    expect(meetingRows).toHaveLength(1);
    expect(meetingRows[0].title).toBe("Coffee chat (rescheduled)");
  });

  it("doesn't duplicate the attendee link on re-import", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "ada@example.com",
      status: "active",
    });

    await importCalendarEvents(testDb.db, [parsedMeeting({})]);
    await importCalendarEvents(testDb.db, [parsedMeeting({})]);

    expect(await testDb.db.select().from(meetingAttendee)).toHaveLength(1);
  });

  it("only matches gmail/hotmail-sourced contacts, not a linkedin profile URL that happens to be stored", async () => {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "linkedin",
      sourceIdentifier: "ada@example.com",
      status: "active",
    });

    const summary = await importCalendarEvents(testDb.db, [parsedMeeting({})]);
    expect(summary.attendeesSkippedNoContact).toBe(1);
  });
});
