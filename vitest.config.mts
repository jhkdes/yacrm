import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Each createTestDb() spins up a real in-memory WASM Postgres instance.
    // With 15+ test files doing this, Vitest's default file-level
    // parallelism can genuinely CPU-starve those instances rather than any
    // external process contention — causing 10s beforeEach timeouts that
    // are flaky, not deterministic. Running files sequentially trades some
    // wall-clock time for reliability; a longer hookTimeout gives real
    // headroom under load either way.
    fileParallelism: false,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
