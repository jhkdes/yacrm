# yacrm — Requirements & Terminology

## Purpose

Track outreach, responses, and mine potential targets for campaigns, across all
personal communication channels (email, LinkedIn, SMS), by unifying contact
history into a single view per person.

## Glossary

| Term | Meaning |
|---|---|
| **Person** | A merged identity across all sources, referenced by name. The unit you interact with. |
| **Contact** | A raw per-source identity (a Gmail address, a phone number, a LinkedIn profile). Multiple Contacts merge into one Person. |
| **Event** | A single message/email/text, message-level granularity (not thread-level). Always tied to a Contact and, once merged, to a Person. |
| **Outreach** | A tracked send-and-response attempt, with its own state machine (e.g. Sent → Delivered → Replied → Stale/NoResponse → FollowUpNeeded). Deferred past MVP. |
| **Campaign** | A goal/instruction describing who you want to reach and why; used to rank/shortlist target People and to steer personalized drafts. |
| **Source** | Gmail, Hotmail, LinkedIn, SMS. |

## Core data model decisions

- **Identity merge**: system suggests auto-merges from strong signals (matching
  email, phone, name). User reviews/spot-checks, then bulk-accepts remaining
  suggestions. Merges are always reversible — un-merging splits Events and
  Outreach back to their originating Contact/Source cleanly, since every Event
  always tracks its source Contact.
- **Contact filtering (Gmail/Hotmail import)**: only import people with
  two-way conversation history (sent AND received at least once), plus
  heuristic filtering of bulk/no-reply/list-header senders. User can purge a
  Contact, which excludes it from future imports too.
- **Event granularity**: message-level, not thread-level. Each individual
  email/text/LinkedIn message is its own Event record.
- **Company/domain signal**: a work-email domain is a *signal* that a Person
  works at a given company — not a sole include/exclude filter, since the same
  Person may also email from a personal address. Used as one input among
  several, never a hard gate.
- **Campaign targeting**: user describes a campaign goal in a sentence or two.
  System runs an AI semantic-relevance pass over each Person's Event history,
  weighted with recency/engagement signals, and produces a ranked/shortlisted
  target list. Domain/company signal available as an additional input, not a
  gate.
- **Personalized drafts**: AI drafts one outreach message per targeted Person,
  using (a) past conversation history with that specific Person, (b) their
  Contact metadata (name, company/domain), and (c) the campaign goal/
  instruction. Draft is always shown for approval before send — no auto-send,
  regardless of how routine the message seems.
- **Sync**: bounded historical import (user specifies a start date), then
  periodic sync for new messages going forward. Not full-history-forever, not
  real-time push, for MVP.
- **Deployment**: local-first, single-user. No multi-tenant design needed.

## MVP scope (v1 — first value-generating milestone)

1. **Import**: Gmail OAuth, bounded date range, two-way conversation +
   heuristic filtering, periodic sync for new mail.
2. **Merge**: auto-merge suggestions into Person, reviewable/reversible.
3. **Person profile**: Contact metadata plus inferred company signal from
   work-email domain when present.
4. **Campaign targeting**: sentence-level campaign goal → AI semantic
   relevance + recency/engagement ranking → shortlisted target Person list.
5. **Personalized draft**: AI drafts a per-Person outreach email using past
   conversation + Contact metadata + campaign goal, shown for user approval
   before send. Sending is via email only in v1.

### Explicitly deferred past MVP

- Outreach state-machine tracking (week-over-week sent/responded/no-response).
- Hotmail import.
- LinkedIn contact/message ingestion (needs a browser extension — not built
  yet; ingestion API to be designed once the Gmail pipeline proves out).
- SMS ingestion from iPhone (needs a Mac mini–based agent — not built yet;
  same deferred ingestion API applies).
- Sending via LinkedIn or SMS (email-only for v1).

## Open items for later design passes

- Tech stack / architecture (next step).
- Generalized ingestion API contract for LinkedIn/SMS push sources.
- Security/token storage approach for OAuth credentials (local-first, but
  still needs care).
