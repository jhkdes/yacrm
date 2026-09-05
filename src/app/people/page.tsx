import { unmergePersonAction } from "@/app/actions";
import { db } from "@/db/client";

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ unmerged?: string; unmerge_error?: string }>;
}) {
  const params = await searchParams;

  const people = await db.query.person.findMany({
    orderBy: (personTable, { asc }) => asc(personTable.id),
    with: { contacts: { with: { events: true } } },
  });

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

      <ul style={{ listStyle: "none", padding: 0 }}>
        {people.map((p) => (
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
