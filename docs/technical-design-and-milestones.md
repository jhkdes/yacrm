# Technical Design & Milestones — Outreach Roadmap

Companion to [`outreach-roadmap.md`](./outreach-roadmap.md). That doc says *what* and *why*; this one says *how*, broken into milestones that continue the existing `M1–M14` numbering, each shippable and independently testable without the ones after it.

## Conventions this design follows (already established in the codebase)

- **Schema**: Drizzle, `src/db/schema.ts`. Enums via `pgEnum`, identity PKs, `unique()` composite constraints, `relations()` blocks.
- **Lib functions split three ways**, same as `campaign-ranking.ts` / `draft-generation.ts` / `gmail-send.ts`:
  - **Pure** functions (no I/O) — unit tested directly.
  - **DB-only** functions (take `db`, no external API calls) — tested against a real Postgres via `pglite`.
  - **Full-pipeline** functions (call Anthropic/Voyage/Gmail/etc.) — not unit tested; verified manually via a `scripts/*.ts` script.
- **Routes**: App Router. Data-fetching pages are server components (`src/app/<feature>/page.tsx`). Mutations are Server Actions in `src/app/actions.ts`, invoked from `<form action={...}>`. Route Handlers (`src/app/api/**/route.ts`) are reserved for things that aren't page navigations or form posts — OAuth callbacks, health checks, and (new in this doc) webhooks and a cron entry point.
- **Tests**: `vitest`, colocated `*.test.ts` next to source.

Every milestone below states its test plan in these terms: what's a `*.test.ts` unit test, what's a `*.test.ts` pglite integration test, and what's manual (script or UI walkthrough) — mirroring how `campaign-ranking.test.ts` vs. `rankPeopleForCampaign` (untested, has `scripts/rank-campaign.ts`) already split.

---

## Milestone overview

| # | Milestone | Status | Phase | Depends on | Proves |
|---|---|---|---|---|---|
| M15 | LinkedIn connections import | ✅ Done | 1 | — | Contacts appear, merge suggestions fire against existing Gmail contacts |
| M16 | LinkedIn messages import | ✅ Done | 1 | M15 | Message history appears on a person's timeline with embeddings |
| M17 | Campaign & recipient schema, incl. campaign/recipient management + undo | ✅ Done | 2 | — | A campaign persists; ranking/drafting write real rows instead of vanishing on refresh; adding/removing people and deleting a campaign are all reversible immediately after the action |
| M18 | Tracked link + click capture | 2 | M17 | Hitting a recipient's tracked link redirects and flips their status to `clicked` |
| M19 | Email send wired to tracking | 2 | M17, M18 | Sending a real email marks `sent`, and an open registers via the pixel |
| M20 | Completion webhook | 2 | M17 | A synthetic completion POST flips a recipient to `completed` |
| M21 | LinkedIn copy-assist queue | 2 | M17 | Walking the queue and clicking "mark sent" flips status without touching email code |
| M22 | Campaign dashboard + CSV export | 2 | M17–M21 | Funnel counts on screen match a hand-computed total from seeded data |
| M23 | 3-day follow-up job | 3 | M17–M21 | Running the job against fixture data sends exactly the recipients past 3 days who haven't clicked/completed |
| M24 | Calendar read + meeting import | 4 | — | Calendar events land as `meeting` rows with attendees linked |
| M25 | Attendee-to-contact matching | 4 | M24 | An unmatched attendee becomes a contact and a merge suggestion appears |
| M26 | Last-touched staleness view | 4 | M24, M25 | Sorting people by last-touched matches a hand-computed answer from fixture events/meetings |
| M27 | Tagged intro-outreach track | 4 | M17–M21 | Tagging people and launching an "intro" campaign only reaches tagged people |

Phases 1 and the schema half of Phase 2 (M15, M17) have no dependencies on each other and can be built in either order or in parallel.

---

## Phase 1 — LinkedIn Import

### M15 — LinkedIn connections import ✅

**Schema**: none — `contact.source` already has `"linkedin"`.

