import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the suites staged for the current card. `acceptance/` is the
    // library they are staged from: running it directly would gate every card
    // on work belonging to later ones.
    include: ["tests/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "acceptance/**"],
    passWithNoTests: true,
  },
});
