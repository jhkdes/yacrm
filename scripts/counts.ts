import { count } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact, event, person, purgedContact } from "@/db/schema";

// Quick health-check / before-and-after snapshot for manual testing.
async function main() {
  await ensurePgliteServerRunning();

  const [personCount] = await db.select({ n: count() }).from(person);
  const [contactCount] = await db.select({ n: count() }).from(contact);
  const [eventCount] = await db.select({ n: count() }).from(event);
  const [purgedCount] = await db.select({ n: count() }).from(purgedContact);

  console.log({
    persons: personCount.n,
    contacts: contactCount.n,
    events: eventCount.n,
    purged: purgedCount.n,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
