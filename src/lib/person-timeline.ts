export interface TimelineSourceEvent {
  id: number;
  direction: "inbound" | "outbound";
  occurredAt: Date;
  subject: string | null;
  bodyText: string;
}

export interface TimelineSourceContact<TEvent extends TimelineSourceEvent> {
  sourceIdentifier: string;
  source: string;
  events: TEvent[];
}

export interface TimelineEntry<TEvent extends TimelineSourceEvent> {
  event: TEvent;
  contactEmail: string;
  contactSource: string;
}

// Flattens every Contact's Events into one feed, newest first — the whole
// point of a merged Person profile: a real back-and-forth interleaves
// Events from both sources by actual time, not grouped by which Contact
// they came from.
export function buildPersonTimeline<TEvent extends TimelineSourceEvent>(
  contacts: TimelineSourceContact<TEvent>[],
): TimelineEntry<TEvent>[] {
  return contacts
    .flatMap((contact) =>
      contact.events.map((event) => ({
        event,
        contactEmail: contact.sourceIdentifier,
        contactSource: contact.source,
      })),
    )
    .sort((a, b) => b.event.occurredAt.getTime() - a.event.occurredAt.getTime());
}
