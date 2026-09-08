import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { campaign, campaignRecipient, contact, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  isValidCompletionPayload,
  recordCompletion,
} from "@/lib/interview-webhook";

describe("isValidCompletionPayload", () => {
  const valid = {
    participantTrackingId: "tok-1",
    interviewId: "527d63ba-67ea-4585-a6a6-60eaab13eb4f",
    studyId: "b1e2c3d4-0000-0000-0000-000000000000",
    status: "completed",
    completedAt: "2026-09-08T05:07:58.000Z",
  };

  it("accepts a well-formed payload", () => {
    expect(isValidCompletionPayload(valid)).toBe(true);
  });

  it("rejects null/non-object input", () => {
    expect(isValidCompletionPayload(null)).toBe(false);
    expect(isValidCompletionPayload("a string")).toBe(false);
    expect(isValidCompletionPayload(42)).toBe(false);
  });

  it("rejects a payload missing a required field", () => {
    const { participantTrackingId: _drop, ...rest } = valid;
    expect(isValidCompletionPayload(rest)).toBe(false);
  });

  it("rejects an empty participantTrackingId", () => {
    expect(
      isValidCompletionPayload({ ...valid, participantTrackingId: "" }),
    ).toBe(false);
  });

  it("rejects a wrong-typed field", () => {
    expect(isValidCompletionPayload({ ...valid, completedAt: 12345 })).toBe(
      false,
    );
  });
});

describe("recordCompletion", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function seedRecipient(status: "drafted" | "sent" | "opened" | "clicked" | "completed") {
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    const [c] = await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "ada@example.com",
      status: "active",
    }).returning();
    const [camp] = await testDb.db.insert(campaign).values({
      name: "Test",
      goal: "goal",
      destinationUrl: "https://interview.example.com/study",
    }).returning();
    await testDb.db.insert(campaignRecipient).values({
      campaignId: camp.id,
      personId: p.id,
      contactId: c.id,
      channel: "email",
      status,
      draftBody: "body",
      trackingToken: "tok-1",
    });
    return "tok-1";
  }

  function payloadFor(token: string, overrides: Partial<{ status: string; completedAt: string }> = {}) {
    return {
      participantTrackingId: token,
      interviewId: "527d63ba-67ea-4585-a6a6-60eaab13eb4f",
      studyId: "b1e2c3d4-0000-0000-0000-000000000000",
      status: overrides.status ?? "completed",
      completedAt: overrides.completedAt ?? "2026-09-08T05:07:58.000Z",
    };
  }

  it("marks a recipient completed, using the tool's own completedAt timestamp", async () => {
    const token = await seedRecipient("clicked");

    const result = await recordCompletion(testDb.db, payloadFor(token));

    expect(result.matched).toBe(true);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("completed");
    expect(row?.completedAt?.toISOString()).toBe("2026-09-08T05:07:58.000Z");
  });

  it("completes regardless of current funnel status — even drafted", async () => {
    const token = await seedRecipient("drafted");
    const result = await recordCompletion(testDb.db, payloadFor(token));
    expect(result.matched).toBe(true);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("completed");
  });

  it("falls back to the current time for an unparseable completedAt", async () => {
    const token = await seedRecipient("clicked");
    const before = new Date();

    await recordCompletion(testDb.db, payloadFor(token, { completedAt: "not-a-date" }));

    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.completedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("is a no-op for an unknown participantTrackingId", async () => {
    const result = await recordCompletion(testDb.db, payloadFor("no-such-token"));
    expect(result.matched).toBe(false);
  });

  it("is a no-op for a non-completed status, future-proofing against new event types", async () => {
    const token = await seedRecipient("clicked");
    const result = await recordCompletion(
      testDb.db,
      payloadFor(token, { status: "started" }),
    );
    expect(result.matched).toBe(false);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("clicked");
  });
});
