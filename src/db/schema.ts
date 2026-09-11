import { relations } from "drizzle-orm";
import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  vector,
} from "drizzle-orm/pg-core";

// voyage-3-lite's output dimensionality — see src/lib/embeddings.ts.
export const EMBEDDING_DIMENSIONS = 512;

export const sourceEnum = pgEnum("source", [
  "gmail",
  "hotmail",
  "linkedin",
  "sms",
  // M25: a calendar attendee with no existing Contact match becomes one
  // sourced here (identifier = their email) — see calendar-import.ts.
  "google_calendar",
]);

export const eventDirectionEnum = pgEnum("event_direction", [
  "inbound",
  "outbound",
]);

export const campaignTypeEnum = pgEnum("campaign_type", [
  "interview_link",
  "intro",
]);

export const campaignRecipientChannelEnum = pgEnum(
  "campaign_recipient_channel",
  ["email", "linkedin"],
);

// Ordered funnel stages. "opened" is email-only (LinkedIn has no
// read-receipt API to observe it — see docs/outreach-roadmap.md).
// "completed" is terminal: once reached it's never overwritten by an
// out-of-order opened/clicked event arriving after it.
export const campaignRecipientStatusEnum = pgEnum(
  "campaign_recipient_status",
  ["drafted", "sent", "opened", "clicked", "completed"],
);

// "pending" = only one-way messages seen so far (not yet a confirmed
// two-way personal contact); "active" = a real back-and-forth exists.
// Pending Contacts are still persisted (not discarded) so that a later
// reply — possibly arriving in a different import/sync batch than the
// original message — can retroactively promote them, instead of requiring
// both sides of a conversation to land in the same batch to be detected.
export const contactStatusEnum = pgEnum("contact_status", [
  "pending",
  "active",
]);

// Phase 5 (M28): fixed taxonomy for LLM-classified LinkedIn title data —
// see docs/title-taxonomy.md, the canonical source these values must match.
// "unknown" means the classifier tried and couldn't confidently place the
// title (see the ambiguity rule in that doc) — distinct from the *column*
// being null, which means no LinkedIn title has ever been classified at all.
export const personSeniorityEnum = pgEnum("person_seniority", [
  "ic",
  "manager",
  "director",
  "vp",
  "c_level",
  "founder",
  "unknown",
]);

export const personFunctionEnum = pgEnum("person_function", [
  "product_management",
  "product_marketing",
  "engineering",
  "design",
  "data_analytics",
  "sales",
  "marketing",
  "customer_success",
  "operations",
  "finance",
  "people_hr",
  "legal",
  "it",
  "executive_general",
  "other",
]);

// Phase 5 (M29): fixed taxonomy for LLM-inferred company industry — see
// docs/industry-taxonomy.md, the canonical source these values must match.
export const companyIndustryEnum = pgEnum("company_industry", [
  "tech_enterprise_software",
  "tech_dev_tools_infra",
  "tech_cybersecurity",
  "tech_fintech",
  "tech_healthtech",
  "tech_edtech",
  "tech_martech_adtech",
  "tech_consumer_software",
  "tech_gaming",
  "tech_hardware_semiconductors",
  "telecommunications",
  "financial_services",
  "healthcare",
  "retail_ecommerce",
  "manufacturing_industrial",
  "media_entertainment",
  "professional_services",
  "education",
  "government_public_sector",
  "nonprofit",
  "real_estate",
  "transportation_logistics",
  "energy_utilities",
  "other",
  "unknown",
]);

// An authenticated mailbox connection (Gmail today, Hotmail later) used to
// import mail and, eventually, send outreach. Not a Contact/Person — this is
// *your* mailbox, not someone you're tracking.
export const oauthAccount = pgTable(
  "oauth_account",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    provider: sourceEnum("provider").notNull(),
    emailAddress: text("email_address").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // "YYYY-MM-DD" — the date argument of the last successful import's
    // Gmail after: query. Gmail's search syntax only supports day
    // granularity, so periodic sync re-scans from this date rather than an
    // exact timestamp (harmless: re-scanned messages dedupe on insert).
    lastSyncedDate: text("last_synced_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.provider, table.emailAddress)],
);

// A (source, identifier) pair the user has explicitly excluded — e.g. a
// mailing list our heuristics missed, or someone they just don't want
// tracked. Kept independently of Contact/Person so the exclusion survives
// even though purging deletes the Contact itself: future imports check this
// table before ever creating a new Contact for that identity again.
export const purgedContact = pgTable(
  "purged_contact",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    source: sourceEnum("source").notNull(),
    sourceIdentifier: text("source_identifier").notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.source, table.sourceIdentifier)],
);

