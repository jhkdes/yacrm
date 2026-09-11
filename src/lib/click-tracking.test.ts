import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { campaign, campaignRecipient, contact, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  appendTrackingId,
  CLICK_GRACE_WINDOW_MS,
  FALLBACK_REDIRECT_PATH,
  isLinkPreviewBot,
  recordClick,
  shouldRecordClick,
} from "@/lib/click-tracking";

describe("appendTrackingId", () => {
  it("adds tracking_id as a new query param", () => {
    expect(appendTrackingId("https://interview.example.com/study", "tok-1")).toBe(
      "https://interview.example.com/study?tracking_id=tok-1",
    );
  });

  it("preserves an existing query string", () => {
    expect(
      appendTrackingId("https://interview.example.com/study?ref=abc", "tok-1"),
    ).toBe("https://interview.example.com/study?ref=abc&tracking_id=tok-1");
  });
});

describe("shouldRecordClick", () => {
  it("records a click from drafted, sent, or opened", () => {
    expect(shouldRecordClick("drafted")).toBe(true);
    expect(shouldRecordClick("sent")).toBe(true);
    expect(shouldRecordClick("opened")).toBe(true);
  });

  it("does not record a second click — clicked is idempotent", () => {
    expect(shouldRecordClick("clicked")).toBe(false);
  });

  it("never downgrades a completed recipient", () => {
    expect(shouldRecordClick("completed")).toBe(false);
  });
});

describe("isLinkPreviewBot", () => {
  it("recognizes LinkedIn's own link-unfurl bot, case-insensitively", () => {
    expect(
      isLinkPreviewBot(
        "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
      ),
    ).toBe(true);
  });

  it("recognizes other common link-preview bots", () => {
    expect(isLinkPreviewBot("facebookexternalhit/1.1")).toBe(true);
    expect(isLinkPreviewBot("Slackbot-LinkExpanding 1.0")).toBe(true);
  });

  it("does not flag a normal browser", () => {
    expect(
      isLinkPreviewBot(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ),
    ).toBe(false);
  });

  it("does not flag a missing user agent", () => {
    expect(isLinkPreviewBot(null)).toBe(false);
  });
});

describe("recordClick", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function seedRecipient(overrides: {
    destinationUrl?: string | null;
    status?: "drafted" | "sent" | "opened" | "clicked" | "completed";
    clickedAt?: Date;
    trackingToken?: string;
    firstSeenAt?: Date;
  } = {}) {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    const [c] = await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "ada@example.com",
      displayName: "Ada",
      status: "active",
    }).returning();
    const [camp] = await testDb.db.insert(campaign).values({
      name: "Test",
      goal: "goal",
      // "destinationUrl" in overrides (not `??`) — ?? would treat an
      // explicit `null` (the "no destination" case under test) as absent
      // and silently fall back to the default URL.
      destinationUrl:
        "destinationUrl" in overrides
          ? overrides.destinationUrl
          : "https://interview.example.com/study",
    }).returning();
    const token = overrides.trackingToken ?? "test-token";
    await testDb.db.insert(campaignRecipient).values({
      campaignId: camp.id,
      personId: p.id,
      contactId: c.id,
      channel: "email",
      status: overrides.status ?? "sent",
      draftBody: "body",
      trackingToken: token,
      clickedAt: overrides.clickedAt,
      firstSeenAt: overrides.firstSeenAt,
    });
    return token;
  }

  it("redirects to the fallback for an unknown token, without touching anything", async () => {
    const result = await recordClick(testDb.db, "no-such-token");
    expect(result).toEqual({
      redirectUrl: FALLBACK_REDIRECT_PATH,
      statusUpdated: false,
    });
  });

  it("advances a sent recipient to clicked and redirects to the destination", async () => {
    const token = await seedRecipient({ status: "sent" });

    const result = await recordClick(testDb.db, token);

    expect(result).toEqual({
      redirectUrl: "https://interview.example.com/study?tracking_id=test-token",
      statusUpdated: true,
    });
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("clicked");
    expect(row?.clickedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — clicking an already-clicked link doesn't reset clickedAt", async () => {
    const firstClick = new Date("2026-01-01T00:00:00Z");
    const token = await seedRecipient({ status: "clicked", clickedAt: firstClick });

    const result = await recordClick(testDb.db, token);

    expect(result.statusUpdated).toBe(false);
    expect(result.redirectUrl).toBe(
      "https://interview.example.com/study?tracking_id=test-token",
    );
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.clickedAt?.toISOString()).toBe(firstClick.toISOString());
  });

  it("still redirects a completed recipient to the destination, but doesn't downgrade their status", async () => {
    const token = await seedRecipient({ status: "completed" });

    const result = await recordClick(testDb.db, token);

    expect(result).toEqual({
      redirectUrl: "https://interview.example.com/study?tracking_id=test-token",
      statusUpdated: false,
    });
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("completed");
  });

  it("redirects a link-preview bot's fetch but doesn't record it as a click", async () => {
    const token = await seedRecipient({ status: "sent" });

    const result = await recordClick(testDb.db, token, "LinkedInBot/1.0");

    expect(result).toEqual({
      redirectUrl: "https://interview.example.com/study?tracking_id=test-token",
      statusUpdated: false,
    });
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("sent");
    expect(row?.clickedAt).toBeNull();
  });

  it("sets firstSeenAt on the very first hit, even a real one, and still records the click", async () => {
    const token = await seedRecipient({ status: "sent" });

    const result = await recordClick(testDb.db, token);

    expect(result.statusUpdated).toBe(true);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.firstSeenAt).toBeInstanceOf(Date);
    expect(row?.status).toBe("clicked");
  });

  it("sets firstSeenAt even when the very first hit is itself bot-suppressed", async () => {
    const token = await seedRecipient({ status: "sent" });

    await recordClick(testDb.db, token, "LinkedInBot/1.0");

    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.firstSeenAt).toBeInstanceOf(Date);
    expect(row?.status).toBe("sent");
  });

  it("suppresses a second hit seconds after the first, even with a normal browser user agent", async () => {
    const firstSeenAt = new Date(Date.now() - 30_000); // 30s ago, within the grace window
    const token = await seedRecipient({ status: "sent", firstSeenAt });

    const result = await recordClick(
      testDb.db,
      token,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/143.0 Safari/537.36",
    );

    expect(result.statusUpdated).toBe(false);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("sent");
    expect(row?.clickedAt).toBeNull();
  });

  it("records a hit past the grace window as a real click", async () => {
    const firstSeenAt = new Date(Date.now() - (CLICK_GRACE_WINDOW_MS + 60_000)); // 1 min past the window
    const token = await seedRecipient({ status: "sent", firstSeenAt });

    const result = await recordClick(testDb.db, token, "some real browser");

    expect(result.statusUpdated).toBe(true);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("clicked");
  });

  it("falls back and skips the status update when the Campaign has no destinationUrl", async () => {
    const token = await seedRecipient({ destinationUrl: null, status: "sent" });

    const result = await recordClick(testDb.db, token);

    expect(result).toEqual({
      redirectUrl: FALLBACK_REDIRECT_PATH,
      statusUpdated: false,
    });
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("sent");
  });
});
