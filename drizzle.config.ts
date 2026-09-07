import { defineConfig } from "drizzle-kit";

import { DATABASE_CONNECTION_URL, IS_REMOTE_DATABASE } from "./src/db/connection";

// Without DATABASE_URL set, connects to the shared pglite-server (see
// scripts/pglite-server.ts) rather than opening .pglite/data directly — run
// `npm run db:serve` (or let it auto-start via any db:* script) before
// generate/migrate.
//
// With DATABASE_URL set (e.g. to Supabase), generate/migrate target that
// real database instead. `pg`'s newer versions treat a bare
// sslmode=require as an alias for full certificate verification, which is
// stricter than — and inconsistent with — the app's own pg.Pool config
// (ssl: {rejectUnauthorized: false} in src/db/client.ts). uselibpqcompat
// restores the traditional libpq meaning of "require" (encrypt, don't
// verify the cert), matching that.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: IS_REMOTE_DATABASE
      ? `${DATABASE_CONNECTION_URL}?uselibpqcompat=true&sslmode=require`
      : DATABASE_CONNECTION_URL,
  },
});