export const person = pgTable("person", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  // Derived: the mean of this Person's Events' embeddings (across all their
  // Contacts), recomputed whenever a new embedded Event is added. Null until
  // at least one of their Events has an embedding.
  summaryEmbedding: vector("summary_embedding", {
    dimensions: EMBEDDING_DIMENSIONS,
  }),
  // Phase 5 (M28): raw LinkedIn Position/Company text as last imported, kept
  // specifically so re-import can diff against it and skip re-classifying
  // unchanged rows. Null means this Person has never had a LinkedIn
  // connections row imported (or predates M28).
  linkedinRawTitle: text("linkedin_raw_title"),
  linkedinRawCompany: text("linkedin_raw_company"),
  // LLM-derived from linkedinRawTitle at import time — see
  // docs/title-taxonomy.md. standardizedTitle is freeform display text;
  // seniority/function are the fixed taxonomy enums. All three are null
  // together (never classified) or set together (classification ran).
  standardizedTitle: text("standardized_title"),
  seniority: personSeniorityEnum("seniority"),
  function: personFunctionEnum("function"),
  // Phase 5 (M29): rule-normalized company name (see
  // company-normalization.ts) — the join key into companyIndustryCache and
  // what industry backfill matches on. Null iff linkedinRawCompany is null.
  normalizedCompanyName: text("normalized_company_name"),
  // Denormalized copy of companyIndustryCache's inference for this
  // person's company at classification time — a later re-inference of the
  // same company (out of scope for M29) wouldn't retroactively update this.
  industry: companyIndustryEnum("industry"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Phase 5 (M29): per-company industry cache — industry is inferred once
// per normalized company name, not once per person, and not re-run for
// every raw-name variant that happens to normalize to the same company.
// Keyed independently of any Person row.
export const companyIndustryCache = pgTable("company_industry_cache", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  normalizedCompanyName: text("normalized_company_name").notNull().unique(),
  industry: companyIndustryEnum("industry").notNull(),
  inferredAt: timestamp("inferred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const contact = pgTable(
  "contact",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    personId: integer("person_id")
      .notNull()
      .references(() => person.id),
    source: sourceEnum("source").notNull(),
    // Email address, phone number, or LinkedIn profile id — unique per source.
    sourceIdentifier: text("source_identifier").notNull(),
    displayName: text("display_name"),
    status: contactStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.source, table.sourceIdentifier)],
);

// A Person pair the user explicitly declined to merge, so the same
// suggestion doesn't keep resurfacing on every visit to the review page.
// personAId is always the smaller id — normalized at write time so the pair
// (3, 7) and (7, 3) are the same row.
export const dismissedMergeSuggestion = pgTable(
  "dismissed_merge_suggestion",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    personAId: integer("person_a_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    personBId: integer("person_b_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.personAId, table.personBId)],
);

export const event = pgTable(
  "event",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contact.id),
    direction: eventDirectionEnum("direction").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    subject: text("subject"),
    bodyText: text("body_text").notNull(),
    // Source-native message id (e.g. Gmail message id) — prevents re-import duplicates.
    sourceMessageId: text("source_message_id").notNull(),
    // Null if embedding generation failed or hasn't run yet — the import
    // that created this Event still succeeds without it (see
    // src/lib/embeddings.ts).
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.contactId, table.sourceMessageId)],
);

