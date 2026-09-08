import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { recipientsToCsv, type CampaignRecipientRow } from "@/lib/campaign-reporting";

// Streams the campaign's recipients as a downloadable CSV. Behind the same
// app-wide access gate as every other route in this app (src/proxy.ts) — no
// separate auth needed here.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId)) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

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
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const rows: CampaignRecipientRow[] = campaign.recipients.map((r) => ({
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

  const csv = recipientsToCsv(rows);
  const filename = `campaign-${campaignId}-recipients.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
