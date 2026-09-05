import { sendDraftAction } from "@/app/actions";
import { db } from "@/db/client";
import { generateDraftForPerson } from "@/lib/draft-generation";
import { listActiveGmailContacts } from "@/lib/gmail-send";

export default async function DraftPage({
  searchParams,
}: {
  searchParams: Promise<{ personId?: string; goal?: string; sendError?: string }>;
}) {
  const params = await searchParams;
  const personId = Number(params.personId);
  const goal = params.goal?.trim() ?? "";

  if (!params.personId || Number.isNaN(personId) || !goal) {
    return (
      <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <p>Missing personId or goal.</p>
        <p>
          <a href="/campaigns">Back to campaign targeting</a>
        </p>
      </main>
    );
  }

  let result: Awaited<ReturnType<typeof generateDraftForPerson>> | null = null;
  let error: string | null = null;
  try {
    result = await generateDraftForPerson(db, personId, goal);
  } catch (err) {
    error = err instanceof Error ? err.message : "unknown_error";
  }

  const gmailContacts = await listActiveGmailContacts(db, personId);

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "40rem" }}>
      <p>
        <a href={`/campaigns?goal=${encodeURIComponent(goal)}`}>
          Back to campaign results
        </a>{" "}
        · <a href={`/people/${personId}`}>View person</a>
      </p>

      <h1>Draft for {result?.context.personName ?? `Person ${personId}`}</h1>
      <p style={{ color: "#555" }}>
        Campaign goal: &quot;{goal}&quot; · based on{" "}
        {result?.context.events.length ?? 0} event(s) of history
      </p>

      {error && <p style={{ color: "crimson" }}>Draft generation failed: {error}</p>}
      {params.sendError && (
        <p style={{ color: "crimson" }}>
          Send failed: {params.sendError} — this regenerated a fresh draft,
          any edits you made were lost.
        </p>
      )}

      {result && (
        <form action={sendDraftAction}>
          <input type="hidden" name="personId" value={personId} />
          <input type="hidden" name="goal" value={goal} />
          <input
            type="hidden"
            name="personName"
            value={result.context.personName}
          />

          <p>
            <label>
              Send to:{" "}
              {gmailContacts.length === 0 ? (
                <em>no active Gmail contact on file for this person</em>
              ) : (
                <select name="contactId" required>
                  {gmailContacts.map((c) => (
                    <option key={c.contactId} value={c.contactId}>
                      {c.displayName ?? c.email} &lt;{c.email}&gt;
                    </option>
                  ))}
                </select>
              )}
            </label>
          </p>

          <p>
            <label>
              Subject:{" "}
              <input
                type="text"
                name="subject"
                defaultValue={result.draft.subject}
                style={{ width: "100%" }}
                required
              />
            </label>
          </p>

          <p>
            <label>
              Body:
              <br />
              <textarea
                name="body"
                defaultValue={result.draft.body}
                rows={14}
                style={{ width: "100%", fontFamily: "inherit" }}
                required
              />
            </label>
          </p>

          <p style={{ color: "#555", fontSize: "0.9em" }}>
            Review and edit before sending — nothing is sent automatically.
            Sending requires a Gmail account connected with send permission
            (reconnect on the home page if you connected before M14).
          </p>

          <button type="submit" disabled={gmailContacts.length === 0}>
            Approve &amp; send
          </button>
        </form>
      )}
    </main>
  );
}
