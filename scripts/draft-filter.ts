import { draftFilterFromGoal } from "@/lib/filter-drafting";

// M33 real-data verification: draft a structured filter from a goal
// string and eyeball it — inherently judgment-based, no automated test
// for the real LLM call itself.
//   npm run db:draft-filter -- "hiring enterprise PMs at mid-size companies"
async function main() {
  const goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    console.error('Usage: npm run db:draft-filter -- "campaign goal text"');
    process.exit(1);
  }

  console.log(`Goal: "${goal}"\n`);
  const filter = await draftFilterFromGoal(goal);
  console.log(JSON.stringify(filter, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
