import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact } from "@/db/schema";
import { generateMergeSuggestions } from "@/lib/merge-suggestions";

// Runs the M7 scoring engine against real imported Contacts and prints the
// top suggestions for manual review — no merging happens here (that's M8).
async function main() {
  await ensurePgliteServerRunning();

  const contacts = await db
    .select({
      contactId: contact.id,
      personId: contact.personId,
      source: contact.source,
      sourceIdentifier: contact.sourceIdentifier,
      displayName: contact.displayName,
    })
    .from(contact);

  const suggestions = generateMergeSuggestions(contacts);
  const top = suggestions.slice(0, 10);

  console.log(`${suggestions.length} suggestion(s), showing top ${top.length}:\n`);

  const byId = new Map(contacts.map((c) => [c.contactId, c]));
  for (const suggestion of top) {
    const a = byId.get(suggestion.contactAId)!;
    const b = byId.get(suggestion.contactBId)!;
    console.log(
      `score ${suggestion.score.toFixed(2)} [${suggestion.reasons.join(", ")}]`,
    );
    console.log(
      `  ${a.displayName ?? "(no name)"} <${a.sourceIdentifier}> [${a.source}]`,
    );
    console.log(
      `  ${b.displayName ?? "(no name)"} <${b.sourceIdentifier}> [${b.source}]`,
    );
    console.log();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
