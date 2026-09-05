# yacrm — Progress Summary

Status as of M10 completion. See `REQUIREMENTS.md` for the glossary/scope,
`ARCHITECTURE.md` for the original stack decision, `MILESTONES.md` for the
full M0–M14 plan. This file tracks what's actually been *built*, key
decisions made along the way, and gotchas worth knowing before continuing.

**Current state**: 156 tests passing (`npm run test`), `tsc --noEmit` clean.
M0–M14 done — full MVP scope from `REQUIREMENTS.md` is built.

## Architecture as actually built (differs from the original plan)

- **Database**: PGlite, but running as a **shared server process**
  (`scripts/pglite-server.ts`, via `@electric-sql/pglite-socket`), not opened
  directly by the app. The app and every CLI script connect to it over the
  Postgres wire protocol (`drizzle-orm/node-postgres` + `pg.Pool`).
  - **Why the change**: Next.js dev runs multiple persistent worker
    processes, and PGlite's file storage can only be safely opened by one
    process at a time. The original M0 plan (app opens the file directly)
    caused a structural deadlock — whichever worker touched the DB first
    permanently owned it, blocking every other worker's routes. Switching to
    a shared server process (the officially-supported PGlite pattern for
    multi-consumer access) fixed this and also fully closed the earlier M5
    file-corruption bug (real concurrent access is now just normal
    client-server DB usage).
  - `npm run dev` auto-starts the server via a `predev` hook if not already
    running. `npm run db:serve` runs it explicitly/persistently. Every
    `db:*` script calls `ensurePgliteServerRunning()` itself at the top of
    its `main()` (not via npm hooks, so it works regardless of invocation
    method) — except `db:generate`/`db:migrate`, which use `predb:*` hooks
    since drizzle-kit is a separate binary we can't inject into.
  - **Gotcha**: no top-level `await` in `src/db/client.ts` — it broke under
    tsx's CommonJS transform for standalone scripts (worked intermittently
    by luck before this was caught).
  - `src/db/test-utils.ts` (`createTestDb()`) is unaffected — tests use a
    fresh **in-memory** PGlite instance directly, no server needed.
  - `src/db/types.ts` exports a driver-agnostic `DrizzleDb` type
    (`PgDatabase<PgQueryResultHKT, typeof schema>`) so lib functions accept
    either the real node-postgres client or the test harness's PGlite
    instance without type errors.

- **Testing**: Vitest, with two layers — pure-function unit tests (no I/O)
  and DB-integration tests against the in-memory `createTestDb()`. Every
  piece of non-trivial logic (parsing, filtering, scoring, merging) lives in
  a small `src/lib/*.ts` module with an injectable `db` parameter, kept
  separate from the Next.js pages/actions that wire it to the real client.
  This pattern was applied consistently from M3 onward and should continue.

- **AI providers**: two separate providers, chosen for different jobs.
  **Voyage AI** (`voyage-3-lite`, 512-dim) embeds Events/campaign goals for
  semantic search — chosen over a local on-device model for negligible cost
  at this scale with no local RAM/disk footprint. **Anthropic's Claude API**
  (`claude-opus-5`) drafts the actual outreach email text — a
  generation task, not a semantic-similarity task, so it's a different model
  family entirely. Both need their own env var (`VOYAGE_API_KEY`,
  `ANTHROPIC_API_KEY`) and both are optional until the milestone that needs
  them (M11/M13 respectively) — everything upstream still works without
  them.
  - **Gotcha**: `extensions: { vector }` passed to `new PGlite(...)` only
    makes the pgvector extension *available* — it still needs an explicit
    `CREATE EXTENSION IF NOT EXISTS vector;` before any `vector` column
    works. This was silently broken from M0 until M11 was the first thing to
    actually use a vector column.
  - **Gotcha**: Voyage's free tier without a payment method on file is a
    strict 3 requests/minute — genuinely hit during real backfills, not just
    in theory. `AdaptiveThrottle` (`src/lib/adaptive-throttle.ts`, originally
    built for Gmail's rate limit) was generalized with a `label` option and
    reused here rather than writing a second throttler.
  - **Gotcha**: only Next.js itself auto-loads `.env.local`; standalone
    `tsx` scripts don't. `src/env.ts` (a `dotenv` loader imported once from
    `src/db/connection.ts`) fixes this for every CLI script.

