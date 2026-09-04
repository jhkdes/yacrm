import { ensurePgliteServerRunning } from "@/db/ensure-server";

// Used as a "pre" hook for commands that don't go through src/db/client.ts
// themselves (drizzle-kit generate/migrate use their own pg connection, and
// `next dev` benefits from the server already being up before compiling).
ensurePgliteServerRunning()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
