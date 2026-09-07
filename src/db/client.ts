import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { DATABASE_CONNECTION_URL, IS_REMOTE_DATABASE } from "./connection";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __yacrmPgPool: Pool | undefined;
}

// Without DATABASE_URL set, the app and every CLI script connect to one
// shared PGlite server process (scripts/pglite-server.ts) over the Postgres
// wire protocol, rather than each independently opening the on-disk data
// directory — PGlite's file storage isn't safe for more than one process to
// open directly, and Next.js dev's multiple worker processes (plus any
// concurrently running script) all need access at once.
//
// With DATABASE_URL set (e.g. to Supabase), this connects to that real,
// network-reachable Postgres instead — needed so a deployed consumer like
// apps/redirect can see the same rows. Requires SSL; Supabase's pooler
// (and most hosted providers) present a cert chain `pg` won't validate
// without `rejectUnauthorized: false`.
//
// This module does NOT ensure the local PGlite server is running itself (no
// top-level await — that breaks under tsx's CommonJS transform for
// standalone scripts). The app relies on the `predev`/`predb:*` npm hooks
// (scripts/ensure-server-cli.ts); every other script calls
// ensurePgliteServerRunning() itself at the top of its own main() — a no-op
// when DATABASE_URL is set, since there's no local server to start.
//
// Reuse a single pool across Next.js dev hot-reloads.
const pool =
  globalThis.__yacrmPgPool ??
  new Pool({
    connectionString: DATABASE_CONNECTION_URL,
    max: 5,
    ssl: IS_REMOTE_DATABASE ? { rejectUnauthorized: false } : undefined,
  });
if (process.env.NODE_ENV !== "production") {
  globalThis.__yacrmPgPool = pool;
}

export const db = drizzle(pool, { schema });
export const pglite = pool;
