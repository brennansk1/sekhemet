import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.spec.ts", "apps/*/tests/**/*.spec.ts"],
    // `fixtures/` holds target projects the harness builds, not harness code.
    // Chronicle ships contract-first acceptance tests that are expected to be
    // RED until an agent implements them; running them here would report the
    // harness as broken for doing exactly what it is supposed to do.
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**"],
  },
});
