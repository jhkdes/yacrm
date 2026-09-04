import { isRateLimitError } from "@/lib/gmail-parsing";

export interface AdaptiveThrottleOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tracks the current inter-request delay for one import run. A fixed delay
// can't know the actual per-user quota available to a given project, so
// instead of guessing once, this backs off permanently (for the rest of the
// run) every time it actually gets rate-limited, rather than retrying the
// one failed call and immediately resuming at the same pace — which just
// walks into the same wall a few requests later.
export class AdaptiveThrottle {
  private delayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;

  constructor(options: AdaptiveThrottleOptions = {}) {
    this.delayMs = options.initialDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 8;
  }

  get currentDelayMs(): number {
    return this.delayMs;
  }

  async wait(): Promise<void> {
    await sleep(this.delayMs);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= this.maxRetries) throw err;
        this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
        const backoff = Math.min(1000 * 2 ** attempt, this.maxBackoffMs);
        console.warn(
          `[gmail-import] rate limited, backing off ${backoff}ms and slowing future requests to ${this.delayMs}ms apart (attempt ${attempt + 1}/${this.maxRetries})`,
        );
        await sleep(backoff);
      }
    }
  }
}
