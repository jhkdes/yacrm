import { asc, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { dismissedMergeSuggestion, person } from "@/db/schema";

// Lists rejected merge suggestions — these won't resurface unless undone
// via the "Undo" button on /merges.
async function main() {
  await ensurePgliteServerRunning();

  const rows = await db
    .select({
      personAId: dismissedMergeSuggestion.personAId,
      personBId: dismissedMergeSuggestion.personBId,
      dismissedAt: dismissedMergeSuggestion.dismissedAt,
    })
    .from(dismissedMergeSuggestion)
    .orderBy(asc(dismissedMergeSuggestion.dismissedAt));

  const personIds = [...new Set(rows.flatMap((r) => [r.personAId, r.personBId]))];
  const people =
    personIds.length > 0
      ? await db
          .select({ id: person.id, name: person.name })
          .from(person)
          .where(inArray(person.id, personIds))
      : [];
  const nameById = new Map(people.map((p) => [p.id, p.name]));

  console.log(`${rows.length} dismissed pair(s):`);
  for (const row of rows) {
    console.log(
      `  ${nameById.get(row.personAId) ?? `Person ${row.personAId}`} <-> ${
        nameById.get(row.personBId) ?? `Person ${row.personBId}`
      } (dismissed ${row.dismissedAt.toISOString()})`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
