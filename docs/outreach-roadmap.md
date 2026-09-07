# yaCRM Outreach Roadmap

**Product Requirements — Enhancement Roadmap**
Owner: Jae Kim · Status: Draft for review · Dated: 2026-09-06 (rev. 2)

Today yaCRM imports Gmail, resolves contacts into merged profiles, and can rank & draft a one-off outbound campaign against them — but it can't see LinkedIn, can't send or measure a real campaign, and can't remind you or itself when to follow up. This doc sequences four phases to close that gap, grounded in what the codebase already has to build on.

## Roadmap at a glance

| Phase | Delivers | Depends on | Status |
|---|---|---|---|
| 1 · LinkedIn Import | Contacts & message history from LinkedIn, merged into existing person model | Nothing — foundational | ✅ Done |
| 2 · Campaign Send & Tracking | Persisted campaigns (+ management/undo), role targeting, tracked link, open/click/completion funnel, dashboard + export | Phase 1 (for LinkedIn recipients) | 🟡 In progress — campaigns persist & are manageable; tracking/send/dashboard not yet built |
| 3 · Automated Follow-Up | One 3-day nudge, skipped if already clicked/completed | Phase 2 (needs recipient status) | Not started |
| 4 · Relationship Maintenance | Calendar-sourced meeting history, staleness view, tagged intro-outreach track | Phase 2 (reuses send infra) | Not started |

---

## Phase 1 — LinkedIn Import ✅ Done

Solves problem 1 — the majority of your contacts live on LinkedIn and are invisible to yaCRM today. Nothing downstream works without this.

**What exists today**
- `contact.source` is an enum that already lists `linkedin` alongside `gmail`, `hotmail`, `sms` — it was designed in from the start, just never fed.
- `findOrCreateContact(source, address, status)` and the person-merge suggestion engine (name similarity + email-heuristics) are source-agnostic: a LinkedIn contact flows through the exact same pipeline a Gmail contact does today.
- Gmail's importer (`gmail-import.ts` / `gmail-parsing.ts`) is the template to mirror for a LinkedIn importer.

**What's new**
- A one-time upload flow for LinkedIn's official **Connections CSV** (name, company, position, profile URL, connected-date) and **messages.csv** export — both come from LinkedIn's own "Download your data" tool, so no scraping or unofficial API.
- A parser that maps each row to `findOrCreateContact('linkedin', profileUrl, 'active')`, and a best-effort thread reconstruction from `messages.csv` into `event` rows (in/out direction, body text) so message history feeds the same embeddings pipeline as email.
- Re-running an import updates existing LinkedIn contacts' role/company rather than duplicating them (matched on profile URL, same idea as `sourceMessageId` dedupe for email).

**Explicitly out of scope**
- Automated/live sync with LinkedIn (no API access, no scraping) — import stays a manual, repeatable upload.
- Full message-thread fidelity — LinkedIn's messages export is not always cleanly threaded; treat recovered history as best-effort context, not a source of truth.

---

## Phase 2 — Campaign Send & Tracking 🟡 In progress

Solves problems 2 and 3 — targeting LinkedIn contacts by current role, and turning the AI-interview outreach into a measurable funnel instead of a one-off send you track by memory.

**What exists today**
- `campaign-ranking.ts` already ranks people against a free-text goal by `similarity×0.6 + recency×0.25 + engagement×0.15`, and `draft-generation.ts` writes a personalized message per person. This is exactly the mechanism problem 2 needs for "target by current role" — no new targeting logic required, just a role-flavored goal string.
- `gmail-send.ts` sends via the Gmail API and logs a `recordSentEvent`. This becomes the email leg of the send.

Gap: a "campaign" today is a request-time string, not a saved thing. There's no Campaign, no per-recipient send record, and no tracking field anywhere — all of the below is new schema, not a rework.

**Decisions locked**
- *Targeting*: Role targeting reuses the existing semantic ranker as-is — type a description ("engineering managers at seed-stage startups") rather than building a title taxonomy.
- *Send channel*: Email sends automatically once an address exists. LinkedIn sends go through a drafted **copy-assist queue**: yaCRM writes the message, you click through and paste it into LinkedIn, one click logs it "sent." Browser-extension-assisted sending is explicitly **out of scope** — not a fast-follow, not planned.
- *Send volume*: Outreach is scoped to **1st-degree LinkedIn connections only**. LinkedIn's messaging limits for existing connections are not the same throttled cap that applies to connection requests to strangers, so no daily send-cap logic is needed in the copy-assist queue.

**The funnel, per channel**

