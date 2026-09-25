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
    expect(p.switches).toEqual({ thinking: "surgical", workerMethod: "strict" });
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
    expect(EXPERIMENT_SWITCHES).toEqual(["SEKHEMET_THINKING", "SEKHEMET_WORKER_METHOD"]);
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
});
