import { asc, count, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact, event, person } from "@/db/schema";

// Shows Person -> Contacts grouping directly — the right way to verify a
// merge (M8): two Contacts should share one Person row and their combined
// Event history, not just look unchanged in a flat per-Contact listing.
async function main() {
  await ensurePgliteServerRunning();

  const people = await db.query.person.findMany({
    orderBy: asc(person.id),
    with: { contacts: true },
  });

  for (const p of people) {
    const eventCounts = await Promise.all(
      p.contacts.map(async (c) => {
        const [row] = await db
          .select({ n: count() })
          .from(event)
          .where(eq(event.contactId, c.id));
        return row.n;
      }),
    );
    const totalEvents = eventCounts.reduce((sum, n) => sum + n, 0);

    console.log(`Person ${p.id}: "${p.name}" — ${totalEvents} event(s) total`);
    for (const c of p.contacts) {
      console.log(
        `    ${c.displayName ?? "(no name)"} <${c.sourceIdentifier}> [${c.source}, ${c.status}]`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
