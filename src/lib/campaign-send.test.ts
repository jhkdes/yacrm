import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { campaign, campaignRecipient, contact, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  CampaignRecipientNotFoundError,
  CampaignRecipientNotSendableError,
  markLinkedInRecipientSent,
  sendCampaignRecipientEmail,
} from "@/lib/campaign-send";
import type { RawEmailParams } from "@/lib/gmail-send";

const sendGmailMessageMock = vi.fn(async (..._args: unknown[]) => ({
  messageId: "sent-1",
  threadId: "thread-1",
}));
const createGmailClientMock = vi.fn(async (..._args: unknown[]) => ({
  gmail: {},
  ownEmail: "me@example.com",
}));

vi.mock("@/lib/gmail-import", () => ({
  createGmailClient: (...args: unknown[]) => createGmailClientMock(...args),
}));

// gmail-send.ts's own logic (buildRawEmail, recordSentEvent) stays real —
// only the actual network call (sendGmailMessage) is mocked, so this test
// still exercises the real tracked-link/pixel embedding and the real
// Event-recording side effect, just without hitting Gmail's API.
vi.mock("@/lib/gmail-send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail-send")>();
  return {
    ...actual,
    sendGmailMessage: (...args: unknown[]) => sendGmailMessageMock(...args),
  };
});

describe("sendCampaignRecipientEmail", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const originalRedirectBaseUrl = process.env.REDIRECT_BASE_URL;

  beforeEach(async () => {
    testDb = await createTestDb();
    process.env.REDIRECT_BASE_URL = "https://redirect.example.com";
    sendGmailMessageMock.mockClear();
    createGmailClientMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url, options) => {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            data: body.input.map((_t: string, index: number) => ({
              embedding: Array(512).fill(0),
              index,
            })),
          }),
        };
      }),
    );
  });

  afterEach(async () => {
    await testDb.client.close();
    vi.unstubAllGlobals();
    if (originalRedirectBaseUrl === undefined) {
      delete process.env.REDIRECT_BASE_URL;
    } else {
      process.env.REDIRECT_BASE_URL = originalRedirectBaseUrl;
    }
  });

  async function seedDraftedRecipient() {
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
    const [recipient] = await testDb.db.insert(campaignRecipient).values({
      campaignId: camp.id,
      personId: p.id,
      contactId: c.id,
      channel: "email",
      status: "drafted",
      draftSubject: "Try our interview",
      draftBody: "Hi Ada, would love for you to try this out.",
      trackingToken: "tok-abc123",
    }).returning();
    return { recipient, personId: p.id, contactId: c.id };
  }

  it("sends via Gmail with the tracked link and pixel embedded, then marks the recipient sent", async () => {
    const { recipient, contactId } = await seedDraftedRecipient();

    await sendCampaignRecipientEmail(testDb.db, 42, recipient.id);

    expect(createGmailClientMock).toHaveBeenCalledWith(testDb.db, 42);
    expect(sendGmailMessageMock).toHaveBeenCalledTimes(1);
    const sentParams = sendGmailMessageMock.mock.calls[0][1] as RawEmailParams;
    expect(sentParams.to).toBe("ada@example.com");
    expect(sentParams.from).toBe("me@example.com");
    expect(sentParams.trackedLinkUrl).toBe(
      "https://redirect.example.com/tok-abc123",
    );
    expect(sentParams.trackingPixelUrl).toBe(
      "https://redirect.example.com/pixel/tok-abc123",
    );

    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, recipient.id),
    });
    expect(row?.status).toBe("sent");
    expect(row?.sentAt).toBeInstanceOf(Date);

    const events = await testDb.db
      .select()
      .from(event)
      .where(eq(event.contactId, contactId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "outbound",
      sourceMessageId: "sent-1",
      bodyText: "Hi Ada, would love for you to try this out.",
    });
  });

  it("throws for a recipient id that doesn't exist", async () => {
    await expect(
      sendCampaignRecipientEmail(testDb.db, 42, 999),
    ).rejects.toThrow(CampaignRecipientNotFoundError);
  });

  it("throws for a linkedin-channel recipient", async () => {
    const { recipient } = await seedDraftedRecipient();
    await testDb.db
      .update(campaignRecipient)
      .set({ channel: "linkedin" })
      .where(eq(campaignRecipient.id, recipient.id));

    await expect(
      sendCampaignRecipientEmail(testDb.db, 42, recipient.id),
    ).rejects.toThrow(CampaignRecipientNotSendableError);
  });

  it("throws for a recipient that's already sent, rather than re-sending", async () => {
    const { recipient } = await seedDraftedRecipient();
    await sendCampaignRecipientEmail(testDb.db, 42, recipient.id);

    await expect(
      sendCampaignRecipientEmail(testDb.db, 42, recipient.id),
    ).rejects.toThrow(CampaignRecipientNotSendableError);
  });

  it("throws a clear error when REDIRECT_BASE_URL isn't configured", async () => {
    delete process.env.REDIRECT_BASE_URL;
    const { recipient } = await seedDraftedRecipient();

    await expect(
      sendCampaignRecipientEmail(testDb.db, 42, recipient.id),
    ).rejects.toThrow(/REDIRECT_BASE_URL/);
  });
});

