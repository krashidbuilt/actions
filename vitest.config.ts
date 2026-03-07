import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "scripts/**/*.test.ts",
        "src/actions/**/index.ts",
        "src/actions/**/config.ts",
        "src/core/index.ts",
        "src/types/**",
        "scripts/**",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
    mockReset: true,
    restoreMocks: true,
  },
});
