# yacrm

Yet another CRM — built for one person's actual outreach, not a sales team's
pipeline.

## Motivation

Most CRMs assume you already have a defined sales process and a team
entering data into it by hand. That's the wrong shape for someone tracking
their own personal and professional relationships: the real history of who
you've talked to already lives scattered across Gmail, LinkedIn messages,
and text threads, and nobody wants to manually re-type it into yet another
tool.

yacrm starts from the opposite assumption: pull the history in
automatically, figure out who's actually a real contact (not a mailing list
or a cold sales email), merge the same person's different addresses and
accounts into one identity, and only then let you act on it — see everyone
by name, reach out with an AI-drafted message, and track who responded and
who you still owe a follow-up to.

## Use cases

1. **Automatic import** — pull personal contacts and their conversation
   history out of Gmail (Hotmail planned), filtering out mailing lists, ads,
   and spam so only real two-way relationships show up.
2. **One identity per person** — the same person emailing from a work
   address and a personal Gmail account, or reachable on LinkedIn too,
   should resolve to a single Person you can look up by name, with every
   Contact's history combined into one timeline.
3. **Reviewed, not blind, merging** — an auto-merge suggestion engine
   proposes likely matches (shared identifiers, matching or near-matching
   names, an email that spells out someone's full name); you review and
   accept or reject each one, and can always split a bad merge back apart.
4. **Campaign target mining** *(planned)* — given a campaign goal, surface
   the People in your history who are actually relevant to reach out to,
   ranked by semantic relevance to their conversation history.
5. **AI-drafted outreach** *(planned)* — write a one-line instruction, get a
   personalized draft email built from that person's actual history and a
   campaign goal, reviewed by you before it ever sends.
6. **Weekly reach-out tracking** *(planned)* — see who you reached out to
   this week, who responded, and what the conversation has been over time.
7. **LinkedIn and iPhone SMS import** *(planned)* — via a browser extension
   and a Mac mini–based bridge respectively, since neither platform offers a
   clean import API.

See `REQUIREMENTS.md` for the full glossary and detailed behavior decisions,
`ARCHITECTURE.md` for the tech stack, `MILESTONES.md` for the build plan,
and `PROGRESS.md` for what's actually been built so far.

## Getting started

1. Copy `.env.local.example` to `.env.local` and fill in a Google Cloud
   OAuth client (Gmail API enabled, redirect URI
   `http://localhost:3000/api/auth/gmail/callback`).
2. `npm install`
3. `npm run db:migrate` — sets up the local database schema (this also
   auto-starts the shared embedded-database process if it isn't running
   yet).
4. `npm run dev` — starts the Next.js app.
5. Open `http://localhost:3000`, connect your Gmail account, and run an
   import.

Run `npm run test` for the test suite. See `PROGRESS.md` for the reasoning
behind the embedded-database setup and other architecture decisions worth
knowing before making changes.
