import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { campaign, campaignRecipient, contact, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";
import {
  addRecipients,
  CampaignNotFoundError,
  createCampaign,
  deleteCampaign,
  removeRecipient,
  restoreCampaign,
  restoreRecipient,
  updateRecipientDraft,
} from "@/lib/campaigns";
import { listPersonIdsByTag, toggleTag } from "@/lib/person-tags";

// generateDraftForPerson's full pipeline calls the real Anthropic API and
// is deliberately left untested at that layer (see draft-generation.ts) —
// mocking it here lets addRecipients' own DB logic (Contact selection by
// channel, tracking-token issuance, dedupe) be exercised without a real
// network call, the same tradeoff gmail-import.test.ts makes by faking the
// Gmail client rather than the embeddings call it also depends on.
vi.mock("@/lib/draft-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/draft-generation")>();
  return {
    ...actual,
    generateDraftForPerson: vi.fn(async (_db, personId: number) => ({
      context: { personId, personName: `Person ${personId}`, contacts: [], events: [] },
      draft: { subject: `Subject for ${personId}`, body: `Body for ${personId}`, raw: "" },
    })),
  };
});

// Every Campaign created in this file uses a non-null destinationUrl, so
// every addRecipients call (including the ones exercised indirectly via
// removeRecipient/deleteCampaign/restoreCampaign/restoreRecipient's setup)
// needs a real REDIRECT_BASE_URL to build the tracked link against.
const originalRedirectBaseUrl = process.env.REDIRECT_BASE_URL;

beforeAll(() => {
  process.env.REDIRECT_BASE_URL = "https://redirect.example.com";
});

afterAll(() => {
  if (originalRedirectBaseUrl === undefined) {
    delete process.env.REDIRECT_BASE_URL;
  } else {
    process.env.REDIRECT_BASE_URL = originalRedirectBaseUrl;
  }
});

describe("createCampaign", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("persists a Campaign that a later query can still find", async () => {
    const { campaignId } = await createCampaign(
      testDb.db,
      "Try the AI interview",
      "invite senior PMs to try the AI interview link",
      "https://example.com/study",
    );

    const row = await testDb.db.query.campaign.findFirst({
      where: (c, { eq }) => eq(c.id, campaignId),
    });
    expect(row?.name).toBe("Try the AI interview");
    expect(row?.type).toBe("interview_link");
  });

  it("defaults type to interview_link but accepts intro", async () => {
    const { campaignId } = await createCampaign(
      testDb.db,
      "Let's connect",
      "generic networking outreach",
      null,
      "intro",
    );
    const row = await testDb.db.query.campaign.findFirst({
      where: (c, { eq }) => eq(c.id, campaignId),
    });
    expect(row?.type).toBe("intro");
  });
});

