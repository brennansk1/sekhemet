import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
// @ts-expect-error: a plain ESM script shared with the test that checks it.
import { splitSpecs } from "./scripts/test_split.mjs";

const EXCLUDE = ["**/node_modules/**", "**/dist/**", "fixtures/**"];
// X23: `pnpm test:unit` (mocked, in-memory) and `pnpm test:integration`
// (real git, fixtures, on-disk SQLite, servers), split by what each spec does.
const split = splitSpecs(import.meta.dirname) as {
  unit: string[];
  integration: string[];
  browser: string[];
};

export default defineConfig({
  test: {
    // Every spec under packages/*/tests and apps/*/tests, in exactly one of
    // the two projects (a root `include` would be merged into both).
    // `fixtures/` holds target projects the harness builds, not harness code.
    // Chronicle ships contract-first acceptance tests that are expected to be
    // RED until an agent implements them; running them here would report the
    // harness as broken for doing exactly what it is supposed to do.
    exclude: EXCLUDE,
    // Tests never read the owner's real ~/.sekhemet/config.toml (B1 review),
    // nor read or write the owner's workspace trust store (S9).
    env: {
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      SEKHEMET_TRUST_DIR: join(tmpdir(), "sekhemet-test-trust"),
      // Nor the owner's login keychain (SEC-27a): keychain.spec.ts turns it on
      // against a throwaway keychain of its own.
      SEKHEMET_KEYCHAIN: "off",
      // MD-N4-5: nor the owner's user directory, model registry or machine
      // profile: every test file writes them under the temporary directory.
      SEKHEMET_CONFIG_DIR: join(tmpdir(), "sekhemet-test-user", ".sekhemet"),
      SEKHEMET_MODEL_REGISTRY: join(tmpdir(), "sekhemet-test-user", "models.json"),
      SEKHEMET_MACHINE_PROFILE: join(tmpdir(), "sekhemet-test-user", "machine.json"),
      // Nor the owner's real model servers or a real llama.cpp binary: a test
      // that would load a model fails instead (`load_guard.ts`, B4.3).
      SEKHEMET_MODEL_LOADS: "off",
    },
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
      // The specs that drive a real Chromium: one file at a time, in one fork,
      // after every other project has finished, so at most one Chromium is
      // open and its timing assertions (Undo's 10 s, Accept's 3 s grace, the
      // offline check's 10 s) do not share the host with the rest (C2d review).
      {
        extends: true,
        test: {
          name: "browser",
          include: split.browser,
          testTimeout: 30_000,
          fileParallelism: false,
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
