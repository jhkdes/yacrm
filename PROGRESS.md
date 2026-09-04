# yacrm — Progress Summary

Status as of M10 completion. See `REQUIREMENTS.md` for the glossary/scope,
`ARCHITECTURE.md` for the original stack decision, `MILESTONES.md` for the
full M0–M14 plan. This file tracks what's actually been *built*, key
decisions made along the way, and gotchas worth knowing before continuing.

**Current state**: 106 tests passing (`npm run test`), `tsc --noEmit` clean.
M0–M10 done. M11 (embeddings) is next.

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

## Known gaps / deferred

- LinkedIn/SMS ingestion (M3/M4 scope from REQUIREMENTS.md) — not started;
  the generalized ingestion API contract is deferred until then.
- Hotmail import — not started (Gmail only so far).
- M11–M14 (embeddings, campaign targeting, draft generation, send) not
  started.
- No UI for editing a Person's name directly (only indirectly via
  merge/un-merge, which derive names from Contact display names).
