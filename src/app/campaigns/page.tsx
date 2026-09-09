import {
  addRecipientsToCampaignAction,
  createCampaignAction,
  createIntroCampaignAction,
  deleteCampaignAction,
  restoreCampaignAction,
} from "@/app/actions";
import { db } from "@/db/client";
import { rankPeopleForCampaign } from "@/lib/campaign-ranking";
import { listDistinctTags, listPersonIdsByTag } from "@/lib/person-tags";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{
    goal?: string;
    error?: string;
    sent?: string;
    campaignId?: string;
    campaign_deleted?: string;
    // Present only on the redirect immediately after a delete — drives a
    // one-shot "Undo" link that's gone the moment you navigate elsewhere.
    undo_campaign_id?: string;
    tag?: string;
  }>;
}) {
  const params = await searchParams;
  const goal = params.goal?.trim();
  const tag = params.tag?.trim();

  // Present when arriving via a campaign's "Add more people" link — targets
  // this ranking pass at an existing Campaign instead of creating a new one.
  const targetCampaignId = params.campaignId
    ? Number(params.campaignId)
    : null;
  const targetCampaign =
    targetCampaignId && Number.isInteger(targetCampaignId)
      ? await db.query.campaign.findFirst({
          where: (c, { eq, and, isNull }) =>
            and(eq(c.id, targetCampaignId), isNull(c.deletedAt)),
        })
      : null;

  let results: Awaited<ReturnType<typeof rankPeopleForCampaign>> = [];
  let error: string | null = params.error ?? null;
  if (goal && !error) {
    try {
      results = await rankPeopleForCampaign(db, goal);
    } catch (err) {
      error = err instanceof Error ? err.message : "unknown_error";
    }
  }

  const existingCampaigns = await db.query.campaign.findMany({
    where: (c, { isNull }) => isNull(c.deletedAt),
    orderBy: (c, { desc }) => desc(c.createdAt),
    with: { recipients: { where: (r, { isNull }) => isNull(r.deletedAt) } },
  });

  const distinctTags = await listDistinctTags(db);
  const taggedPersonIds = tag ? await listPersonIdsByTag(db, tag) : [];
  const taggedPeople = taggedPersonIds.length
    ? await db.query.person.findMany({
        where: (p, { inArray }) => inArray(p.id, taggedPersonIds),
      })
    : [];

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Campaigns</h1>
      <p>
        <a href="/people">Back to people</a>
      </p>

      {params.campaign_deleted && (
        <div style={{ color: "green" }}>
          Campaign deleted.{" "}
          {params.undo_campaign_id && (
            <form
              action={restoreCampaignAction}
              style={{ display: "inline" }}
            >
              <input
                type="hidden"
                name="campaignId"
                value={params.undo_campaign_id}
              />
              <button type="submit">Undo</button>
            </form>
          )}
        </div>
      )}

      {existingCampaigns.length > 0 && (
        <>
          <h2>Existing campaigns</h2>
          <ul>
            {existingCampaigns.map((c) => (
              <li key={c.id}>
                <a href={`/campaigns/${c.id}`}>{c.name}</a> — {c.type},{" "}
                {c.recipients.length} recipient
                {c.recipients.length === 1 ? "" : "s"}{" "}
                <form
                  action={deleteCampaignAction}
                  style={{ display: "inline" }}
                >
                  <input type="hidden" name="campaignId" value={c.id} />
                  <button type="submit">Delete</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>New campaign — target people</h2>
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

      <h2>New campaign — target a tag</h2>
      {distinctTags.length === 0 ? (
        <p style={{ color: "#555" }}>
          No tags yet — add one from a person&apos;s profile page first.
        </p>
      ) : (
        <form action="/campaigns" method="GET">
          <label>
            Tag:{" "}
            <select name="tag" defaultValue={tag ?? ""}>
              <option value="" disabled>
                Select a tag
              </option>
              {distinctTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">View people</button>
        </form>
      )}

      {tag && (
        <>
          <h3>
            {taggedPeople.length} {taggedPeople.length === 1 ? "person" : "people"}{" "}
            tagged &quot;{tag}&quot;
          </h3>
          {taggedPeople.length === 0 ? (
            <p>Nobody carries this tag.</p>
          ) : (
            <form action={createIntroCampaignAction}>
              <input type="hidden" name="tag" value={tag} />
              <ul>
                {taggedPeople.map((p) => (
                  <li key={p.id}>
                    <a href={`/people/${p.id}`}>{p.name}</a>
                  </li>
                ))}
              </ul>
              <p>
                <label>
                  Campaign name:{" "}
                  <input
                    type="text"
                    name="name"
                    placeholder="e.g. Fall intro round"
                    style={{ width: "24rem" }}
                    required
                  />
                </label>
              </p>
              <p>
                <label>
                  Campaign goal (used to draft each message):{" "}
                  <input
                    type="text"
                    name="goal"
                    placeholder="e.g. reconnect and see how they're doing"
                    style={{ width: "28rem" }}
                    required
                  />
                </label>
              </p>
              <p>
                <label>
                  Send via:{" "}
                  <select name="channel" defaultValue="email">
                    <option value="email">Email</option>
                    <option value="linkedin">LinkedIn (copy-assist queue)</option>
                  </select>
                </label>
              </p>
              <button type="submit">
                Create intro campaign for everyone tagged &quot;{tag}&quot;
              </button>
            </form>
          )}
        </>
      )}

      {params.sent && (
        <p style={{ color: "green" }}>
          Sent to {params.sent} and recorded on their timeline.
        </p>
      )}

      {error && (
        <p style={{ color: "crimson" }}>
          {tag ? "Campaign creation failed" : "Ranking failed"}: {error}
        </p>
      )}

      {goal && !error && (
        <>
          <h2>Top {results.length} for &quot;{goal}&quot;</h2>
          {targetCampaignId && !targetCampaign && (
            <p style={{ color: "crimson" }}>
              Campaign {targetCampaignId} not found — targeting will create a
              new campaign instead.
            </p>
          )}
          {targetCampaign && (
            <p>
              Adding to existing campaign: <strong>{targetCampaign.name}</strong>{" "}
              (<a href={`/campaigns/${targetCampaign.id}`}>view</a>)
            </p>
          )}
          {results.length === 0 ? (
            <p>
              No eligible People yet — this needs Contacts with an active
              status and an Event embedding (see M11). Run an import and make
              sure VOYAGE_API_KEY is set.
            </p>
          ) : (
            <form
              action={
                targetCampaign
                  ? addRecipientsToCampaignAction
                  : createCampaignAction
              }
            >
              {targetCampaign ? (
                <input
                  type="hidden"
                  name="campaignId"
                  value={targetCampaign.id}
                />
              ) : (
                <input type="hidden" name="goal" value={goal} />
              )}
              <ol>
                {results.map((r) => (
                  <li key={r.personId} style={{ margin: "0.5rem 0" }}>
                    <label>
                      <input
                        type="checkbox"
                        name="personIds"
                        value={r.personId}
                      />{" "}
                      <a href={`/people/${r.personId}`}>{r.name}</a>
                    </label>{" "}
                    — score {r.score.toFixed(3)} (similarity{" "}
                    {r.similarity.toFixed(2)}, recency{" "}
                    {r.recencyScore.toFixed(2)}, engagement{" "}
                    {r.engagementScore.toFixed(2)}, {r.eventCount} event
                    {r.eventCount === 1 ? "" : "s"}, last{" "}
                    {r.lastEventAt.toISOString().slice(0, 10)}) —{" "}
                    <a
                      href={`/campaigns/draft?personId=${r.personId}&goal=${encodeURIComponent(goal)}`}
                    >
                      Draft one-off outreach
                    </a>
                  </li>
                ))}
              </ol>

              {!targetCampaign && (
                <>
                  <p>
                    <label>
                      Campaign name:{" "}
                      <input
                        type="text"
                        name="name"
                        placeholder="e.g. AI interview outreach — Sept"
                        style={{ width: "24rem" }}
                        required
                      />
                    </label>
                  </p>
                  <p>
                    <label>
                      Destination link (where a recipient&apos;s tracked link
                      sends them, e.g. the AI interview study URL):{" "}
                      <input
                        type="url"
                        name="destinationUrl"
                        placeholder="https://..."
                        style={{ width: "24rem" }}
                        required
                      />
                    </label>
                  </p>
                </>
              )}
              <p>
                <label>
                  Send via:{" "}
                  <select name="channel" defaultValue="email">
                    <option value="email">Email</option>
                    <option value="linkedin">LinkedIn (copy-assist queue)</option>
                  </select>
                </label>
              </p>
              <button type="submit">
                {targetCampaign
                  ? `Add checked people to ${targetCampaign.name}`
                  : "Create campaign from checked people"}
              </button>
            </form>
          )}
        </>
      )}
    </main>
  );
}
