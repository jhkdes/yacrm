import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact } from "@/db/schema";

// Lists every active Contact that survived filtering — the direct check for
// M4: zero mailing lists / bulk senders should appear here. Pending
// (one-way-only) Contacts are excluded; see db:list-pending for those.
async function main() {
  await ensurePgliteServerRunning();

  const rows = await db
    .select({
      email: contact.sourceIdentifier,
      displayName: contact.displayName,
      source: contact.source,
    })
    .from(contact)
    .where(eq(contact.status, "active"))
    .orderBy(asc(contact.sourceIdentifier));

  console.log(`${rows.length} contact(s):`);
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
