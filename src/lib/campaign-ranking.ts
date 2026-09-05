import { and, eq, isNotNull, sql } from "drizzle-orm";

import { contact, event, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { generateEmbeddings } from "@/lib/embeddings";

// Semantic relevance is the primary signal — REQUIREMENTS.md is explicit
// that recency/engagement are secondary weighting, not gates. Recency and
// engagement mostly act as tie-breakers between similarly-relevant People.
const DEFAULT_WEIGHTS = {
  similarity: 0.6,
  recency: 0.25,
  engagement: 0.15,
};

// Exponential decay: a Person last contacted `HALF_LIFE_DAYS` ago scores
// ~0.5, one half-life further back ~0.25, and so on. Never quite reaches 0,
// so a highly relevant but long-dormant contact can still surface.
const RECENCY_HALF_LIFE_DAYS = 90;

// Log-scaled so engagement rewards going from 1 to a few exchanges much more
// than from 20 to 40 — a handful of real messages is already meaningfully
// "engaged"; nobody is 10x more of a target for having 200 emails instead of
// 20.
const ENGAGEMENT_SATURATION_COUNT = 20;

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeRecencyScore(daysSinceLastEvent: number): number {
  // exp(-t/halfLife) alone is an e-folding decay (~0.368 at t=halfLife, not
  // 0.5) — the ln(2) factor is what makes this an actual half-life.
  return Math.exp(
    (-Math.LN2 * Math.max(daysSinceLastEvent, 0)) / RECENCY_HALF_LIFE_DAYS,
  );
}

export function computeEngagementScore(eventCount: number): number {
  if (eventCount <= 0) return 0;
  return Math.min(
    1,
    Math.log(eventCount + 1) / Math.log(ENGAGEMENT_SATURATION_COUNT + 1),
  );
}

export interface CampaignScoreInput {
  similarity: number;
  recencyScore: number;
  engagementScore: number;
}

export function computeCampaignScore(
  input: CampaignScoreInput,
  weights: typeof DEFAULT_WEIGHTS = DEFAULT_WEIGHTS,
): number {
  return (
    input.similarity * weights.similarity +
    input.recencyScore * weights.recency +
    input.engagementScore * weights.engagement
  );
}

export interface PersonForRanking {
  personId: number;
  name: string;
  summaryEmbedding: number[];
  lastEventAt: Date;
  eventCount: number;
}

export interface CampaignRankingEntry {
  personId: number;
  name: string;
  score: number;
  similarity: number;
  recencyScore: number;
  engagementScore: number;
  lastEventAt: Date;
  eventCount: number;
}

// The testable core: given an already-computed campaign embedding and a
// list of candidate People, ranks them. Kept separate from the embedding
// API call and DB query (see rankPeopleForCampaign) so this can be unit
// tested with hand-crafted vectors instead of hitting a real embeddings API.
export function rankPeopleByEmbedding(
  campaignEmbedding: number[],
  candidates: PersonForRanking[],
  now: Date = new Date(),
): CampaignRankingEntry[] {
  return candidates
    .map((candidate) => {
      const similarity = cosineSimilarity(
        campaignEmbedding,
        candidate.summaryEmbedding,
      );
      const daysSinceLastEvent =
        (now.getTime() - candidate.lastEventAt.getTime()) /
        (1000 * 60 * 60 * 24);
      const recencyScore = computeRecencyScore(daysSinceLastEvent);
      const engagementScore = computeEngagementScore(candidate.eventCount);

      return {
        personId: candidate.personId,
        name: candidate.name,
        score: computeCampaignScore({
          similarity,
          recencyScore,
          engagementScore,
        }),
        similarity,
        recencyScore,
        engagementScore,
        lastEventAt: candidate.lastEventAt,
        eventCount: candidate.eventCount,
      };
    })
    .sort((a, b) => b.score - a.score);
}

// Only People with at least one *active* Contact are eligible — pending
// (one-way-only) contacts aren't confirmed personal relationships yet, so
// they shouldn't be surfaced as outreach targets even if they happen to
// have a summary embedding.
async function loadCandidates(db: DrizzleDb): Promise<PersonForRanking[]> {
  const rows = await db
    .select({
      personId: person.id,
      name: person.name,
      summaryEmbedding: person.summaryEmbedding,
      lastEventAt: sql<string>`max(${event.occurredAt})`,
      eventCount: sql<number>`count(${event.id})`,
    })
    .from(person)
    .innerJoin(
      contact,
      and(eq(contact.personId, person.id), eq(contact.status, "active")),
    )
    .innerJoin(event, eq(event.contactId, contact.id))
    .where(isNotNull(person.summaryEmbedding))
    .groupBy(person.id, person.name, person.summaryEmbedding);

  return rows.map((row) => ({
    personId: row.personId,
    name: row.name,
    summaryEmbedding: row.summaryEmbedding!,
    lastEventAt: new Date(row.lastEventAt),
    eventCount: Number(row.eventCount),
  }));
}

// Loads eligible People from the DB and ranks them against an
// already-computed campaign embedding — the piece that's testable against a
// real (test) DB without needing the real embeddings API, since the
// embedding itself is just an input.
export async function rankPeopleByCampaignEmbedding(
  db: DrizzleDb,
  campaignEmbedding: number[],
  limit = 20,
): Promise<CampaignRankingEntry[]> {
  const candidates = await loadCandidates(db);
  return rankPeopleByEmbedding(campaignEmbedding, candidates).slice(0, limit);
}

// Full pipeline: embeds the campaign goal via the real Voyage API, then
// ranks. Not unit tested directly (real network call) — see
// rankPeopleByCampaignEmbedding for the tested DB/ranking logic and
// scripts/rank-campaign.ts for real-data verification.
export async function rankPeopleForCampaign(
  db: DrizzleDb,
  campaignGoal: string,
  limit = 20,
): Promise<CampaignRankingEntry[]> {
  const [campaignEmbedding] = await generateEmbeddings([campaignGoal]);
  return rankPeopleByCampaignEmbedding(db, campaignEmbedding, limit);
}
