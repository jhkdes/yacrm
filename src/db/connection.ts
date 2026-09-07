import path from "node:path";

import "@/env";

export const PGLITE_DIR = path.join(process.cwd(), ".pglite");
export const PGLITE_HOST = "127.0.0.1";
export const PGLITE_PORT = 54329;
export const PGLITE_CONNECTION_URL = `postgres://postgres@${PGLITE_HOST}:${PGLITE_PORT}/postgres`;

// When set (e.g. to a Supabase pooler URL), points the app at a real hosted
// Postgres instead of the local PGlite dev server. Needed for anything that
// must be visible to a deployed consumer — in particular apps/redirect,
// which records clicks against the same campaign_recipient rows the local
// app creates, and can't reach 127.0.0.1 from Vercel.
export const DATABASE_CONNECTION_URL =
  process.env.DATABASE_URL || PGLITE_CONNECTION_URL;

export const IS_REMOTE_DATABASE =
  DATABASE_CONNECTION_URL !== PGLITE_CONNECTION_URL;
