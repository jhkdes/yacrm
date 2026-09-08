import { describe, expect, it } from "vitest";

import {
  recipientsToCsv,
  summarizeCampaign,
  type CampaignRecipientRow,
} from "./campaign-reporting";

function row(overrides: Partial<CampaignRecipientRow>): CampaignRecipientRow {
  return {
    personName: "Ada Lovelace",
    contactIdentifier: "ada@example.com",
    channel: "email",
    status: "drafted",
    draftSubject: "Subject",
    draftBody: "Body",
    trackingToken: "tok-1",
    sentAt: null,
    openedAt: null,
    clickedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("summarizeCampaign", () => {
  it("returns all-zero counts for every channel/status combination given no recipients", () => {
    const summary = summarizeCampaign([]);
    expect(summary).toEqual({
      email: { drafted: 0, sent: 0, opened: 0, clicked: 0, completed: 0 },
      linkedin: { drafted: 0, sent: 0, opened: 0, clicked: 0, completed: 0 },
    });
  });

  it("counts recipients per status per channel", () => {
    const recipients = [
      row({ channel: "email", status: "drafted" }),
      row({ channel: "email", status: "sent" }),
      row({ channel: "email", status: "sent" }),
      row({ channel: "email", status: "completed" }),
      row({ channel: "linkedin", status: "drafted" }),
      row({ channel: "linkedin", status: "clicked" }),
    ];

    const summary = summarizeCampaign(recipients);

    expect(summary.email).toEqual({
      drafted: 1,
      sent: 2,
      opened: 0,
      clicked: 0,
      completed: 1,
    });
    expect(summary.linkedin).toEqual({
      drafted: 1,
      sent: 0,
      opened: 0,
      clicked: 1,
      completed: 0,
    });
  });

  it("never counts a linkedin recipient as opened — there's no read-receipt signal for that channel", () => {
    const summary = summarizeCampaign([
      row({ channel: "linkedin", status: "sent" }),
    ]);
    expect(summary.linkedin.opened).toBe(0);
  });
});

describe("recipientsToCsv", () => {
  it("writes a header row even with no recipients", () => {
    const csv = recipientsToCsv([]);
    expect(csv).toBe(
      "Person,Channel,Contact,Status,Subject,Tracking Token,Sent At,Opened At,Clicked At,Completed At\r\n",
    );
  });

  it("writes one row per recipient with dates as ISO strings", () => {
    const sentAt = new Date("2026-01-01T12:00:00.000Z");
    const csv = recipientsToCsv([
      row({
        personName: "Ada Lovelace",
        channel: "email",
        contactIdentifier: "ada@example.com",
        status: "sent",
        draftSubject: "Try our interview",
        trackingToken: "tok-abc",
        sentAt,
      }),
    ]);

    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "Ada Lovelace,email,ada@example.com,sent,Try our interview,tok-abc,2026-01-01T12:00:00.000Z,,,",
    );
  });

  it("quotes and escapes fields containing commas, quotes, or newlines", () => {
    const csv = recipientsToCsv([
      row({
        personName: 'Dana "The Rocket" Scully, Jr.',
        draftSubject: "Line one\nLine two",
      }),
    ]);

    const lines = csv.trim().split("\r\n");
    expect(lines[1]).toContain('"Dana ""The Rocket"" Scully, Jr."');
    expect(lines[1]).toContain('"Line one\nLine two"');
  });

  it("leaves an unset subject as an empty field rather than the literal null", () => {
    const csv = recipientsToCsv([row({ draftSubject: null })]);
    const lines = csv.trim().split("\r\n");
    expect(lines[1]).toContain(",,tok-1,");
  });
});
