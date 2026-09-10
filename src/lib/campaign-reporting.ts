import type { CampaignChannel } from "@/lib/campaigns";

export type CampaignRecipientStatus =
  | "drafted"
  | "sent"
  | "opened"
  | "clicked"
  | "completed";

// Everything summarizeCampaign/recipientsToCsv need about one recipient —
// callers (the campaign detail page, the CSV export route) build this from
// their own db.query.campaign.findFirst({ with: { recipients: ... } })
// result rather than this module reaching into the DB itself.
export interface CampaignRecipientRow {
  personName: string;
  contactIdentifier: string;
  channel: CampaignChannel;
  status: CampaignRecipientStatus;
  draftSubject: string | null;
  draftBody: string;
  trackingToken: string;
  sentAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  completedAt: Date | null;
}

const CHANNELS: CampaignChannel[] = ["email", "linkedin"];

export type CampaignFunnelSummary = Record<
  CampaignChannel,
  Record<CampaignRecipientStatus, number>
>;

function emptyFunnelSummary(): CampaignFunnelSummary {
  const summary = {} as CampaignFunnelSummary;
  for (const channel of CHANNELS) {
    summary[channel] = {
      drafted: 0,
      sent: 0,
      opened: 0,
      clicked: 0,
      completed: 0,
    };
  }
  return summary;
}

// Pure: counts recipients per status per channel — "opened" stays 0 for
// linkedin since nothing ever sets it there (no read-receipt API — see
// campaignRecipientStatusEnum in schema.ts), not because it's filtered out.
export function summarizeCampaign(
  recipients: CampaignRecipientRow[],
): CampaignFunnelSummary {
  const summary = emptyFunnelSummary();
  for (const r of recipients) {
    summary[r.channel][r.status] += 1;
  }
  return summary;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatDate(d: Date | null): string {
  return d ? d.toISOString() : "";
}

const CSV_HEADER = [
  "Person",
  "Channel",
  "Contact",
  "Status",
  "Subject",
  "Tracking Token",
  "Sent At",
  "Opened At",
  "Clicked At",
  "Completed At",
];

// Pure: one row per recipient, in the order given — sorting/filtering is the
// caller's job (mirrors how recipients are already ordered by the detail
// page's query).
export function recipientsToCsv(recipients: CampaignRecipientRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of recipients) {
    lines.push(
      [
        r.personName,
        r.channel,
        r.contactIdentifier,
        r.status,
        r.draftSubject ?? "",
        r.trackingToken,
        formatDate(r.sentAt),
        formatDate(r.openedAt),
        formatDate(r.clickedAt),
        formatDate(r.completedAt),
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
