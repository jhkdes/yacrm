import { isNotNull } from "drizzle-orm";

import { db } from "@/db/client";
import { person } from "@/db/schema";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { inferIndustries } from "@/lib/industry-inference";

// M29 real-data verification: infer industries for real people's
// normalized companies and eyeball the output against
// docs/industry-taxonomy.md.
//   npm run db:classify-industries -- [limit]
async function main() {
  await ensurePgliteServerRunning();

  const limit = Number(process.argv[2] ?? "10");

  const rows = await db.query.person.findMany({
    where: isNotNull(person.normalizedCompanyName),
    columns: { id: true, name: true, normalizedCompanyName: true },
    limit,
  });

  if (rows.length === 0) {
    console.log("No people with a normalizedCompanyName yet — run a LinkedIn import first.");
    return;
  }

  const names = [...new Set(rows.map((r) => r.normalizedCompanyName!))];
  console.log(`Inferring industry for ${names.length} distinct compan${names.length === 1 ? "y" : "ies"}...\n`);
  const industryByCompany = await inferIndustries(db, names);

  for (const name of names) {
    console.log(`${name} -> ${industryByCompany.get(name)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
