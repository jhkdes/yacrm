import { desc } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { meeting } from "@/db/schema";

// M24 real-data verification: lists every imported meeting and its linked
// attendees — the direct check for "connect a real (test) calendar,
// confirm meetings show up" from the M24 test plan.
async function main() {
  await ensurePgliteServerRunning();

  const meetings = await db.query.meeting.findMany({
    orderBy: desc(meeting.startTime),
    with: { attendees: { with: { contact: true } } },
  });

  console.log(`${meetings.length} meeting(s):`);
  for (const m of meetings) {
    console.log(
      `\n[${m.id}] ${m.title ?? "(untitled)"} — ${m.startTime.toISOString()}`,
    );
    for (const a of m.attendees) {
      console.log(`  - ${a.contact.displayName ?? a.contact.sourceIdentifier}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
