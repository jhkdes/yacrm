import { notFound } from "next/navigation";

import { markLinkedinRecipientSentAction } from "@/app/actions";
import { db } from "@/db/client";

import { CopyButton } from "./CopyButton";

// LinkedIn has no send API this app is willing to automate (see
// docs/outreach-roadmap.md's decision to stay within LinkedIn's terms of
// service) — this page is the manual workflow instead: copy each draft,
// paste it into LinkedIn yourself, send it there, then come back and mark
// it sent here.
export default async function LinkedInQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sent?: string; error?: string }>;
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
        where: (r, { and, eq, isNull }) =>
          and(
            isNull(r.deletedAt),
            eq(r.channel, "linkedin"),
            eq(r.status, "drafted"),
          ),
        with: { person: true, contact: true },
      },
    },
  });
  if (!campaign) {
    notFound();
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <p>
        <a href={`/campaigns/${campaign.id}`}>Back to campaign</a>
      </p>
      <h1>{campaign.name} — LinkedIn copy-assist queue</h1>
      <p style={{ color: "#555" }}>
        For each person: open their profile, paste the message, send it on
        LinkedIn, then come back here and click &quot;Mark sent.&quot;
      </p>

      {query.error && (
        <p style={{ color: "crimson" }}>Failed: {query.error}</p>
      )}
      {query.sent && <p style={{ color: "green" }}>Marked sent.</p>}

      {campaign.recipients.length === 0 ? (
        <p>
          Nothing left in the queue — every LinkedIn recipient on this
          campaign has already been sent (or there are none).
        </p>
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
                <strong>{r.person.name}</strong> —{" "}
                <a
                  href={r.contact.sourceIdentifier}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open LinkedIn profile
                </a>
              </p>
              <p
                style={{
                  whiteSpace: "pre-wrap",
                  color: "#333",
                  border: "1px solid #eee",
                  borderRadius: 4,
                  padding: "0.75rem",
                }}
              >
                {r.draftBody}
              </p>
              <CopyButton text={r.draftBody} />{" "}
              <form
                action={markLinkedinRecipientSentAction}
                style={{ display: "inline" }}
              >
                <input type="hidden" name="campaignId" value={campaign.id} />
                <input type="hidden" name="recipientId" value={r.id} />
                <button type="submit">Mark sent</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
