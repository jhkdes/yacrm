# yacrm — Milestones & Deliverables

Each milestone has one deliverable and one verification method that doesn't
require the next milestone to exist. Milestones are ordered so each one is
buildable and testable on its own.

## Phase 0 — Foundation

### M0. Project scaffold
**Deliverable**: Next.js + TypeScript app boots locally; PGlite initializes a
local data directory with the `pgvector` extension enabled; Drizzle connects
and can run a migration.
**Verify**: `npm run dev` starts the app; a `/api/health` route returns 200
and includes a live round-trip query result (e.g. `SELECT 1`) from PGlite.

### M1. Core schema
**Deliverable**: Drizzle schema + migration for `Person`, `Contact`, `Event`
tables (columns per `ARCHITECTURE.md`, no embeddings yet).
**Verify**: A seed script inserts one Person, one Contact linked to it, and
one Event linked to that Contact; a query script prints them back joined
correctly. Re-running migrations from scratch reproduces the same schema.

## Phase 1 — Gmail import pipeline

### M2. Gmail OAuth connection
**Deliverable**: "Connect Gmail" flow in the UI; OAuth token obtained and
stored locally.
**Verify**: Click connect, complete Google's consent screen, land back in the
app showing your Gmail address as "Connected." Restarting the app doesn't
require reconnecting (token persisted).

### M3. Bounded historical import (raw)
**Deliverable**: Given a connected Gmail account and a user-specified start
date, fetch all messages since then and store them as raw `Contact` +
`Event` rows, unfiltered.
**Verify**: Pick a real date range on your own inbox, run import, and confirm
the Event count in the DB is in the right ballpark vs. Gmail's own search
count for `after:<date>` in the Gmail UI. Spot-check 3 imported Events against
the actual emails.

### M4. Contact filtering (signal, not noise)
**Deliverable**: Two-way-conversation requirement + heuristic bulk/no-reply
filtering applied during import, so mailing lists/ads/spam don't produce
Contacts.
**Verify**: A fixture test with a mix of known-good (two-way, human) and
known-bad (newsletter, no-reply, one-way cold outreach) sample emails —
assert only the known-good senders become Contacts. Run against your real
inbox and manually confirm zero mailing lists appear in the Contact list.

### M5. Contact purge
**Deliverable**: UI action to purge a Contact; purged Contacts are excluded
from future imports.
**Verify**: Purge a Contact, re-run sync, confirm it does not reappear even
though matching messages still exist in Gmail.

### M6. Periodic sync (incremental)
**Deliverable**: Re-running sync only fetches messages newer than the last
successful sync, with no duplicate Events.
**Verify**: Run import once, note Event count. Send yourself a test email,
run sync again, confirm Event count increases by exactly 1 and no existing
Event rows changed.

## Phase 2 — Identity resolution

### M7. Auto-merge suggestions
**Deliverable**: Engine scores Contacts against each other (email/phone/name
signals) and produces ranked merge suggestions into `Person` records.
**Verify**: Fixture test with obviously-same-person Contacts (e.g. same name,
different email domains) and obviously-different Contacts — assert the
engine suggests the first pair and not the second. On your real data, review
suggestions and confirm the first 10 are correct.

### M8. Merge review UI + accept/reject
**Deliverable**: UI listing merge suggestions; accept merges one-by-one or
bulk-accept remaining; reject creates no merge.
**Verify**: Accept a suggested merge, confirm the two Contacts now show under
one Person with combined Event history. Reject another, confirm both Contacts
remain separate Persons.

### M9. Un-merge / split
**Deliverable**: Action to un-merge a Person back into its constituent
Contacts, restoring each Contact's Events to it.
**Verify**: Merge two Contacts, confirm combined Event count, un-merge,
confirm each resulting Person's Event count matches what it had before the
merge (no data loss, no cross-contamination).

### M10. Person profile view
**Deliverable**: UI page per Person showing all linked Contacts and a
chronological Event timeline, with company/domain signal displayed when a
work-email Contact is present.
**Verify**: Open a Person with 2+ merged Contacts and confirm the timeline
correctly interleaves Events from both sources in chronological order.

## Phase 3 — Campaign targeting & outreach draft

### M11. Event/Person embeddings
**Deliverable**: Embedding generated and stored (pgvector column) per Event,
plus a derived per-Person summary embedding.
**Verify**: Script that takes two known-similar Events (same topic) and one
known-dissimilar Event, runs a nearest-neighbor query, and confirms the
similar pair ranks closer than the dissimilar one.

### M12. Campaign definition + ranked targeting
**Deliverable**: UI to enter a campaign goal (free text); backend embeds it,
ranks all People by semantic similarity to their Event history weighted by
recency/engagement, returns a shortlist.
**Verify**: Hand-crafted fixture set of People with clearly on-topic vs.
off-topic history for a sample campaign goal — assert on-topic People rank
above off-topic ones. On real data, sanity-check the top 5 results make sense
to you.

### M13. Personalized draft generation
**Deliverable**: For a targeted Person, generate a draft email referencing
their conversation history, Contact metadata, and the campaign goal.
**Verify**: Generate drafts for 3 different People in the same campaign;
confirm each draft references facts unique to that Person's actual history
(not generic/interchangeable text), read for correctness/tone.

### M14. Approval + send
**Deliverable**: UI to review, edit, approve, and send a draft via the
connected Gmail account; sent messages recorded as new Events.
**Verify**: Approve and send a draft to a real test address you control,
confirm receipt with correct content, and confirm a corresponding Event
appears on that Person's timeline afterward.

---

M0–M14 constitute MVP as scoped in `REQUIREMENTS.md`. Everything else
(Outreach state-machine tracking, Hotmail, LinkedIn/SMS ingestion) is a
separate phase to be milestoned after MVP ships.