**Shipped as** `src/lib/linkedin-import.ts`, mirroring `gmail-import.ts`:
- `parseConnectionsCsv(csvText: string): { rows, rowsSkippedNoUrl }` — **pure**. Parses LinkedIn's `Connections.csv` (columns: First Name, Last Name, URL, Email Address, Company, Position, Connected On) using the `csv-parse` package (added as a dependency — quoted/embedded-comma fields like the Position column need real CSV parsing, not `split(",")`). LinkedIn's export prepends a "Notes:" preamble before the header row; the parser locates the header row and slices from there.
- `importLinkedInConnections(db, rows): Promise<LinkedInImportSummary>` — **DB-only**. For each row, calls `findOrCreateContact(db, "linkedin", { identifier: profileUrl, name }, "active")` — **active**, not the function's default, since a 1st-degree LinkedIn connection is a mutual relationship by definition, unlike an unreplied email. Also writes a synthetic "profile" `event` (`"{position} at {company}"`, `sourceMessageId: "linkedin-profile:{contactId}"`, upserted on re-import) purely so the existing embedding/ranking pipeline has *something* to target a LinkedIn-only contact by role on — without it, a connection with no message history would be invisible to Phase 2's role-based targeting.

**Wiring**: `src/app/import/linkedin/page.tsx` — file upload form. `importLinkedInConnectionsAction` in `actions.ts`.

**Related fix, surfaced by this milestone**: importing real LinkedIn contacts pushed the total Contact count into the low thousands, which exposed an O(n²) all-pairs-plus-edit-distance cost in `generateMergeSuggestions` (`src/lib/merge-suggestions.ts`) — the `/merges` page became slow to load. Fixed by replacing the all-pairs scan with an inverted-index candidate-generation pass (bucket Contacts by exact identifier and by name-shaped tokens, only score pairs sharing a bucket) — turns the common case from O(n²) into roughly O(n) while preserving every existing match signal (exact/fuzzy/initial-abbreviated name match, identifier-spells-out-name in either direction). Not a new milestone, just a scaling fix to existing M8 logic that this milestone's data volume made visible.

**Test plan** (as built):
- Unit: `linkedin-import.test.ts` — `parseConnectionsCsv` against the real sample export shape (Notes: preamble, embedded comma in a quoted field, missing/present email, trailing-slash URL normalization).
- Integration (pglite): idempotent re-import (no duplicate Contacts/Events, profile Event body updates on a changed position); a LinkedIn contact sharing a name with an existing Gmail contact surfaces via `generateMergeSuggestions`.
- Manual: uploaded via `/import/linkedin` against a real (redacted) export.

### M16 — LinkedIn messages import ✅

**Schema**: none — reuses `event`.

**Shipped as** `src/lib/linkedin-messages-import.ts`:
- `parseMessagesCsv(csvText): { rows, rowsSkippedEmptyContent, rowsSkippedBadDate }` — **pure**. LinkedIn's `messages.csv` has one row per message (conversation ID, sender, recipient, date, content), quoted per-field (including the header row — the header-detection marker has to include the leading quote, or slicing from it corrupts the first field for `csv-parse`). Handles genuinely multi-line quoted `CONTENT` fields.
- `resolveMessageDirection(row, ownProfileUrl)` — **pure**. **Deviates from the original plan**: direction is resolved by comparing the row's sender/recipient profile URL against an explicitly-supplied `ownProfileUrl`, not by comparing sender *name* to the account owner's name as originally sketched. LinkedIn's export has no OAuth-account concept telling the importer who "you" are, and inferring it from message frequency (e.g. "whichever profile appears in the most rows") turned out to be fragile — a single-conversation export has both participants appearing with identical frequency, and a wrong guess would silently flip every inbound/outbound label. The import form (`/import/linkedin`) just asks for your profile URL once. Also skips group conversations (more than one recipient) and rows where neither side matches.
- `importLinkedInMessages(db, rows, ownProfileUrl): Promise<LinkedInMessagesImportSummary>` — **DB-only**. Same pending/active two-way-detection logic as `gmail-import.ts` (via the existing, source-agnostic `hasOppositeDirectionHistory`), per-message `sourceMessageId` synthesized as `linkedin-msg:{conversationId}:{occurredAt}:{occurrenceIndex}` since LinkedIn's export has no stable per-message id, only a per-conversation one.

**Wiring**: extends `/import/linkedin/page.tsx` with a second upload section (file + "Your LinkedIn profile URL"). `importLinkedInMessagesAction` in `actions.ts`.

**Related fix, surfaced by this milestone**: a real `messages.csv` export (years of DM history) can exceed Next.js Server Actions' default 1MB request-body cap, which fails client-side as an opaque "Failed to fetch" rather than a helpful error. Fixed by raising `experimental.serverActions.bodySizeLimit` to `20mb` in `next.config.ts` (confirmed against this repo's own bundled Next.js docs, since `AGENTS.md` flags this install as a non-stock version).

