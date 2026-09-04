import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact, event, person } from "@/db/schema";

async function main() {
  await ensurePgliteServerRunning();

  // Reset to a clean slate so this script is safe to re-run.
  await db.delete(event);
  await db.delete(contact);
  await db.delete(person);

  const [insertedPerson] = await db
    .insert(person)
    .values({ name: "Ada Lovelace" })
    .returning();

  const [insertedContact] = await db
    .insert(contact)
    .values({
      personId: insertedPerson.id,
      source: "gmail",
      sourceIdentifier: "ada@example.com",
      displayName: "Ada Lovelace",
    })
    .returning();

  const [insertedEvent] = await db
    .insert(event)
    .values({
      contactId: insertedContact.id,
      direction: "inbound",
      occurredAt: new Date("2026-01-15T10:00:00Z"),
      subject: "Re: analytical engine notes",
      bodyText: "Here are my notes on the punched card program.",
      sourceMessageId: "gmail-msg-001",
    })
    .returning();

  console.log("Seeded:");
  console.log({ insertedPerson, insertedContact, insertedEvent });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
