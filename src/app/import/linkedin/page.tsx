import {
  importLinkedInConnectionsAction,
  importLinkedInMessagesAction,
} from "@/app/actions";

import { ImportSubmitButton } from "./ImportSubmitButton";

export default async function ImportLinkedIn({
  searchParams,
}: {
  searchParams: Promise<{
    rows_processed?: string;
    rows_skipped_no_url?: string;
    contacts_created?: string;
    titles_classified?: string;
    import_error?: string;
    msg_rows_processed?: string;
    msg_rows_skipped_empty?: string;
    msg_rows_skipped_bad_date?: string;
    msg_rows_skipped_group?: string;
    msg_rows_skipped_unresolvable?: string;
    msg_contacts_created?: string;
    msg_contacts_pending?: string;
    msg_contacts_promoted?: string;
    msg_events_created?: string;
    msg_events_skipped_duplicate?: string;
    msg_events_embedded?: string;
    messages_import_error?: string;
  }>;
}) {
  const params = await searchParams;

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Import LinkedIn connections</h1>
      <p>
        From LinkedIn: Settings &amp; Privacy → Data privacy → Get a copy of
        your data → &quot;Connections&quot;. Upload the resulting
        <code> Connections.csv</code> below.
      </p>

      <form action={importLinkedInConnectionsAction}>
        <input type="file" name="file" accept=".csv" required />
        <ImportSubmitButton />
      </form>

      {params.import_error && (
        <p style={{ color: "crimson" }}>
          Import failed: {params.import_error}
        </p>
      )}

      {params.rows_processed && (
        <ul>
          <li>Rows processed: {params.rows_processed}</li>
          <li>Rows skipped (no profile URL): {params.rows_skipped_no_url}</li>
          <li>New contacts created: {params.contacts_created}</li>
          <li>Titles classified: {params.titles_classified}</li>
        </ul>
      )}

      <h1>Import LinkedIn messages</h1>
      <p>
        Same &quot;Get a copy of your data&quot; export, this time selecting
        &quot;Messages&quot; — upload the resulting{" "}
        <code>messages.csv</code> below. Since LinkedIn&apos;s export
        doesn&apos;t say which side of the conversation is you, tell it your
        own profile URL too.
      </p>

      <form action={importLinkedInMessagesAction}>
        <p>
          <label>
            Your LinkedIn profile URL:{" "}
            <input
              type="url"
              name="ownProfileUrl"
              placeholder="https://www.linkedin.com/in/yourname"
              required
            />
          </label>
        </p>
        <input type="file" name="file" accept=".csv" required />
        <ImportSubmitButton />
      </form>

      {params.messages_import_error && (
        <p style={{ color: "crimson" }}>
          Import failed: {params.messages_import_error}
        </p>
      )}

      {params.msg_rows_processed && (
        <ul>
          <li>Rows processed: {params.msg_rows_processed}</li>
          <li>
            Rows skipped (empty content): {params.msg_rows_skipped_empty}
          </li>
          <li>
            Rows skipped (unparseable date): {params.msg_rows_skipped_bad_date}
          </li>
          <li>
            Rows skipped (group conversation): {params.msg_rows_skipped_group}
          </li>
          <li>
            Rows skipped (neither side is you): {params.msg_rows_skipped_unresolvable}
          </li>
          <li>New contacts created: {params.msg_contacts_created}</li>
          <li>
            Contacts pending (one-way so far): {params.msg_contacts_pending}
          </li>
          <li>
            Contacts promoted to active this run: {params.msg_contacts_promoted}
          </li>
          <li>Events created: {params.msg_events_created}</li>
          <li>
            Events skipped (already imported): {params.msg_events_skipped_duplicate}
          </li>
          <li>Events embedded: {params.msg_events_embedded}</li>
        </ul>
      )}

      <p>
        <a href="/contacts">View contacts</a>
      </p>
    </main>
  );
}
