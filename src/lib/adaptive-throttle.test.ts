import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdaptiveThrottle } from "./adaptive-throttle";

function rateLimitError() {
  return Object.assign(new Error("Quota exceeded for quota metric"), {
    response: { status: 429 },
  });
}

// Real backoff delays go up to 60s per attempt, so these tests run against
// fake timers instead of actually sleeping — vi.advanceTimersByTimeAsync
// fast-forwards time while still letting the throttle's real async/await
// logic run.
describe("AdaptiveThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on the first try when nothing fails", async () => {
    const throttle = new AdaptiveThrottle();
    const result = await throttle.run(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(throttle.currentDelayMs).toBe(100);
  });

  it("does not retry a non-rate-limit error", async () => {
    const throttle = new AdaptiveThrottle();
    const fn = vi.fn().mockRejectedValue(new Error("Not found"));

    await expect(throttle.run(fn)).rejects.toThrow("Not found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limit error and eventually succeeds", async () => {
    const throttle = new AdaptiveThrottle({ initialDelayMs: 100 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce("ok");

    const promise = throttle.run(fn);
    // Let the two backoff sleeps (1000ms, 2000ms) elapse.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("doubles the throttle delay (capped) on each rate-limit hit and keeps it for future calls", async () => {
    const throttle = new AdaptiveThrottle({
      initialDelayMs: 100,
      maxDelayMs: 300,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce("ok");

    const promise = throttle.run(fn);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    // 100 -> 200 -> 300 (capped at maxDelayMs, would otherwise be 400/800).
    expect(throttle.currentDelayMs).toBe(300);
  });

  it("throws once retries are exhausted", async () => {
    const throttle = new AdaptiveThrottle({ maxRetries: 2 });
    const fn = vi.fn().mockRejectedValue(rateLimitError());

    const promise = throttle.run(fn);
    const assertion = expect(promise).rejects.toThrow("Quota exceeded");
    // 3 attempts total (initial + 2 retries), backoffs of 1000ms and 2000ms.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });
});
