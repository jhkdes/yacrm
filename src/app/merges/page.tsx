import { asc, inArray } from "drizzle-orm";

import {
  acceptAllMergesAction,
  acceptMergeAction,
  rejectMergeAction,
  undismissMergeAction,
} from "@/app/actions";
import { db } from "@/db/client";
import { contact, dismissedMergeSuggestion, person } from "@/db/schema";
import { getDismissedPairKeys } from "@/lib/merge-dismissals";
import { generateMergeSuggestions } from "@/lib/merge-suggestions";

export default async function MergesPage({
  searchParams,
}: {
  searchParams: Promise<{
    merged?: string;
    rejected?: string;
    undismissed?: string;
    merge_error?: string;
  }>;
}) {
  const params = await searchParams;

  const contacts = await db
    .select({
      contactId: contact.id,
      personId: contact.personId,
      source: contact.source,
      sourceIdentifier: contact.sourceIdentifier,
      displayName: contact.displayName,
    })
    .from(contact);

  const allSuggestions = generateMergeSuggestions(contacts);
  const dismissed = await getDismissedPairKeys(db);
  const suggestions = allSuggestions.filter(
    (s) => !dismissed.has(`${s.personAId}:${s.personBId}`),
  );

  const dismissedPairs = await db
    .select({
      personAId: dismissedMergeSuggestion.personAId,
      personBId: dismissedMergeSuggestion.personBId,
      dismissedAt: dismissedMergeSuggestion.dismissedAt,
    })
    .from(dismissedMergeSuggestion)
    .orderBy(asc(dismissedMergeSuggestion.dismissedAt));

  const personIds = [
    ...new Set(
      [...suggestions, ...dismissedPairs].flatMap((s) => [
        s.personAId,
        s.personBId,
      ]),
    ),
  ];
  const relevantContacts =
    personIds.length > 0
      ? await db
          .select({
            personId: contact.personId,
            email: contact.sourceIdentifier,
            displayName: contact.displayName,
            source: contact.source,
          })
          .from(contact)
          .where(inArray(contact.personId, personIds))
      : [];
  const relevantPeople =
    personIds.length > 0
      ? await db
          .select({ id: person.id, name: person.name })
          .from(person)
          .where(inArray(person.id, personIds))
      : [];
  const personNameById = new Map(relevantPeople.map((p) => [p.id, p.name]));
  const contactsByPersonId = new Map<number, typeof relevantContacts>();
  for (const c of relevantContacts) {
    const list = contactsByPersonId.get(c.personId) ?? [];
    list.push(c);
    contactsByPersonId.set(c.personId, list);
  }

  function renderPersonPair(personAId: number, personBId: number) {
    return (
      <div style={{ display: "flex", gap: "2rem" }}>
        {[personAId, personBId].map((id) => (
          <div key={id}>
            <strong>{personNameById.get(id)}</strong>
            <ul>
              {(contactsByPersonId.get(id) ?? []).map((c) => (
                <li key={c.email}>
                  {c.displayName ?? "(no name)"} &lt;{c.email}&gt; [{c.source}]
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Merge suggestions</h1>
      <p>
        <a href="/contacts">Back to contacts</a> · <a href="/people">View people</a>
      </p>

      {params.merged && (
        <p style={{ color: "green" }}>Merged successfully.</p>
      )}
      {params.rejected && (
        <p style={{ color: "green" }}>
          Rejected — this pair won&apos;t be suggested again.
        </p>
      )}
      {params.undismissed && (
        <p style={{ color: "green" }}>
          Restored — this pair may show up as a suggestion again below.
        </p>
      )}
      {params.merge_error && (
        <p style={{ color: "crimson" }}>Action failed: {params.merge_error}</p>
      )}

      {suggestions.length === 0 ? (
        <p>No merge suggestions right now.</p>
      ) : (
        <>
          <form action={acceptAllMergesAction}>
            <input
              type="hidden"
              name="pairs"
              value={JSON.stringify(
                suggestions.map((s) => [s.personAId, s.personBId]),
              )}
            />
            <button type="submit">
              Accept all {suggestions.length} remaining
            </button>
          </form>

          <ul style={{ listStyle: "none", padding: 0 }}>
            {suggestions.map((s) => (
              <li
                key={`${s.personAId}:${s.personBId}`}
                style={{
                  border: "1px solid #ccc",
                  borderRadius: 8,
                  padding: "1rem",
                  margin: "1rem 0",
                }}
              >
                <p>
                  Score {s.score.toFixed(2)} — {s.reasons.join(", ")}
                </p>
                {renderPersonPair(s.personAId, s.personBId)}
                <form
                  action={acceptMergeAction}
                  style={{ display: "inline-block", marginRight: "0.5rem" }}
                >
                  <input type="hidden" name="personAId" value={s.personAId} />
                  <input type="hidden" name="personBId" value={s.personBId} />
                  <button type="submit">Accept</button>
                </form>
                <form action={rejectMergeAction} style={{ display: "inline-block" }}>
                  <input type="hidden" name="personAId" value={s.personAId} />
                  <input type="hidden" name="personBId" value={s.personBId} />
                  <button type="submit">Reject</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Dismissed</h2>
      <p>These pairs were rejected and won&apos;t be suggested again unless undone.</p>
      {dismissedPairs.length === 0 ? (
        <p>Nothing dismissed.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {dismissedPairs.map((d) => (
            <li
              key={`${d.personAId}:${d.personBId}`}
              style={{
                border: "1px solid #eee",
                borderRadius: 8,
                padding: "1rem",
                margin: "1rem 0",
              }}
            >
              <p>Dismissed {d.dismissedAt.toISOString()}</p>
              {renderPersonPair(d.personAId, d.personBId)}
              <form action={undismissMergeAction}>
                <input type="hidden" name="personAId" value={d.personAId} />
                <input type="hidden" name="personBId" value={d.personBId} />
                <button type="submit">Undo</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
