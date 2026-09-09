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
| M18 | Tracked link + click capture | ✅ Done | 2 | M17 | Hitting a recipient's tracked link redirects and flips their status to `clicked` |
| M19 | Email send wired to tracking | ✅ Done | 2 | M17, M18 | Sending a real email marks `sent`, and an open registers via the pixel |
| M20 | Completion webhook | ✅ Done | 2 | M17 | A synthetic completion POST flips a recipient to `completed` |
| M21 | LinkedIn copy-assist queue | ✅ Done | 2 | M17 | Walking the queue and clicking "mark sent" flips status without touching email code |
| M22 | Campaign dashboard + CSV export | ✅ Done | 2 | M17–M21 | Funnel counts on screen match a hand-computed total from seeded data |
| M23 | 3-day follow-up job | ✅ Done | 3 | M17–M21 | Running the job against fixture data sends exactly the recipients past 3 days who haven't clicked/completed |
| M24 | Calendar read + meeting import | ✅ Done | 4 | — | Calendar events land as `meeting` rows with attendees linked |
| M25 | Attendee-to-contact matching | ✅ Done | 4 | M24 | An unmatched attendee becomes a contact and a merge suggestion appears |
| M26 | Last-touched staleness view | ✅ Done | 4 | M24, M25 | Sorting people by last-touched matches a hand-computed answer from fixture events/meetings |
| M27 | Tagged intro-outreach track | ✅ Done | 4 | M17–M21 | Tagging people and launching an "intro" campaign only reaches tagged people |

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

### M18 — Tracked link + click capture ✅

**Deviates from the original plan**: the tracked-link endpoint doesn't live only in this app. It was built twice, deliberately: `src/lib/click-tracking.ts` + `src/app/api/r/[token]/route.ts` here (Drizzle-based, kept as a local-testing fallback), and a hand-duplicated raw-SQL copy in `apps/redirect/src/click-tracking.ts` + `apps/redirect/src/app/[token]/route.ts` — a separate, minimal, independently-deployed Next.js app that's the one a real recipient's click actually reaches. This split happened because getting a real end-to-end test working surfaced that this app couldn't be both privately-run (for you) and publicly reachable (for recipients) at the same time on Vercel's free tier without real work — see `docs/outreach-roadmap.md` and the security note under M19 below for the fuller story. It also forced migrating the database itself off local-only PGlite onto Supabase, since a deployed app can't reach `127.0.0.1`.

