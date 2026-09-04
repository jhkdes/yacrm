import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";

async function main() {
  await ensurePgliteServerRunning();

  const people = await db.query.person.findMany({
    with: {
      contacts: {
        with: {
          events: true,
        },
      },
    },
  });

  console.log(JSON.stringify(people, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
