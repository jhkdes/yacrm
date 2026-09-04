# yacrm — Architecture & Tech Stack

## Stack decision

- **Language**: TypeScript, end-to-end (backend + frontend + future browser
  extension share one language/toolchain).
- **App framework**: Next.js (API routes + React UI in one deployable).
- **Database**: PGlite — Postgres compiled to WASM, embedded in-process. No
  server to install/run/manage; data lives in a local directory. Same SQL
  dialect and extension model as server Postgres, so migrating to a networked
  Postgres later (if ever needed) is a config change, not a rewrite.
- **Vector search**: `pgvector` extension under PGlite, used for semantic
  campaign-matching over Person/Event history.
- **ORM**: Drizzle (Postgres dialect), works against PGlite.
- **Scheduler**: in-process job (node-cron or similar) for periodic Gmail
  sync — no separate worker service needed for a local-first single-user app.
- **AI**: Claude API for embeddings-backed semantic relevance ranking and for
  drafting personalized outreach messages.

Rejected alternatives: Docker-based Postgres (avoided per user preference —
no interest in managing a Docker service for a local-first single-user app);
Python backend (would split the stack across two languages, with no shared
code path to the future browser extension); SQLite + sqlite-vec (vector
search is core to MVP's value and sqlite-vec is less proven than pgvector for
that).

## Components

1. **Gmail connector** — OAuth flow, bounded historical fetch (user-specified
   start date), periodic sync, two-way-conversation + heuristic filtering
   before anything becomes a Contact.
2. **Data store** (PGlite + pgvector) — `Person`, `Contact`, `Event` tables;
   embeddings column on Event (or a derived per-Person summary) for semantic
   search.
3. **Merge engine** — generates auto-merge suggestions (email/phone/name
   signals) for review; reversible merge/split, splitting Events/Outreach
   back to originating Contact.
4. **Campaign engine** — takes a sentence-level campaign goal, embeds it,
   ranks People by semantic similarity to their Event history plus
   recency/engagement weighting, produces a shortlist.
5. **Draft engine** — Claude call composing a personalized email per targeted
   Person from (their Event history + Contact metadata + campaign goal); held
   for user approval before send.
6. **UI** (Next.js/React) — merge review, Person browser/timeline, campaign
   runner, draft review/approval/send.
7. **Scheduler** — in-process periodic sync job.

## Deferred design (post-MVP)

- Generalized ingestion API contract for LinkedIn/SMS push sources (browser
  extension, Mac mini agent) — to be designed once the Gmail pipeline is
  proven out, likely reusing the same Contact/Event ingestion path.
- Outreach state-machine entity and week-over-week tracking UI.
- OAuth token storage hardening approach (still local-first, but credentials
  deserve encryption at rest even on a single-user machine).
