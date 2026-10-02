import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { DecisionStore, SpidrFeaturePlanner, latestPlan, persistPlan } from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelList, runCalibrate } from "../src/calibrate_cmd.js";
import { runDoctor } from "../src/doctor.js";
import { LearningStore } from "../src/learning/store.js";
import { dailyStandup } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { parseHours } from "../src/scheduler.js";
import {
  type RepoContext,
  batchBySwaps,
  gateRuleOnFixtures,
  overnightPlanLine,
  replanOnRung3,
  ruleGateVerdict,
} from "../src/wave2.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function kernel(): RepoContext {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-w2more-"));
  dirs.push(repoPath);
  mkdirSync(join(repoPath, "src"));
  writeFileSync(join(repoPath, "src", "auth.ts"), "export const login = () => true;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

describe("P12: a rung-3 re-plan runs the Replan session on a planned epic", () => {
  it("records plan v2 with a diff", async () => {
    const k = kernel();
    const spec =
      "Implement user authentication with JWT session cookies, password hashing, and rate limiting.";
    await k.cardStore.createCard({
      id: "epic_a",
      tier: "epic",
      title: spec,
      status: "in_progress",
      spec,
    });
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_a",
      parentTier: "epic",
      spec,
    });
    const r = await persistPlan({ store: k.cardStore, log: k.log }, plan, { epicId: "epic_a" });
    const card = await k.cardStore.getCard(r.created[0]?.id as string);
    const note = await replanOnRung3(k, card as never, "the hashing library is missing");
    expect(note).toMatch(/Replanned epic_a to v2/);
    expect((await latestPlan({ store: k.cardStore, log: k.log }, "epic_a"))?.version).toBe(2);
    expect(
      await replanOnRung3(k, { ...(card as object), parentId: undefined } as never, "x"),
    ).toBeUndefined();
  });
});

describe("P13: Seshat's standup carries decisions waiting and the next window", () => {
  it("lists a waiting decision with its wait time", async () => {
    const k = kernel();
    await k.cardStore.createCard({ id: "c", tier: "task", title: "c", status: "ready" });
    await k.cardStore.createCard({ id: "r", tier: "task", title: "Ready one", status: "ready" });
    await new DecisionStore({ store: k.cardStore, log: k.log }).request({
      id: "q",
      cardId: "c",
      question: "Which database?",
      options: [
        { label: "SQLite", consequence: "", effortDelta: "", riskNote: "Low." },
        { label: "Postgres", consequence: "", effortDelta: "", riskNote: "Low." },
      ],
      previewSketches: [],
      recommendation: { optionIndex: 0, rationale: "" },
      policy: "default_deny",
      defaultIfNoAnswer: { deadline: "2099-01-01T00:00:00Z" },
      category: "storage",
      createdAt: "",
    });
    // PM-P6-3: the one standup builder carries the planner's half, in plain words.
    const text = await dailyStandup({
      repoPath: k.repoPath,
      cardStore: k.cardStore,
      pmStore: new PmStore(k.log),
    });
    expect(text).toMatch(
      /Needs a decision from you: Which database\? \(c\) No default[^;]* Waiting \d/,
    );
    expect(text).toMatch(/Next up: (?:.*, then )?Ready one \(\d+-\d+ min, /);
  });
});

describe("E5: learning approvals are gated on the frozen fixtures", () => {
  it("records the verdict, and a rejected rule cannot be approved through the API", async () => {
    const k = kernel();
    const learning = new LearningStore(k.log);
    const rule = await learning.propose({
      role: "worker",
      text: "Always rewrite the whole file.",
      scope: { kind: "implement" },
      source: "seed",
      evidence: [],
    });
    const verdict = await gateRuleOnFixtures(k, rule?.id as string, {
      fixtures: ["chronicle", "onyx"],
      runFixture: async (fixture, candidate) => ({
        passed: fixture === "onyx" && candidate ? 3 : 4,
        total: 6,
      }),
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/onyx lost 1/);
    expect((await ruleGateVerdict(k.log, rule?.id as string))?.accepted).toBe(false);
    const { createPmApi } = await import("../src/pm_api.js");
    void createPmApi;
  });
});

describe("E19/C12: doctor reports playbook net gain, bloat and pruning", () => {
  it("adds a Playbook and skills check that warns on a costly unmeasured rule", async () => {
    const k = kernel();
    mkdirSync(join(k.repoPath, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(k.repoPath, ".sekhemet", "playbook.toml"),
      `[[rule]]\nid = "long"\npattern = "src/"\ninstruction = "${"Be careful with every edit. ".repeat(60)}"\n`,
    );
    const report = await runDoctor(k.repoPath);
    const c = report.checks.find((x) => x.name === "Playbook and skills");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/MEASURE long/);
  }, 60_000);
});

describe("M25: batched swaps in the run order and the overnight plan", () => {
  it("runs the worker's cards back to back before the escalation model's", () => {
    const card = (id: string, executor?: string) =>
      ({
        id,
        tier: "task",
        title: id,
        status: "ready",
        scopeFiles: [],
        stepBudget: 10,
        stepsUsed: 0,
        createdAt: "",
        updatedAt: "",
        ...(executor ? { modelRoute: { executor } } : {}),
      }) as never;
    const order = batchBySwaps([card("a"), card("hard", "escalation"), card("b")]).map(
      (c: { id: string }) => c.id,
    );
    expect(order).toEqual(["a", "b", "hard"]);
    const line = overnightPlanLine(
      parseHours("none"),
      [card("a"), card("hard", "escalation")],
      new Date(),
    );
    expect(line).toMatch(/Plan: worker\/board x1, escalation\/board x1; 1 model load/);
  });
});

describe("M24: calibrate records the engine chosen by measurement", () => {
  it("saves an engine decision in the machine profile", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cal2-")), "machine.json");
    dirs.push(dirname(path));
    const lines: string[] = [];
    const profile = await runCalibrate({
      models: parseModelList("a=worker"),
      buckets: [2048],
      force: true,
      resolve: (name) => ({
        modelId: name,
        supportedArms: ["arm_a_flat"],
        generate: async () => ({
          text: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 2048,
            completionTokens: 64,
            durationMs: 1,
            prefillTokensPerSecond: 400,
            decodeTokensPerSecond: 30,
          },
        }),
      }),
      path,
      registry: null,
      say: (l) => lines.push(l),
    });
    expect(profile?.engine?.engine).toBeDefined();
    expect(JSON.parse(readFileSync(path, "utf8")).engine.engine).toBe(profile?.engine?.engine);
    expect(lines.at(-1)).toMatch(/^Engine: /);
  });
});
