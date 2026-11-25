import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several tests start real processes, which slows down when the whole suite runs in parallel.
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "html"]
    },
    include: ["tests/**/*.test.ts"]
  }
});