export const campaign = pgTable("campaign", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  // Free text fed to both rankPeopleForCampaign (targeting) and
  // generateDraftForPerson (drafting) — the same goal string drives both.
  goal: text("goal").notNull(),
  type: campaignTypeEnum("type").notNull().default("interview_link"),
  // Where a recipient's tracked link (see src/lib/click-tracking.ts) sends
  // them — e.g. the AI-interview study URL. Null for an "intro" campaign,
  // which has no tracked link at all.
  destinationUrl: text("destination_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Soft delete: null = active. A Campaign's drafts and any real send/click
  // history have no external source to re-derive from (unlike a purged
  // Gmail Contact, whose messages still exist on Gmail's servers) — a
  // "delete" that couldn't be undone would be a genuine, permanent data
  // loss, not just an inconvenience.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const campaignRecipient = pgTable(
  "campaign_recipient",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => person.id),
    // The specific Contact (and therefore channel/address) this campaign is
    // reaching this Person through.
    contactId: integer("contact_id")
      .notNull()
      .references(() => contact.id),
    channel: campaignRecipientChannelEnum("channel").notNull(),
    status: campaignRecipientStatusEnum("status")
      .notNull()
      .default("drafted"),
    draftSubject: text("draft_subject"),
    draftBody: text("draft_body").notNull(),
    // Per-recipient token embedded in their outreach link — how a click is
    // attributed back to this row (see M18 in
    // docs/technical-design-and-milestones.md).
    trackingToken: text("tracking_token").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // The very first GET this token ever received, bot or not — the
    // anchor recordClick (src/lib/click-tracking.ts) uses to tell a real
    // click apart from automated preview/security-scan infrastructure that
    // hits the link within seconds of it being sent but doesn't always
    // self-identify via User-Agent.
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    // Independent of `status` — a follow-up doesn't move a recipient
    // backward through the funnel, it's an orthogonal "we nudged them" fact
    // (see M23 in docs/technical-design-and-milestones.md).
    followedUpAt: timestamp("followed_up_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft delete for the same reason as campaign.deletedAt — removing a
    // recipient (possibly an already-sent one) shouldn't be an unrecoverable
    // mistake. The (campaignId, personId) unique constraint deliberately
    // still counts a soft-deleted row, so addRecipients revives it (see
    // src/lib/campaigns.ts) instead of colliding with a dead row it can't
    // see past.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.campaignId, table.personId),
    unique().on(table.trackingToken),
  ],
);

export const personRelations = relations(person, ({ many }) => ({
  contacts: many(contact),
  campaignRecipients: many(campaignRecipient),
  tags: many(personTag),
}));

export const contactRelations = relations(contact, ({ one, many }) => ({
  person: one(person, {
    fields: [contact.personId],
    references: [person.id],
  }),
  events: many(event),
}));

export const eventRelations = relations(event, ({ one }) => ({
  contact: one(contact, {
    fields: [event.contactId],
    references: [contact.id],
  }),
}));

export const campaignRelations = relations(campaign, ({ many }) => ({
  recipients: many(campaignRecipient),
}));

export const campaignRecipientRelations = relations(
  campaignRecipient,
  ({ one }) => ({
    campaign: one(campaign, {
      fields: [campaignRecipient.campaignId],
      references: [campaign.id],
    }),
    person: one(person, {
      fields: [campaignRecipient.personId],
      references: [person.id],
    }),
    contact: one(contact, {
      fields: [campaignRecipient.contactId],
      references: [contact.id],
    }),
  }),
);

// M24: a calendar event with at least one non-owner attendee. Keyed on
// googleEventId so re-importing (a periodic sync, or the same date range
// run twice) updates the same row instead of duplicating it.
export const meeting = pgTable(
  "meeting",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    googleEventId: text("google_event_id").notNull(),
    title: text("title"),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.googleEventId)],
);

// One row per (meeting, contact) — a meeting's non-owner attendees, each
// resolved to a Contact (M24: only an existing one; M25: creates one for an
// unmatched attendee, same as any other source). No onDelete on contactId:
// a Contact should never be silently deleted out from under a meeting
// record the way a Campaign Recipient can (see campaign.deletedAt) — there
// is currently no Contact-delete path at all, only person-merge, which
// reassigns rather than removes.
export const meetingAttendee = pgTable(
  "meeting_attendee",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    meetingId: integer("meeting_id")
      .notNull()
      .references(() => meeting.id, { onDelete: "cascade" }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contact.id),
  },
  (table) => [unique().on(table.meetingId, table.contactId)],
);

export const meetingRelations = relations(meeting, ({ many }) => ({
  attendees: many(meetingAttendee),
}));

export const meetingAttendeeRelations = relations(
  meetingAttendee,
  ({ one }) => ({
    meeting: one(meeting, {
      fields: [meetingAttendee.meetingId],
      references: [meeting.id],
    }),
    contact: one(contact, {
      fields: [meetingAttendee.contactId],
      references: [contact.id],
    }),
  }),
);

// M27: a freeform label a Person can carry, toggled on/off from their
// profile page — the audience for an "intro" campaign is this explicit,
// manually curated set, not a rule-based segment (see
// docs/outreach-roadmap.md's decision on why tagging is manual here).
export const personTag = pgTable(
  "person_tag",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    personId: integer("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.personId, table.tag)],
);

export const personTagRelations = relations(personTag, ({ one }) => ({
  person: one(person, {
    fields: [personTag.personId],
    references: [person.id],
  }),
}));
