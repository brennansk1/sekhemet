import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_SWITCHES,
  RUN_PROFILE_FLAGS,
  RunProfileRefusal,
  profileArgs,
  profileSwitchCount,
  resolveRunProfile,
  runProfileHash,
} from "../src/run_profile.js";

describe("one recorded RunProfile (MS-M9-4, MS-M9-5)", () => {
  it("resolves defaults, then configuration, then the settings file, then switches, then flags", () => {
    const p = resolveRunProfile({
      config: { roles: { worker: "cyber-tiel", reviewer: "dirk" }, policies: { stepCap: 30 } },
      settingsFile: {
        path: "/x/arm.json",
        text: JSON.stringify({ policies: { stepCap: 24 }, switches: { thinking: "surgical" } }),
      },
      env: { SEKHEMET_WORKER_METHOD: "strict" },
      argv: ["run", "card_a", "--repo", "/r", "--max-turns", "20", "--review"],
    });
    expect(p.roles).toEqual({ worker: "cyber-tiel", reviewer: "dirk" });
    expect(p.policies.stepCap).toBe(20);
    expect(p.policies.review).toBe(true);
    expect(p.switches).toEqual({
      thinking: "surgical",
      workerMethod: "strict",
      evidenceGate: "off",
      toolArm: "progressive",
    });
    expect(p.sources).toMatchObject({
      "roles.worker": "config",
      "policies.stepCap": "flag",
      "switches.thinking": "settings",
      "switches.workerMethod": "env",
    });
  });

  it("records the settings file's path and content hash", () => {
    const text = '{ "switches": { "thinking": "all" } }';
    const p = resolveRunProfile({ settingsFile: { path: "/x/s.json", text }, env: {}, argv: [] });
    expect(p.settingsFile).toEqual({
      path: "/x/s.json",
      sha256: createHash("sha256").update(text).digest("hex"),
    });
  });

  it("refuses a flag that would change another setting", () => {
    expect(() => resolveRunProfile({ env: {}, argv: ["queue", "--profile", "full"] })).toThrow(
      RunProfileRefusal,
    );
    expect(() => resolveRunProfile({ env: {}, argv: ["queue", "--profile", "full"] })).toThrow(
      /--profile would set --explore, --escalate-retries, --review and --max-turns.*--settings <file>/,
    );
  });

  it("refuses a flag given twice with different values, and a settings file with unknown keys", () => {
    expect(() =>
      resolveRunProfile({ env: {}, argv: ["--max-turns", "10", "--max-turns", "20"] }),
    ).toThrow(/--max-turns is given twice/);
    expect(() =>
      resolveRunProfile({
        env: {},
        argv: [],
        settingsFile: { path: "s.json", text: '{ "policies": { "turbo": true } }' },
      }),
    ).toThrow(/s.json: unknown setting policies.turbo/);
  });

  it("names the arm under test and hashes the profile stably, ignoring where each value came from", () => {
    const a = resolveRunProfile({ env: {}, argv: ["--arm", "thinking=surgical"] });
    expect(a.armUnderTest).toBe("thinking=surgical");
    const b = resolveRunProfile({ env: { SEKHEMET_THINKING: "surgical" }, argv: [] });
    const c = resolveRunProfile({
      env: {},
      argv: [],
      settingsFile: { path: "s", text: '{"switches":{"thinking":"surgical"}}' },
    });
    expect(runProfileHash(b)).not.toBe(runProfileHash(a));
    expect(runProfileHash({ ...c, settingsFile: undefined })).toBe(runProfileHash(b));
  });

  it("counts the switches a footprint compares: the experiment switches plus the profile's flags", () => {
    expect(EXPERIMENT_SWITCHES).toEqual([
      "SEKHEMET_THINKING",
      "SEKHEMET_WORKER_METHOD",
      "SEKHEMET_PRUNE",
      "SEKHEMET_EVIDENCE_GATE",
    ]);
    expect(profileSwitchCount()).toBe(
      EXPERIMENT_SWITCHES.length + Object.keys(RUN_PROFILE_FLAGS).length,
    );
  });
  it("hands a profile to the product's command line as one-setting flags and switches, losing nothing", () => {
    const p = resolveRunProfile({
      settingsFile: {
        path: "arm.json",
        text: JSON.stringify({
          roles: { worker: "cyber-tiel", reviewer: "dirk" },
          policies: { review: true, stepCap: 24 },
          switches: { thinking: "surgical", workerMethod: "strict" },
          armUnderTest: "thinking=surgical",
        }),
      },
      env: {},
      argv: [],
    });
    const { argv, env } = profileArgs(p);
    expect(argv).not.toContain("--profile");
    const back = resolveRunProfile({ env, argv });
    expect(runProfileHash({ ...back, settingsFile: undefined })).toBe(
      runProfileHash({ ...p, settingsFile: undefined }),
    );
  });

  it("reads the Researcher a person set in the environment as a role, with its source", () => {
    const p = resolveRunProfile({
      env: { SEKHEMET_RESEARCHER: "apodex" },
      argv: [],
      envRoles: true,
    });
    expect(p.roles.researcher).toBe("apodex");
    expect(p.sources["roles.researcher"]).toBe("env");
    expect(resolveRunProfile({ env: { SEKHEMET_RESEARCHER: "apodex" }, argv: [] }).roles).toEqual(
      {},
    );
  });

  it("records a fixed sampling seed only when one is given, and hands it on (rule 10)", () => {
    expect(resolveRunProfile({ env: {}, argv: [] }).switches.seed).toBeUndefined();
    const p = resolveRunProfile({ env: {}, argv: ["--seed", "42"] });
    expect(p.switches.seed).toBe(42);
    expect(p.sources["switches.seed"]).toBe("flag");
    expect(profileArgs(p).argv).toEqual(["--seed", "42"]);
    expect(runProfileHash(p)).not.toBe(runProfileHash(resolveRunProfile({ env: {}, argv: [] })));
    expect(() => resolveRunProfile({ env: {}, argv: ["--seed", "x"] })).toThrow(
      /--seed must be a non-negative integer/,
    );
    const fromFile = resolveRunProfile({
      env: {},
      argv: [],
      settingsFile: { path: "s.json", text: '{"switches":{"seed":7}}' },
    });
    expect(fromFile.switches.seed).toBe(7);
  });

  it("reads the prune arm from its experiment switch, and hands it on as one (MS-T7-6)", () => {
    const p = resolveRunProfile({ env: { SEKHEMET_PRUNE: "random" }, argv: [] });
    expect(p.switches.prune).toBe("random");
    expect(p.sources["switches.prune"]).toBe("env");
    expect(profileArgs(p).env.SEKHEMET_PRUNE).toBe("random");
    expect(resolveRunProfile({ env: {}, argv: [] }).switches.prune).toBeUndefined();
    expect(profileArgs(resolveRunProfile({ env: {}, argv: [] })).env.SEKHEMET_PRUNE).toBe("query");
  });

  it("names B2.5's two arms: the evidence gate and the tool arm, with their defaults (rule 29a, M2)", () => {
    const d = resolveRunProfile({ env: {}, argv: [] });
    expect(d.switches).toMatchObject({ evidenceGate: "off", toolArm: "progressive" });
    const p = resolveRunProfile({
      env: { SEKHEMET_EVIDENCE_GATE: "on" },
      argv: ["--tool-arm", "fixed"],
    });
    expect(p.switches).toMatchObject({ evidenceGate: "on", toolArm: "fixed" });
    expect(p.sources).toMatchObject({ "switches.evidenceGate": "env", "switches.toolArm": "flag" });
    expect(runProfileHash(p)).not.toBe(runProfileHash(d));
    // Handed on to the product's command line unchanged.
    const { argv, env } = profileArgs(p);
    expect(env.SEKHEMET_EVIDENCE_GATE).toBe("on");
    expect(argv).toContain("--tool-arm");
    expect(runProfileHash(resolveRunProfile({ env, argv }))).toBe(runProfileHash(p));
    expect(() => resolveRunProfile({ env: {}, argv: ["--tool-arm", "some"] })).toThrow(
      /--tool-arm is progressive or fixed/,
    );
  });
});
