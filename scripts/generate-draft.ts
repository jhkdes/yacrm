import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { generateDraftForPerson } from "@/lib/draft-generation";

// M13 real-data verification: draft an outreach email for a real Person
// against a real campaign goal, and read it for correctness/tone.
//   npm run db:generate-draft -- <personId> "campaign goal text"
async function main() {
  await ensurePgliteServerRunning();

  const [personIdArg, ...goalParts] = process.argv.slice(2);
  const personId = Number(personIdArg);
  const goal = goalParts.join(" ").trim();
  if (!personIdArg || Number.isNaN(personId) || !goal) {
    console.error(
      'Usage: npm run db:generate-draft -- <personId> "campaign goal text"',
    );
    process.exit(1);
  }

  console.log(`Drafting for Person ${personId} — goal: "${goal}"\n`);
  const { context, draft } = await generateDraftForPerson(db, personId, goal);

  console.log(`Person: ${context.personName}`);
  console.log(`Based on ${context.events.length} event(s) of history.\n`);
  console.log(`Subject: ${draft.subject}\n`);
  console.log(draft.body);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
