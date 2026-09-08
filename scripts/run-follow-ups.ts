import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { runFollowUpCycle } from "@/lib/follow-up";

// M23 real-data verification: run the follow-up job directly against real
// data and eyeball the result before wiring up the actual cron trigger (see
// docs/technical-design-and-milestones.md's M23 test plan). Never sends
// anything to a real recipient — this only drafts follow-ups and, if
// anything was queued, emails the owner's own connected Gmail account a
// review digest. Actually sending each one is a separate, logged-in step.
//   npm run db:run-follow-ups
async function main() {
  await ensurePgliteServerRunning();

  const summary = await runFollowUpCycle(db);

  console.log("Follow-up run complete:");
  console.log(`  Email follow-ups queued for review:    ${summary.emailQueued}`);
  console.log(`  LinkedIn follow-ups queued for review: ${summary.linkedinQueued}`);
  console.log(`  Skipped (draft generation failed):     ${summary.skippedDraftFailed}`);
  console.log(`  Owner notified by email:               ${summary.notified}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
