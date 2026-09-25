import { defineConfig } from "vitest/config";
// @ts-expect-error: a plain ESM script shared with the test that checks it.
import { splitSpecs } from "./scripts/test_split.mjs";

const EXCLUDE = ["**/node_modules/**", "**/dist/**", "fixtures/**"];
// X23: `pnpm test:unit` (mocked, in-memory) and `pnpm test:integration`
// (real git, fixtures, on-disk SQLite, servers), split by what each spec does.
const split = splitSpecs(import.meta.dirname) as { unit: string[]; integration: string[] };

export default defineConfig({
  test: {
    // Every spec under packages/*/tests and apps/*/tests, in exactly one of
    // the two projects (a root `include` would be merged into both).
    // `fixtures/` holds target projects the harness builds, not harness code.
    // Chronicle ships contract-first acceptance tests that are expected to be
    // RED until an agent implements them; running them here would report the
    // harness as broken for doing exactly what it is supposed to do.
    exclude: EXCLUDE,
    // Tests never read the owner's real ~/.sekhemet/config.toml (B1 review).
    env: { SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml" },
    projects: [
      { extends: true, test: { name: "unit", include: split.unit } },
      // A card run with real git and SQLite takes 4.3-4.5 s alone on the 24 GB
      // reference host (execute_events at ef31a37 and after B2.4), so the 5 s
      // default failed ~50 of them whenever the host was busy. The limit is
      // for hangs, not speed; assertions are unchanged.
      {
        extends: true,
        test: { name: "integration", include: split.integration, testTimeout: 30_000 },
      },
    ],
  },
});
