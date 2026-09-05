import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { rankPeopleForCampaign } from "@/lib/campaign-ranking";

// M12 real-data verification: run a real campaign goal against your actual
// People and sanity-check that the top results make sense.
//   npm run db:rank-campaign -- "hiring a senior backend engineer"
async function main() {
  await ensurePgliteServerRunning();

  const goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    console.error('Usage: npm run db:rank-campaign -- "campaign goal text"');
    process.exit(1);
  }

  console.log(`Ranking People for: "${goal}"\n`);
  const results = await rankPeopleForCampaign(db, goal);

  if (results.length === 0) {
    console.log(
      "No eligible People — need active Contacts with embedded Events (see M11).",
    );
    return;
  }

  for (const r of results) {
    console.log(
      `${r.score.toFixed(3)}  ${r.name}  ` +
        `[similarity ${r.similarity.toFixed(2)}, recency ${r.recencyScore.toFixed(2)}, ` +
        `engagement ${r.engagementScore.toFixed(2)}, ${r.eventCount} events, ` +
        `last ${r.lastEventAt.toISOString().slice(0, 10)}]`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
