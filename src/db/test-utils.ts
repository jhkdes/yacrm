import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";

import * as schema from "./schema";

// A fresh, in-memory Postgres (via PGlite) per call, with real migrations
// applied — used by integration tests that need actual Postgres semantics
// (unique constraints, onConflictDoNothing) rather than a mocked ORM.
export async function createTestDb() {
  const client = new PGlite({ extensions: { vector } });
  // `extensions: { vector }` only makes the extension available — it still
  // needs to be explicitly created before any `vector` column/type works
  // (and the migrations below add vector columns).
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector;");
  const db = drizzle(client, { schema });

  await migrate(db, {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });

  return { db, client };
}
