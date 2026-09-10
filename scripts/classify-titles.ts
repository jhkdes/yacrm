import { isNotNull } from "drizzle-orm";

import { db } from "@/db/client";
import { person } from "@/db/schema";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { classifyTitles } from "@/lib/title-extraction";

// M28 real-data verification: classify real people's LinkedIn raw titles
// and eyeball the output against docs/title-taxonomy.md.
//   npm run db:classify-titles -- [limit]
async function main() {
  await ensurePgliteServerRunning();

  const limit = Number(process.argv[2] ?? "10");

  const rows = await db.query.person.findMany({
    where: isNotNull(person.linkedinRawTitle),
    columns: { id: true, name: true, linkedinRawTitle: true, linkedinRawCompany: true },
    limit,
  });

  if (rows.length === 0) {
    console.log("No people with a linkedinRawTitle yet — run a LinkedIn import first.");
    return;
  }

  console.log(`Classifying ${rows.length} people...\n`);
  const results = await classifyTitles(
    db,
    rows.map((r) => ({
      personId: r.id,
      rawTitle: r.linkedinRawTitle!,
      rawCompany: r.linkedinRawCompany,
    })),
  );

  for (const result of results) {
    const source = rows.find((r) => r.id === result.personId)!;
    console.log(`${source.name}`);
    console.log(`  raw: "${source.linkedinRawTitle}"${source.linkedinRawCompany ? ` at ${source.linkedinRawCompany}` : ""}`);
    console.log(`  -> ${result.standardizedTitle} (${result.seniority}, ${result.function})\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
