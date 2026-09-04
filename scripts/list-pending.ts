import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact } from "@/db/schema";

// Lists Contacts that are one-way so far — persisted (not discarded) so a
// reply arriving in a future sync can promote them to active.
async function main() {
  await ensurePgliteServerRunning();

  const rows = await db
    .select({
      email: contact.sourceIdentifier,
      displayName: contact.displayName,
      source: contact.source,
    })
    .from(contact)
    .where(eq(contact.status, "pending"))
    .orderBy(asc(contact.sourceIdentifier));

  console.log(`${rows.length} pending contact(s):`);
  for (const row of rows) {
    console.log(`  ${row.displayName ?? "(no name)"} <${row.email}> [${row.source}]`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
