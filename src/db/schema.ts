import { relations } from "drizzle-orm";
import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const sourceEnum = pgEnum("source", [
  "gmail",
  "hotmail",
  "linkedin",
  "sms",
]);

export const eventDirectionEnum = pgEnum("event_direction", [
  "inbound",
  "outbound",
]);

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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.contactId, table.sourceMessageId)],
);

export const personRelations = relations(person, ({ many }) => ({
  contacts: many(contact),
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
