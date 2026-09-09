import { notFound } from "next/navigation";

import { toggleTagAction } from "@/app/actions";
import { db } from "@/db/client";
import { inferCompanyDomains } from "@/lib/company-signal";
import { listTagsForPerson } from "@/lib/person-tags";
import { buildPersonTimeline } from "@/lib/person-timeline";

export default async function PersonProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tag_error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const personId = Number(id);
  if (!Number.isInteger(personId)) {
    notFound();
  }

  const person = await db.query.person.findFirst({
    where: (p, { eq }) => eq(p.id, personId),
    with: { contacts: { with: { events: true } } },
  });
  if (!person) {
    notFound();
  }

  const companyDomains = inferCompanyDomains(person.contacts);
  const tags = await listTagsForPerson(db, personId);

  const timeline = buildPersonTimeline(person.contacts);

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <p>
        <a href="/people">Back to people</a>
      </p>
      <h1>{person.name}</h1>

      {companyDomains.length > 0 && (
        <p>
          Likely works at:{" "}
          {companyDomains.map((d) => (
            <span
              key={d}
              style={{
                background: "#eee",
                borderRadius: 4,
                padding: "0.2rem 0.5rem",
                marginRight: "0.5rem",
              }}
            >
              {d}
            </span>
          ))}
        </p>
      )}

      <h2>Tags</h2>
      {query.tag_error && (
        <p style={{ color: "crimson" }}>Failed: {query.tag_error}</p>
      )}
      <p>
        {tags.length === 0 ? (
          <span style={{ color: "#555" }}>No tags yet.</span>
        ) : (
          tags.map((tag) => (
            <span key={tag} style={{ marginRight: "0.5rem" }}>
              <span
                style={{
                  background: "#eee",
                  borderRadius: 4,
                  padding: "0.2rem 0.5rem",
                }}
              >
                {tag}
              </span>{" "}
              <form action={toggleTagAction} style={{ display: "inline" }}>
                <input type="hidden" name="personId" value={personId} />
                <input type="hidden" name="tag" value={tag} />
                <button type="submit">Remove</button>
              </form>
            </span>
          ))
        )}
      </p>
      <form action={toggleTagAction}>
        <input type="hidden" name="personId" value={personId} />
        <label>
          Add tag:{" "}
          <input type="text" name="tag" placeholder="e.g. vip" required />
        </label>
        <button type="submit">Add</button>
      </form>

      <h2>Contacts</h2>
      <ul>
        {person.contacts.map((c) => (
          <li key={c.id}>
            {c.displayName ?? "(no name)"} &lt;{c.sourceIdentifier}&gt; [
            {c.source}, {c.status}]
          </li>
        ))}
      </ul>

      <h2>Timeline ({timeline.length} event{timeline.length === 1 ? "" : "s"}, newest first)</h2>
      {timeline.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {timeline.map(({ event: e, contactEmail, contactSource }) => (
            <li
              key={e.id}
              style={{
                borderLeft: `4px solid ${e.direction === "inbound" ? "#4a90d9" : "#7ac36a"}`,
                padding: "0.5rem 1rem",
                margin: "0.5rem 0",
              }}
            >
              <div>
                <strong>{e.direction === "inbound" ? "Received from" : "Sent to"}</strong>{" "}
                {contactEmail} [{contactSource}] — {e.occurredAt.toISOString()}
              </div>
              {e.subject && <div>Subject: {e.subject}</div>}
              <div style={{ color: "#555" }}>{e.bodyText.slice(0, 200)}</div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
