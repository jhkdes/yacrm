import { defineConfig } from "drizzle-kit";

import { PGLITE_CONNECTION_URL } from "./src/db/connection";

// Connects to the shared pglite-server (see scripts/pglite-server.ts)
// rather than opening .pglite/data directly — run `npm run db:serve` (or
// let it auto-start via any db:* script) before generate/migrate.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: PGLITE_CONNECTION_URL,
  },
});
