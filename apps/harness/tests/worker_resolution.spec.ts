import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { ModelRegistry, assignRole } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { defaultWorkerName, effectiveConfig, queueDefaults } from "../src/config_apply.js";
import { recommendRoster } from "../src/init.js";
import { resolveWorkerName, workerZone3Fit } from "../src/model_access.js";

/**
 * SUR-11 (P10): with no Worker set anywhere, `run`, `queue` and the
 * dashboard resolve it the same way — the roster for this machine's tier —
 * instead of each keeping its own fallback. That default is the last step:
 * config's own step names only what config.toml sets, so a person's
 * assignment (MD-N10-3: flag, assignment, config, default) still outranks it.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("SUR-11: one Worker resolution for run, queue and the dashboard", () => {
  it("leaves an unset (auto) Worker to the tier's roster default, and a set one to itself", () => {
    const repo = mkdtempSync(join(tmpdir(), "worker-res-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".sekhemet"));
    const auto = effectiveConfig(repo).config;
    expect(auto.models.executor).toBe("auto");
    // Config names no Worker, so the assignment can still win before the default.
    expect(queueDefaults(auto, []).worker).toBeUndefined();
    expect(defaultWorkerName()).toBe(recommendRoster(totalmem()).worker);
    writeFileSync(join(repo, ".sekhemet", "config.toml"), '[models]\nexecutor = "nail"\n');
    expect(queueDefaults(effectiveConfig(repo).config, []).worker).toBe("nail");
    // A flag still wins over both.
    expect(queueDefaults(auto, ["--worker", "x"]).worker).toBeUndefined();
  });

  it("resolves the Worker as run, queue and the dashboard do: flag, assignment, config, default", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-res-"));
    dirs.push(dir);
    const registry = new ModelRegistry(join(dir, "models.json"));
    const opts = { registry, host: "h" };
    expect(resolveWorkerName(undefined, undefined, opts)).toBe(recommendRoster(totalmem()).worker);
    expect(resolveWorkerName(undefined, "nail", opts)).toBe("nail");
    assignRole(registry, {
      role: "worker",
      model: "assigned-worker",
      scope: "personal",
      by: "person: B",
      host: "h",
      qualification: "qualified",
    });
    // MD-N10-3: the person's assignment outranks config.toml and the default.
    expect(resolveWorkerName(undefined, "nail", opts)).toBe("assigned-worker");
    expect(resolveWorkerName("x", "nail", opts)).toBe("x");
  });
});

describe("PM-12..14: the board's Small check is the planner's, at the resolved Worker's W", () => {
  it("caps Zone 3 at 3,792 tokens for the reference Worker, and refuses a card over it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-z3-"));
    dirs.push(dir);
    const registry = new ModelRegistry(join(dir, "models.json"));
    const fit = workerZone3Fit(dir, { registry, configured: "cyber-tiel" });
    const small = await fit({
      id: "c",
      title: "t",
      spec: "s",
      acceptanceCriteria: [],
      scopeFiles: [],
    } as never);
    expect(small.cap).toBe(3_792);
    expect(small.tokens).toBeLessThan(small.cap);
    const big = await fit({
      id: "c",
      title: "t",
      spec: "word ".repeat(20_000),
      acceptanceCriteria: [],
      scopeFiles: [],
    } as never);
    expect(big.tokens).toBeGreaterThan(big.cap);
  });
});
