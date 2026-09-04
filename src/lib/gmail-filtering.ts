import { gmail_v1 } from "googleapis";

import { getHeader, parseFirstAddress } from "@/lib/gmail-parsing";

// Local-part patterns that are unambiguously automated — never a human you'd
// have a real back-and-forth with. Kept narrow on purpose: something like
// "support@" or "info@" can be a real two-way conversation with a small
// business, so it's not included here.
const AUTOMATED_LOCAL_PART = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)$/i;

// A message is a bulk/automated signal if it carries the headers mailing
// systems use to identify themselves, or comes from an unambiguously
// automated address — independent of whether the recipient ever replied.
export function isBulkOrAutomatedMessage(
  message: gmail_v1.Schema$Message,
): boolean {
  if (getHeader(message, "List-Unsubscribe")) return true;

  const precedence = getHeader(message, "Precedence")?.toLowerCase();
  if (precedence && ["bulk", "list", "junk"].includes(precedence)) {
    return true;
  }

  const autoSubmitted = getHeader(message, "Auto-Submitted")?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;

  const fromEmail = parseFirstAddress(getHeader(message, "From"))?.email;
  const localPart = fromEmail?.split("@")[0];
  if (localPart && AUTOMATED_LOCAL_PART.test(localPart)) return true;

  return false;
}

export interface CandidateMessage<T> {
  otherPartyEmail: string;
  direction: "inbound" | "outbound";
  isBulkSignal: boolean;
  payload: T;
}

export interface TwoWayFilterResult<T> {
  // Messages from addresses that pass the personal-contact filter.
  kept: CandidateMessage<T>[];
  // Distinct addresses excluded for having only ever sent, or only ever
  // received, mail from you — no real conversation.
  excludedOneWayEmails: Set<string>;
  // Distinct addresses excluded because at least one inbound message looked
  // automated/bulk (List-Unsubscribe, Precedence: bulk, no-reply@, etc.),
  // even if a two-way exchange technically exists (e.g. a support inbox).
  excludedBulkEmails: Set<string>;
}

// A Contact only becomes "personal" if there's a real two-way exchange (per
// REQUIREMENTS.md: sent AND received at least once) and no inbound message
// from that address looks automated/bulk. The bulk check is a hard override:
// it excludes the address even if a two-way exchange exists.
export function filterToPersonalContacts<T>(
  candidates: CandidateMessage<T>[],
): TwoWayFilterResult<T> {
  const byEmail = new Map<string, CandidateMessage<T>[]>();
  for (const candidate of candidates) {
    const group = byEmail.get(candidate.otherPartyEmail) ?? [];
    group.push(candidate);
    byEmail.set(candidate.otherPartyEmail, group);
  }

  const kept: CandidateMessage<T>[] = [];
  const excludedOneWayEmails = new Set<string>();
  const excludedBulkEmails = new Set<string>();

  for (const [email, group] of byEmail) {
    const hasInbound = group.some((c) => c.direction === "inbound");
    const hasOutbound = group.some((c) => c.direction === "outbound");
    const hasBulkSignal = group.some(
      (c) => c.direction === "inbound" && c.isBulkSignal,
    );

    if (hasBulkSignal) {
      excludedBulkEmails.add(email);
    } else if (!hasInbound || !hasOutbound) {
      excludedOneWayEmails.add(email);
    } else {
      kept.push(...group);
    }
  }

  return { kept, excludedOneWayEmails, excludedBulkEmails };
}
