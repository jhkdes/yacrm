import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contact, EMBEDDING_DIMENSIONS, event, person } from "@/db/schema";
import { createTestDb } from "@/db/test-utils";

import {
  computeCampaignScore,
  computeEngagementScore,
  computeRecencyScore,
  cosineSimilarity,
  rankPeopleByCampaignEmbedding,
  rankPeopleByEmbedding,
  type PersonForRanking,
} from "./campaign-ranking";

function pad(vector: number[]): number[] {
  return [...vector, ...Array(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
}

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for a zero vector rather than NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("computeRecencyScore", () => {
  it("scores a just-now event at (almost) 1", () => {
    expect(computeRecencyScore(0)).toBeCloseTo(1);
  });

  it("scores an event one half-life (90 days) ago at ~0.5", () => {
    expect(computeRecencyScore(90)).toBeCloseTo(0.5, 1);
  });

  it("scores a more recent event higher than an older one", () => {
    expect(computeRecencyScore(10)).toBeGreaterThan(computeRecencyScore(200));
  });

  it("never scores below 0, even for events far in the future (clock skew)", () => {
    expect(computeRecencyScore(-5)).toBeLessThanOrEqual(1);
  });
});

describe("computeEngagementScore", () => {
  it("scores zero events at 0", () => {
    expect(computeEngagementScore(0)).toBe(0);
  });

  it("scores more events higher, but with diminishing returns", () => {
    const delta1to5 = computeEngagementScore(5) - computeEngagementScore(1);
    const delta20to24 =
      computeEngagementScore(24) - computeEngagementScore(20);
    expect(delta1to5).toBeGreaterThan(delta20to24);
  });

  it("caps at 1 for very high counts", () => {
    expect(computeEngagementScore(1000)).toBeLessThanOrEqual(1);
  });
});

describe("computeCampaignScore", () => {
  it("weights similarity most heavily by default", () => {
    const highSimilarity = computeCampaignScore({
      similarity: 1,
      recencyScore: 0,
      engagementScore: 0,
    });
    const highRecencyAndEngagement = computeCampaignScore({
      similarity: 0,
      recencyScore: 1,
      engagementScore: 1,
    });
    expect(highSimilarity).toBeGreaterThan(highRecencyAndEngagement);
  });
});

describe("rankPeopleByEmbedding", () => {
  it("ranks on-topic People above off-topic People for a sample campaign goal", () => {
    // Campaign: "hiring a senior backend engineer"
    const campaignEmbedding = [1, 0, 0];

    const candidates: PersonForRanking[] = [
      {
        personId: 1,
        name: "On-topic: talked about backend engineering roles",
        summaryEmbedding: [0.95, 0.1, 0],
        lastEventAt: new Date(),
        eventCount: 5,
      },
      {
        personId: 2,
        name: "Off-topic: talked about a birthday party",
        summaryEmbedding: [0, 0, 1],
        lastEventAt: new Date(),
        eventCount: 5,
      },
      {
        personId: 3,
        name: "On-topic: talked about engineering hiring",
        summaryEmbedding: [0.9, 0.2, 0],
        lastEventAt: new Date(),
        eventCount: 5,
      },
    ];

    const ranked = rankPeopleByEmbedding(campaignEmbedding, candidates);

    expect(ranked.map((r) => r.personId)).toEqual([1, 3, 2]);
    expect(ranked[0].score).toBeGreaterThan(ranked[2].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it("lets recency/engagement break ties between similarly on-topic People", () => {
    const campaignEmbedding = [1, 0];
    const now = new Date("2026-06-01");

    const candidates: PersonForRanking[] = [
      {
        personId: 1,
        name: "Recent and engaged",
        summaryEmbedding: [1, 0],
        lastEventAt: new Date("2026-05-30"),
        eventCount: 10,
      },
      {
        personId: 2,
        name: "Same topic, but dormant for a year",
        summaryEmbedding: [1, 0],
        lastEventAt: new Date("2025-06-01"),
        eventCount: 1,
      },
    ];

    const ranked = rankPeopleByEmbedding(campaignEmbedding, candidates, now);

    expect(ranked.map((r) => r.personId)).toEqual([1, 2]);
    // Same similarity, so the whole score gap comes from recency/engagement.
    expect(ranked[0].similarity).toBeCloseTo(ranked[1].similarity);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

});

describe("rankPeopleByCampaignEmbedding", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.client.close();
  });

  async function seedPerson(options: {
    name: string;
    status: "active" | "pending";
    embedding: number[];
    eventEmbedding?: number[];
  }) {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: options.name, summaryEmbedding: options.embedding })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: `${options.name}@example.com`,
        status: options.status,
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: c.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "hi",
      sourceMessageId: `msg-${options.name}`,
      embedding: options.eventEmbedding ?? options.embedding,
    });
    return p;
  }

  it("excludes People whose only Contact is pending (not yet a confirmed relationship)", async () => {
    const active = await seedPerson({
      name: "active-person",
      status: "active",
      embedding: pad([1, 0]),
    });
    await seedPerson({
      name: "pending-person",
      status: "pending",
      embedding: pad([1, 0]),
    });

    const ranked = await rankPeopleByCampaignEmbedding(
      testDb.db,
      pad([1, 0]),
    );

    expect(ranked.map((r) => r.personId)).toEqual([active.id]);
  });

  it("excludes People with no summary embedding", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "no-embedding" })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "no-embedding@example.com",
        status: "active",
      })
      .returning();
    await testDb.db.insert(event).values({
      contactId: c.id,
      direction: "inbound",
      occurredAt: new Date(),
      bodyText: "hi",
      sourceMessageId: "msg-1",
    });

    const ranked = await rankPeopleByCampaignEmbedding(
      testDb.db,
      pad([1, 0]),
    );

    expect(ranked).toHaveLength(0);
  });

  it("counts Events and finds the most recent occurredAt via real SQL aggregation", async () => {
    const [p] = await testDb.db
      .insert(person)
      .values({ name: "multi-event", summaryEmbedding: pad([1, 0]) })
      .returning();
    const [c] = await testDb.db
      .insert(contact)
      .values({
        personId: p.id,
        source: "gmail",
        sourceIdentifier: "multi@example.com",
        status: "active",
      })
      .returning();
    await testDb.db.insert(event).values([
      {
        contactId: c.id,
        direction: "inbound",
        occurredAt: new Date("2026-01-01"),
        bodyText: "old",
        sourceMessageId: "msg-old",
        embedding: pad([1, 0]),
      },
      {
        contactId: c.id,
        direction: "outbound",
        occurredAt: new Date("2026-03-01"),
        bodyText: "new",
        sourceMessageId: "msg-new",
        embedding: pad([1, 0]),
      },
    ]);

    const ranked = await rankPeopleByCampaignEmbedding(
      testDb.db,
      pad([1, 0]),
    );

    expect(ranked[0].eventCount).toBe(2);
    expect(ranked[0].lastEventAt.toISOString().slice(0, 10)).toBe(
      "2026-03-01",
    );
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedPerson({
        name: `person-${i}`,
        status: "active",
        embedding: pad([1, 0]),
      });
    }

    const ranked = await rankPeopleByCampaignEmbedding(
      testDb.db,
      pad([1, 0]),
      2,
    );

    expect(ranked).toHaveLength(2);
  });
});
