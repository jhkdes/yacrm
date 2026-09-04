import { asc, eq } from "drizzle-orm";

import { purgeContactAction, unpurgeAction } from "@/app/actions";
import { db } from "@/db/client";
import { contact, purgedContact } from "@/db/schema";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    purged?: string;
    unpurged?: string;
    purge_error?: string;
  }>;
}) {
  const params = await searchParams;

  const contacts = await db
    .select({
      id: contact.id,
      email: contact.sourceIdentifier,
      displayName: contact.displayName,
      source: contact.source,
    })
    .from(contact)
    .where(eq(contact.status, "active"))
    .orderBy(asc(contact.sourceIdentifier));

  const pendingContacts = await db
    .select({
      id: contact.id,
      email: contact.sourceIdentifier,
      displayName: contact.displayName,
      source: contact.source,
    })
    .from(contact)
    .where(eq(contact.status, "pending"))
    .orderBy(asc(contact.sourceIdentifier));

  const purgedContacts = await db
    .select({
      source: purgedContact.source,
      sourceIdentifier: purgedContact.sourceIdentifier,
      purgedAt: purgedContact.purgedAt,
    })
    .from(purgedContact)
    .orderBy(asc(purgedContact.purgedAt));

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Contacts</h1>
      <p>
        <a href="/">Back to home</a> · <a href="/merges">Review merge suggestions</a> ·{" "}
        <a href="/people">View people</a>
      </p>

      {params.purged && (
        <p style={{ color: "green" }}>Contact purged successfully.</p>
      )}
      {params.unpurged && (
        <p style={{ color: "green" }}>
          Contact un-purged. Run an import to bring their history back.
        </p>
      )}
      {params.purge_error && (
        <p style={{ color: "crimson" }}>Purge failed: {params.purge_error}</p>
      )}

      {contacts.length === 0 ? (
        <p>No contacts yet.</p>
      ) : (
        <table cellPadding={8} style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th>Name</th>
              <th>Email</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid #eee" }}>
                <td>{c.displayName ?? "(no name)"}</td>
                <td>{c.email}</td>
                <td>{c.source}</td>
                <td>
                  <form action={purgeContactAction}>
                    <input type="hidden" name="contactId" value={c.id} />
                    <button type="submit">Purge</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Pending</h2>
      <p>
        One-way so far — you&apos;ve either sent to or received from these
        addresses, but not both. They&apos;ll move to Contacts automatically
        once a two-way exchange is detected on a future import.
      </p>
      {pendingContacts.length === 0 ? (
        <p>Nothing pending.</p>
      ) : (
        <table cellPadding={8} style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th>Name</th>
              <th>Email</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pendingContacts.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid #eee" }}>
                <td>{c.displayName ?? "(no name)"}</td>
                <td>{c.email}</td>
                <td>{c.source}</td>
                <td>
                  <form action={purgeContactAction}>
                    <input type="hidden" name="contactId" value={c.id} />
                    <button type="submit">Purge</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Purged</h2>
      <p>
        These addresses are excluded from future imports. Undoing a purge
        does not restore deleted history — it just allows their messages to
        be picked up again on your next import.
      </p>
      {purgedContacts.length === 0 ? (
        <p>Nothing purged yet.</p>
      ) : (
        <table cellPadding={8} style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th>Email</th>
              <th>Source</th>
              <th>Purged at</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {purgedContacts.map((p) => (
              <tr
                key={`${p.source}:${p.sourceIdentifier}`}
                style={{ borderBottom: "1px solid #eee" }}
              >
                <td>{p.sourceIdentifier}</td>
                <td>{p.source}</td>
                <td>{p.purgedAt.toISOString()}</td>
                <td>
                  <form action={unpurgeAction}>
                    <input type="hidden" name="source" value={p.source} />
                    <input
                      type="hidden"
                      name="sourceIdentifier"
                      value={p.sourceIdentifier}
                    />
                    <button type="submit">Undo</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