describe("addRecipients", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function makePerson(
    name: string,
    contacts: { source: "gmail" | "linkedin"; identifier: string; status?: "active" | "pending" }[],
  ) {
    const [p] = await testDb.db.insert(person).values({ name }).returning();
    for (const c of contacts) {
      await testDb.db.insert(contact).values({
        personId: p.id,
        source: c.source,
        sourceIdentifier: c.identifier,
        displayName: name,
        status: c.status ?? "active",
      });
    }
    return p.id;
  }

  it("throws for a Campaign that doesn't exist", async () => {
    await expect(
      addRecipients(testDb.db, 999, [{ personId: 1 }], "email"),
    ).rejects.toThrow(CampaignNotFoundError);
  });

  it("adds a recipient with a draft and a unique tracking token per channel", async () => {
    const personId = await makePerson("Ada Lovelace", [
      { source: "gmail", identifier: "ada@example.com" },
      { source: "linkedin", identifier: "https://www.linkedin.com/in/ada" },
    ]);
    const { campaignId } = await createCampaign(testDb.db, "Test", "test goal", "https://example.com/study");

    const emailResult = await addRecipients(
      testDb.db,
      campaignId,
      [{ personId }],
      "email",
    );
    expect(emailResult).toMatchObject({ added: 1, skippedNoContactForChannel: 0 });

    const rows = await testDb.db.query.campaignRecipient.findMany({
      where: (r, { eq }) => eq(r.campaignId, campaignId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "email",
      status: "drafted",
      draftSubject: `Subject for ${personId}`,
    });
    expect(rows[0].trackingToken).toBeTruthy();
    // The mocked draft body has no {{LINK}} placeholder, so
    // fillLinkPlaceholder falls back to appending the real tracked link —
    // built from this exact same trackingToken, not a separate one.
    expect(rows[0].draftBody).toBe(
      `Body for ${personId}\n\nhttps://redirect.example.com/${rows[0].trackingToken}`,
    );
  });

  it("skips a Person with no active Contact on the requested channel", async () => {
    const personId = await makePerson("Bob", [
      { source: "gmail", identifier: "bob@example.com" },
    ]);
    const { campaignId } = await createCampaign(testDb.db, "Test", "test goal", "https://example.com/study");

    const result = await addRecipients(
      testDb.db,
      campaignId,
      [{ personId }],
      "linkedin",
    );
    expect(result).toMatchObject({ added: 0, skippedNoContactForChannel: 1 });
  });

  it("does not target a pending (one-way) Contact", async () => {
    const personId = await makePerson("Carol", [
      { source: "gmail", identifier: "carol@example.com", status: "pending" },
    ]);
    const { campaignId } = await createCampaign(testDb.db, "Test", "test goal", "https://example.com/study");

    const result = await addRecipients(
      testDb.db,
      campaignId,
      [{ personId }],
      "email",
    );
    expect(result).toMatchObject({ added: 0, skippedNoContactForChannel: 1 });
  });

  it("is safe to call twice for the same Campaign — doesn't duplicate a recipient", async () => {
    const personId = await makePerson("Dana", [
      { source: "gmail", identifier: "dana@example.com" },
    ]);
    const { campaignId } = await createCampaign(testDb.db, "Test", "test goal", "https://example.com/study");

    await addRecipients(testDb.db, campaignId, [{ personId }], "email");
    const second = await addRecipients(
      testDb.db,
      campaignId,
      [{ personId }],
      "email",
    );

    expect(second).toMatchObject({ added: 0, skippedAlreadyRecipient: 1 });
    const rows = await testDb.db.select().from(campaignRecipient);
    expect(rows).toHaveLength(1);
  });

  it("revives a previously-removed recipient with a fresh draft and token instead of colliding", async () => {
    const personId = await makePerson("Ivy", [
      { source: "gmail", identifier: "ivy@example.com" },
    ]);
    const { campaignId } = await createCampaign(testDb.db, "Test", "test goal", "https://example.com/study");

    await addRecipients(testDb.db, campaignId, [{ personId }], "email");
    const [original] = await testDb.db.select().from(campaignRecipient);
    await removeRecipient(testDb.db, campaignId, original.id);

    const result = await addRecipients(
      testDb.db,
      campaignId,
      [{ personId }],
      "email",
    );

    expect(result).toMatchObject({ added: 1, skippedAlreadyRecipient: 0 });
    const rows = await testDb.db.select().from(campaignRecipient);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].deletedAt).toBeNull();
    expect(rows[0].trackingToken).not.toBe(original.trackingToken);
  });

  it("throws for a soft-deleted Campaign, the same as a missing one", async () => {
    const personId = await makePerson("Jack", [
      { source: "gmail", identifier: "jack@example.com" },
    ]);
    const { campaignId } = await createCampaign(testDb.db, "Test", "test goal", "https://example.com/study");
    await deleteCampaign(testDb.db, campaignId);

    await expect(
      addRecipients(testDb.db, campaignId, [{ personId }], "email"),
    ).rejects.toThrow(CampaignNotFoundError);
  });

  it("uses the Campaign's own persisted goal for drafting, not a caller-supplied one", async () => {
    const { generateDraftForPerson } = await import("@/lib/draft-generation");
    const personId = await makePerson("Erin", [
      { source: "gmail", identifier: "erin@example.com" },
    ]);
    const { campaignId } = await createCampaign(
      testDb.db,
      "Test",
      "the campaign's real goal",
      "https://example.com/study",
    );

    await addRecipients(testDb.db, campaignId, [{ personId }], "email");

    expect(generateDraftForPerson).toHaveBeenCalledWith(
      testDb.db,
      personId,
      "the campaign's real goal",
    );
  });
});

