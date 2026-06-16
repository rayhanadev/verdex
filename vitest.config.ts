import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Barrel re-exports and the types-only Standard Schema spec carry no runtime logic.
      exclude: ["src/index.ts", "src/schema.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
