import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuiteRunResult } from "@sekhemet/eval";
import { afterEach, describe, expect, it } from "vitest";
import { type SuiteSpawn, bakeOffOnSuitePath, runSuitePath } from "../src/suite_path.js";
import { runFixtureGate } from "../src/wave2.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-suite-path-"));
  dirs.push(d);
  return d;
};

function result(
  passes: (boolean | "blocked")[],
  worker = "w",
): SuiteRunResult & { worker: string } {
  const outcomes = passes.map((p, i) => ({
    task: { suite: "chronicle", cardId: `c${i}`, title: `c${i}` },
    passed: p === true,
    ...(p === "blocked" ? { blocked: true } : {}),
    wallClockSeconds: 60,
    tokens: 1000,
    rungs: 0,
  }));
  return {
    worker,
    suiteHash: "h",
    version: "1",
    passed: passes.filter((p) => p === true).length,
    total: passes.length,
    outcomes,
    cost: { wallClockSeconds: 60 * passes.length, tokens: 1000 * passes.length, rungs: 0 },
    firstTry: passes.filter((p) => p === true).length,
    at: "2026-09-25T00:00:00Z",
  };
}

/** A spawn that records its call and writes the result the runner would. */
function scripted(
  write: (args: string[]) => unknown,
): SuiteSpawn & { calls: { args: string[]; env: Record<string, string | undefined> }[] } {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  const spawn = (async (_cmd: string, args: string[], env: Record<string, string | undefined>) => {
    calls.push({ args, env });
    const out = args[args.indexOf("--out") + 1] as string;
    const body = write(args);
    if (body !== undefined) writeFileSync(out, JSON.stringify(body));
    return 0;
  }) as SuiteSpawn & { calls: typeof calls };
  spawn.calls = calls;
  return spawn;
}

describe("one measurement path: the rule gate and the bake-off call the suite runner (MS-M9-1)", () => {
  it("runs the suite runner script on the named fixtures with the Worker, settings and environment", async () => {
    const spawn = scripted(() => result([true, false]));
    const r = await runSuitePath({
      harnessRoot: "/h",
      worker: "cyber-tiel",
      fixtures: ["chronicle", "onyx"],
      out: join(temp(), "r.json"),
      settingsFile: "/s/arm.json",
      env: { SEKHEMET_CANDIDATE_RULE: "Use node:sqlite." },
      spawn,
    });
    expect(r.passed).toBe(1);
    const call = spawn.calls[0];
    expect(call?.args.slice(0, 5)).toEqual([
      "/h/scripts/run_suite.mjs",
      "--worker",
      "cyber-tiel",
      "--fixtures",
      "chronicle,onyx",
    ]);
    expect(call?.args).toContain("--settings");
    expect(call?.env.SEKHEMET_CANDIDATE_RULE).toBe("Use node:sqlite.");
  });

  it("says the runner wrote no result rather than scoring zero", async () => {
    await expect(
      runSuitePath({
        harnessRoot: "/h",
        worker: "w",
        fixtures: ["chronicle"],
        out: join(temp(), "r.json"),
        spawn: scripted(() => undefined),
      }),
    ).rejects.toThrow(/the suite runner wrote no result \(exit 0\)/);
  });

  it("the rule gate scores a fixture on the suite path: passed over measured, blocked cards apart", async () => {
    const spawn = scripted((args) =>
      result(
        args.includes("--out") && spawn.calls.length === 1
          ? [true, true, "blocked"]
          : [true, false, "blocked"],
      ),
    );
    const base = await runFixtureGate("/h", "chronicle", undefined, [], spawn);
    const withRule = await runFixtureGate(
      "/h",
      "chronicle",
      "Use node:sqlite.",
      ["--worker", "cyber-tiel"],
      spawn,
    );
    expect(base).toEqual({ passed: 2, total: 2 });
    expect(withRule).toEqual({ passed: 1, total: 2 });
    expect(spawn.calls[1]?.env.SEKHEMET_CANDIDATE_RULE).toBe("Use node:sqlite.");
    expect(spawn.calls[1]?.args.slice(1, 3)).toEqual(["--worker", "cyber-tiel"]);
  });

  it("the rule gate passes its Worker and settings through, refuses other queue flags, and surfaces a failed run (review minor)", async () => {
    const spawn = scripted(() => result([true]));
    await runFixtureGate(
      "/h",
      "chronicle",
      undefined,
      ["--worker", "w", "--settings", "/s/arm.json"],
      spawn,
    );
    expect(spawn.calls[0]?.args).toContain("/s/arm.json");
    await expect(
      runFixtureGate("/h", "chronicle", undefined, ["--manager", "dirk"], spawn),
    ).rejects.toThrow(/--manager.*--settings <file>/);
    await expect(
      runFixtureGate(
        "/h",
        "chronicle",
        undefined,
        [],
        scripted(() => undefined),
      ),
    ).rejects.toThrow(/wrote no result/);
  });

  it("the bake-off runs each Worker on the suite path, naming the manager through a settings file", async () => {
    const dir = temp();
    const spawn = scripted((args) => {
      const w = args[args.indexOf("--worker") + 1] as string;
      return result(w === "a" ? [true, true, false] : [true, false, false], w);
    });
    const rows = await bakeOffOnSuitePath({
      harnessRoot: "/h",
      workers: ["a", "b"],
      fixture: "chronicle",
      manager: "dirk",
      dir,
      spawn,
    });
    expect(rows.map((r) => [r.worker, r.result?.passed])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    const settings = spawn.calls[0]?.args[spawn.calls[0].args.indexOf("--settings") + 1] as string;
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ roles: { manager: "dirk" } });
  });
});
