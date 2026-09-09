import { calendar_v3, google } from "googleapis";
import { eq } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { meeting, meetingAttendee } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { findContactByEmail, findOrCreateContact } from "@/lib/contact-resolution";
import { createGoogleAuthClient } from "@/lib/gmail-import";

export interface ParsedMeetingAttendee {
  email: string;
  name: string | null;
}

export interface ParsedMeeting {
  googleEventId: string;
  title: string | null;
  startTime: Date;
  endTime: Date | null;
  attendees: ParsedMeetingAttendee[];
}

function parseEventDateTime(
  dt: calendar_v3.Schema$EventDateTime | undefined,
): Date | null {
  if (!dt) return null;
  // A timed event has dateTime (RFC3339); an all-day event has only date
  // ("yyyy-mm-dd"), treated as midnight UTC that day since there's no
  // specific time to anchor it to.
  const raw = dt.dateTime ?? (dt.date ? `${dt.date}T00:00:00.000Z` : null);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Pure — parses one Calendar API Event into a ParsedMeeting, or null when
// there's nothing here worth tracking as a "meeting": no id, cancelled, no
// resolvable start time, or no attendees besides the calendar owner
// (self) or a room/resource — declining to treat solo blocked-time (or an
// event with only a conference room "attending") as a meeting.
export function parseCalendarEvent(
  raw: calendar_v3.Schema$Event,
): ParsedMeeting | null {
  if (!raw.id) return null;
  if (raw.status === "cancelled") return null;

  const startTime = parseEventDateTime(raw.start);
  if (!startTime) return null;

  const attendees: ParsedMeetingAttendee[] = (raw.attendees ?? [])
    .filter((a) => !a.self && !a.resource && a.email)
    .map((a) => ({
      email: a.email!.trim().toLowerCase(),
      name: a.displayName?.trim() || null,
    }));
  if (attendees.length === 0) return null;

  return {
    googleEventId: raw.id,
    title: raw.summary?.trim() || null,
    startTime,
    endTime: parseEventDateTime(raw.end),
    attendees,
  };
}

export interface CalendarImportSummary {
  eventsProcessed: number;
  meetingsCreated: number;
  meetingsUpdated: number;
  // Matched an existing Contact (any prior source) by email.
  attendeesLinked: number;
  // No existing Contact matched by email, so a new one was created —
  // source "google_calendar" (M25). The existing name-similarity
  // merge-suggestion engine (generateMergeSuggestions, already
  // source-agnostic) is what reconciles this with, say, a Gmail contact
  // for the same person under a different address.
  attendeesCreated: number;
}

// DB-only — upserts a `meeting` row per event (keyed on googleEventId, so
// re-importing the same event updates it rather than duplicating it) and
// resolves each attendee to a Contact: an existing one by email if there
// is one, otherwise a new one (M25) — every attendee ends up linked, none
// are ever silently dropped.
export async function importCalendarEvents(
  db: DrizzleDb,
  events: ParsedMeeting[],
): Promise<CalendarImportSummary> {
  const summary: CalendarImportSummary = {
    eventsProcessed: events.length,
    meetingsCreated: 0,
    meetingsUpdated: 0,
    attendeesLinked: 0,
    attendeesCreated: 0,
  };

  for (const ev of events) {
    const existing = await db.query.meeting.findFirst({
      where: eq(meeting.googleEventId, ev.googleEventId),
    });

    const [meetingRow] = await db
      .insert(meeting)
      .values({
        googleEventId: ev.googleEventId,
        title: ev.title,
        startTime: ev.startTime,
        endTime: ev.endTime,
      })
      .onConflictDoUpdate({
        target: meeting.googleEventId,
        set: { title: ev.title, startTime: ev.startTime, endTime: ev.endTime },
      })
      .returning();

    if (existing) summary.meetingsUpdated += 1;
    else summary.meetingsCreated += 1;

    for (const attendee of ev.attendees) {
      const matched = await findContactByEmail(db, attendee.email);
      let contactId: number;
      if (matched) {
        contactId = matched.contactId;
        summary.attendeesLinked += 1;
      } else {
        const created = await findOrCreateContact(
          db,
          "google_calendar",
          { identifier: attendee.email, name: attendee.name },
          // A meeting attendee is, like a LinkedIn connection, a mutual
          // relationship by definition — you were both actually there —
          // not a one-way message that needs a reply to confirm it.
          "active",
        );
        contactId = created.contactId;
        summary.attendeesCreated += 1;
      }

      await db
        .insert(meetingAttendee)
        .values({ meetingId: meetingRow.id, contactId })
        .onConflictDoNothing();
    }
  }

  return summary;
}

// Full pipeline: fetches every event between startDate and now (inclusive)
// from the account's primary calendar and imports it — mirrors Gmail
// import's "messages after this date" framing (a bounded look backward
// from today), not an open-ended window. Without an upper bound, a
// recurring meeting (weekly standup, 1:1, etc.) would contribute every
// future instance of itself indefinitely, since singleEvents expands a
// recurring series into individual instances — a real bug caught by a
// startDate of "2026-08-01" unexpectedly returning 742 events. Not unit
// tested (real network call) — see parseCalendarEvent and
// importCalendarEvents for the tested pieces, and scripts/list-meetings.ts
// for real-data verification.
export async function importCalendarHistory(
  accountId: number,
  startDate: string,
): Promise<CalendarImportSummary> {
  const { oauthClient } = await createGoogleAuthClient(defaultDb, accountId);
  const calendar = google.calendar({ version: "v3", auth: oauthClient });

  const now = new Date();
  const rawEvents: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date(`${startDate}T00:00:00.000Z`).toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      pageToken,
      maxResults: 250,
    });
    rawEvents.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const parsed = rawEvents
    .map(parseCalendarEvent)
    .filter((e): e is ParsedMeeting => e !== null);

  return importCalendarEvents(defaultDb, parsed);
}