**Shipped as**:
- `shouldRecordClick(status)` — **pure**: a click only ever advances `drafted`/`sent`/`opened` → `clicked`; never re-triggers on an already-`clicked` link (idempotent, doesn't reset `clickedAt`); never downgrades `completed`.
- `recordClick(db, token)` — **DB-only**: looks up the recipient joined with its campaign for `destinationUrl`; an unknown token or a campaign with no `destinationUrl` returns a fallback path (`/`) rather than erroring.
- The route handler is a thin wrapper redirecting to whatever `recordClick` resolves.

**Test plan** (as built): `click-tracking.test.ts` — pure `shouldRecordClick` cases, plus pglite-backed `recordClick` integration tests (unknown token, normal advance, idempotent re-click, completed-never-downgraded, no-destinationUrl fallback). Manually verified end to end twice: once locally against local PGlite, once for real against the deployed `apps/redirect` reading live Supabase data (seeded a real row, hit the live URL, confirmed the DB update).

### M19 — Email send wired to tracking ✅

**Shipped as**:
- `buildRawEmail` (`src/lib/gmail-send.ts`) gains optional `trackedLinkUrl`/`trackingPixelUrl` params. With neither set, behavior is byte-for-byte unchanged (plain-text single-part email) — existing tests keep passing untouched. With either set, it builds a `multipart/alternative` message: a plain-text part (original body + the bare tracked-link URL appended, since most clients auto-linkify a bare URL) and an HTML part (HTML-escaped body with `\n` → `<br>`, a real `<a href>` for the link, and the `<img>` pixel). Both are always sent together rather than conditionally choosing plain-vs-HTML — simpler than two code paths, and every "interview_link" send wants both signals anyway.
- `src/lib/open-tracking.ts` — `recordOpen(db, token)`, mirroring `click-tracking.ts`'s shape: only advances `"sent"` → `"opened"`; a nonexistent token, an already-`opened`/`clicked`/`completed` recipient, or (deliberately) a `"drafted"` one (never sent — a hit there would be spoofed, not a real open) are all no-ops.
- `src/lib/campaign-send.ts` — `sendCampaignRecipientEmail(db, accountId, recipientId)`, the actual orchestration: loads the recipient (must be `channel: "email"` and `status: "drafted"`, or throws `CampaignRecipientNotSendableError`), builds the tracked-link/pixel URLs from `REDIRECT_BASE_URL` (throws loudly if unset — a relative fallback is meaningless inside a real sent email, unlike the campaign-detail-page *display* case), sends via the existing `sendGmailMessage`, records the usual outbound `event` via `recordSentEvent` so it joins the Person's timeline like any other sent email, then sets `status: "sent"`, `sentAt: now`.
- Both `src/app/api/pixel/[token]/route.ts` (this app, local-testing fallback) and `apps/redirect/src/app/pixel/[token]/route.ts` (the real public path, same raw-SQL-duplication pattern as M18's click route) exist, for the same reason M18 needed both.
- UI: a "Send" button appears next to any `channel: "email"`, `status: "drafted"` recipient on `/campaigns/[id]`, calling `sendCampaignRecipientAction`.

**Test plan** (as built):
- Unit: extended `gmail-send.test.ts` for the multipart/link/pixel/escaping behavior.
- Integration (pglite): `open-tracking.test.ts` mirrors `click-tracking.test.ts`'s cases. `campaign-send.test.ts` mocks only the actual network call (`sendGmailMessage`) and `createGmailClient`, leaving `buildRawEmail`/`recordSentEvent` real — so it verifies the real tracked-link/pixel URLs get built and passed through, the real `event` row gets created, and the guard errors (not-found, wrong channel, already-sent, missing `REDIRECT_BASE_URL`) all fire correctly, without ever hitting Gmail's actual API.
- Manual: verified the pixel path the same way as M18's click path — real row seeded in Supabase, real HTTP hit against the deployed `apps/redirect` pixel route, confirmed the status flip.

**Related incident, surfaced by actually deploying for this milestone's testing**: reconsidering "should the main app also deploy" (to make manual testing easier) led to briefly deploying it publicly with no authentication at all — Vercel Authentication's free Hobby tier explicitly excludes a project's production custom domain from protection, only preview/deployment URLs, which isn't obvious until you check. The gap was live for a period with real Gmail access exposed. Fixed with an app-level password gate (`src/proxy.ts`, `src/lib/access-gate.ts`, `/login`) that doesn't depend on Vercel's own protection at all. Documented here because it's the direct reason `REDIRECT_BASE_URL` — not the main app's own domain — is the only correct place for a real send's tracked link/pixel to point.

### M20 — Completion webhook ✅

The original plan assumed a generic "shared secret header" and a tracking token we'd invent our own passthrough mechanism for. Once the actual interview tool's integration contract was provided, both assumptions turned out to be slightly off — implemented against the real spec instead:

- **Auth is a secret URL segment, not a header.** The tool's webhook has no signature scheme at all — their own guidance is "treat the URL itself as the shared secret." So the route is `/webhooks/interview-complete/[secret]` (both apps), checked against `INTERVIEW_WEBHOOK_SECRET`; a wrong/missing secret gets a 404 (not 401 — no reason to confirm the route exists to a guesser).
- **The passthrough mechanism is a `tracking_id` query param on the destination link**, not something invented locally — their platform only calls the webhook for interviews visited via a tagged link, and echoes that exact value back in the payload as `participantTrackingId`. This meant M18's click redirect needed a small retroactive change: `appendTrackingId(destinationUrl, token)` (`click-tracking.ts`, both apps) now tags every redirect with `?tracking_id=<trackingToken>` — reusing the same token already used for click correlation, no new field needed.

**Shipped as**:
- `src/lib/interview-webhook.ts` — `isValidCompletionPayload` (**pure**: validates `{participantTrackingId, interviewId, studyId, status, completedAt}` all present and correctly typed) and `recordCompletion` (**DB-only**: sets `status: "completed"` using the *tool's own* `completedAt` timestamp, not our receipt time; unconditional on prior funnel status, since completion is an objective fact the tool is reporting, not something to validate against our own state; a non-`"completed"` `status` value or an unmatched `participantTrackingId` is a no-op, not an error — matches their spec that any non-5xx response means "don't retry").
- Route handlers in both apps, same split as M18/M19: the main app's copy is a local-testing fallback (behind the access gate — a local curl test needs the gate cookie included), `apps/redirect`'s copy is the real endpoint given to the tool's operator.
- Malformed JSON or a payload missing required fields returns 400 (their spec treats 4xx as non-retryable, which is correct here — retrying a malformed request never helps).

**Test plan** (as built): `interview-webhook.test.ts` — pure validator cases (missing field, wrong type, empty tracking id, non-object input) and pglite-backed `recordCompletion` integration tests (normal completion using their timestamp, completing from every funnel status including `drafted`, unparseable `completedAt` falling back to now, unmatched token, non-`"completed"` status). `click-tracking.test.ts` extended for `appendTrackingId` (new param, and preserving an existing query string).

Manually verified twice: first with a synthetic completion payload against live Supabase (seeded a `clicked` recipient, hit the deployed `apps/redirect` click route, confirmed `tracking_id` was appended to the redirect, then POSTed a synthetic payload to the deployed webhook — wrong secret → 404, correct secret → 200 and the DB row flipped to `completed`). Then confirmed for real: a live campaign send → real click-through with `tracking_id` attached → an actual completed interview → the AI-interview tool's own webhook call flipped the real recipient to `completed` with no manual intervention. One deploy-config gotcha hit along the way, worth remembering: adding `INTERVIEW_WEBHOOK_SECRET` to Vercel's dashboard didn't take effect on the already-running deployment — it only applied after an explicit redeploy of `apps/redirect`. Vercel env var changes need a fresh deployment to actually be picked up, not just a save in the dashboard.

### M21 — LinkedIn copy-assist queue ✅

**Shipped as**:
- `markLinkedInRecipientSent(db, recipientId)` — added to `src/lib/campaign-send.ts` alongside `sendCampaignRecipientEmail`, reusing its `CampaignRecipientNotFoundError`/`CampaignRecipientNotSendableError` (same shape of guard: must be `channel: "linkedin"` and `status: "drafted"`). No pixel, no draft-generation, no `event` recorded — unlike an email send, there's no Gmail API call happening at all, so there's no message id or content this app actually sent to attach to the Person's timeline; it just trusts the user that they sent it and records the funnel transition.
- `src/app/campaigns/[id]/linkedin-queue/page.tsx` — lists that campaign's LinkedIn/`drafted` recipients, each with their profile link (opens in a new tab), the draft body, a **Copy message** button, and a **Mark sent** button (`markLinkedinRecipientSentAction`).
- `CopyButton.tsx` — this app's first (and, deliberately, only) Client Component. Everything else is server components + form posts; clipboard access has no server-side equivalent, so this one small, isolated exception was unavoidable rather than a stylistic drift.
- The campaign detail page links to the queue whenever it has any LinkedIn/`drafted` recipients, showing the pending count.

**Test plan** (as built): `campaign-send.test.ts` extended with `markLinkedInRecipientSent` cases — marks sent, leaves other recipients untouched, not-found, wrong-channel, already-sent. No unit test for `CopyButton` (trivial, browser-API-only, not worth a DOM-testing setup for one `navigator.clipboard.writeText` call) — verified manually instead: walked a real queue, confirmed the copy button and profile links work.

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

**Shipped as** `src/lib/follow-up.ts`, `src/app/api/cron/follow-ups/route.ts`, `scripts/run-follow-ups.ts`.

**Deviation from the plan above — nothing is ever sent automatically.** After the plan above was implemented once (auto-sending email follow-ups directly via Gmail), the owner made the call that they want to personally review every outbound message — follow-ups included — before it leaves, the same as every other send in this app. `sendFollowUps` was reworked into two smaller pieces instead of one that sends:

- `prepareFollowUps(db, now)` — **full-pipeline, but never sends**. For every recipient due for a nudge (either channel), drafts the follow-up and writes it into `draftSubject`/`draftBody`, resets `status` back to `"drafted"`, and sets `followedUpAt: now`. This puts the recipient in front of the *existing* per-recipient "Send" button (email) or the M21 copy-assist queue (linkedin) exactly like a fresh, never-sent draft — there's no separate "pending follow-up" state to build. `status` being reset to `"drafted"` here is a deliberate, one-time exception to the rule that `followedUpAt` is independent of `status` (see the column comment in `schema.ts`): the whole point of this milestone is to get the draft back in front of the owner, and `"drafted"` is what makes it show up for review/send.
- `notifyOwnerOfPendingFollowUps(db, queued)` — emails the owner's own connected Gmail account (from and to are both `ownEmail` — this is a self-notification, not outreach) a plain-text digest of what just got queued, grouped by channel, with a link to each campaign for review. Does nothing if nothing was queued (no daily empty-digest spam).
- `runFollowUpCycle(db, now)` — composes the two for the cron route / manual script: prepare, then notify.

New `sendAllDraftedCampaignEmails(db, accountId, campaignId)` in `src/lib/campaign-send.ts` — the bulk counterpart to the existing per-recipient `sendCampaignRecipientEmail`, wired to a new "Send all drafted emails (N)" button on the campaign detail page (`sendAllCampaignRecipientsAction`) — so a day's worth of queued follow-ups (or a fresh batch of first-time drafts) can be reviewed once and sent in bulk instead of one click per recipient. Email-only; LinkedIn sending stays manual by design, walked one at a time through the M21 copy-assist queue.

**Scheduling, corrected against Vercel's actual docs (not assumed)**: Vercel Cron always invokes with `GET`, never `POST`, and only auto-attaches an `Authorization: Bearer` header when the project env var is named exactly `CRON_SECRET` — a differently-named var (this started as `FOLLOW_UP_CRON_SECRET`) never gets sent, since Vercel Cron has no way to attach a custom header at all. The route was written as `POST` first and corrected to `GET` + `CRON_SECRET` once this was checked. New `vercel.json` at the repo root registers the schedule (`{ "path": "/api/cron/follow-ups", "schedule": "0 8 * * *" }` — 08:00 UTC daily). On the Hobby plan, cron jobs are capped at once per day and Vercel may fire any time within the scheduled hour, not the exact minute — this job is idempotent (`followedUpAt` is the one-shot guard) so that imprecision is harmless.

New env vars: `CRON_SECRET` (unlike the M18/M19/M20 tracking routes, this route is excluded from `src/proxy.ts`'s access gate — it's the real production entry point Vercel Cron hits with no browser session, not a local-testing fallback — and relies on its own fail-closed secret check instead); `APP_BASE_URL`, this app's own public URL, used to build the campaign links inside the review digest email.

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

**Shipped as** `src/lib/calendar-import.ts`, schema additions in `src/db/schema.ts`, `scripts/list-meetings.ts`.

**Deviations from the plan above**:
- `GMAIL_SCOPES` was renamed to `GOOGLE_SCOPES` (the plan's own suggested option) — one Google OAuth connection now covers Gmail and Calendar both, so "Gmail scopes" stopped being an accurate name. An account connected before this ships needs to click "Reconnect Gmail" again (same button, now requesting the extra scope) or calendar import fails with a scope error.
- Token/OAuth-client setup was factored out of `createGmailClient` into a new shared `createGoogleAuthClient(db, accountId)` in `gmail-import.ts`, so the Calendar client (built here) and the Gmail client don't duplicate the refreshed-token-persistence listener.
- M24's "find existing contact by email or skip" stub is a new `findContactByEmail(db, email)` in `contact-resolution.ts`, restricted to the `gmail`/`hotmail` sources (the only ones whose `sourceIdentifier` is ever email-shaped) rather than matching on `sourceIdentifier` alone.
- A meeting event with no attendees besides the calendar owner (`self`) or a room/resource (`resource: true`) is treated as no attendees at all, not just a literally-empty `attendees` array — a real event where you're the only human invited (a booked room, a solo hold) shouldn't become a "meeting" any more than one with no attendees field at all.
- Minimal UI wiring was added even though the plan didn't specify a page: a "Calendar" section on the homepage (same connected-account gating as the existing Gmail import section) with a start-date form, since every other milestone this session has been tested by clicking through the real UI, not just a script. `scripts/list-meetings.ts` still exists for direct DB verification.

### M25 — Attendee-to-contact matching

**Changes to `src/lib/calendar-import.ts`**: when an attendee's email doesn't match any existing `contact.sourceIdentifier`, call `findOrCreateContact(db, "google_calendar", { identifier: email, displayName: attendee.name }, "active")` — reusing the exact function M15 uses, no new matching logic. This is the resolution from the roadmap doc: the existing name-similarity merge-suggestion engine (`generateMergeSuggestions`, already source-agnostic) picks up the rest.

**Test plan**:
- Integration (pglite): importing a meeting with an attendee sharing a name with an existing Person (different email, different source) results in `generateMergeSuggestions` flagging the pair — same assertion shape as M15's merge test, different source.
- Manual: verify with a real calendar invite from someone already in the CRM under a different email.

**Shipped as** a change to `importCalendarEvents` in `src/lib/calendar-import.ts`, matching the plan exactly (the `{ identifier, displayName }` in the plan's prose is `{ identifier, name }` — `ContactIdentity`'s actual field name from `contact-resolution.ts`). `CalendarImportSummary.attendeesSkippedNoContact` (M24) is renamed to `attendeesCreated`, since nothing is skipped anymore — every attendee now resolves to a Contact, either matched or newly created. `findOrCreateContact`'s `source` parameter type gained `"google_calendar"` to accept the new call site.

### M26 — Last-touched staleness view

**New module** `src/lib/last-touched.ts`:
- `computeLastTouched(events: { occurredAt: Date }[], meetings: { startTime: Date }[]): Date | null` — **pure**: max of all provided timestamps.
- `listPeopleByLastTouched(db): Promise<PersonWithLastTouched[]>` — **DB-only**.

**Wiring**: `src/app/people/page.tsx` gains a sort-by-last-touched option and a "quiet for 30+/60+/90+ days" filter.

**Test plan**:
- Unit: `computeLastTouched` against fixtures (events only, meetings only, both, neither → `null`).
- Manual: sort `/people` by last-touched, spot-check the top and bottom entries against the DB.

**Shipped as** `src/lib/last-touched.ts`. `listPeopleByLastTouched` aggregates `MAX(occurredAt)`/`MAX(startTime)` per Person in SQL (two grouped queries, one per Event/Meeting) rather than loading every row into memory — a Person with years of Gmail history shouldn't require pulling every message just to answer "when was the last time." A Person with no history at all (`lastTouchedAt: null`) always sorts last regardless of direction, and counts as "quiet" for every day-threshold filter — there's nothing staler than never having touched base.

`src/app/people/page.tsx` gained `?sort=last_touched` and `?quiet_days=30|60|90` query params (both link-driven, no client JS) — the aggregate query only runs when either is present, so the default person list stays as cheap as it always was. The "now" used for the day-threshold cutoff had to move into a plain (non-component) helper function — the React Compiler's `react-hooks/purity` lint rule flags any impure call like `Date.now()` made directly inside a function shaped like a component, this app's Server Components included.

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

**Shipped as** `src/lib/person-tags.ts` (`normalizeTag`, `toggleTag`, `listTagsForPerson`, `listDistinctTags`, `listPersonIdsByTag`), `toggleTagAction`/`createIntroCampaignAction` in `actions.ts`, wiring on `/people/[id]` and `/campaigns`.

**Deviations from the plan above**:
- Tags are normalized (trimmed + lowercased) rather than stored verbatim — there's no fixed vocabulary, so this is the only thing stopping "VIP" and "vip" from silently forking into two different tags.
- The campaigns page's tag picker is a `<select>` of tags that actually exist (`listDistinctTags`), not a free-text field — a typo'd tag name would otherwise silently produce a campaign with zero recipients instead of an error.
- An "intro" campaign still asks for a goal (used to draft each message's content) even though it has no destination URL — `generateDraftForPerson` needs *some* goal text regardless of channel; only the tracked-link substitution is skipped for this campaign type.

---

## What "independently testable" means per milestone

Every milestone above ships with at least one of:
1. A **pure-function unit test** (fastest, no infra) wherever the milestone has decision logic (`needsFollowUp`, `computeLastTouched`, `summarizeCampaign`, CSV parsers).
2. A **pglite integration test** wherever the milestone touches the DB (contact creation, status transitions, uniqueness constraints).
3. A **manual walkthrough or script** wherever the milestone's core value depends on a real external system (actual LinkedIn export, actual Gmail send, actual interview-tool webhook) that pglite/vitest can't stand in for.

None of the milestones require the ones after them to be present to verify (1) and (2) — fixtures substitute for upstream milestones' data. (3) is the exception by nature: verifying a real send or a real webhook needs the real thing on the other end, which is why the roadmap doc flags the interview-tool webhook contract as a dependency rather than a blocker.
