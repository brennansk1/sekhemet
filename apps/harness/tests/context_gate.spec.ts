import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { abVerdictLine, contextVersionGate, measuredContextVersions } from "../src/context_gate.js";
import { computeFootprint, runMeasureCommand } from "../src/measure_cmd.js";
import { workerContextVersion } from "../src/qualify.js";

/**
 * CX-N6-2: the release gate compares the built context version with the one
 * stamped on the newest adopted A/B in SUITE_RUNS.md, and fails naming both.
 */
const V1 = "0123456789abcdef";
const V2 = "fedcba9876543210";
const suiteRuns = (...lines: string[]) =>
  ["# Frozen-suite runs", "", ...lines.flatMap((l) => ["## An A/B", "", l, ""])].join("\n");

describe("CX-N6-2: the release gate checks the context version was measured", () => {
  it("reads the stamped A/B lines, newest adopted first", () => {
    const text = suiteRuns(
      abVerdictLine("not adopted", V2, "2026-09-30"),
      abVerdictLine("not established — cheaper", V1, "2026-09-28"),
      abVerdictLine("admitted", V2, "2026-09-20"),
    );
    expect(measuredContextVersions(text).map((m) => [m.verdict, m.version])).toEqual([
      ["not adopted", V2],
      ["not established — cheaper", V1],
      ["admitted", V2],
    ]);
    expect(contextVersionGate(text, V1)).toMatchObject({ ok: true, newest: { version: V1 } });
    const refused = contextVersionGate(text, V2);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain(V2);
    expect(refused.reason).toContain(V1);
  });

  it("fails when no A/B was ever adopted, naming the built version", () => {
    const gate = contextVersionGate(suiteRuns(abVerdictLine("not adopted", V1, "2026-09-30")), V1);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(new RegExp(`${V1}.*no adopted A/B`));
  });

  it("`measure context-gate` checks the built Worker's version; the footprint and admit stamp it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-gate-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const k = { repoPath: dir, log, cardStore: new CardStore(db, log) };
    const built = workerContextVersion();
    const file = join(dir, "SUITE_RUNS.md");
    const lines: string[] = [];
    writeFileSync(file, suiteRuns(abVerdictLine("admitted", V1, "2026-09-20")));
    expect(
      await runMeasureCommand(["context-gate", "--suite-runs", file], k, (l) => lines.push(l)),
    ).toBe(1);
    expect(lines.join("\n")).toContain(built);
    writeFileSync(file, suiteRuns(abVerdictLine("not established — simpler", built, "2026-09-25")));
    expect(await runMeasureCommand(["context-gate", "--suite-runs", file], k, () => {})).toBe(0);
    expect(computeFootprint(dir).contextVersion).toBe(built);
    // Minor 4: the footprint's prompt tokens, tools, switches and context
    // version are this build's, so another checkout's --root is refused.
    const said: string[] = [];
    expect(await runMeasureCommand(["footprint", "--root", dir], k, (l) => said.push(l))).toBe(1);
    expect(said.join("\n")).toMatch(/--root.*this build/);
    db.close();
  });
});
