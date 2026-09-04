import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact, event, person } from "@/db/schema";

// Clears imported Person/Contact/Event data for a clean re-test, without
// touching oauth_account — your Gmail connection stays intact.
async function main() {
  await ensurePgliteServerRunning();

  const deletedEvents = await db.delete(event).returning({ id: event.id });
  const deletedContacts = await db
    .delete(contact)
    .returning({ id: contact.id });
  const deletedPersons = await db.delete(person).returning({ id: person.id });

  console.log("Reset complete:");
  console.log({
    eventsDeleted: deletedEvents.length,
    contactsDeleted: deletedContacts.length,
    personsDeleted: deletedPersons.length,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
