import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { campaign, campaignRecipient, contact, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import { recordOpen } from "@/lib/open-tracking";

describe("recordOpen", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  let nextContactSuffix = 0;

  async function seedRecipient(status: "drafted" | "sent" | "opened" | "clicked" | "completed") {
    nextContactSuffix += 1;
    const token = `token-${nextContactSuffix}`;
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    const [c] = await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: `ada-${nextContactSuffix}@example.com`,
      status: "active",
    }).returning();
    const [camp] = await testDb.db.insert(campaign).values({
      name: "Test",
      goal: "goal",
      destinationUrl: "https://example.com",
    }).returning();
    await testDb.db.insert(campaignRecipient).values({
      campaignId: camp.id,
      personId: p.id,
      contactId: c.id,
      channel: "email",
      status,
      draftBody: "body",
      trackingToken: token,
    });
    return token;
  }

  it("advances a sent recipient to opened", async () => {
    const token = await seedRecipient("sent");

    const result = await recordOpen(testDb.db, token);

    expect(result.statusUpdated).toBe(true);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.status).toBe("opened");
    expect(row?.openedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — a second pixel load doesn't reset openedAt", async () => {
    const token = await seedRecipient("sent");
    await recordOpen(testDb.db, token);
    const first = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });

    const second = await recordOpen(testDb.db, token);

    expect(second.statusUpdated).toBe(false);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.trackingToken, token),
    });
    expect(row?.openedAt?.toISOString()).toBe(first?.openedAt?.toISOString());
  });

  it("never downgrades clicked or completed", async () => {
    for (const status of ["clicked", "completed"] as const) {
      const token = await seedRecipient(status);
      const result = await recordOpen(testDb.db, token);
      expect(result.statusUpdated).toBe(false);
      const row = await testDb.db.query.campaignRecipient.findFirst({
        where: (r, { eq }) => eq(r.trackingToken, token),
      });
      expect(row?.status).toBe(status);
    }
  });

  it("does not advance a drafted (never sent) recipient — a hit here would be spoofed", async () => {
    const token = await seedRecipient("drafted");
    const result = await recordOpen(testDb.db, token);
    expect(result.statusUpdated).toBe(false);
  });

  it("returns statusUpdated: false for an unknown token", async () => {
    const result = await recordOpen(testDb.db, "no-such-token");
    expect(result.statusUpdated).toBe(false);
  });
});
