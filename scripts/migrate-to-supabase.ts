import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { PGLITE_CONNECTION_URL } from "@/db/connection";
import {
  contact,
  dismissedMergeSuggestion,
  event,
  oauthAccount,
  person,
  purgedContact,
} from "@/db/schema";

// One-time data migration: copies everything out of local PGlite into
// Supabase (or whatever DATABASE_URL points at), so Supabase can become the
// app's sole database going forward instead of an empty operational copy.
//
// Deliberately uses Drizzle for both sides, not raw SQL — event.embedding
// is a pgvector column, and going through Drizzle's own type handling for
// both the read and the write is what guarantees that round-trips
// correctly instead of getting mangled as a raw string somewhere.
//
// IDs are remapped, not preserved: GENERATED ALWAYS AS IDENTITY columns
// reject explicit id inserts without OVERRIDING SYSTEM VALUE, and even with
// that, local ids have gaps (deleted/merged/purged rows over time) that
// would make "insert in id order" an unreliable way to reproduce them
// anyway. Foreign keys (contact.personId, event.contactId,
// dismissedMergeSuggestion.personAId/personBId) are rewritten through the
// id maps built while copying each table, in dependency order.
const BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function main() {
  const remoteUrl = process.env.DATABASE_URL;
  if (!remoteUrl) {
    throw new Error(
      "DATABASE_URL must be set (to the Supabase connection string) — this migrates local PGlite data INTO that database.",
    );
  }

  const localPool = new Pool({ connectionString: PGLITE_CONNECTION_URL, max: 5 });
  const localDb = drizzle(localPool, {
    schema: { contact, dismissedMergeSuggestion, event, oauthAccount, person, purgedContact },
  });

  const remotePool = new Pool({
    connectionString: remoteUrl,
    max: 5,
    ssl: { rejectUnauthorized: false },
  });
  const remoteDb = drizzle(remotePool, {
    schema: { contact, dismissedMergeSuggestion, event, oauthAccount, person, purgedContact },
  });

  try {
    await localPool.query("SELECT 1");
  } catch (err) {
    throw new Error(
      `Couldn't reach local PGlite at ${PGLITE_CONNECTION_URL} — run "npm run db:serve" in another terminal first.\n${err}`,
    );
  }

  const [existingPersonCount] = await remoteDb.select().from(person).limit(1);
  if (existingPersonCount) {
    throw new Error(
      "The remote database already has at least one Person row. Refusing to run — this script isn't idempotent (re-running would hit unique-constraint errors partway through, or silently double up rows that have no unique constraint). If you really want to re-run it, clear the remote tables first.",
    );
  }

  console.log("Copying oauth_account...");
  const oauthRows = await localDb.select().from(oauthAccount);
  for (const batch of chunk(oauthRows, BATCH_SIZE)) {
    await remoteDb.insert(oauthAccount).values(
      batch.map(({ id: _id, ...rest }) => rest),
    );
  }
  console.log(`  ${oauthRows.length} row(s)`);

  console.log("Copying purged_contact...");
  const purgedRows = await localDb.select().from(purgedContact);
  for (const batch of chunk(purgedRows, BATCH_SIZE)) {
    await remoteDb.insert(purgedContact).values(
      batch.map(({ id: _id, ...rest }) => rest),
    );
  }
  console.log(`  ${purgedRows.length} row(s)`);

  console.log("Copying person...");
  const personRows = await localDb.select().from(person);
  const personIdMap = new Map<number, number>();
  for (const batch of chunk(personRows, BATCH_SIZE)) {
    const inserted = await remoteDb
      .insert(person)
      .values(batch.map(({ id: _id, ...rest }) => rest))
      .returning({ id: person.id });
    batch.forEach((row, i) => personIdMap.set(row.id, inserted[i].id));
  }
  console.log(`  ${personRows.length} row(s)`);

  console.log("Copying contact...");
  const contactRows = await localDb.select().from(contact);
  const contactIdMap = new Map<number, number>();
  for (const batch of chunk(contactRows, BATCH_SIZE)) {
    const inserted = await remoteDb
      .insert(contact)
      .values(
        batch.map(({ id: _id, personId, ...rest }) => ({
          ...rest,
          personId: personIdMap.get(personId)!,
        })),
      )
      .returning({ id: contact.id });
    batch.forEach((row, i) => contactIdMap.set(row.id, inserted[i].id));
  }
  console.log(`  ${contactRows.length} row(s)`);

  console.log("Copying event (includes embeddings — this is the slow one)...");
  const eventRows = await localDb.select().from(event);
  for (const batch of chunk(eventRows, BATCH_SIZE)) {
    await remoteDb.insert(event).values(
      batch.map(({ id: _id, contactId, ...rest }) => ({
        ...rest,
        contactId: contactIdMap.get(contactId)!,
      })),
    );
  }
  console.log(`  ${eventRows.length} row(s)`);

  console.log("Copying dismissed_merge_suggestion...");
  const dismissedRows = await localDb.select().from(dismissedMergeSuggestion);
  for (const batch of chunk(dismissedRows, BATCH_SIZE)) {
    await remoteDb.insert(dismissedMergeSuggestion).values(
      batch.map(({ id: _id, personAId, personBId, ...rest }) => ({
        ...rest,
        personAId: personIdMap.get(personAId)!,
        personBId: personIdMap.get(personBId)!,
      })),
    );
  }
  console.log(`  ${dismissedRows.length} row(s)`);

  console.log("Done.");
  await localPool.end();
  await remotePool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
