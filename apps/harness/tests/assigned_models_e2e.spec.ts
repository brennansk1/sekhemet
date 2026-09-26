import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import {
  ModelRegistry,
  QUALIFICATION_SUITE_VERSION,
  hardwareFingerprint,
  hostFingerprintHash,
  saveMachineProfile,
} from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { describeModel } from "../src/model_access.js";
import { qualificationCombination } from "../src/qualify.js";

// MD-N10-3, end to end: `run` and `queue` take the Worker a person assigned
// with `sekhemet models assign` when no --worker is given. The spawned binary
// is stopped by the throughput floor before any model loads (MD-N2-3).

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const ASSIGNED = "assigned-worker:latest";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function project() {
  const root = mkdtempSync(join(tmpdir(), "sek-assigned-"));
  dirs.push(root);
  const repo = join(root, "cwd");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(repo);
  await new CardStore(db, log).createCard({
    id: "c1",
    tier: "story",
    title: "Write a",
    status: "ready",
    scopeFiles: ["src/a.ts"],
    stepBudget: 3,
    spec: "Export a constant named a from src/a.ts",
  });
  db.close();
  const configDir = join(home, ".sekhemet");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    SEKHEMET_CONFIG_DIR: configDir,
    SEKHEMET_MODEL_REGISTRY: join(configDir, "models.json"),
    SEKHEMET_MACHINE_PROFILE: join(configDir, "machine.json"),
    SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
    BROWSER: "false",
  };
  // The assigned model qualified for the combination the binary resolves.
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const registry = new ModelRegistry(env.SEKHEMET_MODEL_REGISTRY);
  const adapter = describeModel(ASSIGNED, "worker", { registry });
  registry.recordCombinationQualification(
    adapter.modelId,
    qualificationCombination(adapter, { registry }),
    {
      suiteVersion: QUALIFICATION_SUITE_VERSION,
      passRate: 1,
      status: "qualified",
      toolCallChecks: true,
    },
  );
  // Measured on this host below the overnight floor: nothing will load.
  saveMachineProfile(
    {
      version: 1,
      date: "2026-09-25T00:00:00Z",
      fingerprint: hardwareFingerprint(),
      fingerprintHash: hostFingerprintHash(),
      usableBytes: 16 * 1024 ** 3,
      tier: "M",
      models: {
        assigned: {
          modelId: ASSIGNED,
          label: "assigned",
          buckets: {},
          speed: { prefillTokensPerSecond: 20, decodeTokensPerSecond: 4 },
          throughputClass: "below_floor",
        },
      },
    },
    env.SEKHEMET_MACHINE_PROFILE,
  );
  const sekhemet = (args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd: repo,
      encoding: "utf8",
      timeout: 60_000,
      env,
    });
  return { repo, sekhemet };
}

describe("MD-N10-3: run and queue take the person's assigned Worker", () => {
  it("assign, then run and queue without --worker use it", async () => {
    const { repo, sekhemet } = await project();
    const assigned = sekhemet(["models", "assign", "worker", ASSIGNED, "--repo", repo]);
    expect(assigned.stdout).toMatch(/worker: assigned-worker:latest assigned \(personal\)/);
    expect(assigned.status).toBe(0);

    const run = sekhemet(["run", "c1", "--repo", repo]);
    expect(run.stdout).toMatch(/Worker: assigned-worker:latest/);
    expect(run.stderr).toMatch(
      /Refusing to run cards on assigned-worker:latest: measured prefill 20\.0 tok\/s \(required 40\)/,
    );
    expect(run.status).toBe(1);

    const queue = sekhemet(["queue", "--repo", repo]);
    expect(queue.stderr).toMatch(/Refusing to run cards on assigned-worker:latest/);
    expect(queue.status).toBe(1);
  }, 120_000);
});