## Milestone-by-milestone summary

### M0 — Project scaffold
Next.js (App Router) + TypeScript + PGlite + Drizzle. `/api/health` proves
a live DB round-trip.

### M1 — Core schema
`person`, `contact`, `event` tables (`src/db/schema.ts`). Every Contact
belongs to exactly one Person from creation (solo Person until merged).

### M2 — Gmail OAuth
`src/lib/google.ts`, `/api/auth/gmail/{start,callback,status}`. Tokens
stored in `oauth_account`, refreshed automatically via googleapis, refreshed
token persisted back to the DB.

### M3 — Bounded historical import
`src/lib/gmail-import.ts` (`importGmailHistory`). Fetches via Gmail API,
parses addresses (`src/lib/gmail-parsing.ts` — handles the "Last, First"
comma-in-display-name bug found during testing), stores raw Contact/Event
rows. `AdaptiveThrottle` (`src/lib/adaptive-throttle.ts`) handles Gmail's
per-user rate limit with exponential backoff, permanently slowing down for
the rest of a run after a hit rather than retrying at the same pace.

### M4 — Contact filtering
`src/lib/gmail-filtering.ts`. Two-way-conversation requirement
(`filterToPersonalContacts`) plus a bulk/automated-sender heuristic
(`isBulkOrAutomatedMessage`: `List-Unsubscribe`, `Precedence`,
`Auto-Submitted` headers, narrow no-reply-style local-part patterns —
deliberately *not* flagging `support@`/`info@` on local-part alone, since
those can be real two-way conversations).

### M5 — Contact purge
`src/lib/contact-purge.ts`. `purged_contact` table records exclusions
independently of the Contact row (survives the Contact being deleted).
`/contacts` page has Purge + Undo (with a "Purged" section for visibility).
This is also where the original PGlite file-corruption bug was found and
fixed with a process lock (later superseded by the M10-era server
architecture change above).

### M6 — Periodic sync
`resolveSyncStartDate`/`recordSuccessfulSync` in `gmail-import.ts`.
Gmail's `after:` query is day-granular, so sync re-scans from the last
successful run's date rather than an exact timestamp (harmless — re-scanned
messages dedupe on insert). "Sync now" button on the homepage, only shown
once an initial dated import has run.

**Cross-batch two-way detection gap (found and fixed here)**: two-way
filtering only saw messages within one import batch, so an old one-way
message and a much-later reply landing in different batches could each look
one-way forever. Fixed by adding `contact.status` (`pending`/`active`) —
one-way-but-not-bulk messages are now persisted as `pending` (not
discarded), and `hasOppositeDirectionHistory()` checks prior runs' Events to
promote a pending Contact to `active` once a reply arrives, regardless of
which batch it's in. `/contacts` has a "Pending" section for these.

### M7 — Auto-merge suggestions
`src/lib/merge-suggestions.ts` (`generateMergeSuggestions`), pure/no I/O.
Signals, weakest to strongest: `name_initial_match` (0.52 — one name slot
matches fully, the other is an abbreviated initial, e.g. "Dana W." vs "Dana
Wilkins"; requires at least one full-word match so two bare-initials never
qualify on their own), `similar_name` (0.5–0.6, Damerau-Levenshtein fuzzy
match — transposition-aware so typos like "Theil"/"Thiel" score correctly),
`exact_name_match` (0.6), `email_matches_other_name` (0.55 — one Contact's
email local-part spells out the other's full name, e.g. "vitaly.obernikhin"
matching "Vitaly Obernikhin"), `same_identifier_different_source` (0.9).
`db:suggest-merges` script for manual review.

### M8 — Merge review UI
`src/lib/person-merge.ts` (`mergePersons`) + `src/lib/merge-dismissals.ts`.
`/merges` page: accept (merges Persons, keeps the longer name), reject
(persisted via `dismissed_merge_suggestion` so it doesn't resurface, with a
"Dismissed" section + Undo), accept-all-remaining (handles chains within one
batch, e.g. (1,2) then (2,3), by tracking id resolution as it goes).

### M9 — Un-merge
`unmergePerson()` in `person-merge.ts`. Splits every Contact under a Person
back into its own solo Person — there's no stored "which merge produced this
grouping" history, so it ungroups everything at once rather than reversing
one specific merge. `/people` page lists Person→Contacts groupings with an
Un-merge button (shown when a Person has 2+ Contacts).

