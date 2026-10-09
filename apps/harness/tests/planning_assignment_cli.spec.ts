import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, g2Dirs, g2Env } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, recorded, scriptEnv, scriptedModel } from "./support/g2_model.js";

/**
 * N0 (c6 #2), through the built binary: `sekhemet plan` and `sekhemet
 * "<spec>"` plan with the person's Planning model assignment on this host
 * (`sekhemet models assign planner <model>`), as the queue resolves the
 * Planning model — not the shipped default. The Planning model is a
 * scripted model at the HTTP boundary (`support/g2_model.ts`), recorded as
 * verified on this host; nothing is downloaded and no model is loaded.
 */

const QUALIFY = join(import.meta.dirname, "support/g2_qualify.mjs");

const PLANNER_REPLY = JSON.stringify({
  slices: [
    {
      kind: "rule",
      title: "Count the rows of the reports page CSV export",
      keywords: ["csv", "export", "reports"],
      rationale: "the CSV export's size",
      criteria: [
        {
          text: "Given 2 report rows, csvRowCount returns 3, the header and two rows",
          examples: [{ args: [2], expected: 3 }],
        },
      ],
      interface: [
        { symbol: "csvRowCount", file: "src/csv.js", signature: "csvRowCount(number) → number" },
      ],
    },
  ],
  targetSymbols: [{ filePath: "src/csv.js", symbol: "csvRowCount", change: "add" }],
  preconditions: ["the row count is not negative"],
  invariants: ["an empty report exports only its header"],
  diffSketch: "Count the header and each row.",
});

describe("N0 (c6 #2): plan uses the person's Planning model assignment", () => {
  it(
    "plans with the assigned Planning model when no --planner is given",
    { timeout: 200_000 },
    async () => {
      const where = g2Dirs();
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: where.cwd });
      writeFileSync(
        join(where.cwd, "package.json"),
        JSON.stringify({ name: "reports", version: "0.1.0" }),
      );
      // A scripted model is reached over HTTP: the load guard would refuse it.
      const { SEKHEMET_MODEL_LOADS: _off, ...base } = g2Env(where.home);
      const { preload, record } = scriptedModel(where.home);
      const env = { ...base, ...scriptEnv(record, { other: PLANNER_REPLY }) };
      execFileSync(process.execPath, [QUALIFY, SCRIPTED_MODEL, '[{"role":"planner"}]'], {
        env,
        encoding: "utf8",
      });
      const assigned = await cli(["models", "assign", "planner", SCRIPTED_MODEL], {
        cwd: where.cwd,
        env,
        preload,
      });
      expect(assigned.status, assigned.stdout + assigned.stderr).toBe(0);

      const r = await cli(["plan", "add CSV export to the reports page", "--offline"], {
        cwd: where.cwd,
        env,
        preload,
        timeoutMs: 180_000,
      });
      const out = r.stdout + r.stderr;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/Planned without a model|planning without a model/);
      expect(out).not.toMatch(/dirk-27b/);
      // The assigned Planning model wrote the plan.
      expect(recorded(record).length, out).toBeGreaterThan(0);
    },
  );
});