| Stage | Email | LinkedIn |
|---|---|---|
| Sent | Auto (Gmail API) | Manual mark after copy-paste |
| Opened | Tracking pixel | Not tracked — no read-receipt API available; omitted rather than faked |
| Clicked | Tracked interview link | Tracked interview link (same mechanism) |
| Completed | Webhook from the interview tool | Webhook from the interview tool (same mechanism) |

**What's new**
- `campaign` and `campaign_recipient` tables: a persisted goal, generated draft, channel, and status (drafted → sent → opened → clicked → completed) per person. ✅ Built.
- Full campaign/recipient management, not just creation: add people to an *existing* campaign, remove a recipient, delete a whole campaign — each reversible via an "Undo" link available immediately after the action (not a persistent undo-anytime history; navigate away and it's gone). ✅ Built — this grew out of using the persisted-campaign feature in practice, not the original plan, but fits squarely under "campaign send & tracking" as basic list hygiene.
- A per-recipient tracked link (unique token appended to the AI-interview URL) plus a redirect endpoint that logs the click and forwards to the real tool. *Not yet built.*
- An email open pixel embedded in the Gmail send. *Not yet built.*
- A completion webhook receiver from the AI-interview tool, matched back to the recipient by token. *Not yet built.*
- A campaign dashboard (sent/opened/clicked/completed counts and per-contact status) plus a CSV export of the same data. *Funnel counts are visible per campaign already; CSV export not yet built.*

---

## Phase 3 — Automated Follow-Up

Solves problem 4. Depends entirely on Phase 2's per-recipient status existing — there is nothing to "follow up on" until sends and clicks are tracked.

**Rule**: A scheduled job checks recipients whose status is still `sent` after 3 days. If so, it generates and sends exactly one follow-up nudge, then marks the recipient `followed_up` so it never fires twice.

Skip conditions, checked at fire time:
- Recipient status is already `clicked` or `completed` — they engaged, don't nag them.

Note: a reply on email or LinkedIn is *not* currently a skip condition — v1 has no reply-detection wired up. If that turns out to cause awkward follow-ups to people who already responded, that's the natural v1.1 addition.

---

## Phase 4 — Relationship Maintenance

Solves problems 5 and 6 — generic networking outreach and knowing who's gone quiet. Grouped together because both are about relationship *state over time* rather than a single send.

**What exists today**: Google OAuth is already wired for Gmail (`google.ts`), but scoped to Gmail only — no Calendar access yet. Nothing meeting-related exists in the schema.

**What's new — Meetings (#6)**
- Extend the existing Google OAuth scope to include read-only Calendar access.
- A `meeting` table, populated by matching calendar-event attendees to `contact` emails.
- When an attendee's email doesn't match any existing contact, create a new `contact` (source `google_calendar`) using the name Calendar supplies for that attendee — the same treatment a new Gmail sender gets today. This means an unmatched attendee isn't a silent miss: the existing name-similarity merge-suggestion engine (already source-agnostic) will surface it as a suggested merge against the matching Person, exactly like a Gmail/LinkedIn duplicate does now, and you confirm it through the same review flow. The one case this doesn't catch is an attendee with no display name on their Google profile — just a bare email Calendar can't attach a name to — which stays an unmatched contact until merged by hand; no special-casing needed beyond that.
- A "last touched" view per person — most recent of last meeting, last inbound event, last outbound event — sortable to surface contacts gone quiet.

**What's new — Intro outreach (#5)**
- Reuses Phase 2's send/draft infrastructure as a second, lighter-touch message track (generic "let's connect" rather than interview-link).
- Audience is a manually tagged list, not a rule-based segment — you decide who's in.
- Same channel handling as Phase 2: email auto-sends, LinkedIn goes through the copy-assist queue.

---

## Open Questions

None outstanding as of rev. 2 — see resolutions below.

### Resolved (rev. 2)

1. **LinkedIn send volume** — scope is 1st-degree connections only, so the connection-request throttling that prompted this question doesn't apply. No send-cap logic needed.
2. **Browser-extension send** — out of scope, full stop. Phase 2's LinkedIn leg stays the manual copy-assist queue indefinitely; not revisited as a fast-follow.
3. **Calendar attendee matching** — resolved by reusing the existing merge-suggestion engine rather than building new matching logic: an attendee who doesn't match an existing contact by email becomes a new contact (source `google_calendar`) named from what Calendar provides, and falls into the same name-similarity merge-suggestion review you already use for Gmail/LinkedIn duplicates. Only a nameless bare-email attendee falls through this, and that's an acceptable, narrow edge case rather than a general miss-matching problem.
