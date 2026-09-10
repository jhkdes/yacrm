import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";

// Read-only discovery tool for src/lib/voice-examples.ts (see docs/... plan
// "Ground campaign drafts in the user's real voice"). Each LinkedIn
// contact's *earliest* outbound message is the closest analog to a
// cold-outreach opener — the thing campaign drafts actually are, as
// opposed to a mid-conversation reply. Prints candidates for the user to
// hand-pick from; writes nothing.
async function main() {
  await ensurePgliteServerRunning();

  const result = await db.execute(sql`
    select distinct on (e.contact_id)
      p.name as person_name,
      e.occurred_at,
      e.body_text
    from event e
    join contact c on c.id = e.contact_id
    join person p on p.id = c.person_id
    where c.source = 'linkedin'
      and e.direction = 'outbound'
      and length(trim(e.body_text)) > 40
    order by e.contact_id, e.occurred_at asc
  `);

  const rows = (result.rows as { person_name: string; occurred_at: string; body_text: string }[])
    .slice()
    .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

  console.log(`${rows.length} candidate(s):\n`);
  for (const row of rows) {
    const date = new Date(row.occurred_at).toISOString().slice(0, 10);
    console.log(`--- ${row.person_name} (${date}) ---`);
    console.log(row.body_text.trim());
    console.log();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
