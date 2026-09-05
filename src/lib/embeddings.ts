import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { AdaptiveThrottle } from "@/lib/adaptive-throttle";

export const EMBEDDING_MODEL = "voyage-3-lite";
export { EMBEDDING_DIMENSIONS };

// Voyage's batch endpoint caps the number of inputs per request.
const MAX_BATCH_SIZE = 128;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.local.example.`,
    );
  }
  return value;
}

interface VoyageEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

class VoyageRequestError extends Error {
  // isRateLimitError (used by AdaptiveThrottle) checks this shape.
  response: { status: number };

  constructor(status: number, body: string) {
    super(`Voyage embeddings request failed (${status}): ${body}`);
    this.response = { status };
  }
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = requiredEnv("VOYAGE_API_KEY");

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new VoyageRequestError(res.status, body);
  }

  const json = (await res.json()) as VoyageEmbeddingResponse;
  // Voyage returns results in request order, but sort by index defensively.
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// Chunks into Voyage's max batch size and issues one request per chunk —
// far cheaper and faster than one request per text for a batch import.
// Rate-limited with the same adaptive backoff used for Gmail: Voyage's free
// tier without a payment method is a strict 3 requests/minute, so a
// multi-chunk backfill can genuinely hit 429s, not just in theory.
export async function generateEmbeddings(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const throttle = new AdaptiveThrottle({
    label: "voyage-embeddings",
    initialDelayMs: 200,
    maxDelayMs: 21_000,
    maxBackoffMs: 60_000,
    maxRetries: 10,
  });

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const chunk = texts.slice(i, i + MAX_BATCH_SIZE);
    const embeddings = await throttle.run(() => embedBatch(chunk));
    results.push(...embeddings);
    if (i + MAX_BATCH_SIZE < texts.length) {
      await throttle.wait();
    }
  }
  return results;
}
