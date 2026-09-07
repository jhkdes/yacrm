import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { campaign, campaignRecipient, contact, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  FALLBACK_REDIRECT_PATH,
  recordClick,
  shouldRecordClick,
} from "@/lib/click-tracking";

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
      redirectUrl: "https://interview.example.com/study",
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
    expect(result.redirectUrl).toBe("https://interview.example.com/study");
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.clickedAt?.toISOString()).toBe(firstClick.toISOString());
  });

  it("still redirects a completed recipient to the destination, but doesn't downgrade their status", async () => {
    const token = await seedRecipient({ status: "completed" });

    const result = await recordClick(testDb.db, token);

    expect(result).toEqual({
      redirectUrl: "https://interview.example.com/study",
      statusUpdated: false,
    });
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("completed");
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