describe("removeRecipient", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("soft-deletes the recipient row rather than removing it", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Fiona" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "fiona@example.com",
      displayName: "Fiona",
      status: "active",
    });
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await addRecipients(testDb.db, campaignId, [{ personId: p.id }], "email");
    const [recipient] = await testDb.db.select().from(campaignRecipient);

    const result = await removeRecipient(
      testDb.db,
      campaignId,
      recipient.id,
    );

    expect(result.removed).toBe(true);
    const rows = await testDb.db.select().from(campaignRecipient);
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it("is idempotent — removing an already-removed recipient reports removed: false", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Fiona2" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "fiona2@example.com",
      displayName: "Fiona2",
      status: "active",
    });
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await addRecipients(testDb.db, campaignId, [{ personId: p.id }], "email");
    const [recipient] = await testDb.db.select().from(campaignRecipient);

    await removeRecipient(testDb.db, campaignId, recipient.id);
    const second = await removeRecipient(testDb.db, campaignId, recipient.id);

    expect(second.removed).toBe(false);
  });

  it("reports removed: false for a recipient that doesn't belong to that Campaign", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Gary" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "gary@example.com",
      displayName: "Gary",
      status: "active",
    });
    const { campaignId: campaignA } = await createCampaign(testDb.db, "A", "goal", "https://example.com/study");
    const { campaignId: campaignB } = await createCampaign(testDb.db, "B", "goal", "https://example.com/study");
    await addRecipients(testDb.db, campaignA, [{ personId: p.id }], "email");
    const [recipient] = await testDb.db.select().from(campaignRecipient);

    // Wrong campaignId for this recipient — must not delete it.
    const result = await removeRecipient(testDb.db, campaignB, recipient.id);

    expect(result.removed).toBe(false);
    expect(await testDb.db.select().from(campaignRecipient)).toHaveLength(1);
  });

  it("reports removed: false for a recipient id that doesn't exist", async () => {
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    const result = await removeRecipient(testDb.db, campaignId, 999);
    expect(result.removed).toBe(false);
  });
});

describe("deleteCampaign", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("soft-deletes the Campaign, leaving its recipients in place", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Henry" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "henry@example.com",
      displayName: "Henry",
      status: "active",
    });
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await addRecipients(testDb.db, campaignId, [{ personId: p.id }], "email");

    const result = await deleteCampaign(testDb.db, campaignId);

    expect(result.deleted).toBe(true);
    const campaignRows = await testDb.db.select().from(campaign);
    expect(campaignRows).toHaveLength(1);
    expect(campaignRows[0].deletedAt).not.toBeNull();
    // Recipients are untouched — restoring the Campaign brings them back
    // exactly as they were, with no separate per-recipient restore needed.
    expect(await testDb.db.select().from(campaignRecipient)).toHaveLength(1);
  });

  it("is idempotent — deleting an already-deleted Campaign reports deleted: false", async () => {
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await deleteCampaign(testDb.db, campaignId);
    const second = await deleteCampaign(testDb.db, campaignId);
    expect(second.deleted).toBe(false);
  });

  it("reports deleted: false for a Campaign id that doesn't exist", async () => {
    const result = await deleteCampaign(testDb.db, 999);
    expect(result.deleted).toBe(false);
  });
});

describe("restoreCampaign", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("undoes deleteCampaign", async () => {
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await deleteCampaign(testDb.db, campaignId);

    const result = await restoreCampaign(testDb.db, campaignId);

    expect(result.restored).toBe(true);
    const row = await testDb.db.query.campaign.findFirst({
      where: (c, { eq }) => eq(c.id, campaignId),
    });
    expect(row?.deletedAt).toBeNull();
  });

  it("reports restored: false for a Campaign that isn't deleted", async () => {
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    const result = await restoreCampaign(testDb.db, campaignId);
    expect(result.restored).toBe(false);
  });
});

describe("restoreRecipient", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("undoes removeRecipient", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Kate" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "kate@example.com",
      displayName: "Kate",
      status: "active",
    });
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await addRecipients(testDb.db, campaignId, [{ personId: p.id }], "email");
    const [recipient] = await testDb.db.select().from(campaignRecipient);
    await removeRecipient(testDb.db, campaignId, recipient.id);

    const result = await restoreRecipient(testDb.db, campaignId, recipient.id);

    expect(result.restored).toBe(true);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, recipient.id),
    });
    expect(row?.deletedAt).toBeNull();
  });

  it("reports restored: false for a recipient that isn't removed", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Liam" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "liam@example.com",
      displayName: "Liam",
      status: "active",
    });
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await addRecipients(testDb.db, campaignId, [{ personId: p.id }], "email");
    const [recipient] = await testDb.db.select().from(campaignRecipient);

    const result = await restoreRecipient(testDb.db, campaignId, recipient.id);
    expect(result.restored).toBe(false);
  });
});

