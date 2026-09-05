import { db } from "@/db/client";
import { rankPeopleForCampaign } from "@/lib/campaign-ranking";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ goal?: string; error?: string; sent?: string }>;
}) {
  const params = await searchParams;
  const goal = params.goal?.trim();

  let results: Awaited<ReturnType<typeof rankPeopleForCampaign>> = [];
  let error: string | null = params.error ?? null;
  if (goal && !error) {
    try {
      results = await rankPeopleForCampaign(db, goal);
    } catch (err) {
      error = err instanceof Error ? err.message : "unknown_error";
    }
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Campaign targeting</h1>
      <p>
        <a href="/people">Back to people</a>
      </p>

      <form action="/campaigns" method="GET">
        <label>
          Campaign goal:{" "}
          <input
            type="text"
            name="goal"
            defaultValue={goal}
            placeholder="e.g. hiring a senior backend engineer"
            style={{ width: "28rem" }}
            required
          />
        </label>
        <button type="submit">Rank people</button>
      </form>

      {params.sent && (
        <p style={{ color: "green" }}>
          Sent to {params.sent} and recorded on their timeline.
        </p>
      )}

      {error && (
        <p style={{ color: "crimson" }}>Ranking failed: {error}</p>
      )}

      {goal && !error && (
        <>
          <h2>Top {results.length} for &quot;{goal}&quot;</h2>
          {results.length === 0 ? (
            <p>
              No eligible People yet — this needs Contacts with an active
              status and an Event embedding (see M11). Run an import and make
              sure VOYAGE_API_KEY is set.
            </p>
          ) : (
            <ol>
              {results.map((r) => (
                <li key={r.personId} style={{ margin: "0.5rem 0" }}>
                  <a href={`/people/${r.personId}`}>{r.name}</a> — score{" "}
                  {r.score.toFixed(3)} (similarity {r.similarity.toFixed(2)},
                  recency {r.recencyScore.toFixed(2)}, engagement{" "}
                  {r.engagementScore.toFixed(2)}, {r.eventCount} event
                  {r.eventCount === 1 ? "" : "s"}, last{" "}
                  {r.lastEventAt.toISOString().slice(0, 10)}) —{" "}
                  <a
                    href={`/campaigns/draft?personId=${r.personId}&goal=${encodeURIComponent(goal)}`}
                  >
                    Draft outreach
                  </a>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </main>
  );
}