### M10 — Person profile view
`src/lib/company-signal.ts` (`inferCompanyDomains` — flags non-free-mail
email domains as a "likely works at" signal) + `src/lib/person-timeline.ts`
(`buildPersonTimeline` — merges every Contact's Events into one
newest-first feed). `/people/[id]` page shows Contacts, company signal, and
the merged timeline.

### M11 — Event/Person embeddings
`src/lib/embeddings.ts` (`generateEmbeddings`, Voyage `voyage-3-lite`,
batched up to 128 texts/request) + `src/lib/person-embedding.ts`
(`updatePersonSummaryEmbedding` — a Person's summary embedding is the mean
of all their Events' embeddings across every merged Contact). Gmail import
now embeds each batch of new Events inline (best-effort — a failed/missing
`VOYAGE_API_KEY` doesn't fail the import, Events just keep a null
embedding). `db:backfill-embeddings` backfills any Events missed earlier
and `db:verify-embeddings` runs the milestone's actual nearest-neighbor
verification (two similar-topic Events should rank closer than a
dissimilar one).

### M12 — Campaign definition + ranked targeting
`src/lib/campaign-ranking.ts`. Score = weighted sum of cosine similarity
(0.6, dominant — semantic relevance is the primary signal per
REQUIREMENTS.md), recency (0.25, true exponential half-life decay, 90-day
half-life — `computeRecencyScore` had an off-by-`ln(2)` bug caught by its
own test, not manual review), and engagement (0.15, log-scaled, saturating
at 20 events so 20 vs. 200 messages score nearly the same). Only People
with at least one **active** Contact are eligible — `pending` (one-way)
contacts aren't confirmed relationships yet. `/campaigns` page: free-text
goal in, ranked People with score breakdown out. `db:rank-campaign` for
real-data verification.

### M13 — Personalized draft generation
`src/lib/draft-generation.ts`. `loadPersonDraftContext` pulls a Person's
full chronological Event history across every merged Contact plus their
contact metadata; `buildDraftPrompt` (pure, unit-tested) turns that into a
system/user prompt instructing Claude to reference only given facts, never
fabricate shared history, and output a strict `Subject: ...` + body format
(`parseDraftResponse` splits it back apart, falling back to
whole-response-as-body if the model doesn't follow the format).
`generateDraftForPerson` is the untested real-API pipeline; the tests prove
two different People's contexts never leak into each other's prompt.
`/campaigns/draft` page + `db:generate-draft` script for real-data
verification.

### M14 — Approval + send
`src/lib/gmail-send.ts`. `gmail.send` added to `GMAIL_SCOPES`
(`src/lib/google.ts`) — **any account connected before this milestone must
reconnect** to grant it, and the scope also has to be added to the Google
Cloud OAuth consent screen's configured scope list (Data Access → Scopes),
not just requested in code, or consent silently doesn't grant it.
`buildRawEmail` (pure RFC 2822 + base64url construction, MIME-encodes
non-ASCII subjects) and `sendGmailMessage` are unit-tested against a fake
Gmail client. `approveAndSendDraft` looks up the recipient address
server-side from the selected `contactId` (never trusts a client-submitted
address, so it can't drift from the dropdown selection), sends, then
`recordSentEvent` inserts the sent message as a new outbound Event —
embedded and folded into the Person's summary embedding exactly like an
imported message, so it shows up in the timeline and future campaign
ranking immediately. `/campaigns/draft` is now an editable form (subject +
body + recipient picker) submitting to `sendDraftAction`, which redirects
to `/campaigns` with a sent confirmation.

## Known gaps / deferred

- LinkedIn/SMS ingestion (M3/M4 scope from REQUIREMENTS.md) — not started;
  the generalized ingestion API contract is deferred until then.
- Hotmail import — not started (Gmail only so far).
- No UI for editing a Person's name directly (only indirectly via
  merge/un-merge, which derive names from Contact display names).
- No Outreach state-machine tracking (sent/replied/etc. beyond the raw
  Event record) — out of MVP scope per `MILESTONES.md`.
- A failed send on `/campaigns/draft` regenerates a fresh AI draft rather
  than preserving the user's edits — a known v1 rough edge, not a bug.
- No approval/audit trail beyond the Event itself — there's no record of
  who clicked "Approve & send" or when, beyond the Event's `createdAt`.
