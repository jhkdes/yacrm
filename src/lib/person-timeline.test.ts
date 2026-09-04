import { describe, expect, it } from "vitest";

import { buildPersonTimeline, TimelineSourceEvent } from "./person-timeline";

function event(overrides: Partial<TimelineSourceEvent> & { id: number }): TimelineSourceEvent {
  return {
    direction: "inbound",
    occurredAt: new Date(),
    subject: null,
    bodyText: "body",
    ...overrides,
  };
}

describe("buildPersonTimeline", () => {
  it("interleaves Events from two different Contacts by actual time, not grouped by source", () => {
    const contacts = [
      {
        sourceIdentifier: "nadia@gmail.com",
        source: "gmail",
        events: [
          event({ id: 1, occurredAt: new Date("2026-01-01T00:00:00Z") }),
          event({ id: 3, occurredAt: new Date("2026-01-03T00:00:00Z") }),
        ],
      },
      {
        sourceIdentifier: "nadia@work.com",
        source: "gmail",
        events: [
          event({ id: 2, occurredAt: new Date("2026-01-02T00:00:00Z") }),
          event({ id: 4, occurredAt: new Date("2026-01-04T00:00:00Z") }),
        ],
      },
    ];

    const timeline = buildPersonTimeline(contacts);

    // Newest first, correctly interleaved across both Contacts: 4,3,2,1 —
    // not grouped as [3,1] then [4,2] or [4,2] then [3,1].
    expect(timeline.map((t) => t.event.id)).toEqual([4, 3, 2, 1]);
  });

  it("tags each timeline entry with the Contact it came from", () => {
    const contacts = [
      {
        sourceIdentifier: "nadia@gmail.com",
        source: "gmail",
        events: [event({ id: 1, occurredAt: new Date("2026-01-01") })],
      },
      {
        sourceIdentifier: "nadia-linkedin",
        source: "linkedin",
        events: [event({ id: 2, occurredAt: new Date("2026-01-02") })],
      },
    ];

    const timeline = buildPersonTimeline(contacts);

    expect(timeline[0]).toMatchObject({
      contactEmail: "nadia-linkedin",
      contactSource: "linkedin",
    });
    expect(timeline[1]).toMatchObject({
      contactEmail: "nadia@gmail.com",
      contactSource: "gmail",
    });
  });

  it("returns an empty timeline for a Person with no Events", () => {
    expect(
      buildPersonTimeline([
        { sourceIdentifier: "nadia@gmail.com", source: "gmail", events: [] },
      ]),
    ).toEqual([]);
  });

  it("handles a single Contact with multiple Events correctly", () => {
    const contacts = [
      {
        sourceIdentifier: "nadia@gmail.com",
        source: "gmail",
        events: [
          event({ id: 1, occurredAt: new Date("2026-01-01") }),
          event({ id: 2, occurredAt: new Date("2026-01-03") }),
          event({ id: 3, occurredAt: new Date("2026-01-02") }),
        ],
      },
    ];

    const timeline = buildPersonTimeline(contacts);

    expect(timeline.map((t) => t.event.id)).toEqual([2, 3, 1]);
  });
});
