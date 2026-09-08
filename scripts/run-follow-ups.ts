import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { sendFollowUps } from "@/lib/follow-up";

// M23 real-data verification: run the follow-up job directly against real
// data and eyeball the result before wiring up the actual cron trigger (see
// docs/technical-design-and-milestones.md's M23 test plan) — this hits
// real Gmail sends for any eligible email recipient, so don't run it
// against real data until you're ready to trust it unattended.
//   npm run db:run-follow-ups
async function main() {
  await ensurePgliteServerRunning();

  const summary = await sendFollowUps(db);

  console.log("Follow-up run complete:");
  console.log(`  Emails sent:        ${summary.emailsSent}`);
  console.log(`  LinkedIn re-queued: ${summary.linkedinQueued}`);
  console.log(`  Skipped (draft failed):     ${summary.skippedDraftFailed}`);
  console.log(`  Skipped (no Gmail account): ${summary.skippedNoGmailAccount}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