**Test plan** (as built):
- Unit: `parseMessagesCsv` and `resolveMessageDirection` against the real sample conversation (multi-line content, group-conversation skip, neither-side-matches skip).
- Integration (pglite): one Contact + one Event per message; pending status when only one direction appears and no prior history exists; idempotent re-import.
- Manual: uploaded via `/import/linkedin`.

---

## Phase 2 — Campaign Send & Tracking

### M17 — Campaign & recipient schema, plus campaign/recipient management ✅

Shipped scope grew beyond the original sketch: alongside persisting campaigns, this milestone ended up covering the full lifecycle a user actually needed once they could see persisted campaigns — adding people to an *existing* campaign (not just a new one), removing a recipient, and deleting a campaign outright, each reversible immediately after the action.

**Schema, as actually shipped** (`src/db/schema.ts`, migrations `0007`–`0009`):

```ts
export const campaignTypeEnum = pgEnum("campaign_type", [
  "interview_link",
  "intro",
]);

export const campaignRecipientChannelEnum = pgEnum("campaign_recipient_channel", [
  "email",
  "linkedin",
]);

export const campaignRecipientStatusEnum = pgEnum("campaign_recipient_status", [
  "drafted",
  "sent",
  "opened",
  "clicked",
  "completed",
]);

export const campaign = pgTable("campaign", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  goal: text("goal").notNull(), // fed to rankPeopleForCampaign / generateDraftForPerson
  type: campaignTypeEnum("type").notNull().default("interview_link"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete — see below
});

export const campaignRecipient = pgTable(
  "campaign_recipient",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    campaignId: integer("campaign_id").notNull().references(() => campaign.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull().references(() => person.id),
    contactId: integer("contact_id").notNull().references(() => contact.id),
    channel: campaignRecipientChannelEnum("channel").notNull(),
    status: campaignRecipientStatusEnum("status").notNull().default("drafted"),
    draftSubject: text("draft_subject"),
    draftBody: text("draft_body").notNull(),
    trackingToken: text("tracking_token").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    followedUpAt: timestamp("followed_up_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete — see below
  },
  (table) => [
    unique().on(table.campaignId, table.personId),
    unique().on(table.trackingToken),
  ],
);
```

`followedUpAt` is deliberately separate from `status` — a follow-up doesn't move a recipient backward through the funnel, it's an orthogonal fact ("we nudged them") checked by M23.

**`deletedAt` / soft delete, and what "undo" means here**: a Campaign's drafted content and a recipient's real send/click history have no external source of truth to fall back on (unlike, say, a purged Gmail Contact, whose messages still exist on Gmail's servers and get recreated by the next import) — so a hard delete would be genuine, permanent data loss. Both tables carry a nullable `deletedAt` instead. Deliberately **not** a persistent trash/restore browsing UI, though — undo is scoped to a single request: the redirect immediately after a delete/remove carries the id needed to undo it as a query param (e.g. `?campaign_deleted=1&undo_campaign_id=7`), which renders a one-shot "Undo" link/button. Navigate anywhere else and that link — along with the query param driving it — is gone; the row stays soft-deleted (invisible, but not gone) rather than becoming browsable again. `ON DELETE CASCADE` on `campaignRecipient.campaignId` is kept as a DB-level safety net for a genuine hard delete (not currently triggered by any app code path, since `deleteCampaign` only soft-deletes).

**`src/lib/campaigns.ts`**:
- `createCampaign(db, name, goal, type)` — **DB-only**.
- `addRecipients(db, campaignId, people, channel): Promise<AddRecipientsResult>` — **DB-only**. For each person: finds their active Contact on the requested channel (skips if none), generates a draft via `generateDraftForPerson` against **the campaign's own persisted goal** (not a separately-passed one, so a recipient's draft can never drift from the campaign it belongs to), issues a fresh `trackingToken`. Uses `INSERT ... ON CONFLICT (campaignId, personId) DO UPDATE ... WHERE deletedAt IS NOT NULL` — a conflict against an *active* existing recipient is a true no-op (`skippedAlreadyRecipient`), but a conflict against a *soft-deleted* one revives it with a fresh draft/token instead of erroring, so re-adding someone you'd previously removed (outside of clicking Undo) just works.
- `removeRecipient(db, campaignId, recipientId)` / `restoreRecipient(db, campaignId, recipientId)` — soft-delete / undo a single recipient, scoped to both ids so a tampered form field can't touch the wrong campaign's recipient.
- `deleteCampaign(db, campaignId)` / `restoreCampaign(db, campaignId)` — soft-delete / undo a whole campaign. Recipients are untouched by either call — they simply become unreachable through a soft-deleted campaign and reachable again once it's restored.

