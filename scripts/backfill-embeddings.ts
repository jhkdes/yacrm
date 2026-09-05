import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { backfillEmbeddings } from "@/lib/embedding-backfill";

// Embeds any Event imported before M11 (or whose embedding failed at
// import time) and recomputes affected Persons' summary embeddings. Needed
// once after adding VOYAGE_API_KEY if you already had imported data —
// otherwise M12's campaign ranking has nothing to rank against.
async function main() {
  await ensurePgliteServerRunning();

  console.log("Finding Events without an embedding...");
  const result = await backfillEmbeddings(db);

  console.log(
    `Found ${result.eventsFound}, embedded ${result.eventsEmbedded}, ` +
      `updated ${result.personsUpdated} Person summary embedding(s).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
