import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { runFollowUpCycle } from "@/lib/follow-up";

// M23 real-data verification: run the follow-up job directly against real
// data and eyeball the result before wiring up the actual cron trigger (see
// docs/technical-design-and-milestones.md's M23 test plan). Never sends
// anything to a real recipient — this only drafts follow-ups and, if
// anything was queued, emails the owner's own connected Gmail account a
// review digest. Actually sending each one is a separate, logged-in step.
//
// Takes an optional "now" override so you can test the 3-day rule without
// actually waiting 3 days: send a real campaign email today, then run this
// with a date 3+ days after that real sentAt. needsFollowUp only compares
// sentAt against the "now" it's given (see follow-up.ts) — nothing else
// about the recipient row needs to be backdated.
//   npm run db:run-follow-ups
//   npm run db:run-follow-ups -- 2026-03-14T00:00:00Z
async function main() {
  await ensurePgliteServerRunning();

  const nowArg = process.argv[2];
  let now: Date | undefined;
  if (nowArg) {
    now = new Date(nowArg);
    if (Number.isNaN(now.getTime())) {
      console.error(`Invalid date: "${nowArg}". Expected an ISO date, e.g. 2026-03-14T00:00:00Z.`);
      process.exit(1);
    }
    console.log(`Simulating "now" as ${now.toISOString()}\n`);
  }

  const summary = await runFollowUpCycle(db, now);

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
