import { asc } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { purgedContact } from "@/db/schema";

// Lists every (source, identifier) excluded via purge — these are blocked
// from ever being re-imported until someone removes the row directly.
async function main() {
  await ensurePgliteServerRunning();

  const rows = await db
    .select({
      source: purgedContact.source,
      sourceIdentifier: purgedContact.sourceIdentifier,
      purgedAt: purgedContact.purgedAt,
    })
    .from(purgedContact)
    .orderBy(asc(purgedContact.purgedAt));

  console.log(`${rows.length} purged identifier(s):`);
  for (const row of rows) {
    console.log(
      `  ${row.sourceIdentifier} [${row.source}] — purged ${row.purgedAt.toISOString()}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
