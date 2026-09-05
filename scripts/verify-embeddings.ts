import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { ensurePgliteServerRunning } from "@/db/ensure-server";
import { contact, event, person } from "@/db/schema";
import { generateEmbeddings } from "@/lib/embeddings";
import { findNearestEventsTo } from "@/lib/event-similarity";

// M11 verification: two known-similar texts (same topic: scheduling a
// meeting) and one known-dissimilar text (a completely different topic)
// should rank the similar pair closer together than either is to the
// dissimilar one — using the real Voyage API on real text, not hand-crafted
// vectors (see event-similarity.test.ts for the fixture-based version of
// this same check).
async function main() {
  await ensurePgliteServerRunning();

  console.log("Requesting real embeddings from Voyage AI...");
  const texts = [
    "Are you free to hop on a call Tuesday at 2pm to go over the project timeline?",
    "Can we schedule a meeting for next Tuesday afternoon to discuss the project schedule?",
    "The lasagna recipe calls for two cups of ricotta cheese and a pound of ground beef.",
  ];
  const [embeddingA, embeddingB, embeddingC] = await generateEmbeddings(texts);

  const [testPerson] = await db
    .insert(person)
    .values({ name: "Embedding Verification (safe to delete)" })
    .returning();
  const [testContact] = await db
    .insert(contact)
    .values({
      personId: testPerson.id,
      source: "gmail",
      sourceIdentifier: "verify-embeddings@example.com",
    })
    .returning();

  const rows = await db
    .insert(event)
    .values([
      {
        contactId: testContact.id,
        direction: "inbound",
        occurredAt: new Date(),
        bodyText: texts[0],
        sourceMessageId: "verify-1",
        embedding: embeddingA,
      },
      {
        contactId: testContact.id,
        direction: "inbound",
        occurredAt: new Date(),
        bodyText: texts[1],
        sourceMessageId: "verify-2",
        embedding: embeddingB,
      },
      {
        contactId: testContact.id,
        direction: "inbound",
        occurredAt: new Date(),
        bodyText: texts[2],
        sourceMessageId: "verify-3",
        embedding: embeddingC,
      },
    ])
    .returning({ id: event.id });
  const [similarA, similarB, dissimilar] = rows;

  const nearest = await findNearestEventsTo(db, similarA.id, 2);
  const distanceToSimilar = nearest.find((n) => n.id === similarB.id)!.distance;
  const distanceToDissimilar = nearest.find(
    (n) => n.id === dissimilar.id,
  )!.distance;

  console.log(`Distance to similar-topic event:    ${distanceToSimilar.toFixed(4)}`);
  console.log(`Distance to dissimilar-topic event: ${distanceToDissimilar.toFixed(4)}`);

  if (distanceToSimilar < distanceToDissimilar) {
    console.log("PASS: the similar-topic event ranked closer, as expected.");
  } else {
    console.log("FAIL: the dissimilar-topic event ranked closer than the similar one.");
  }

  console.log("\nCleaning up test data...");
  await db.delete(event).where(eq(event.contactId, testContact.id));
  await db.delete(contact).where(eq(contact.id, testContact.id));
  await db.delete(person).where(eq(person.id, testPerson.id));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
