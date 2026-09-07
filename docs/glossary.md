# yaCRM Glossary

Canonical definitions for terms used across the codebase and the [outreach roadmap](./outreach-roadmap.md) / [technical design](./technical-design-and-milestones.md) docs. When code, docs, or conversation disagree with this file, this file wins — update it rather than letting a term drift.

## Core data model

**Person**
A real human, identity-resolved across every channel they've contacted you through. One Person can have several Contacts (a work email, a personal email, a LinkedIn profile) but is a single row in `person`.

**Contact**
One Person's presence on one Source — a (`source`, `sourceIdentifier`) pair. A Person with a Gmail address and a LinkedIn profile has two Contact rows pointing at the same `personId`. A Contact never moves between Persons; a merge reassigns which Person it points to.

**Source**
Where a Contact or Event came from: `gmail`, `hotmail`, `linkedin`, `sms` today; `google_calendar` added in Phase 4 (Milestone M24) for contacts discovered only through a calendar invite. Stored as the `source` enum.

**Identifier** (or **source identifier**)
The source-native string that uniquely names a Contact within its Source: an email address for `gmail`/`hotmail`, a phone number for `sms`, a profile URL for `linkedin`. Not always an email — code and docs should say "identifier," not "email," when describing this generically (see `ContactIdentity` in `contact-resolution.ts`).

**Contact status**
`pending` — only one-way messages seen so far, not yet a confirmed real relationship, but kept (not discarded) so a later reply can retroactively promote it. `active` — a genuine back-and-forth exists. Never downgrades from `active` back to `pending`.

**Event**
One message, in one direction, tied to one Contact: an email, an SMS, a LinkedIn DM. Has a `direction` (`inbound`/`outbound`), a body, and — when embedding succeeds — a vector used for semantic ranking.

**Import** vs. **Sync**
*Import* is the first, full pull of history for a source (a date range, or in LinkedIn's case a one-time file upload). *Sync* is a subsequent incremental pull that continues from where the last successful run left off. LinkedIn has no sync — every LinkedIn import is a fresh manual file upload (Milestones M15/M16).

**Merge suggestion**
A system-proposed pairing of two Persons believed to be the same human (by name similarity or email/name heuristics), surfaced for the user to accept or dismiss. Source-agnostic — a Gmail contact and a LinkedIn contact can be suggested for merge exactly like two Gmail contacts.

**Person merge**
The user-confirmed action that reassigns all of one Person's Contacts to another Person and removes the now-empty duplicate. Reversible (`unmergePerson`).

## Outreach & campaigns (Phase 2+)

**Campaign**
A persisted outreach effort: a name, a targeting goal (free text, used for semantic ranking), a `type` (`interview_link` or `intro`), and a set of Campaign Recipients. Before Milestone M17, "campaign" meant only an ephemeral request-time ranking — the term now always means the persisted `campaign` row unless a doc explicitly says "ranking pass."

**Campaign Recipient**
One Person's participation in one Campaign: which Contact/channel they're reached on, their generated draft, and their funnel `status`. One row per (campaign, person).

**Soft delete**
How deleting a Campaign or a Campaign Recipient actually works: a `deletedAt` timestamp is set rather than the row being removed, since a draft or a real send/click history has no external source to recover it from if it were truly deleted. A soft-deleted row is invisible everywhere the app lists campaigns/recipients, but not gone.

**Undo**
The user-facing action that clears `deletedAt`. Deliberately scoped to a single request, not a persistent "recently deleted" list: the redirect immediately after a delete/remove carries the id needed to undo it as a query param, rendering a one-shot Undo link. Navigate away and that link (and the query param driving it) is gone — the row stays soft-deleted, just no longer undoable from the UI.

**Channel**
`email` or `linkedin` — which send path a Campaign Recipient uses. Determines what's trackable: email gets the full funnel (see below), LinkedIn skips "opened" (no read-receipt access) and is sent through the copy-assist queue rather than automatically.

**Funnel status** (Campaign Recipient `status`)
The ordered stages a recipient can reach: `drafted` → `sent` → `opened` → `clicked` → `completed`. `opened` is email-only. `completed` is terminal and always wins regardless of arrival order relative to `opened`/`clicked`.

**Tracked link**
A per-recipient URL (unique `trackingToken`) that redirects to the real destination (e.g. the AI-interview tool) while recording a `clicked` event. Distinct from the destination itself, which yaCRM doesn't control the internals of.

**Copy-assist queue**
The LinkedIn send UI: yaCRM generates the draft, the user copies it into LinkedIn by hand and clicks "mark sent." Not an automated send — deliberately, to stay within LinkedIn's terms of service (see roadmap doc; browser-extension-assisted sending is explicitly out of scope).

**Follow-up**
An automatic single nudge sent 3 days after a Campaign Recipient's `sentAt`, unless they've already reached `clicked` or `completed`. Tracked via `followedUpAt`, which is independent of `status` — a follow-up doesn't move a recipient backward through the funnel.

## Relationship maintenance (Phase 4)

**Meeting**
A calendar event with attendees, imported read-only from Google Calendar and linked to Contacts via attendee email. Distinct from an Event — a Meeting is a scheduled block of time, not a message.

**Last touched**
The most recent of a Person's meetings, inbound Events, and outbound Events — used to sort/filter for contacts who've gone quiet.

**Tag**
A user-applied label on a Person (`person_tag`), used to hand-curate an audience for a Campaign (currently only the Phase 4 `intro` outreach track) rather than relying on semantic ranking.

---

*Terms are added here as new milestones introduce them — see the technical design doc for which milestone owns which term.*
