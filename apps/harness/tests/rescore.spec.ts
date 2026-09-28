import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunProfile } from "@sekhemet/eval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMeasureCommand } from "../src/measure_cmd.js";
import { expectedQueueProfile, rescoreSuiteResult } from "../src/rescore.js";
import type { Kernel } from "../src/wave2.js";

// SUITE_RUNS (B2.5, ref-r1): the suite script checked each card's recorded
// profile against the run's, without the fixture repository's configuration
// layer the queue adds (the default step budget), so every card was named.

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("SEKHEMET_USER_CONFIG", "/nonexistent/sekhemet-test-user-config.toml");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-rescore-"));
  dirs.push(d);
  return d;
};

/** The run's own profile, as ref-r1 recorded it: a settings file naming no setting. */
const runProfile = () =>
  resolveRunProfile({
    settingsFile: { path: "/arms/ref.json", text: '{"switches":{}}' },
    env: {},
    argv: ["--worker", "cyber-tiel", "--auto-accept"],
    envRoles: true,
  });

/** A card's profile as the queue recorded it in ref-r1: the run's settings plus the config's budget. */
const recorded = (stepCap: number, env: Record<string, string> = {}) =>
  resolveRunProfile({
    config: { policies: { stepCap } },
    env: { SEKHEMET_THINKING: "off", ...env },
    argv: ["--worker", "cyber-tiel", "--auto-accept"],
    envRoles: true,
  });

function repo(root: string, fixture: string, config?: string): string {
  const dir = join(root, fixture);
  mkdirSync(join(dir, ".sekhemet", "evidence"), { recursive: true });
  if (config) writeFileSync(join(dir, ".sekhemet", "config.toml"), config);
  return dir;
}

function evidence(dir: string, card: string, profile: object): void {
  writeFileSync(
    join(dir, ".sekhemet", "evidence", `latest-${card}.json`),
    JSON.stringify({ reproducibility: { runProfile: profile } }),
  );
}

describe("the profile a fixture's queue is expected to resolve", () => {
  it("is the run's settings plus the repository's configuration layer", () => {
    const root = tmp();
    const plain = expectedQueueProfile(repo(root, "chronicle"), runProfile());
    expect(plain.policies.stepCap).toBe(40);
    expect(plain.sources["policies.stepCap"]).toBe("config");
    expect(plain.roles).toEqual({ worker: "cyber-tiel" });
    const tuned = expectedQueueProfile(
      repo(root, "onyx", "[loop]\ndefault_step_budget = 25\n"),
      runProfile(),
    );
    expect(tuned.policies.stepCap).toBe(25);
    const flagged = expectedQueueProfile(
      repo(root, "vanguard", "[loop]\ndefault_step_budget = 25\n"),
      resolveRunProfile({ env: {}, argv: ["--worker", "cyber-tiel", "--max-turns", "30"] }),
    );
    expect(flagged.policies.stepCap).toBe(30);
  });
});

describe("sekhemet measure rescore: an existing result re-scored from its work dir's evidence", () => {
  function made() {
    const root = tmp();
    const work = join(root, "work");
    const chronicle = repo(work, "chronicle");
    evidence(chronicle, "card_a", recorded(40));
    // A real divergence stays named: a tuned budget, a different switch.
    evidence(chronicle, "card_b", recorded(30));
    evidence(chronicle, "card_c", recorded(40, { SEKHEMET_WORKER_METHOD: "strict" }));
    const resultPath = join(root, "ref-r1.json");
    const text = `${JSON.stringify({
      suiteHash: "h",
      outcomes: [
        { task: { suite: "chronicle", cardId: "chronicle_1" } },
        { task: { suite: "chronicle", cardId: "chronicle_2" } },
        { task: { suite: "chronicle", cardId: "chronicle_3" } },
      ],
      runProfile: runProfile(),
      profileMismatch: ["chronicle/card_a", "chronicle/card_b", "chronicle/card_c"],
    })}\n`;
    writeFileSync(resultPath, text);
    return { root, work, resultPath, text };
  }

  it("writes the rescored result next to the original and leaves the original alone", () => {
    const { root, work, resultPath, text } = made();
    const r = rescoreSuiteResult(resultPath, work);
    expect(r.out).toBe(join(root, "ref-r1.rescored.json"));
    expect(r.profileMismatch).toEqual(["chronicle/card_b", "chronicle/card_c"]);
    expect(r.differences).toEqual({
      "chronicle/card_b": ["policies.stepCap"],
      "chronicle/card_c": ["switches.workerMethod"],
    });
    expect(readFileSync(resultPath, "utf8")).toBe(text);
    const out = JSON.parse(readFileSync(r.out, "utf8"));
    expect(out.profileMismatch).toEqual(["chronicle/card_b", "chronicle/card_c"]);
    expect(Object.keys(out.cardProfiles)).toEqual([
      "chronicle/card_a",
      "chronicle/card_b",
      "chronicle/card_c",
    ]);
    expect(out.rescored.previousProfileMismatch).toHaveLength(3);
    expect(out.rescored.from).toBe("ref-r1.json");
    expect(out.suiteHash).toBe("h");
  });

  it("drops profileMismatch when every card matches, and refuses to write over the original", () => {
    const root = tmp();
    const work = join(root, "work");
    evidence(repo(work, "onyx"), "card_x", recorded(40));
    const resultPath = join(root, "run.json");
    writeFileSync(
      resultPath,
      JSON.stringify({
        outcomes: [{ task: { suite: "onyx", cardId: "onyx_1" } }],
        runProfile: runProfile(),
        profileMismatch: ["onyx/card_x"],
      }),
    );
    const r = rescoreSuiteResult(resultPath, work);
    expect(JSON.parse(readFileSync(r.out, "utf8")).profileMismatch).toBeUndefined();
    expect(() => rescoreSuiteResult(resultPath, work, resultPath)).toThrow(/never over it/);
    expect(() => rescoreSuiteResult(resultPath, join(root, "nowhere"))).toThrow(
      /no fixture repository/,
    );
  });

  it("is a measure subcommand", async () => {
    const { work, resultPath } = made();
    const lines: string[] = [];
    const code = await runMeasureCommand(
      ["rescore", resultPath, "--work", work],
      {} as Kernel,
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/2 of 3 issue\(s\) ran with a different profile/);
    expect(lines.join("\n")).toMatch(/chronicle\/card_b \(policies\.stepCap\)/);
  });
});
