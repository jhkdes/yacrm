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
  body: string;
  // M19: when set, sends multipart/alternative (plain text + HTML) instead
  // of plain-text-only, so the HTML part can carry a clickable tracked
  // link and an open-tracking pixel — a plain-text email has no way to
  // render either. trackedLinkUrl alone would technically work in plain
  // text too (email clients auto-linkify a bare URL), but since
  // trackingPixelUrl always requires HTML anyway, both go through the same
  // multipart path for one consistent code path rather than two.
  trackedLinkUrl?: string;
  trackingPixelUrl?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textToHtml(text: string): string {
  return escapeHtml(text).split("\n").join("<br>\n");
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

  const plainTextBody = trackedLinkUrl ? `${body}\n\n${trackedLinkUrl}` : body;
  const htmlBody = [
    textToHtml(body),
    trackedLinkUrl
      ? `<p><a href="${trackedLinkUrl}">${trackedLinkUrl}</a></p>`
      : "",
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
    plainTextBody,
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
