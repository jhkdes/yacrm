import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { PGLITE_CONNECTION_URL } from "./connection";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __yacrmPgPool: Pool | undefined;
}

// The app and every CLI script connect to one shared PGlite server process
// (scripts/pglite-server.ts) over the Postgres wire protocol, rather than
// each independently opening the on-disk data directory — PGlite's file
// storage isn't safe for more than one process to open directly, and
// Next.js dev's multiple worker processes (plus any concurrently running
// script) all need access at once.
//
// This module does NOT ensure the server is running itself (no top-level
// await — that breaks under tsx's CommonJS transform for standalone
// scripts). The app relies on the `predev`/`predb:*` npm hooks
// (scripts/ensure-server-cli.ts); every other script calls
// ensurePgliteServerRunning() itself at the top of its own main().
//
// Reuse a single pool across Next.js dev hot-reloads.
const pool =
  globalThis.__yacrmPgPool ??
  new Pool({ connectionString: PGLITE_CONNECTION_URL, max: 5 });
if (process.env.NODE_ENV !== "production") {
  globalThis.__yacrmPgPool = pool;
}

export const db = drizzle(pool, { schema });
export const pglite = pool;