describe("updateRecipientDraft", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function seedDraftedRecipient() {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "Nora" })
      .returning();
    await testDb.db.insert(contact).values({
      personId: p.id,
      source: "gmail",
      sourceIdentifier: "nora@example.com",
      displayName: "Nora",
      status: "active",
    });
    const { campaignId } = await createCampaign(testDb.db, "Test", "goal", "https://example.com/study");
    await addRecipients(testDb.db, campaignId, [{ personId: p.id }], "email");
    const [recipient] = await testDb.db.select().from(campaignRecipient);
    return { campaignId, recipient };
  }

  it("updates subject and body on a still-drafted recipient", async () => {
    const { campaignId, recipient } = await seedDraftedRecipient();

    const result = await updateRecipientDraft(testDb.db, campaignId, recipient.id, {
      draftSubject: "Edited subject",
      draftBody: "Edited body",
    });

    expect(result.updated).toBe(true);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, recipient.id),
    });
    expect(row?.draftSubject).toBe("Edited subject");
    expect(row?.draftBody).toBe("Edited body");
  });

  it("reports updated: false and leaves the row untouched once the recipient is no longer drafted", async () => {
    const { campaignId, recipient } = await seedDraftedRecipient();
    await testDb.db
      .update(campaignRecipient)
      .set({ status: "sent" })
      .where(eq(campaignRecipient.id, recipient.id));

    const result = await updateRecipientDraft(testDb.db, campaignId, recipient.id, {
      draftSubject: "Should not apply",
      draftBody: "Should not apply",
    });

    expect(result.updated).toBe(false);
    const row = await testDb.db.query.campaignRecipient.findFirst({
      where: (r, { eq }) => eq(r.id, recipient.id),
    });
    expect(row?.draftBody).not.toBe("Should not apply");
  });

  it("reports updated: false for the wrong campaignId", async () => {
    const { recipient } = await seedDraftedRecipient();
    const { campaignId: otherCampaignId } = await createCampaign(
      testDb.db,
      "Other",
      "goal",
      "https://example.com/study",
    );

    const result = await updateRecipientDraft(testDb.db, otherCampaignId, recipient.id, {
      draftSubject: "x",
      draftBody: "x",
    });

    expect(result.updated).toBe(false);
  });

  it("reports updated: false for a nonexistent recipient", async () => {
    const { campaignId } = await seedDraftedRecipient();

    const result = await updateRecipientDraft(testDb.db, campaignId, 999999, {
      draftSubject: "x",
      draftBody: "x",
    });

    expect(result.updated).toBe(false);
  });
});

// M27: the tagged intro-outreach track skips rankPeopleForCampaign
// entirely — the audience is exactly whoever carries the tag, an
// explicit, manually curated list — and reuses addRecipients directly.
describe("intro campaign targeting a tag", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  it("adding everyone with a given tag produces exactly one recipient per tagged person", async () => {
    const names = ["Ada", "Bob", "Carol", "Dana", "Erin"];
    const peopleIds: number[] = [];
    for (const name of names) {
      const [p] = await testDb.db.insert(person).values({ name }).returning();
      await testDb.db.insert(contact).values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: `${name.toLowerCase()}@example.com`,
        status: "active",
      });
      peopleIds.push(p.id);
    }

    // Tag exactly 2 of the 5.
    await toggleTag(testDb.db, peopleIds[0], "vip");
    await toggleTag(testDb.db, peopleIds[2], "vip");

    const { campaignId } = await createCampaign(
      testDb.db,
      "Fall intro round",
      "reconnect",
      null,
      "intro",
    );

    const taggedPersonIds = await listPersonIdsByTag(testDb.db, "vip");
    expect(taggedPersonIds).toHaveLength(2);

    const result = await addRecipients(
      testDb.db,
      campaignId,
      taggedPersonIds.map((personId) => ({ personId })),
      "email",
    );

    expect(result.added).toBe(2);
    const rows = await testDb.db
      .select()
      .from(campaignRecipient)
      .where(eq(campaignRecipient.campaignId, campaignId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.personId).sort()).toEqual(
      [peopleIds[0], peopleIds[2]].sort(),
    );
  });
});
