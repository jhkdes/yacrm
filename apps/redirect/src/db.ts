import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __yacrmRedirectPool: Pool | undefined;
}

// No local fallback here (unlike the main app's src/db/client.ts) — this
// app only ever runs deployed, talking to the same hosted Postgres the
// main app uses, so DATABASE_URL is required. Checked lazily (inside a
// function, not at module load) so a build without the env var set doesn't
// fail — only an actual request would.
function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required — set it to the same hosted Postgres connection string the main yaCRM app uses, so this service sees the same campaign_recipient rows.",
    );
  }
  // Most hosted providers (Supabase included) present a cert chain `pg`
  // won't validate without this — matches the main app's src/db/client.ts.
  return new Pool({ connectionString, max: 5, ssl: { rejectUnauthorized: false } });
}

export function getPool(): Pool {
  if (!globalThis.__yacrmRedirectPool) {
    globalThis.__yacrmRedirectPool = createPool();
  }
  return globalThis.__yacrmRedirectPool;
}
