import { eq, max } from "drizzle-orm";

import { contact, event, meeting, meetingAttendee } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

// Pure: the most recent of any event/meeting timestamp, or null when
// there's neither — a Person with no history at all shouldn't sort as
// "just touched" (which a fallback like `new Date(0)` would risk looking
// like) or crash a naive Math.max on an empty array.
export function computeLastTouched(
  events: { occurredAt: Date }[],
  meetings: { startTime: Date }[],
): Date | null {
  const timestamps = [
    ...events.map((e) => e.occurredAt.getTime()),
    ...meetings.map((m) => m.startTime.getTime()),
  ];
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps));
}

export interface PersonWithLastTouched {
  personId: number;
  name: string;
  lastTouchedAt: Date | null;
}

// DB-only: the max Event/Meeting timestamp per Person is aggregated in SQL
// rather than loading every row into memory just to find the max — a
// Person with years of Gmail history shouldn't require pulling every
// message just to answer "when was the last time." Sorted most-recent
// first; a Person with no history at all (lastTouchedAt: null) sorts last,
// not first — there's nothing to rank them by, so they don't belong mixed
// in with real dates at either extreme.
export async function listPeopleByLastTouched(
  db: DrizzleDb,
): Promise<PersonWithLastTouched[]> {
  const [lastEventByPerson, lastMeetingByPerson, people] = await Promise.all([
    db
      .select({ personId: contact.personId, lastEventAt: max(event.occurredAt) })
      .from(event)
      .innerJoin(contact, eq(event.contactId, contact.id))
      .groupBy(contact.personId),
    db
      .select({ personId: contact.personId, lastMeetingAt: max(meeting.startTime) })
      .from(meetingAttendee)
      .innerJoin(contact, eq(meetingAttendee.contactId, contact.id))
      .innerJoin(meeting, eq(meetingAttendee.meetingId, meeting.id))
      .groupBy(contact.personId),
    db.query.person.findMany({ columns: { id: true, name: true } }),
  ]);

  const eventMap = new Map(lastEventByPerson.map((r) => [r.personId, r.lastEventAt]));
  const meetingMap = new Map(
    lastMeetingByPerson.map((r) => [r.personId, r.lastMeetingAt]),
  );

  const results = people.map((p) => {
    const lastEventAt = eventMap.get(p.id);
    const lastMeetingAt = meetingMap.get(p.id);
    return {
      personId: p.id,
      name: p.name,
      lastTouchedAt: computeLastTouched(
        lastEventAt ? [{ occurredAt: lastEventAt }] : [],
        lastMeetingAt ? [{ startTime: lastMeetingAt }] : [],
      ),
    };
  });

  return results.sort((a, b) => {
    if (a.lastTouchedAt === null && b.lastTouchedAt === null) return 0;
    if (a.lastTouchedAt === null) return 1;
    if (b.lastTouchedAt === null) return -1;
    return b.lastTouchedAt.getTime() - a.lastTouchedAt.getTime();
  });
}
