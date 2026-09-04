import { eq } from "drizzle-orm";

import { importGmailAction, syncGmailAction } from "@/app/actions";
import { db } from "@/db/client";
import { oauthAccount } from "@/db/schema";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    gmail_connected?: string;
    gmail_error?: string;
    import_scanned?: string;
    import_created?: string;
    import_skipped?: string;
    import_skipped_no_address?: string;
    import_skipped_self?: string;
    import_skipped_duplicate?: string;
    import_skipped_bulk?: string;
    import_skipped_purged?: string;
    import_contacts?: string;
    import_contacts_excluded_bulk?: string;
    import_contacts_pending?: string;
    import_contacts_promoted?: string;
    import_error?: string;
  }>;
}) {
  const params = await searchParams;

  const gmailAccounts = await db
    .select({
      emailAddress: oauthAccount.emailAddress,
      hasRefreshToken: oauthAccount.refreshToken,
      lastSyncedDate: oauthAccount.lastSyncedDate,
    })
    .from(oauthAccount)
    .where(eq(oauthAccount.provider, "gmail"));

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>yacrm</h1>
      <p>
        <a href="/contacts">View contacts</a>
      </p>

      {params.gmail_connected && (
        <p style={{ color: "green" }}>
          Connected {params.gmail_connected} successfully.
        </p>
      )}
      {params.gmail_error && (
        <p style={{ color: "crimson" }}>
          Gmail connection failed: {params.gmail_error}
        </p>
      )}

      <h2>Gmail</h2>
      {gmailAccounts.length === 0 ? (
        <p>No Gmail account connected yet.</p>
      ) : (
        <ul>
          {gmailAccounts.map((account) => (
            <li key={account.emailAddress}>
              {account.emailAddress} — Connected
              {account.hasRefreshToken ? "" : " (no refresh token)"}
              {account.lastSyncedDate
                ? ` — last synced from ${account.lastSyncedDate}`
                : " — never imported"}
            </li>
          ))}
        </ul>
      )}

      <a href="/api/auth/gmail/start">
        <button type="button">
          {gmailAccounts.length === 0 ? "Connect Gmail" : "Reconnect Gmail"}
        </button>
      </a>

      {gmailAccounts.length > 0 && (
        <>
          <h2>Import history</h2>
          <form action={importGmailAction}>
            <label>
              Import messages after:{" "}
              <input type="date" name="startDate" required />
            </label>
            <button type="submit">Import</button>
          </form>

          <h2>Sync</h2>
          {gmailAccounts[0]?.lastSyncedDate ? (
            <form action={syncGmailAction}>
              <p>
                Fetches anything new since{" "}
                {gmailAccounts[0].lastSyncedDate}.
              </p>
              <button type="submit">Sync now</button>
            </form>
          ) : (
            <p>Run an initial import above before syncing.</p>
          )}

          {params.import_error && (
            <p style={{ color: "crimson" }}>
              Import failed: {params.import_error}
            </p>
          )}
          {params.import_scanned && (
            <ul>
              <li>Messages scanned: {params.import_scanned}</li>
              <li>Events created: {params.import_created}</li>
              <li>
                Events skipped: {params.import_skipped}
                <ul>
                  <li>No resolvable address: {params.import_skipped_no_address}</li>
                  <li>Resolved to own address: {params.import_skipped_self}</li>
                  <li>Duplicate (already imported): {params.import_skipped_duplicate}</li>
                  <li>Bulk/automated sender: {params.import_skipped_bulk}</li>
                  <li>Purged (won&apos;t be re-imported): {params.import_skipped_purged}</li>
                </ul>
              </li>
              <li>New contacts created: {params.import_contacts}</li>
              <li>
                Contacts excluded (bulk/automated): {params.import_contacts_excluded_bulk}
              </li>
              <li>
                Contacts pending (one-way so far, will promote once they reply): {params.import_contacts_pending}
              </li>
              <li>
                Contacts promoted to active this run: {params.import_contacts_promoted}
              </li>
            </ul>
          )}
        </>
      )}
    </main>
  );
}
