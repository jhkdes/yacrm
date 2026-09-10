import {
  addRecipientsToCampaignAction,
  createCampaignAction,
  createIntroCampaignAction,
  deleteCampaignAction,
  draftFilterAction,
  restoreCampaignAction,
} from "@/app/actions";
import { db } from "@/db/client";
import { companyIndustryEnum, personFunctionEnum, personSeniorityEnum } from "@/db/schema";
import {
  BROAD_RESULT_THRESHOLD,
  buildCandidateSortUrl,
  filterCandidates,
  sortFilterResults,
  type FilterResult,
  type SortField,
} from "@/lib/candidate-filter";
import { listDistinctTags, listPersonIdsByTag } from "@/lib/person-tags";

import { CandidateDrawerTrigger } from "./CandidateDrawerTrigger";

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const SORT_FIELDS: SortField[] = [
  "name",
  "title",
  "company",
  "seniority",
  "function",
  "industry",
  "lastInteraction",
];

function isSortField(value: string | undefined): value is SortField {
  return value !== undefined && (SORT_FIELDS as string[]).includes(value);
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{
    title?: string;
    seniority?: string | string[];
    function?: string | string[];
    industry?: string | string[];
    goal?: string;
    sort?: string;
    dir?: string;
    error?: string;
    sent?: string;
    campaignId?: string;
    campaign_deleted?: string;
    undo_campaign_id?: string;
    tag?: string;
  }>;
}) {
  const params = await searchParams;
  const tag = params.tag?.trim();

  // Present when arriving via a campaign's "Add more people" link — targets
  // this filter pass at an existing Campaign instead of creating a new one.
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

  const seniorityValues = toArray(params.seniority) as (typeof personSeniorityEnum.enumValues)[number][];
  const functionValues = toArray(params.function) as (typeof personFunctionEnum.enumValues)[number][];
  const industryValues = toArray(params.industry) as (typeof companyIndustryEnum.enumValues)[number][];
  const titleQuery = params.title?.trim();

  // A submitted filter form always includes `title` (even empty — a plain
  // text input serializes regardless of value), so its presence in the URL
  // is a reliable "the form was submitted" signal distinct from "no
  // criteria chosen" (an empty filter is valid — it just means everyone
  // eligible). Arriving via "Add more people" runs the filter immediately
  // too, matching the old goal-ranking page's arrive-and-see-results flow.
  const shouldFilter = params.title !== undefined || Boolean(targetCampaign);

  let results: FilterResult[] = [];
  let error: string | null = params.error ?? null;
  if (shouldFilter && !error) {
    try {
      results = await filterCandidates(db, {
        titleQuery,
        seniority: seniorityValues.length ? seniorityValues : undefined,
        function: functionValues.length ? functionValues : undefined,
        industry: industryValues.length ? industryValues : undefined,
      });
      if (isSortField(params.sort)) {
        results = sortFilterResults(results, params.sort, params.dir === "desc" ? "desc" : "asc");
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "unknown_error";
    }
  }

  // Preserves every current filter/goal/campaignId param, only changing
  // sort/dir — same link-driven pattern as M26's /people sort links. A
  // second click on the already-active column flips direction instead of
  // resetting to ascending.
  function buildSortUrl(field: SortField): string {
    return buildCandidateSortUrl(
      {
        title: params.title,
        seniority: seniorityValues,
        function: functionValues,
        industry: industryValues,
        goal: params.goal,
        campaignId: targetCampaignId,
        currentSort: params.sort,
        currentDir: params.dir,
      },
      field,
    );
  }

  function sortIndicator(field: SortField): string {
    if (params.sort !== field) return "";
    return params.dir === "desc" ? " ▼" : " ▲";
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

      <h3>Draft a filter from your goal (optional)</h3>
      <form action={draftFilterAction} style={{ marginBottom: "1rem" }}>
        {targetCampaignId && (
          <input type="hidden" name="campaignId" value={targetCampaignId} />
        )}
        <label>
          Campaign goal:{" "}
          <input
            type="text"
            name="goal"
            defaultValue={params.goal ?? ""}
            placeholder="e.g. hiring enterprise PMs at mid-size B2B software companies"
            style={{ width: "28rem" }}
            required
          />
        </label>{" "}
        <button type="submit">Draft filter</button>
        <p style={{ color: "#555", margin: "0.25rem 0 0" }}>
          Drafts the checkboxes below from your goal — review and edit them
          before creating the campaign. This doesn&apos;t target people
          directly; it just pre-fills the filter.
        </p>
      </form>

      <form action="/campaigns" method="GET">
        {targetCampaignId && (
          <input type="hidden" name="campaignId" value={targetCampaignId} />
        )}
        <p>
          <label>
            Title contains:{" "}
            <input
              type="text"
              name="title"
              defaultValue={params.title ?? ""}
              placeholder="e.g. product manager"
              style={{ width: "20rem" }}
            />
          </label>
        </p>
        <fieldset style={{ marginBottom: "0.75rem" }}>
          <legend>Seniority</legend>
          {personSeniorityEnum.enumValues.map((v) => (
            <label key={v} style={{ marginRight: "1rem" }}>
              <input
                type="checkbox"
                name="seniority"
                value={v}
                defaultChecked={seniorityValues.includes(v)}
              />{" "}
              {v}
            </label>
          ))}
        </fieldset>
        <fieldset style={{ marginBottom: "0.75rem" }}>
          <legend>Function</legend>
          {personFunctionEnum.enumValues.map((v) => (
            <label key={v} style={{ marginRight: "1rem" }}>
              <input
                type="checkbox"
                name="function"
                value={v}
                defaultChecked={functionValues.includes(v)}
              />{" "}
              {v}
            </label>
          ))}
        </fieldset>
        <fieldset style={{ marginBottom: "0.75rem" }}>
          <legend>Industry</legend>
          <div
            style={{
              maxHeight: "10rem",
              overflowY: "auto",
              border: "1px solid #ccc",
              padding: "0.5rem",
              width: "24rem",
            }}
          >
            {companyIndustryEnum.enumValues.map((v) => (
              <label key={v} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  name="industry"
                  value={v}
                  defaultChecked={industryValues.includes(v)}
                />{" "}
                {v}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit">Filter people</button>
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
          {tag ? "Campaign creation failed" : "Filtering failed"}: {error}
        </p>
      )}

      {shouldFilter && !error && (
        <>
          <h2>{results.length} matching people</h2>
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
              No eligible people match this filter. Eligibility requires an
              active LinkedIn contact — try loosening the filter, or import
              more connections first.
            </p>
          ) : (
            <>
              {results.length > BROAD_RESULT_THRESHOLD && (
                <p style={{ color: "#a15c00" }}>
                  {results.length} matches is a lot to review by hand —
                  consider narrowing the filter above.
                </p>
              )}
            <form
              action={
                targetCampaign
                  ? addRecipientsToCampaignAction
                  : createCampaignAction
              }
            >
              {targetCampaign && (
                <input
                  type="hidden"
                  name="campaignId"
                  value={targetCampaign.id}
                />
              )}
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th></th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                        <a href={buildSortUrl("name")}>Name{sortIndicator("name")}</a>
                      </th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                        <a href={buildSortUrl("title")}>Title{sortIndicator("title")}</a>
                      </th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                        <a href={buildSortUrl("company")}>Company{sortIndicator("company")}</a>
                      </th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                        <a href={buildSortUrl("seniority")}>Seniority{sortIndicator("seniority")}</a>
                      </th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                        <a href={buildSortUrl("function")}>Function{sortIndicator("function")}</a>
                      </th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                        <a href={buildSortUrl("industry")}>Industry{sortIndicator("industry")}</a>
                      </th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                        <a href={buildSortUrl("lastInteraction")}>
                          Last interaction{sortIndicator("lastInteraction")}
                        </a>
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.personId} style={{ borderTop: "1px solid #eee" }}>
                        <td style={{ padding: "0.25rem 0.5rem" }}>
                          <input type="checkbox" name="personIds" value={r.personId} />
                        </td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>
                          <a href={`/people/${r.personId}`}>{r.name}</a>
                        </td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>{r.standardizedTitle ?? "—"}</td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>{r.company ?? "—"}</td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>{r.seniority ?? "—"}</td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>{r.function ?? "—"}</td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>{r.industry ?? "—"}</td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>
                          {r.lastInteractionAt ? r.lastInteractionAt.toISOString().slice(0, 10) : "—"}
                        </td>
                        <td style={{ padding: "0.25rem 0.5rem" }}>
                          <CandidateDrawerTrigger
                            name={r.name}
                            standardizedTitle={r.standardizedTitle}
                            company={r.company}
                            seniority={r.seniority}
                            function={r.function}
                            industry={r.industry}
                            lastInteractionAt={r.lastInteractionAt}
                            linkedinProfileUrl={r.linkedinProfileUrl}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

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
                      Campaign goal (used to draft each message, not for
                      targeting):{" "}
                      <input
                        type="text"
                        name="goal"
                        defaultValue={params.goal ?? ""}
                        placeholder="e.g. inviting them to try our AI interview study"
                        style={{ width: "28rem" }}
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
            </>
          )}
        </>
      )}

      <p>
        <a href="/contacts">View contacts</a>
      </p>
    </main>
  );
}
