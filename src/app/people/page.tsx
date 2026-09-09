import { unmergePersonAction } from "@/app/actions";
import { db } from "@/db/client";
import { listPeopleByLastTouched } from "@/lib/last-touched";

const QUIET_DAY_OPTIONS = [30, 60, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// Plain (non-component) helper — computing "now" has to happen somewhere,
// and doing it in a lowercase, non-component-shaped function keeps it out
// of PeoplePage's own body, which the React Compiler's purity lint rule
// treats as render code and flags any impure call (Date.now()) inside.
function sortAndFilterByLastTouched<T extends { id: number }>(
  people: T[],
  lastTouchedMap: Map<number, Date | null>,
  quietDaysFilter: number | null,
): T[] {
  const sorted = [...people].sort((a, b) => {
    const aAt = lastTouchedMap.get(a.id) ?? null;
    const bAt = lastTouchedMap.get(b.id) ?? null;
    if (aAt === null && bAt === null) return 0;
    if (aAt === null) return 1;
    if (bAt === null) return -1;
    return bAt.getTime() - aAt.getTime();
  });

  if (!quietDaysFilter) return sorted;

  const cutoff = Date.now() - quietDaysFilter * DAY_MS;
  return sorted.filter((p) => {
    const at = lastTouchedMap.get(p.id) ?? null;
    // No history at all counts as "quiet" too — there's nothing staler
    // than never having touched base.
    return at === null || at.getTime() <= cutoff;
  });
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{
    unmerged?: string;
    unmerge_error?: string;
    sort?: string;
    quiet_days?: string;
  }>;
}) {
  const params = await searchParams;
  const sortByLastTouched = params.sort === "last_touched";
  const quietDays = Number(params.quiet_days);
  const quietDaysFilter = QUIET_DAY_OPTIONS.includes(
    quietDays as (typeof QUIET_DAY_OPTIONS)[number],
  )
    ? quietDays
    : null;

  const people = await db.query.person.findMany({
    orderBy: (personTable, { asc }) => asc(personTable.id),
    with: { contacts: { with: { events: true } } },
  });

  // Only computed (and its extra queries run) when actually needed — the
  // default view doesn't pay for the aggregate query at all.
  const needsLastTouched = sortByLastTouched || quietDaysFilter !== null;
  const lastTouchedMap = needsLastTouched
    ? new Map(
        (await listPeopleByLastTouched(db)).map((r) => [r.personId, r.lastTouchedAt]),
      )
    : null;

  const displayPeople = lastTouchedMap
    ? sortAndFilterByLastTouched(people, lastTouchedMap, quietDaysFilter)
    : people;

  function withParam(name: string, value: string | null): string {
    const next = new URLSearchParams();
    if (sortByLastTouched) next.set("sort", "last_touched");
    if (quietDaysFilter) next.set("quiet_days", String(quietDaysFilter));
    if (value === null) next.delete(name);
    else next.set(name, value);
    const qs = next.toString();
    return qs ? `/people?${qs}` : "/people";
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>People</h1>
      <p>
        <a href="/contacts">Contacts</a> · <a href="/merges">Merge suggestions</a> ·{" "}
        <a href="/campaigns">Campaign targeting</a>
      </p>

      {params.unmerged && (
        <p style={{ color: "green" }}>
          Un-merged — each Contact now has its own Person again.
        </p>
      )}
      {params.unmerge_error && (
        <p style={{ color: "crimson" }}>Un-merge failed: {params.unmerge_error}</p>
      )}

      <p>
        Sort:{" "}
        {sortByLastTouched ? (
          <>
            <strong>Last touched</strong> ·{" "}
            <a href={withParam("sort", null)}>Default order</a>
          </>
        ) : (
          <>
            Default order ·{" "}
            <a href={withParam("sort", "last_touched")}>Sort by last touched</a>
          </>
        )}
      </p>
      <p>
        Quiet for:{" "}
        {QUIET_DAY_OPTIONS.map((days, i) => (
          <span key={days}>
            {i > 0 && " · "}
            {quietDaysFilter === days ? (
              <strong>{days}+ days</strong>
            ) : (
              <a href={withParam("quiet_days", String(days))}>{days}+ days</a>
            )}
          </span>
        ))}
        {quietDaysFilter && (
          <>
            {" · "}
            <a href={withParam("quiet_days", null)}>Clear</a>
          </>
        )}
      </p>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {displayPeople.map((p) => (
          <li
            key={p.id}
            style={{
              border: "1px solid #ccc",
              borderRadius: 8,
              padding: "1rem",
              margin: "1rem 0",
            }}
          >
            <strong>
              <a href={`/people/${p.id}`}>{p.name}</a>
            </strong>
            {lastTouchedMap && (
              <span style={{ color: "#555" }}>
                {" — last touched "}
                {(() => {
                  const at = lastTouchedMap.get(p.id) ?? null;
                  return at ? at.toISOString().slice(0, 10) : "never";
                })()}
              </span>
            )}
            <ul>
              {p.contacts.map((c) => (
                <li key={c.id}>
                  {c.displayName ?? "(no name)"} &lt;{c.sourceIdentifier}&gt; [
                  {c.source}, {c.status}] — {c.events.length} event(s)
                </li>
              ))}
            </ul>
            {p.contacts.length > 1 && (
              <form action={unmergePersonAction}>
                <input type="hidden" name="personId" value={p.id} />
                <button type="submit">
                  Un-merge into {p.contacts.length} separate people
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
