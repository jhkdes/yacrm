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
| 5 · Campaign Targeting Rework | Richer goal capture, structured (non-semantic) filtering on LinkedIn-derived title/seniority/function/industry, wider candidate pool, in-app candidate detail + LinkedIn link | Phase 1 (extends the LinkedIn importer) | Not started |

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
- A per-recipient tracked link (unique token appended to the AI-interview URL) plus a redirect endpoint that logs the click and forwards to the real tool. ✅ Built — and now deployed as its own small public app (`apps/redirect`), not just a route in this app; see the security note below for why.
- An email open pixel embedded in the Gmail send, and the real Gmail send itself wired up (draft → tracked link + pixel embedded → sent via Gmail → status advances to `sent`). ✅ Built.
- A completion webhook receiver from the AI-interview tool, matched back to the recipient by token. ✅ Built against the tool's real integration contract (a secret URL segment for auth, `tracking_id` query-param passthrough) — see M20 in `technical-design-and-milestones.md`.
- A campaign dashboard (sent/opened/clicked/completed counts and per-contact status) plus a CSV export of the same data. *Funnel counts are visible per campaign already; CSV export not yet built.*

**Security note, surfaced while building this phase**: getting the tracked link/pixel actually working for a real recipient meant this app could no longer stay purely local — Supabase became the app's real database (not just an operational copy), and a small separate app (`apps/redirect`) got deployed publicly to host the two tracking routes, since a deployed service can't reach `127.0.0.1`. Reconsidering whether the *main* app should also deploy (for easier manual testing) led to briefly deploying it with no authentication at all — Vercel's free-tier "Vercel Authentication" protection turns out to explicitly exclude a project's production custom domain, protecting only preview/deployment URLs, which isn't obvious until checked directly. The gap was live for a period with real Gmail access exposed to anyone with the URL. Fixed with an app-level password gate that doesn't depend on Vercel's own protection. Worth knowing if this app is ever deployed again from scratch: verify the *actual* production domain is gated, not just a `*.vercel.app` preview URL — they can behave differently.

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

## Phase 5 — Campaign Targeting Rework

Solves three problems surfaced by actually using Phase 2's targeting in practice: (1) a one-line campaign goal can't express real targeting intent, (2) the candidate pool is both too narrow (excludes anyone without prior message history) and biased toward people already contacted recently, (3) suggested people show no context (title, company) and no path to their LinkedIn profile without losing the list.

**What exists today**
- `campaign.goal` (free text) and `campaign-ranking.ts`'s `similarity×0.6 + recency×0.25 + engagement×0.15` scoring, per Phase 2.
- `loadCandidates` (`campaign-ranking.ts`) requires an *active* `contact` **and at least one `event`** — a LinkedIn 1st-degree connection with no message history is invisible to targeting today, even though Phase 1 already imports them.
- The LinkedIn connections importer (`linkedin-import.ts`, Phase 1/M15) already captures name, company, position, profile URL, connected-date per row, but only writes a synthetic profile `event` for embedding purposes — it doesn't persist structured title/company/industry fields.

**Decisions locked**
- *Goal capture*: the free-text goal field stays (still feeds drafting) — it's not replaced by a form. An LLM call drafts a **structured, editable filter** (title/seniority/function/industry, per the fixed taxonomies below) from the goal text; the user reviews and edits the *filter*, not the prose, before it runs.
- *Targeting mechanism*: candidate selection becomes a **pure deterministic structured filter** — no embedding/semantic ranking step, no LLM involved in picking or scoring individual people. This reverses Phase 2's semantic-ranking approach for targeting specifically, once the structured fields below exist to filter on directly.
- *Candidate pool*: drop the "must have an `event`" requirement — any person with an active LinkedIn contact is eligible, whether or not they've been messaged.
- *Recency/engagement weighting*: removed entirely from targeting. Recency of prior contact has no bearing on whether someone is a good campaign target.
- *Result ordering*: no ranking score to sort by. Unsorted by default (first-name), user can sort any column in the UI.
- *Empty/overbroad results*: UI surfaces a warning on 0 matches ("try loosening filters") and on very broad matches (e.g. hundreds of results), rather than silently returning either extreme.
- *Candidate visibility*: the suggestion list/table shows standardized title, company, seniority, industry, and last-interaction date per person. A side drawer shows full detail plus an "Open LinkedIn" link (opens the profile URL in a new tab — LinkedIn cannot be embedded in-app, it blocks iframing).

**What's new — LinkedIn import enrichment**
- Extends the existing importer (Phase 1) to persist, per person: raw title, LLM-standardized title, seniority, function (see [title-taxonomy.md](./title-taxonomy.md)), raw company name, rule-normalized company name (legal-suffix stripping only — e.g. "Inc.", "LLC", "Corp." — deliberately *not* fuzzy-merged further: "Amazon" and "AWS" stay distinct rather than risk merging genuinely different entities), and industry (see [industry-taxonomy.md](./industry-taxonomy.md)).
- Industry is inferred once per normalized company name via LLM (using the company's real-world identity, not per-person data) and cached — not re-inferred per person, and not re-inferred on re-import unless the normalized name is new. Company headcount is explicitly **not** inferred (it's volatile and unverifiable from a company name alone); no headcount field/filter exists.
- Title/seniority/function extraction runs once per person at import time, and only re-runs on re-import for rows that are new or whose raw title/company changed since the last import (a hash/diff against the previously imported row).
- **CSV-row-to-person matching** (for updating existing people vs. creating new ones): email exact match when the CSV row has one; otherwise fuzzy first/last-name match (accounting for common nickname equivalence — "Rob"/"Robert", "Nick"/"Nicholas" — and last-initial-only forms). Auto-merge only when exactly one confident candidate is found; an ambiguous or multi-candidate match is **not** auto-merged — it's surfaced as a suggested match for manual review, same pattern as the existing merge-suggestion engine. Once a person has been matched once, later re-imports match directly on our own previously-stored LinkedIn URL first (fast path), falling back to email/name only for people not yet seen.
- Both taxonomies use an explicit `unknown`/`other` value and an "if not confident, don't guess" rule — a wrong-but-plausible-looking classification silently corrupts filter results, where an unclassified one visibly signals a gap instead.

**Explicitly out of scope**
- Company headcount (or any other enrichment requiring a third-party data source) — not buildable from the LinkedIn CSV export alone, and not worth a paid enrichment integration at this stage.
- Any embedded/iframed LinkedIn profile view — not technically possible (LinkedIn blocks iframing); "Open LinkedIn" opens a new tab instead.
- Re-introducing semantic/embedding ranking anywhere in targeting — deliberately dropped in favor of a fully deterministic, debuggable filter.

---

## Open Questions

None outstanding as of rev. 2 — see resolutions below.

### Resolved (rev. 2)

1. **LinkedIn send volume** — scope is 1st-degree connections only, so the connection-request throttling that prompted this question doesn't apply. No send-cap logic needed.
2. **Browser-extension send** — out of scope, full stop. Phase 2's LinkedIn leg stays the manual copy-assist queue indefinitely; not revisited as a fast-follow.
3. **Calendar attendee matching** — resolved by reusing the existing merge-suggestion engine rather than building new matching logic: an attendee who doesn't match an existing contact by email becomes a new contact (source `google_calendar`) named from what Calendar provides, and falls into the same name-similarity merge-suggestion review you already use for Gmail/LinkedIn duplicates. Only a nameless bare-email attendee falls through this, and that's an acceptable, narrow edge case rather than a general miss-matching problem.
