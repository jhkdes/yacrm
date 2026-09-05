import Anthropic from "@anthropic-ai/sdk";
import { asc, eq, inArray } from "drizzle-orm";

import { contact, event, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";

const DRAFT_MODEL = "claude-opus-5";

export class PersonNotFoundError extends Error {
  constructor(personId: number) {
    super(`No Person found with id ${personId}.`);
  }
}

export interface DraftEventContext {
  direction: "inbound" | "outbound";
  occurredAt: Date;
  subject: string | null;
  bodyText: string;
}

export interface DraftContactContext {
  source: string;
  sourceIdentifier: string;
  displayName: string | null;
  status: string;
}

export interface PersonDraftContext {
  personId: number;
  personName: string;
  contacts: DraftContactContext[];
  // Chronological, oldest first — matches how a person would recall it.
  events: DraftEventContext[];
}

// Loads everything about a Person the drafting prompt needs. Pulled out from
// generateDraftForPerson so it's testable against a real (test) DB without
// needing the Anthropic API — mirrors the loadCandidates/rankPeople split in
// campaign-ranking.ts.
export async function loadPersonDraftContext(
  db: DrizzleDb,
  personId: number,
): Promise<PersonDraftContext> {
  const [personRow] = await db
    .select({ id: person.id, name: person.name })
    .from(person)
    .where(eq(person.id, personId));
  if (!personRow) throw new PersonNotFoundError(personId);

  const contactRows = await db
    .select({
      id: contact.id,
      source: contact.source,
      sourceIdentifier: contact.sourceIdentifier,
      displayName: contact.displayName,
      status: contact.status,
    })
    .from(contact)
    .where(eq(contact.personId, personId));

  const contactIds = contactRows.map((c) => c.id);
  const eventRows = contactIds.length
    ? await db
        .select({
          direction: event.direction,
          occurredAt: event.occurredAt,
          subject: event.subject,
          bodyText: event.bodyText,
        })
        .from(event)
        .where(inArray(event.contactId, contactIds))
        .orderBy(asc(event.occurredAt))
    : [];

  return {
    personId: personRow.id,
    personName: personRow.name,
    contacts: contactRows.map((c) => ({
      source: c.source,
      sourceIdentifier: c.sourceIdentifier,
      displayName: c.displayName,
      status: c.status,
    })),
    events: eventRows.map((e) => ({
      direction: e.direction,
      occurredAt: e.occurredAt,
      subject: e.subject,
      bodyText: e.bodyText,
    })),
  };
}

function formatEvent(e: DraftEventContext): string {
  const date = e.occurredAt.toISOString().slice(0, 10);
  const who = e.direction === "inbound" ? "them" : "you";
  const subject = e.subject ? ` — "${e.subject}"` : "";
  return `[${date}, from ${who}]${subject}\n${e.bodyText}`;
}

export interface DraftPrompt {
  system: string;
  user: string;
}

// Pure prompt construction — kept separate from the API call so it's unit
// testable without a real network request (same convention as
// rankPeopleByEmbedding vs. rankPeopleForCampaign).
export function buildDraftPrompt(
  context: PersonDraftContext,
  campaignGoal: string,
): DraftPrompt {
  const contactLines = context.contacts
    .map((c) => `- ${c.displayName ?? "(no name on file)"} <${c.sourceIdentifier}> via ${c.source}`)
    .join("\n");

  const historyText =
    context.events.length > 0
      ? context.events.map(formatEvent).join("\n\n")
      : "(no message history on file)";

  const system = [
    "You draft short, personalized outreach emails on behalf of the user.",
    "You will be given one specific person's real contact metadata and full",
    "message history with the user, plus the goal of an outreach campaign.",
    "",
    "Rules:",
    "- Reference only facts that actually appear in the provided contact",
    "  metadata or message history. Never invent shared history, job titles,",
    "  companies, or events that weren't given to you.",
    "- The draft must be specific to this person — someone who has never met",
    "  them should be able to tell, from reading it, that it was written for",
    "  them and not as an interchangeable template.",
    "- Match a natural, warm, professional tone consistent with how the",
    "  conversation history reads (formal if it's formal, casual if casual).",
    "- If the history is empty, write a cold-outreach email that relies only",
    "  on the contact metadata and the campaign goal — do not fabricate a",
    "  prior relationship.",
    "- Output exactly two parts: a line starting with 'Subject: ' followed by",
    "  the subject line, a blank line, then the email body. No preamble, no",
    "  explanation, no markdown formatting.",
  ].join("\n");

  const user = [
    `Campaign goal: ${campaignGoal}`,
    "",
    `Person: ${context.personName}`,
    "Known contact info:",
    contactLines || "(none on file)",
    "",
    "Message history (chronological):",
    historyText,
  ].join("\n");

  return { system, user };
}

export interface GeneratedDraft {
  subject: string;
  body: string;
  raw: string;
}

// Splits the model's "Subject: ...\n\n<body>" convention back apart. Falls
// back to treating the whole response as the body if the model didn't
// follow the format, so a formatting slip never surfaces as a hard failure.
export function parseDraftResponse(raw: string): GeneratedDraft {
  const trimmed = raw.trim();
  const match = trimmed.match(/^Subject:\s*(.*)\n\n?([\s\S]*)$/);
  if (!match) {
    return { subject: "", body: trimmed, raw: trimmed };
  }
  return { subject: match[1].trim(), body: match[2].trim(), raw: trimmed };
}

// Full pipeline: loads the Person's real context, then calls the real
// Anthropic API to draft the email. Not unit tested directly (real network
// call) — see loadPersonDraftContext and buildDraftPrompt for the tested
// pieces, and scripts/generate-draft.ts for real-data verification.
export async function generateDraftForPerson(
  db: DrizzleDb,
  personId: number,
  campaignGoal: string,
): Promise<{ context: PersonDraftContext; draft: GeneratedDraft }> {
  const context = await loadPersonDraftContext(db, personId);
  const { system, user } = buildDraftPrompt(context, campaignGoal);

  const client = new Anthropic();
  const response = await client.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Anthropic response contained no text block.");
  }

  return { context, draft: parseDraftResponse(textBlock.text) };
}
