import { gmail_v1 } from "googleapis";
import { describe, expect, it } from "vitest";

import {
  CandidateMessage,
  filterToPersonalContacts,
  isBulkOrAutomatedMessage,
} from "./gmail-filtering";

function fakeMessage(
  headers: Record<string, string>,
): gmail_v1.Schema$Message {
  return {
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
    },
  };
}

describe("isBulkOrAutomatedMessage", () => {
  it("flags a message with a List-Unsubscribe header", () => {
    expect(
      isBulkOrAutomatedMessage(
        fakeMessage({
          From: "Newsletter <news@company.com>",
          "List-Unsubscribe": "<mailto:unsub@company.com>",
        }),
      ),
    ).toBe(true);
  });

  it("flags a message with Precedence: bulk", () => {
    expect(
      isBulkOrAutomatedMessage(
        fakeMessage({
          From: "Alerts <alerts@company.com>",
          Precedence: "bulk",
        }),
      ),
    ).toBe(true);
  });

  it("flags a message with Auto-Submitted set to something other than no", () => {
    expect(
      isBulkOrAutomatedMessage(
        fakeMessage({
          From: "System <system@company.com>",
          "Auto-Submitted": "auto-generated",
        }),
      ),
    ).toBe(true);
  });

  it("flags a no-reply@ sender even without special headers", () => {
    expect(
      isBulkOrAutomatedMessage(
        fakeMessage({ From: "no-reply@company.com" }),
      ),
    ).toBe(true);
  });

  it("does not flag a plain human email with no special headers", () => {
    expect(
      isBulkOrAutomatedMessage(
        fakeMessage({ From: "Ada Lovelace <ada@example.com>" }),
      ),
    ).toBe(false);
  });

  it("does not flag a support@ address just for its local part", () => {
    // Deliberately conservative: support@ can be a real two-way conversation
    // with a small business, so local-part matching stays narrow.
    expect(
      isBulkOrAutomatedMessage(
        fakeMessage({ From: "Small Biz Support <support@smallbiz.com>" }),
      ),
    ).toBe(false);
  });
});

describe("filterToPersonalContacts", () => {
  function candidate(
    overrides: Partial<CandidateMessage<{ label: string }>>,
  ): CandidateMessage<{ label: string }> {
    return {
      otherPartyEmail: "someone@example.com",
      direction: "inbound",
      isBulkSignal: false,
      payload: { label: "msg" },
      ...overrides,
    };
  }

  it("keeps an address with both an inbound and an outbound message", () => {
    const result = filterToPersonalContacts([
      candidate({ otherPartyEmail: "friend@example.com", direction: "inbound" }),
      candidate({ otherPartyEmail: "friend@example.com", direction: "outbound" }),
    ]);

    expect(result.kept).toHaveLength(2);
    expect(result.excludedOneWayEmails.size).toBe(0);
    expect(result.excludedBulkEmails.size).toBe(0);
  });

  it("excludes an address with only inbound messages (one-way cold outreach / newsletter)", () => {
    const result = filterToPersonalContacts([
      candidate({ otherPartyEmail: "newsletter@company.com", direction: "inbound" }),
      candidate({ otherPartyEmail: "newsletter@company.com", direction: "inbound" }),
    ]);

    expect(result.kept).toHaveLength(0);
    expect(result.excludedOneWayEmails).toEqual(
      new Set(["newsletter@company.com"]),
    );
  });

  it("excludes an address with only outbound messages (you emailed, they never replied)", () => {
    const result = filterToPersonalContacts([
      candidate({ otherPartyEmail: "cold@company.com", direction: "outbound" }),
    ]);

    expect(result.kept).toHaveLength(0);
    expect(result.excludedOneWayEmails).toEqual(new Set(["cold@company.com"]));
  });

  it("excludes an address with a bulk signal even if it has two-way messages", () => {
    const result = filterToPersonalContacts([
      candidate({
        otherPartyEmail: "support@company.com",
        direction: "inbound",
        isBulkSignal: true,
      }),
      candidate({
        otherPartyEmail: "support@company.com",
        direction: "outbound",
      }),
    ]);

    expect(result.kept).toHaveLength(0);
    expect(result.excludedBulkEmails).toEqual(new Set(["support@company.com"]));
    expect(result.excludedOneWayEmails.size).toBe(0);
  });

  it("handles a mix of known-good and known-bad addresses in one batch", () => {
    const result = filterToPersonalContacts([
      // known-good: real two-way human conversation
      candidate({ otherPartyEmail: "ada@example.com", direction: "inbound" }),
      candidate({ otherPartyEmail: "ada@example.com", direction: "outbound" }),
      // known-bad: newsletter, one-way inbound only
      candidate({
        otherPartyEmail: "newsletter@company.com",
        direction: "inbound",
        isBulkSignal: true,
      }),
      // known-bad: cold outreach you never replied to
      candidate({ otherPartyEmail: "sales@vendor.com", direction: "inbound" }),
      // known-bad: no-reply system notification you never replied to
      candidate({
        otherPartyEmail: "no-reply@service.com",
        direction: "inbound",
        isBulkSignal: true,
      }),
    ]);

    const keptEmails = new Set(result.kept.map((c) => c.otherPartyEmail));
    expect(keptEmails).toEqual(new Set(["ada@example.com"]));
    expect(result.excludedBulkEmails).toEqual(
      new Set(["newsletter@company.com", "no-reply@service.com"]),
    );
    expect(result.excludedOneWayEmails).toEqual(new Set(["sales@vendor.com"]));
  });
});
