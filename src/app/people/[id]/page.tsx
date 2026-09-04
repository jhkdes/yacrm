import { notFound } from "next/navigation";

import { db } from "@/db/client";
import { inferCompanyDomains } from "@/lib/company-signal";
import { buildPersonTimeline } from "@/lib/person-timeline";

export default async function PersonProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
