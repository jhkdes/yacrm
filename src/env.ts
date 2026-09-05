import { config } from "dotenv";
import path from "node:path";

// Next.js loads .env.local automatically for the app itself; standalone CLI
// scripts (tsx scripts/*.ts) have no such mechanism, so this loads it
// explicitly. Imported by src/db/connection.ts, which every script and the
// app both already transitively import, so this one side effect covers
// every entry point without needing a per-script import.
config({ path: path.join(process.cwd(), ".env.local") });
