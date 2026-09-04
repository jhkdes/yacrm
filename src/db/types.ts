import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type * as schema from "./schema";

// Driver-agnostic Drizzle db type: the app's real client (node-postgres,
// connecting to the shared pglite-server) and the test harness's in-memory
// PGlite instance (createTestDb) use different underlying drivers, but
// every lib function that takes a `db` parameter should accept either —
// tests shouldn't need a real running server just to satisfy a type.
export type DrizzleDb = PgDatabase<PgQueryResultHKT, typeof schema>;
