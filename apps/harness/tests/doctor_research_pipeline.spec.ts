import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { researchPipelineCheck } from "../src/doctor.js";
import { RESEARCH_GOLDEN_RUN } from "../src/research_bakeoff.js";

// design-stage DS-N2-9: `doctor` says which research pipeline the latest
// golden-set run found worse for a model, "not recommended", with the
// numbers. An on-disk ledger (DEFINITION_OF_DONE §2A).
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "sek-doc-rp-"));
  dirs.push(r);
  return r;
}

describe("doctor's research pipeline check (DS-N2-9)", () => {
  it("passes with nothing to say when no golden-set run is recorded, or no ledger exists", async () => {
    const r = repo();
    expect(await researchPipelineCheck(r)).toMatchObject({ status: "pass" });
    mkdirSync(join(r, ".sekhemet"));
    const db = new DatabaseSync(join(r, ".sekhemet", "events.db"));
    initSchema(db);
    db.close();
    expect(await researchPipelineCheck(r)).toMatchObject({ status: "pass" });
  });

  it("warns, naming the model and the pipeline not recommended, with the counts", async () => {
    const r = repo();
    mkdirSync(join(r, ".sekhemet"));
    const db = new DatabaseSync(join(r, ".sekhemet", "events.db"));
    initSchema(db);
    const contender = (pipeline: string, correct: number) => ({
      model: "spark-x2.5-4b",
      pipeline,
      correct,
      n: 25,
      accuracy: correct / 25,
      citationPrecision: null,
      verifiedCitations: 0,
      unverifiedCitations: 0,
      secondsPerQuestion: 1,
      grades: [],
    });
    await new EventLog(db).append({
      actor: "harness",
      type: RESEARCH_GOLDEN_RUN,
      payload: {
        setHash: "f".repeat(64),
        setVersion: "1",
        host: "host-a",
        items: 25,
        contenders: [contender("native", 10), contender("tool-loop", 24)],
        pipelines: [
          {
            model: "spark-x2.5-4b",
            recommended: "tool-loop",
            notRecommended: ["native"],
            tests: [
              {
                a: "native",
                b: "tool-loop",
                aRight: 10,
                bRight: 24,
                better: 14,
                worse: 0,
                p: 0.0001,
              },
            ],
          },
        ],
        adoption: { incumbent: "apodex-1.1-mini", verdicts: [] },
      },
    });
    db.close();
    const c = await researchPipelineCheck(r);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/spark-x2\.5-4b on the native pipeline is not recommended/);
    expect(c.detail).toMatch(/24\/25.*10\/25/);
  });
});
