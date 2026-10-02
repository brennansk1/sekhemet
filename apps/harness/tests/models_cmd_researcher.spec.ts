import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter, ModelRegistry, currentAssignment } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { type CombinationDeps, qualificationCombination } from "../src/qualify.js";
import { type RepoContext, runDevCommand } from "../src/wave2.js";

// models MD-N11-2 on the generic path: the Researcher's shipped default
// changes only as the research golden-set run's adoption verdict allows,
// through `sekhemet research-bakeoff --adopt-from <run>`. A recorded
// overnight benchmark alone does not carry that verdict, so
// `models assign researcher <m> --default --bake-off <id>` is refused.
// Nothing here loads a model.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_REGISTRY");
});

const deps: CombinationDeps = {
  digest: () => "sampled-sha256:abc",
  engineBuild: () => "b7000 (abc1234)",
  host: () => "host-a",
  contextVersion: () => "ctx-1",
};

describe("models assign researcher --default (MD-N11-2)", () => {
  it("is refused and sent to research-bakeoff --adopt-from, the default unchanged", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "sek-models-rs-"));
    dirs.push(repoPath);
    process.env.SEKHEMET_MODEL_REGISTRY = join(repoPath, "models.json");
    const db = new DatabaseSync(join(repoPath, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const k: RepoContext = { repoPath, log, cardStore: new CardStore(db, log) };
    const out: string[] = [];
    const io = {
      print: (l: string) => out.push(l),
      model: (n: string) => new MockInferenceAdapter(n, [], { exhaustion: "default" as const }),
      combinationDeps: deps,
    };
    new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY).recordCombinationQualification(
      "spark-x",
      // Qualified for the Research model's role (CX-N6-4).
      qualificationCombination(io.model("spark-x"), { ...deps, role: "researcher" }),
      { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" },
    );
    const night = await log.append({
      actor: "harness",
      type: "measure/benchmarked",
      payload: {
        tier: "overnight",
        profileHash: "d".repeat(64),
        host: "host-a",
        combination: { researcher: "spark-x" },
        partial: false,
        roles: [
          {
            role: "researcher",
            model: "spark-x",
            state: "measured",
            score: 0.96,
            items: [{ id: "rg-1", score: 1 }],
          },
        ],
        comparisons: [],
      },
    });
    expect(
      await runDevCommand(
        "models",
        ["assign", "researcher", "spark-x", "--default", "--bake-off", night.id],
        k,
        io,
      ),
    ).toBe(1);
    expect(out.at(-1)).toMatch(/sekhemet research-bakeoff --adopt-from/);
    expect(
      currentAssignment(
        new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY),
        "host-a",
        "researcher",
        "default",
      ),
    ).toBeUndefined();
    // A person's own choice is still theirs to make.
    expect(await runDevCommand("models", ["assign", "researcher", "spark-x"], k, io)).toBe(0);
  });
});
