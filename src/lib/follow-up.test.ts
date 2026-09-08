import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { campaign, campaignRecipient, contact, oauthAccount, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  findRecipientsNeedingFollowUp,
  needsFollowUp,
  notifyOwnerOfPendingFollowUps,
  prepareFollowUps,
  runFollowUpCycle,
  type FollowUpEligibility,
  type QueuedFollowUp,
} from "./follow-up";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-03-10T12:00:00.000Z");

function eligibility(overrides: Partial<FollowUpEligibility>): FollowUpEligibility {
  return {
    status: "sent",
    sentAt: new Date(NOW.getTime() - 4 * DAY_MS),
    followedUpAt: null,
    ...overrides,
  };
}

describe("needsFollowUp", () => {
  it("is true for a sent recipient 4 days ago with no follow-up yet", () => {
    expect(needsFollowUp(eligibility({}), NOW)).toBe(true);
  });

  it("is true for an opened recipient — opening alone isn't enough engagement to skip the nudge", () => {
    expect(needsFollowUp(eligibility({ status: "opened" }), NOW)).toBe(true);
  });

  it("is false for a clicked recipient — a click is real engagement", () => {
    expect(needsFollowUp(eligibility({ status: "clicked" }), NOW)).toBe(false);
  });

  it("is false for a completed recipient", () => {
    expect(needsFollowUp(eligibility({ status: "completed" }), NOW)).toBe(false);
  });

  it("is false for a still-drafted recipient — never sent, nothing to follow up on", () => {
    expect(
      needsFollowUp(eligibility({ status: "drafted", sentAt: null }), NOW),
    ).toBe(false);
  });

  it("is false when sent less than 3 days ago", () => {
    expect(
      needsFollowUp(eligibility({ sentAt: new Date(NOW.getTime() - 2 * DAY_MS) }), NOW),
    ).toBe(false);
  });

  it("is true at exactly the 3-day boundary", () => {
    expect(
      needsFollowUp(eligibility({ sentAt: new Date(NOW.getTime() - 3 * DAY_MS) }), NOW),
    ).toBe(true);
  });

  it("is false once already followed up", () => {
    expect(
      needsFollowUp(
        eligibility({ followedUpAt: new Date(NOW.getTime() - DAY_MS) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when sentAt is null even if status looks eligible", () => {
    expect(needsFollowUp(eligibility({ sentAt: null }), NOW)).toBe(false);
  });
});

describe("findRecipientsNeedingFollowUp", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function makeRecipient(overrides: {
    personName: string;
    channel?: "email" | "linkedin";
    status?: "drafted" | "sent" | "opened" | "clicked" | "completed";
    sentAt?: Date | null;
    followedUpAt?: Date | null;
    campaignDeletedAt?: Date | null;
    recipientDeletedAt?: Date | null;
  }) {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: overrides.personName })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: overrides.channel === "linkedin" ? "linkedin" : "gmail",
        sourceIdentifier: `${overrides.personName.toLowerCase()}@example.com`,
        status: "active",
      })
      .returning();
    const [camp] = await testDb.db
      .insert(campaign)
      .values({
        name: "Test",
        goal: "test goal",
        destinationUrl: "https://example.com/study",
        deletedAt: overrides.campaignDeletedAt ?? null,
      })
      .returning();
    const [recipient] = await testDb.db
      .insert(campaignRecipient)
      .values({
        campaignId: camp.id,
        personId: p.id,
        contactId: c.id,
        channel: overrides.channel ?? "email",
        status: overrides.status ?? "sent",
        draftBody: "Hi there.",
        trackingToken: `tok-${p.id}`,
        sentAt: overrides.sentAt === undefined ? new Date(NOW.getTime() - 4 * DAY_MS) : overrides.sentAt,
        followedUpAt: overrides.followedUpAt ?? null,
        deletedAt: overrides.recipientDeletedAt ?? null,
      })
      .returning();
    return recipient;
  }

  it("finds a recipient sent 4 days ago with no follow-up yet", async () => {
    await makeRecipient({ personName: "Ada" });

    const results = await findRecipientsNeedingFollowUp(testDb.db, NOW);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      contactIdentifier: "ada@example.com",
      personName: "Ada",
      campaignName: "Test",
    });
  });

  it("excludes a recipient sent less than 3 days ago", async () => {
    await makeRecipient({
      personName: "Bob",
      sentAt: new Date(NOW.getTime() - DAY_MS),
    });

    const results = await findRecipientsNeedingFollowUp(testDb.db, NOW);
    expect(results).toHaveLength(0);
  });

  it("excludes a recipient that's already been followed up", async () => {
    await makeRecipient({
      personName: "Carol",
      followedUpAt: new Date(NOW.getTime() - DAY_MS),
    });

    const results = await findRecipientsNeedingFollowUp(testDb.db, NOW);
    expect(results).toHaveLength(0);
  });

  it("excludes a clicked recipient — real engagement, no nudge needed", async () => {
    await makeRecipient({ personName: "Dana", status: "clicked" });

    const results = await findRecipientsNeedingFollowUp(testDb.db, NOW);
    expect(results).toHaveLength(0);
  });

  it("excludes a recipient whose Campaign is soft-deleted", async () => {
    await makeRecipient({ personName: "Erin", campaignDeletedAt: new Date() });

    const results = await findRecipientsNeedingFollowUp(testDb.db, NOW);
    expect(results).toHaveLength(0);
  });

  it("excludes a soft-deleted recipient", async () => {
    await makeRecipient({ personName: "Frank", recipientDeletedAt: new Date() });

    const results = await findRecipientsNeedingFollowUp(testDb.db, NOW);
    expect(results).toHaveLength(0);
  });
});

