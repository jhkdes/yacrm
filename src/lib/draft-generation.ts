import Anthropic from "@anthropic-ai/sdk";
import { asc, eq, inArray } from "drizzle-orm";

import { contact, event, person } from "@/db/schema";
import type { DrizzleDb } from "@/db/types";
import { USER_VOICE_EXAMPLES } from "@/lib/voice-examples";

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
// needing the Anthropic API.
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
    "",
    "Voice — two jobs at once: cut every pattern that screams 'an AI wrote",
    "this,' and match the real voice shown in the examples below, not a",
    "generic template.",
    "",
    "Kill these AI tells wherever they show up:",
    "- Binary contrasts ('this isn't just X, it's Y') — just say the Y part.",
    "- Throat-clearing openers ('here's the thing', 'I hope this finds you",
    "  well', 'I wanted to reach out because') — start with the actual point.",
    "- Colon-reveal sentences ('the real reason: ...') — rewrite as one",
    "  plain sentence instead.",
    "- Fake-profound closers ('and that changes everything') — cut them;",
    "  end on your last concrete point instead.",
    "- Dramatic fragments ('That's it. That's the whole ask.') — say it",
    "  once, plainly.",
    "- Faux-insight setups ('what most people don't realize...'), importance",
    "  puffery ('marks a pivotal moment', 'is a testament to'), weasel",
    "  attribution ('studies show'), and hedge stacking ('might potentially')",
    "  — state the fact plainly or cut the claim entirely.",
    "- Corporate buzzwords: delve, robust, seamless, leverage (as a verb),",
    "  unlock, elevate, holistic, dynamic, cutting-edge, game-changer,",
    "  synergies, comprehensive, unprecedented, and similar — only keep one",
    "  if it's genuinely the right word for what happened.",
    "",
    "Here's how the user actually writes outreach messages on LinkedIn —",
    "match this voice: sentence length, punctuation habits, how they open",
    "and sign off, how direct the ask is, how much warmth vs. formality.",
    "Don't copy these verbatim or reuse their specific details — match the",
    "voice, not the content.",
    "",
    ...USER_VOICE_EXAMPLES.flatMap((example, i) => [
      `Example ${i + 1}:`,
      example,
      "",
    ]),
    "Before finalizing: read it back next to the examples above — does it",
    "sound like the same person wrote it, or like a generic template? If a",
    "sentence sounds impressive but says nothing concrete, cut it.",
    "- If the history is empty, write a cold-outreach email that relies only",
    "  on the contact metadata and the campaign goal — do not fabricate a",
    "  prior relationship.",
    "- If the campaign goal involves sharing a link (e.g. inviting them to",
    "  try something), write the exact placeholder text {{LINK}} at the spot",
    "  where the link belongs — do not invent a URL, and do not write any",
    "  other placeholder like '[link]' or '[insert link here]'. The real",
    "  link is substituted in afterward, verbatim, wherever {{LINK}} appears.",
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

const LINK_PLACEHOLDER = "{{LINK}}";

// Pure: substitutes the real tracked link wherever the model wrote the
// {{LINK}} placeholder the system prompt asked for. Falls back to
// appending the link at the end if the placeholder is missing (the model
// forgetting an instruction is a real failure mode, not a hypothetical —
// see the `[link]`-placeholder bug this was written to fix), so a
// generated draft never silently ships with no working link at all when
// one was expected.
export function fillLinkPlaceholder(body: string, linkUrl: string): string {
  if (body.includes(LINK_PLACEHOLDER)) {
    return body.split(LINK_PLACEHOLDER).join(linkUrl);
  }
  return `${body}\n\n${linkUrl}`;
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
