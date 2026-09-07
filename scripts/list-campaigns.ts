import { desc } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { campaign } from "@/db/schema";

// Lists every persisted Campaign and its recipients' funnel status — the
// direct check for M17: a campaign created through /campaigns should still
// be here (and its recipients still "drafted") after a server restart.
async function main() {
  await ensurePgliteServerRunning();

  const campaigns = await db.query.campaign.findMany({
    orderBy: desc(campaign.createdAt),
    with: { recipients: { with: { person: true } } },
  });

  console.log(`${campaigns.length} campaign(s):`);
  for (const c of campaigns) {
    console.log(`\n[${c.id}] ${c.name} (${c.type}) — goal: "${c.goal}"`);
    for (const r of c.recipients) {
      console.log(
        `  - ${r.person.name} — ${r.channel} — ${r.status}${
          r.sentAt ? ` (sent ${r.sentAt.toISOString()})` : ""
        }`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