// generateDraftForPerson's full pipeline calls the real Anthropic API and
// is deliberately left untested at that layer — same tradeoff
// campaigns.test.ts makes.
vi.mock("@/lib/draft-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/draft-generation")>();
  return {
    ...actual,
    generateDraftForPerson: vi.fn(async (_db, personId: number, goal: string) => ({
      context: { personId, personName: `Person ${personId}`, contacts: [], events: [] },
      draft: {
        subject: `Following up`,
        body: `Nudge for ${personId}: ${goal}`,
        raw: "",
      },
    })),
  };
});

const sendGmailMessageMock = vi.fn(async (..._args: unknown[]) => ({
  messageId: "sent-followup-1",
  threadId: "thread-followup-1",
}));
const createGmailClientMock = vi.fn(async (..._args: unknown[]) => ({
  gmail: {},
  ownEmail: "me@example.com",
}));

vi.mock("@/lib/gmail-import", () => ({
  createGmailClient: (...args: unknown[]) => createGmailClientMock(...args),
}));

vi.mock("@/lib/gmail-send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail-send")>();
  return {
    ...actual,
    sendGmailMessage: (...args: unknown[]) => sendGmailMessageMock(...args),
  };
});

describe("prepareFollowUps", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const originalRedirectBaseUrl = process.env.REDIRECT_BASE_URL;

  beforeEach(async () => {
    testDb = await createTestDb();
    process.env.REDIRECT_BASE_URL = "https://redirect.example.com";
  });

  afterEach(async () => {
    await testDb.client.close();
    if (originalRedirectBaseUrl === undefined) {
      delete process.env.REDIRECT_BASE_URL;
    } else {
      process.env.REDIRECT_BASE_URL = originalRedirectBaseUrl;
    }
  });

  async function seedRecipient(
    channel: "email" | "linkedin",
    personName: string,
  ) {
    const [p] = await testDb.db.insert(person).values({ name: personName }).returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: channel === "linkedin" ? "linkedin" : "gmail",
        sourceIdentifier:
          channel === "linkedin"
            ? `https://www.linkedin.com/in/${personName.toLowerCase()}`
            : `${personName.toLowerCase()}@example.com`,
        status: "active",
      })
      .returning();
    const [camp] = await testDb.db
      .insert(campaign)
      .values({
        name: "Test Campaign",
        goal: "test goal",
        destinationUrl: "https://example.com/study",
      })
      .returning();
    const [recipient] = await testDb.db
      .insert(campaignRecipient)
      .values({
        campaignId: camp.id,
        personId: p.id,
        contactId: c.id,
        channel,
        status: "sent",
        draftSubject: "Original subject",
        draftBody: "Original body",
        trackingToken: `tok-${p.id}`,
        sentAt: new Date(NOW.getTime() - 4 * DAY_MS),
      })
      .returning();
    return recipient;
  }

  it("never sends anything — only drafts and re-queues, for both channels", async () => {
    await seedRecipient("email", "Ada");
    await seedRecipient("linkedin", "Bob");

    const result = await prepareFollowUps(testDb.db, NOW);

    expect(result.queued).toHaveLength(2);
    expect(result.skippedDraftFailed).toBe(0);
    expect(sendGmailMessageMock).not.toHaveBeenCalled();
    expect(createGmailClientMock).not.toHaveBeenCalled();
  });

  it("writes the follow-up draft and resets status to drafted, keeping followedUpAt set", async () => {
    const recipient = await seedRecipient("email", "Carol");

    await prepareFollowUps(testDb.db, NOW);

    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, recipient.id),
    });
    expect(row?.status).toBe("drafted");
    expect(row?.followedUpAt).toBeInstanceOf(Date);
    expect(row?.draftBody).toContain("Nudge for");
  });

  it("resets a LinkedIn recipient back into the copy-assist queue", async () => {
    const recipient = await seedRecipient("linkedin", "Dana");

    const result = await prepareFollowUps(testDb.db, NOW);

    expect(result.queued[0]).toMatchObject({ channel: "linkedin", personName: "Dana" });
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, recipient.id),
    });
    expect(row?.status).toBe("drafted");
  });

  it("does nothing when there are no recipients due for a follow-up", async () => {
    const result = await prepareFollowUps(testDb.db, NOW);
    expect(result).toEqual({ queued: [], skippedDraftFailed: 0 });
  });

  it("throws a clear error when REDIRECT_BASE_URL isn't configured but a candidate needs a tracked link", async () => {
    await seedRecipient("email", "Erin");
    delete process.env.REDIRECT_BASE_URL;

    await expect(prepareFollowUps(testDb.db, NOW)).rejects.toThrow(/REDIRECT_BASE_URL/);
  });
});