describe("markLinkedInRecipientSent", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  let nextSuffix = 0;

  async function seedDraftedLinkedInRecipient() {
    nextSuffix += 1;
    const suffix = nextSuffix;
    const [p] = await testDb.db.insert(person).values({ name: `Ada ${suffix}` }).returning();
    const [c] = await testDb.db.insert(contact).values({
      personId: p.id,
      source: "linkedin",
      sourceIdentifier: `https://www.linkedin.com/in/ada-${suffix}`,
      status: "active",
    }).returning();
    const [camp] = await testDb.db.insert(campaign).values({
      name: "Test",
      goal: "goal",
      destinationUrl: "https://interview.example.com/study",
    }).returning();
    const [recipient] = await testDb.db.insert(campaignRecipient).values({
      campaignId: camp.id,
      personId: p.id,
      contactId: c.id,
      channel: "linkedin",
      status: "drafted",
      draftBody: "Hi Ada, would love for you to try this out.",
      trackingToken: `tok-li-${suffix}`,
    }).returning();
    return recipient;
  }

  it("marks the recipient sent", async () => {
    const recipient = await seedDraftedLinkedInRecipient();

    await markLinkedInRecipientSent(testDb.db, recipient.id);

    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, recipient.id),
    });
    expect(row?.status).toBe("sent");
    expect(row?.sentAt).toBeInstanceOf(Date);
  });

  it("leaves other recipients untouched", async () => {
    const recipient = await seedDraftedLinkedInRecipient();
    const other = await seedDraftedLinkedInRecipient();

    await markLinkedInRecipientSent(testDb.db, recipient.id);

    const otherRow = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, other.id),
    });
    expect(otherRow?.status).toBe("drafted");
  });

  it("throws for a recipient id that doesn't exist", async () => {
    await expect(
      markLinkedInRecipientSent(testDb.db, 999),
    ).rejects.toThrow(CampaignRecipientNotFoundError);
  });

  it("throws for an email-channel recipient", async () => {
    const recipient = await seedDraftedLinkedInRecipient();
    await testDb.db
      .update(campaignRecipient)
      .set({ channel: "email" })
      .where(eq(campaignRecipient.id, recipient.id));

    await expect(
      markLinkedInRecipientSent(testDb.db, recipient.id),
    ).rejects.toThrow(CampaignRecipientNotSendableError);
  });

  it("throws for a recipient that's already sent", async () => {
    const recipient = await seedDraftedLinkedInRecipient();
    await markLinkedInRecipientSent(testDb.db, recipient.id);

    await expect(
      markLinkedInRecipientSent(testDb.db, recipient.id),
    ).rejects.toThrow(CampaignRecipientNotSendableError);
  });
});
