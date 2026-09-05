import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import path from "node:path";

import { acquirePgliteLock } from "@/db/process-lock";
import { PGLITE_DIR, PGLITE_HOST, PGLITE_PORT } from "@/db/connection";

async function main() {
  // Only one server may ever open the on-disk directory directly — every
  // other consumer (the Next.js app, however many worker processes it
  // spawns, and every CLI script) connects to *this* process over TCP
  // instead, exactly like a real Postgres server.
  acquirePgliteLock(PGLITE_DIR);

  const dataDir = path.join(PGLITE_DIR, "data");
  const db = new PGlite(dataDir, { extensions: { vector } });
  // `extensions: { vector }` only makes the extension available — it still
  // needs to be explicitly created before any `vector` column/type works.
  await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

  const server = new PGLiteSocketServer({
    db,
    host: PGLITE_HOST,
    port: PGLITE_PORT,
    maxConnections: 20,
  });
  await server.start();
  console.log(`[pglite-server] listening on ${PGLITE_HOST}:${PGLITE_PORT}`);

  const shutdown = async () => {
    console.log("[pglite-server] shutting down");
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[pglite-server] failed to start", err);
  process.exit(1);
});
