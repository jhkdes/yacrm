import { notFound } from "next/navigation";

import {
  deleteCampaignAction,
  removeCampaignRecipientAction,
  restoreCampaignRecipientAction,
  sendAllCampaignRecipientsAction,
  sendCampaignRecipientAction,
} from "@/app/actions";
import { db } from "@/db/client";
import { summarizeCampaign, type CampaignRecipientRow } from "@/lib/campaign-reporting";

// Once apps/redirect is deployed, set REDIRECT_BASE_URL (e.g.
// "https://yacrm-redirect.vercel.app") so links shown here — and, later,
// links actually embedded in a sent email — point at the public redirect
// app instead of this app's own /api/r/[token]. That route stays working
// as a local-testing fallback until REDIRECT_BASE_URL is set; it's not
// reachable by a real recipient (this app isn't deployed publicly), but
// it's useful for exercising the click-tracking flow from a browser.
function buildTrackedLink(token: string): string {
  const base = process.env.REDIRECT_BASE_URL;
  return base ? `${base.replace(/\/+$/, "")}/${token}` : `/api/r/${token}`;
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    added?: string;
    skipped_no_contact?: string;
    skipped_draft_failed?: string;
    skipped_already?: string;
    removed?: string;
    // Present only on the redirect immediately after removing a recipient —
    // drives a one-shot "Undo" link that's gone once you navigate away.
    undo_recipient_id?: string;
    restored?: string;
    campaign_restored?: string;
    sent_recipient?: string;
    sent_all?: string;
    sent_all_failed?: string;
    error?: string;
  }>;
}) {
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId)) {
    notFound();
  }
  const query = await searchParams;

  const campaign = await db.query.campaign.findFirst({
    where: (c, { and, eq, isNull }) =>
      and(eq(c.id, campaignId), isNull(c.deletedAt)),
    with: {
      recipients: {
        where: (r, { isNull }) => isNull(r.deletedAt),
        with: { person: true, contact: true },
      },
    },
  });
  if (!campaign) {
    notFound();
  }

  const reportingRows: CampaignRecipientRow[] = campaign.recipients.map((r) => ({
    personName: r.person.name,
    contactIdentifier: r.contact.sourceIdentifier,
    channel: r.channel,
    status: r.status,
    draftSubject: r.draftSubject,
    draftBody: r.draftBody,
    trackingToken: r.trackingToken,
    sentAt: r.sentAt,
    openedAt: r.openedAt,
    clickedAt: r.clickedAt,
    completedAt: r.completedAt,
  }));
  const funnel = summarizeCampaign(reportingRows);
  const linkedInQueueCount = campaign.recipients.filter(
    (r) => r.channel === "linkedin" && r.status === "drafted",
  ).length;
  const draftedEmailCount = campaign.recipients.filter(
    (r) => r.channel === "email" && r.status === "drafted",
  ).length;

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <p>
        <a href="/campaigns">Back to campaigns</a>
      </p>
      <h1>{campaign.name}</h1>
      <p style={{ color: "#555" }}>
        Goal: &quot;{campaign.goal}&quot; · type {campaign.type} · created{" "}
        {campaign.createdAt.toISOString().slice(0, 10)}
        {campaign.destinationUrl && (
          <>
            {" "}
            · destination:{" "}
            <a href={campaign.destinationUrl}>{campaign.destinationUrl}</a>
          </>
        )}
      </p>
      <p>
        <a
          href={`/campaigns?${new URLSearchParams({
            campaignId: String(campaign.id),
          }).toString()}`}
        >
          Add more people to this campaign
        </a>
      </p>
      {linkedInQueueCount > 0 && (
        <p>
          <a href={`/campaigns/${campaign.id}/linkedin-queue`}>
            LinkedIn copy-assist queue ({linkedInQueueCount} pending)
          </a>
        </p>
      )}
      <form action={deleteCampaignAction}>
        <input type="hidden" name="campaignId" value={campaign.id} />
        <button type="submit">
          Delete this campaign ({campaign.recipients.length} recipient
          {campaign.recipients.length === 1 ? "" : "s"})
        </button>
      </form>

      {query.error && (
        <p style={{ color: "crimson" }}>Failed: {query.error}</p>
      )}
      {query.added && (
        <p style={{ color: "green" }}>
          Added {query.added} recipient{query.added === "1" ? "" : "s"}.
          {Number(query.skipped_no_contact) > 0 &&
            ` ${query.skipped_no_contact} skipped (no active Contact on that channel).`}
          {Number(query.skipped_draft_failed) > 0 &&
            ` ${query.skipped_draft_failed} skipped (draft generation failed).`}
          {Number(query.skipped_already) > 0 &&
            ` ${query.skipped_already} already in this campaign.`}
        </p>
      )}
      {query.removed && (
        <div style={{ color: "green" }}>
          Removed from this campaign.{" "}
          {query.undo_recipient_id && (
            <form
              action={restoreCampaignRecipientAction}
              style={{ display: "inline" }}
            >
              <input type="hidden" name="campaignId" value={campaign.id} />
              <input
                type="hidden"
                name="recipientId"
                value={query.undo_recipient_id}
              />
              <button type="submit">Undo</button>
            </form>
          )}
        </div>
      )}
      {query.restored && (
        <p style={{ color: "green" }}>Restored.</p>
      )}
      {query.campaign_restored && (
        <p style={{ color: "green" }}>Campaign restored.</p>
      )}
      {query.sent_recipient && (
        <p style={{ color: "green" }}>Sent.</p>
      )}
      {query.sent_all && (
        <p style={{ color: "green" }}>
          Sent {query.sent_all} email{query.sent_all === "1" ? "" : "s"}.
          {Number(query.sent_all_failed) > 0 &&
            ` ${query.sent_all_failed} failed to send — see server logs.`}
        </p>
      )}

      <h2>Funnel</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0" }}>
              Channel
            </th>
            <th style={{ textAlign: "right", padding: "0.25rem 1rem" }}>Drafted</th>
            <th style={{ textAlign: "right", padding: "0.25rem 1rem" }}>Sent</th>
            <th style={{ textAlign: "right", padding: "0.25rem 1rem" }}>Opened</th>
            <th style={{ textAlign: "right", padding: "0.25rem 1rem" }}>Clicked</th>
            <th style={{ textAlign: "right", padding: "0.25rem 1rem" }}>Completed</th>
          </tr>
        </thead>
        <tbody>
          {(["email", "linkedin"] as const).map((channel) => (
            <tr key={channel}>
              <td style={{ padding: "0.25rem 1rem 0.25rem 0" }}>{channel}</td>
              <td style={{ textAlign: "right", padding: "0.25rem 1rem" }}>
                {funnel[channel].drafted}
              </td>
              <td style={{ textAlign: "right", padding: "0.25rem 1rem" }}>
                {funnel[channel].sent}
              </td>
              <td style={{ textAlign: "right", padding: "0.25rem 1rem" }}>
                {funnel[channel].opened}
              </td>
              <td style={{ textAlign: "right", padding: "0.25rem 1rem" }}>
                {funnel[channel].clicked}
              </td>
              <td style={{ textAlign: "right", padding: "0.25rem 1rem" }}>
                {funnel[channel].completed}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <a href={`/api/campaigns/${campaign.id}/export`}>
          Export recipients as CSV
        </a>
      </p>

      <h2>Recipients ({campaign.recipients.length})</h2>
      {draftedEmailCount > 0 && (
        <form action={sendAllCampaignRecipientsAction} style={{ marginBottom: "1rem" }}>
          <input type="hidden" name="campaignId" value={campaign.id} />
          <button type="submit">
            Send all drafted emails ({draftedEmailCount})
          </button>
        </form>
      )}
      {campaign.recipients.length === 0 ? (
        <p>No recipients yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {campaign.recipients.map((r) => (
            <li
              key={r.id}
              style={{
                border: "1px solid #ccc",
                borderRadius: 8,
                padding: "1rem",
                margin: "1rem 0",
              }}
            >
              <p>
                <strong>
                  <a href={`/people/${r.personId}`}>{r.person.name}</a>
                </strong>{" "}
                — {r.channel} via {r.contact.sourceIdentifier} — status{" "}
                <strong>{r.status}</strong>
              </p>
              {r.draftSubject && <p>Subject: {r.draftSubject}</p>}
              <p style={{ whiteSpace: "pre-wrap", color: "#333" }}>
                {r.draftBody}
              </p>
              {campaign.destinationUrl && (
                <p style={{ fontSize: "0.9em" }}>
                  Tracked link:{" "}
                  <a href={buildTrackedLink(r.trackingToken)}>
                    {buildTrackedLink(r.trackingToken)}
                  </a>
                </p>
              )}
              {r.channel === "email" && r.status === "drafted" && (
                <form action={sendCampaignRecipientAction}>
                  <input type="hidden" name="campaignId" value={campaign.id} />
                  <input type="hidden" name="recipientId" value={r.id} />
                  <button type="submit">Send</button>
                </form>
              )}
              <form action={removeCampaignRecipientAction}>
                <input type="hidden" name="campaignId" value={campaign.id} />
                <input type="hidden" name="recipientId" value={r.id} />
                <button type="submit">
                  Remove from campaign
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
