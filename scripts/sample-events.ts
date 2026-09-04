import { desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact, event } from "@/db/schema";

// Prints a handful of imported Events with their Contact, so you can spot
// check them against the real messages in Gmail.
async function main() {
  await ensurePgliteServerRunning();

  const sampleSize = Number(process.argv[2] ?? 5);

  const rows = await db
    .select({
      occurredAt: event.occurredAt,
      direction: event.direction,
      subject: event.subject,
      sourceMessageId: event.sourceMessageId,
      contactEmail: contact.sourceIdentifier,
      contactName: contact.displayName,
    })
    .from(event)
    .innerJoin(contact, eq(event.contactId, contact.id))
    .orderBy(desc(event.occurredAt))
    .limit(sampleSize);

  const withLinks = rows.map((row) => ({
    ...row,
    gmailLink: `https://mail.google.com/mail/u/0/#all/${row.sourceMessageId}`,
  }));

  console.log(JSON.stringify(withLinks, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
