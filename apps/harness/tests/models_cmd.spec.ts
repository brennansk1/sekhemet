import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter, ModelRegistry, currentAssignment } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { type CombinationDeps, qualificationCombination } from "../src/qualify.js";
import { type Kernel, runWave2Command } from "../src/wave2.js";

// NEW-models-10: `sekhemet models assign|restore`. Nothing here loads a model.

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

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-models-cmd-"));
  dirs.push(repoPath);
  process.env.SEKHEMET_MODEL_REGISTRY = join(repoPath, "models.json");
  const db = new DatabaseSync(join(repoPath, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const k: Kernel = { repoPath, log, cardStore: new CardStore(db, log) };
  const out: string[] = [];
  const io = {
    print: (l: string) => out.push(l),
    model: (n: string) => new MockInferenceAdapter(n, [], { exhaustion: "default" as const }),
    combinationDeps: deps,
  };
  const qualify = (name: string) => {
    const reg = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    reg.recordCombinationQualification(name, qualificationCombination(io.model(name), deps), {
      suiteVersion: "q1.2",
      passRate: 0.95,
      status: "qualified",
    });
  };
  return { k, io, out, log, qualify };
}

describe("sekhemet models assign and restore (NEW-models-10)", () => {
  it("MD-N10-3, MD-N10-2: assigns a qualified model on the ledger with the principal, and restores in one command", async () => {
    const { k, io, out, log, qualify } = setup();
    qualify("apodex");
    qualify("spark-x");
    expect(await runWave2Command("models", ["assign", "researcher", "apodex"], k, io)).toBe(0);
    expect(await runWave2Command("models", ["assign", "researcher", "spark-x"], k, io)).toBe(0);
    const reg = () => new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    expect(currentAssignment(reg(), "host-a", "researcher")?.model).toBe("spark-x");
    const events = (await log.getEvents()).filter((e) => e.type === "models/assigned");
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({
      role: "researcher",
      model: "spark-x",
      scope: "personal",
      previous: "apodex",
    });
    expect(events[1]?.principal).toBe(k.cardStore.localPrincipal());
    // The baseline is untouched by a person's own choice.
    expect(currentAssignment(reg(), "host-a", "researcher", "baseline")).toBeUndefined();

    expect(await runWave2Command("models", ["restore", "researcher"], k, io)).toBe(0);
    expect(currentAssignment(reg(), "host-a", "researcher")?.model).toBe("apodex");
    expect(out.at(-1)).toMatch(/researcher: restored apodex \(replacing spark-x\)/);
    expect((await log.getEvents()).some((e) => e.type === "models/restored")).toBe(true);
  });

  it("MD-N10-3: refuses an unqualified model, naming the missing qualification", async () => {
    const { k, io, out } = setup();
    expect(await runWave2Command("models", ["assign", "reviewer", "gemma-x"], k, io)).toBe(1);
    expect(out.at(-1)).toMatch(/gemma-x is not qualified for the reviewer role on this host/);
  });

  /** A recorded benchmark of qwen-next as the Worker on host-a, as the kernel registry requires it. */
  const benchmarked = (tier: "quick" | "overnight") => ({
    tier,
    profileHash: "d".repeat(64),
    host: "host-a",
    combination: { worker: "qwen-next", planner: "p" },
    partial: false,
    roles: [
      {
        role: "worker",
        model: "qwen-next",
        state: "measured",
        score: 1,
        items: [{ id: "s1", score: 1 }],
      },
    ],
    comparisons: [],
  });

  it("MD-N10-1: the baseline changes only with a recorded overnight bake-off on this host", async () => {
    const { k, io, out, log, qualify } = setup();
    qualify("qwen-next");
    expect(
      await runWave2Command("models", ["assign", "worker", "qwen-next", "--baseline"], k, io),
    ).toBe(1);
    expect(out.at(-1)).toMatch(/requires a recorded bake-off on this host/);
    const quick = await log.append({
      actor: "harness",
      type: "measure/benchmarked",
      payload: benchmarked("quick"),
    });
    expect(
      await runWave2Command(
        "models",
        ["assign", "worker", "qwen-next", "--baseline", "--bake-off", quick.id],
        k,
        io,
      ),
    ).toBe(1);
    expect(out.at(-1)).toMatch(/quick-benchmark score does not satisfy it/);
    const night = await log.append({
      actor: "harness",
      type: "measure/benchmarked",
      payload: benchmarked("overnight"),
    });
    expect(
      await runWave2Command(
        "models",
        ["assign", "worker", "qwen-next", "--baseline", "--bake-off", night.id],
        k,
        io,
      ),
    ).toBe(0);
    expect(
      currentAssignment(
        new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY),
        "host-a",
        "worker",
        "baseline",
      ),
    ).toMatchObject({ model: "qwen-next", bakeOff: night.id });
  });
});
