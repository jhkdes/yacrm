import { gmail_v1 } from "googleapis";
import { and, eq } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { contact, event } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { createGmailClient } from "@/lib/gmail-import";
import { generateEmbeddings } from "@/lib/embeddings";
import { updatePersonSummaryEmbedding } from "@/lib/person-embedding";

export interface ActiveGmailContact {
  contactId: number;
  email: string;
  displayName: string | null;
}

// Only "active" gmail Contacts are offered as send targets — a "pending"
// (one-way) contact isn't a confirmed relationship yet, and there's no
// other source we can send outreach through in M14.
export async function listActiveGmailContacts(
  db: DrizzleDb,
  personId: number,
): Promise<ActiveGmailContact[]> {
  const rows = await db
    .select({
      id: contact.id,
      sourceIdentifier: contact.sourceIdentifier,
      displayName: contact.displayName,
    })
    .from(contact)
    .where(
      and(
        eq(contact.personId, personId),
        eq(contact.source, "gmail"),
        eq(contact.status, "active"),
      ),
    );

  return rows.map((r) => ({
    contactId: r.id,
    email: r.sourceIdentifier,
    displayName: r.displayName,
  }));
}

function encodeHeaderIfNeeded(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

export interface RawEmailParams {
  from: string;
  to: string;
  subject: string;
  // Expected to already contain the real tracked link inline, verbatim,
  // wherever it belongs — see fillLinkPlaceholder in draft-generation.ts,
  // which is what puts it there when the recipient's draft is created.
  // This function never appends a link on its own; a body with no link in
  // it just sends with no link, same as any other plain outreach message.
  body: string;
  // M19/M22: when set, sends multipart/alternative (plain text + HTML)
  // instead of plain-text-only, so the HTML part can carry the tracked
  // link as a real clickable <a> (wrapping this exact substring wherever
  // it's found in `body`) and an open-tracking pixel — a plain-text email
  // has no way to render either. The plain-text part is `body` verbatim;
  // most clients auto-linkify a bare URL in plain text anyway, so no
  // special handling is needed there.
  trackedLinkUrl?: string;
  trackingPixelUrl?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escapes the body for HTML, then wraps any occurrence of linkUrl as a
// clickable <a> — done by splitting around the (unescaped) link first, so
// the URL itself is never run through escapeHtml. That matters: a tracked
// link's query string can contain a literal "&" (see
// click-tracking.ts/appendTrackingId's tracking_id param), which
// escapeHtml would turn into "&amp;" — breaking a naive find-after-escape
// approach, since the escaped text would no longer contain the original
// URL string to search for.
function textToHtml(text: string, linkUrl?: string): string {
  if (!linkUrl || !text.includes(linkUrl)) {
    return escapeHtml(text).split("\n").join("<br>\n");
  }
  return text
    .split(linkUrl)
    .map((segment) => escapeHtml(segment).split("\n").join("<br>\n"))
    .join(`<a href="${linkUrl}">${linkUrl}</a>`);
}

// Pure RFC 2822 message construction, base64url-encoded the way Gmail's
// messages.send API requires — kept separate from the actual API call so
// it's unit testable without a real network request.
export function buildRawEmail(params: RawEmailParams): string {
  const { from, to, subject, body, trackedLinkUrl, trackingPixelUrl } = params;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderIfNeeded(subject)}`,
    "MIME-Version: 1.0",
  ];

  if (!trackedLinkUrl && !trackingPixelUrl) {
    const lines = [...headers, "Content-Type: text/plain; charset=utf-8", "", body];
    return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
  }

  const htmlBody = [
    textToHtml(body, trackedLinkUrl),
    trackingPixelUrl
      ? `<img src="${trackingPixelUrl}" width="1" height="1" alt="" style="display:none">`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const boundary = `yacrm_${crypto.randomUUID()}`;
  const lines = [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    htmlBody,
    "",
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

export interface SentMessage {
  messageId: string;
  threadId: string;
}

// Thin wrapper around the real Gmail send call — takes an already-built
// client so it can be exercised in tests with a fake gmail_v1.Gmail, the
// same way gmail-import.test.ts fakes message list/get.
export async function sendGmailMessage(
  gmail: gmail_v1.Gmail,
  params: RawEmailParams,
): Promise<SentMessage> {
  const raw = buildRawEmail(params);
  const { data } = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  if (!data.id || !data.threadId) {
    throw new Error("Gmail send response was missing an id/threadId.");
  }
  return { messageId: data.id, threadId: data.threadId };
}

// Records an already-sent message as a new outbound Event on the target
// Contact, then re-embeds it and refreshes the Person's summary embedding —
// mirrors how runGmailImport handles inbound/outbound Events, so a sent
// draft shows up in the timeline (M10) and future campaign ranking (M12)
// exactly like an imported one.
export async function recordSentEvent(
  db: DrizzleDb,
  contactId: number,
  personId: number,
  sent: SentMessage,
  subject: string,
  bodyText: string,
): Promise<void> {
  let embedding: number[] | null = null;
  try {
    [embedding] = await generateEmbeddings([bodyText]);
  } catch (err) {
    console.warn(
      "[gmail-send] embedding generation failed, continuing without it",
      err,
    );
  }

  await db.insert(event).values({
    contactId,
    direction: "outbound",
    occurredAt: new Date(),
    subject,
    bodyText,
    sourceMessageId: sent.messageId,
    embedding,
  });

  await updatePersonSummaryEmbedding(db, personId);
}

// Full pipeline used by the UI's approve/send action: sends the approved
// draft through the connected Gmail account, then records it as an Event.
// The recipient address is looked up from contactId server-side rather than
// trusted from a form field, so it can never drift from whichever contact
// the user actually selected. Not unit tested directly (real network call)
// — see buildRawEmail and recordSentEvent for the tested pieces.
export async function approveAndSendDraft(
  accountId: number,
  contactId: number,
  personId: number,
  subject: string,
  body: string,
): Promise<SentMessage> {
  const [targetContact] = await defaultDb
    .select({ sourceIdentifier: contact.sourceIdentifier })
    .from(contact)
    .where(eq(contact.id, contactId));
  if (!targetContact) {
    throw new Error(`No Contact found with id ${contactId}`);
  }

  const { gmail, ownEmail } = await createGmailClient(defaultDb, accountId);

  const sent = await sendGmailMessage(gmail, {
    from: ownEmail,
    to: targetContact.sourceIdentifier,
    subject,
    body,
  });

  await recordSentEvent(defaultDb, contactId, personId, sent, subject, body);

  return sent;
}