describe("notifyOwnerOfPendingFollowUps", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const originalAppBaseUrl = process.env.APP_BASE_URL;

  beforeEach(async () => {
    testDb = await createTestDb();
    process.env.APP_BASE_URL = "https://yacrm.example.com";
    sendGmailMessageMock.mockClear();
    createGmailClientMock.mockClear();
  });

  afterEach(async () => {
    await testDb.client.close();
    if (originalAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = originalAppBaseUrl;
    }
  });

  function queuedFollowUp(overrides: Partial<QueuedFollowUp>): QueuedFollowUp {
    return {
      campaignId: 1,
      campaignName: "Test Campaign",
      personName: "Ada",
      channel: "email",
      draftSubject: "Following up",
      ...overrides,
    };
  }

  it("does nothing and reports not notified when nothing was queued", async () => {
    const result = await notifyOwnerOfPendingFollowUps(testDb.db, []);
    expect(result).toEqual({ notified: false });
    expect(sendGmailMessageMock).not.toHaveBeenCalled();
  });

  it("throws when there's something to notify about but no Gmail account is connected", async () => {
    await expect(
      notifyOwnerOfPendingFollowUps(testDb.db, [queuedFollowUp({})]),
    ).rejects.toThrow(/no Gmail account/i);
  });

  it("emails the owner's own Gmail account a digest grouped by channel", async () => {
    await testDb.db.insert(oauthAccount).values({
      provider: "gmail",
      emailAddress: "me@example.com",
      accessToken: "token",
      expiresAt: new Date(),
    });

    const result = await notifyOwnerOfPendingFollowUps(testDb.db, [
      queuedFollowUp({ personName: "Ada", channel: "email", campaignId: 5 }),
      queuedFollowUp({ personName: "Bob", channel: "linkedin", campaignId: 5 }),
    ]);

    expect(result).toEqual({ notified: true });
    expect(sendGmailMessageMock).toHaveBeenCalledTimes(1);
    const params = sendGmailMessageMock.mock.calls[0][1] as {
      from: string;
      to: string;
      body: string;
    };
    expect(params.from).toBe("me@example.com");
    expect(params.to).toBe("me@example.com");
    expect(params.body).toContain("Ada");
    expect(params.body).toContain("Bob");
    expect(params.body).toContain("https://yacrm.example.com/campaigns/5");
    expect(params.body).toContain("nothing has been sent");
  });
});

describe("runFollowUpCycle", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const originalRedirectBaseUrl = process.env.REDIRECT_BASE_URL;
  const originalAppBaseUrl = process.env.APP_BASE_URL;

  beforeEach(async () => {
    testDb = await createTestDb();
    process.env.REDIRECT_BASE_URL = "https://redirect.example.com";
    process.env.APP_BASE_URL = "https://yacrm.example.com";
    sendGmailMessageMock.mockClear();
    createGmailClientMock.mockClear();
  });

  afterEach(async () => {
    await testDb.client.close();
    if (originalRedirectBaseUrl === undefined) {
      delete process.env.REDIRECT_BASE_URL;
    } else {
      process.env.REDIRECT_BASE_URL = originalRedirectBaseUrl;
    }
    if (originalAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = originalAppBaseUrl;
    }
  });

  it("prepares follow-ups and notifies the owner in one call", async () => {
    await testDb.db.insert(oauthAccount).values({
      provider: "gmail",
      emailAddress: "me@example.com",
      accessToken: "token",
      expiresAt: new Date(),
    });
    const [p] = await testDb.db.insert(person).values({ name: "Ada" }).returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "ada@example.com",
        status: "active",
      })
      .returning();
    const [camp] = await testDb.db
      .insert(campaign)
      .values({ name: "Test", goal: "goal", destinationUrl: "https://example.com/study" })
      .returning();
    await testDb.db.insert(campaignRecipient).values({
      campaignId: camp.id,
      personId: p.id,
      contactId: c.id,
      channel: "email",
      status: "sent",
      draftBody: "Original",
      trackingToken: "tok-ada",
      sentAt: new Date(NOW.getTime() - 4 * DAY_MS),
    });

    const summary = await runFollowUpCycle(testDb.db, NOW);

    expect(summary).toEqual({
      emailQueued: 1,
      linkedinQueued: 0,
      skippedDraftFailed: 0,
      notified: true,
    });
    expect(sendGmailMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not call Gmail at all when nothing is due", async () => {
    const summary = await runFollowUpCycle(testDb.db, NOW);
    expect(summary).toEqual({
      emailQueued: 0,
      linkedinQueued: 0,
      skippedDraftFailed: 0,
      notified: false,
    });
    expect(createGmailClientMock).not.toHaveBeenCalled();
    expect(sendGmailMessageMock).not.toHaveBeenCalled();
  });
});