**Wiring**:
- `src/app/campaigns/page.tsx` — ranks people, lets the user check who to target, and either creates a new campaign (`createCampaignAction`) or, when arrived at via a campaign's "Add more people" link (carries `?campaignId=`), adds to that existing campaign instead (`addRecipientsToCampaignAction`) — same checkbox UI, different Server Action based on whether a target campaign is present. Also lists non-deleted campaigns with an inline Delete button.
- `src/app/campaigns/[id]/page.tsx` (new) — a soft-deleted campaign 404s here like a genuinely missing one. Shows funnel counts and each non-deleted recipient's draft, a "Remove from campaign" button per recipient, a "Delete this campaign" button, and renders the one-shot Undo flash described above when the relevant query params are present.
- All queries that list campaigns or recipients filter `deletedAt IS NULL` (via Drizzle's relational `with: { recipients: { where: ... } }`).

**Test plan** (as built, `campaigns.test.ts`, 21 tests):
- Integration (pglite): `createCampaign` + `addRecipients` persistence; channel-based Contact selection (skips `pending` contacts and people with no Contact on the requested channel); idempotent re-add; the campaign's own goal (not a caller-supplied one) drives drafting; soft-delete/restore round-trips for both recipient and campaign, including the revive-on-conflict path and the cascade-preserves-recipients behavior.
- Manual: `npm run db:list-campaigns` (new script) to inspect campaign/recipient state from the CLI without opening the browser; full walkthrough at `/campaigns` — create, add-to-existing, remove-with-undo, delete-with-undo.

### M18 — Tracked link + click capture

**New route handler** `src/app/api/r/[token]/route.ts`:
- `GET`: look up `campaign_recipient` by `trackingToken`. If found and `status` is `"sent"` or `"opened"`, set `status: "clicked"`, `clickedAt: now`. Redirect (302) to the real AI-interview URL (with the recipient's identity passed through however that tool expects, e.g. as a query param). If the token is unknown, redirect to a generic fallback rather than erroring — a stale/tampered link shouldn't dead-end the recipient.

**Test plan**:
- Integration (pglite + route handler test): seed a `campaign_recipient` with `status: "sent"`, `GET` the route with its token, assert a 302 and that `status` is now `"clicked"`.
- Integration: an unknown token still redirects (to the fallback), doesn't 500.
- Manual: click a real generated link end to end once the interview tool's real URL is known.

### M19 — Email send wired to tracking

**Changes to `src/lib/gmail-send.ts`**:
- `buildRawEmail` gets an optional `trackingPixelUrl` param appended as an `<img>` tag in the HTML body — **pure**, extend the existing unit test.
- New: `src/app/api/pixel/[token]/route.ts` — `GET` returns a 1x1 transparent GIF; as a side effect, if the recipient's `status` is `"sent"`, sets `status: "opened"`, `openedAt: now`.
- `approveAndSendDraft` (or a new `sendCampaignRecipient(db, recipientId)` wrapping it) rewrites the draft body to inline the M18 tracking link and the M19 pixel before sending, then sets `campaign_recipient.status: "sent"`, `sentAt: now`.

**Test plan**:
- Unit: `buildRawEmail` includes the pixel `<img>` tag when a URL is passed.
- Integration (pglite): the pixel route flips `sent → opened` but does *not* downgrade an already-`clicked` recipient (order of arrival between pixel and click shouldn't matter — `opened` should only apply the `sent → opened` transition, never overwrite `clicked`/`completed`).
- Manual: send a real campaign email to yourself, confirm the open registers on load and the link click registers on click (`scripts/send-test-campaign-email.ts`).

### M20 — Completion webhook

**New route handler** `src/app/api/webhooks/interview-complete/route.ts`:
- `POST`, body includes the tracking token (passed through the M18 redirect as a query param, echoed back by the interview tool's webhook payload). Looks up the recipient, sets `status: "completed"`, `completedAt: now`, regardless of current status (completion is terminal and should win over any funnel state).
- Protected by a shared secret header, since this is a public endpoint the interview tool calls.

**Test plan**:
- Integration: `POST` with a valid token + secret flips status to `completed`; missing/wrong secret returns 401 and makes no DB change; unknown token returns 404.
- Manual: only fully verifiable once the real interview tool's webhook shape is known — flagged as a dependency, not a blocker (contract can be stubbed and swapped).

### M21 — LinkedIn copy-assist queue

**New page** `src/app/campaigns/[id]/linkedin-queue/page.tsx`: lists this campaign's `channel: "linkedin"` recipients with `status: "drafted"`, showing each draft with a copy-to-clipboard button and the recipient's LinkedIn profile URL (opens in a new tab). A "Mark sent" Server Action (`markLinkedinRecipientSentAction` in `actions.ts`) sets `status: "sent"`, `sentAt: now` — no pixel, no email; `openedAt` never populates for LinkedIn recipients by design (per the roadmap's funnel table).

**Test plan**:
- Integration (pglite): `markLinkedinRecipientSentAction` flips exactly the targeted recipient, leaves others untouched.
- Manual: walk the queue for a real small campaign, confirm the copy button and profile links work.

### M22 — Campaign dashboard + CSV export

**New module** `src/lib/campaign-reporting.ts`:
- `summarizeCampaign(recipients: CampaignRecipientRow[]): CampaignFunnelSummary` — **pure**: counts per status per channel. Unit tested directly against a hand-built fixture array — this is the "hand-computed total" check from the milestone table.
- `recipientsToCsv(recipients): string` — **pure**.

**Wiring**: `src/app/campaigns/[id]/page.tsx` renders `summarizeCampaign` output as a funnel table. `src/app/api/campaigns/[id]/export/route.ts` — `GET` streams `recipientsToCsv` output with a `Content-Disposition: attachment` header.

**Test plan**:
- Unit: `summarizeCampaign` and `recipientsToCsv` against fixtures covering every status/channel combination.
- Manual: open the dashboard against a seeded campaign, cross-check the numbers by eye, download the CSV and open it.

---

## Phase 3 — Automated Follow-Up

### M23 — 3-day follow-up job

**New module** `src/lib/follow-up.ts`:
- `needsFollowUp(recipient: CampaignRecipientRow, now: Date): boolean` — **pure**: `true` iff `status` is `"sent"` or `"opened"` (opening the email isn't the engagement signal the roadmap's skip rule cares about — only a click or a completion is), `sentAt` is ≥ 3 days before `now`, and `followedUpAt` is null.
- `findRecipientsNeedingFollowUp(db, now = new Date()): Promise<CampaignRecipientRow[]>` — **DB-only**, filters in SQL then double-checks with `needsFollowUp` for the exact boundary logic.
- `sendFollowUps(db, now = new Date()): Promise<FollowUpSummary>` — **full-pipeline**: for each recipient from the finder, generates a short nudge draft (reusing `generateDraftForPerson` with an amended goal like `"${originalGoal} — brief follow-up reminder"`), sends via the M19/M21 path matching the recipient's channel, sets `followedUpAt: now`.

**New route handler** `src/app/api/cron/follow-ups/route.ts` — `POST`, requires a shared-secret bearer header, calls `sendFollowUps(db)`. This is genuinely new infrastructure (the codebase has no scheduler today); it's a plain authenticated endpoint so it can be driven by whatever's available at deploy time (Vercel Cron, an OS-level scheduled task, or a one-line `curl` in a cron job) without coupling the app to one scheduler.

**Test plan**:
- Unit: `needsFollowUp` against fixtures for every status × age combination — this is the core logic and it's fully pure, so it's the cheapest and most important test in this milestone.
- Integration (pglite): `findRecipientsNeedingFollowUp` against seeded rows with controlled `sentAt`/`status`/`followedUpAt` values.
- Manual: `scripts/run-follow-ups.ts` invoking `sendFollowUps` directly against real data once ready to trust it unattended; only wire the actual cron trigger after that's been eyeballed at least once.

---

## Phase 4 — Relationship Maintenance

### M24 — Calendar read + meeting import

**Schema additions**:

```ts
// Extend the existing enum
export const sourceEnum = pgEnum("source", [
  "gmail",
  "hotmail",
  "linkedin",
  "sms",
  "google_calendar",
]);

export const meeting = pgTable(
  "meeting",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    googleEventId: text("google_event_id").notNull(),
    title: text("title"),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.googleEventId)],
);

export const meetingAttendee = pgTable(
  "meeting_attendee",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    meetingId: integer("meeting_id").notNull().references(() => meeting.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").notNull().references(() => contact.id),
  },
  (table) => [unique().on(table.meetingId, table.contactId)],
);
```

**Changes to `src/lib/google.ts`**: add `https://www.googleapis.com/auth/calendar.readonly` to `GMAIL_SCOPES` (rename to `GOOGLE_SCOPES` or add a second exported const — existing connected accounts will need to re-consent, so this ships with a UI prompt to "reconnect Google" rather than silently failing on the old token).

**New module** `src/lib/calendar-import.ts`:
- `parseCalendarEvent(raw: calendar_v3.Schema$Event): ParsedMeeting | null` — **pure**: extracts title/start/end/attendee emails+names; returns `null` for events with no attendees (declining to treat solo blocked-time as a "meeting").
- `importCalendarEvents(db, events: ParsedMeeting[]): Promise<ImportSummary>` — **DB-only**: upserts `meeting` by `googleEventId`, resolves each attendee to a contact (this is M25's job — M24 can stub it as "find existing contact by email or skip").

**Test plan**:
- Unit: `parseCalendarEvent` against fixture Calendar API JSON, including a no-attendee event (returns `null`) and one with an attendee that has no `displayName`.
- Integration (pglite): `importCalendarEvents` against a fixture event whose attendee email matches an existing contact links them correctly.
- Manual: connect a real (test) calendar, confirm meetings show up.

### M25 — Attendee-to-contact matching

**Changes to `src/lib/calendar-import.ts`**: when an attendee's email doesn't match any existing `contact.sourceIdentifier`, call `findOrCreateContact(db, "google_calendar", { identifier: email, displayName: attendee.name }, "active")` — reusing the exact function M15 uses, no new matching logic. This is the resolution from the roadmap doc: the existing name-similarity merge-suggestion engine (`generateMergeSuggestions`, already source-agnostic) picks up the rest.

**Test plan**:
- Integration (pglite): importing a meeting with an attendee sharing a name with an existing Person (different email, different source) results in `generateMergeSuggestions` flagging the pair — same assertion shape as M15's merge test, different source.
- Manual: verify with a real calendar invite from someone already in the CRM under a different email.

### M26 — Last-touched staleness view

**New module** `src/lib/last-touched.ts`:
- `computeLastTouched(events: { occurredAt: Date }[], meetings: { startTime: Date }[]): Date | null` — **pure**: max of all provided timestamps.
- `listPeopleByLastTouched(db): Promise<PersonWithLastTouched[]>` — **DB-only**.

**Wiring**: `src/app/people/page.tsx` gains a sort-by-last-touched option and a "quiet for 30+/60+/90+ days" filter.

**Test plan**:
- Unit: `computeLastTouched` against fixtures (events only, meetings only, both, neither → `null`).
- Manual: sort `/people` by last-touched, spot-check the top and bottom entries against the DB.

### M27 — Tagged intro-outreach track

**Schema addition**:

```ts
export const personTag = pgTable(
  "person_tag",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    personId: integer("person_id").notNull().references(() => person.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.personId, table.tag)],
);
```

**Wiring**: a tag-toggle control on `/people/[id]` (Server Action `toggleTagAction`). `/campaigns/page.tsx` gains a "target a tag" mode alongside the existing free-text-goal ranking: selecting a tag instead of ranking calls `addRecipients` directly with everyone carrying that tag, `campaign.type: "intro"`, skipping `rankPeopleForCampaign` entirely (there's nothing to rank — the audience is already explicit, per the roadmap's decision that this is a manually curated list, not a rule-based segment).

**Test plan**:
- Integration (pglite): tagging 2 of 5 people and launching an intro campaign against that tag produces exactly 2 `campaign_recipient` rows.
- Manual: full walkthrough — tag a couple of test contacts, launch, confirm only they appear in the queue/dashboard.

---

## What "independently testable" means per milestone

Every milestone above ships with at least one of:
1. A **pure-function unit test** (fastest, no infra) wherever the milestone has decision logic (`needsFollowUp`, `computeLastTouched`, `summarizeCampaign`, CSV parsers).
2. A **pglite integration test** wherever the milestone touches the DB (contact creation, status transitions, uniqueness constraints).
3. A **manual walkthrough or script** wherever the milestone's core value depends on a real external system (actual LinkedIn export, actual Gmail send, actual interview-tool webhook) that pglite/vitest can't stand in for.

None of the milestones require the ones after them to be present to verify (1) and (2) — fixtures substitute for upstream milestones' data. (3) is the exception by nature: verifying a real send or a real webhook needs the real thing on the other end, which is why the roadmap doc flags the interview-tool webhook contract as a dependency rather than a blocker.
