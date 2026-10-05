import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  MockInferenceAdapter,
  ModelRegistry,
  type ModelRole,
  QUALIFICATION_BAR,
} from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { M0_PENDING, pendingM0, recordWorkerAdopted } from "../src/m0_path.js";
import {
  type CombinationDeps,
  gateRole,
  qualificationCombination,
  verifiedQueueRoles,
  verifiedQueues,
  verifiedReviewerRole,
} from "../src/qualify.js";
import { type RepoContext, queuePrelude, runDevCommand } from "../src/wave2.js";
import { BIN, SCRIPTED_WORKER, sandboxDirs, scriptedWorkerProject } from "./cli_fixture.js";

// MD-N8-1 (W11): every role — the Coding model, the manager and escalation
// (the Planning model's weights), the Review model and the Research model —
// is refused until its exact combination is verified on this machine, with
// rule 23's fallback and words that name Verify; a person's recorded
// override is honoured per role. CFG-04: assigning a Coding model owes its
// first-run benchmark. Nothing here loads a model.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const deps: CombinationDeps = {
  digest: () => "sampled-sha256:abc",
  engineBuild: () => "b10809 (abc1234)",
  host: () => "host-a",
  contextVersion: (role) => `ctx-${role}`,
};
const mock = (n: string) => new MockInferenceAdapter(n, [], { exhaustion: "default" as const });

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-roles-"));
  dirs.push(repoPath);
  const registryPath = join(repoPath, "models.json");
  vi.stubEnv("SEKHEMET_MODEL_REGISTRY", registryPath);
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(repoPath, "user-config.toml"));
  const db = new DatabaseSync(join(repoPath, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const k: RepoContext = { repoPath, log, cardStore: new CardStore(db, log) };
  const reg = () => new ModelRegistry(registryPath);
  const record = (name: string, role: ModelRole, status: "qualified" | "failed") =>
    reg().recordCombinationQualification(
      name,
      qualificationCombination(mock(name), { ...deps, role }),
      {
        suiteVersion: "q1.2",
        passRate: status === "qualified" ? 0.95 : 0.5,
        status,
        byCategory: { schema: status === "qualified" ? 0.95 : 0.5 },
      },
    );
  const out: string[] = [];
  const io = { print: (l: string) => out.push(l), model: mock, combinationDeps: deps };
  return { k, log, reg, record, out, io };
}

describe("MD-N8-1: a role runs only once its combination is verified on this machine", () => {
  it("refuses an unverified Review model in words that name Verify and its command", () => {
    const { reg } = setup();
    const gate = gateRole(reg(), mock("critic"), "reviewer", "critic", deps);
    expect(gate.refusal).toBe(
      "The Review model critic is not verified on this machine for this combination (missing). Verify it on Configuration › Models, or run: sekhemet qualify --models critic --role reviewer",
    );
  });

  it("passes a verified role, and not one verified only for another role", () => {
    const { reg, record } = setup();
    record("critic", "worker", "qualified");
    expect(gateRole(reg(), mock("critic"), "reviewer", "critic", deps).refusal).toMatch(
      /not verified/,
    );
    record("critic", "reviewer", "qualified");
    expect(gateRole(reg(), mock("critic"), "reviewer", "critic", deps).refusal).toBeUndefined();
  });

  it("names a failed role, and honours a person's override recorded for that role", () => {
    const { reg, record } = setup();
    record("scout", "researcher", "failed");
    expect(gateRole(reg(), mock("scout"), "researcher", "scout", deps).refusal).toMatch(
      /^The Research model scout is not verified on this machine for this combination \(failed: this combination failed qualification\)/,
    );
    const r = reg();
    r.recordQualificationOverride(
      "scout",
      qualificationCombination(mock("scout"), { ...deps, role: "researcher", registry: r }),
      { by: "person: B", reason: "small repository" },
      QUALIFICATION_BAR,
    );
    const adapter = mock("scout");
    const gate = gateRole(reg(), adapter, "researcher", "scout", deps);
    expect(gate.refusal).toBeUndefined();
    expect(gate.override?.by).toBe("person: B");
    expect((adapter as unknown as { workerOverride?: unknown }).workerOverride).toBeDefined();
  });

  it("keeps the Coding model's own refusal line", () => {
    const { reg } = setup();
    expect(gateRole(reg(), mock("w"), "worker", "w", deps).refusal).toMatch(
      /^Refusing w as the Coding model: not verified on this machine .*sekhemet qualify --models w$/,
    );
  });

  it("rule 23: run's Review role falls back to unfilled, the refusal its reason", () => {
    const { reg, record } = setup();
    const filled = { state: "filled" as const, model: "critic", queue: "reviewer" as const };
    const fallback = verifiedReviewerRole(reg(), filled, mock, deps);
    expect(fallback).toEqual({
      state: "unfilled",
      reason: expect.stringMatching(/The Review model critic is not verified on this machine/),
    });
    record("critic", "reviewer", "qualified");
    expect(verifiedReviewerRole(reg(), filled, mock, deps)).toEqual(filled);
    const unfilled = { state: "unfilled" as const, reason: "no Review model" };
    expect(verifiedReviewerRole(reg(), unfilled, mock, deps)).toBe(unfilled);
  });

  it("the queue's roles: each unverified one is left out with its line; the Coding model is gated on its own", () => {
    const { reg, record } = setup();
    record("planner-x", "planner", "qualified");
    const specs = [
      { queue: "worker", role: "worker" as const, name: "w" },
      { queue: "manager", role: "planner" as const, name: "planner-x" },
      { queue: "escalation", role: "planner" as const, name: "planner-x" },
      { queue: "researcher", role: "researcher" as const, name: "scout" },
      { queue: "reviewer", role: "reviewer" as const, name: "critic" },
    ];
    const v = verifiedQueues(reg(), specs, mock, deps);
    expect(v.verified.map((s) => s.queue)).toEqual(["worker", "manager", "escalation"]);
    expect(v.refused.map((r) => r.queue)).toEqual(["researcher", "reviewer"]);
    expect(v.refused[0]?.line).toMatch(
      /The Research model scout is not verified .*; questions are answered from the repository alone\.$/,
    );
    expect(v.refused[1]?.line).toMatch(
      /The Review model critic is not verified .*; changes reach Review without an AI review, and each issue says so\.$/,
    );
  });

  it("the queue's selection (B1-C3 review): the unverified Planning model takes the manager, Seshat and escalation out together, with one line", () => {
    const { reg, record } = setup();
    record("scout", "researcher", "qualified");
    const specs = [
      { queue: "worker", role: "worker" as const, name: "w" },
      { queue: "manager", role: "planner" as const, name: "planner-x" },
      { queue: "seshat", role: "planner" as const, name: "planner-x" },
      { queue: "escalation", role: "planner" as const, name: "planner-x" },
      { queue: "researcher", role: "researcher" as const, name: "scout" },
    ];
    const unfilled = { state: "unfilled" as const, reason: "no Review model" };
    const r = verifiedQueueRoles(reg(), specs, unfilled, mock, deps);
    expect(r.verified.map((s) => s.queue)).toEqual(["worker", "researcher"]);
    expect(r.has("manager")).toBe(false);
    expect(r.has("escalation")).toBe(false);
    expect(r.has("researcher")).toBe(true);
    // One line for the Planning model's weights, not one per queue.
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatch(
      /^The Planning model planner-x is not verified .*; the queue runs without it: Seshat does not answer during the run, and issues are not escalated to it\.$/,
    );
    expect(r.reviewer).toBe(unfilled);
  });

  it("the queue's selection: an unverified Review model is unfilled with its refusal, and so is the Planning model reviewing when it is refused", () => {
    const { reg, record } = setup();
    record("planner-x", "planner", "qualified");
    const specs = [
      { queue: "worker", role: "worker" as const, name: "w" },
      { queue: "manager", role: "planner" as const, name: "planner-x" },
    ];
    const critic = { state: "filled" as const, model: "critic", queue: "reviewer" as const };
    const a = verifiedQueueRoles(reg(), specs, critic, mock, deps);
    expect(a.reviewer).toEqual({
      state: "unfilled",
      reason: expect.stringMatching(/^The Review model critic is not verified on this machine/),
    });
    expect(a.has("reviewer")).toBe(false);
    record("critic", "reviewer", "qualified");
    const b = verifiedQueueRoles(reg(), specs, critic, mock, deps);
    expect(b.reviewer).toEqual(critic);
    expect(b.verified.map((s) => s.queue)).toEqual(["worker", "manager", "reviewer"]);
    // The Planning model doubling as the Review model (queue "manager"),
    // verified for review but not for planning: no manager queue, so no review.
    const { reg: reg2, record: record2 } = setup();
    record2("planner-y", "reviewer", "qualified");
    const doubling = { state: "filled" as const, model: "planner-y", queue: "manager" as const };
    const c = verifiedQueueRoles(
      reg2(),
      [{ queue: "manager", role: "planner" as const, name: "planner-y" }],
      doubling,
      mock,
      deps,
    );
    expect(c.has("manager")).toBe(false);
    expect(c.reviewer).toEqual({
      state: "unfilled",
      reason: expect.stringMatching(
        /^The Planning model planner-y is not verified .*; changes reach Review without an AI review, and each issue says so\.$/,
      ),
    });
  });

  it("queuePrelude says each refused role's line before the pass", async () => {
    const { k } = setup();
    const out: string[] = [];
    await queuePrelude(k, [], {
      print: (l) => out.push(l),
      setup: "solo",
      roleRefusals: ["The Review model critic is not verified on this machine."],
    });
    expect(out[0]).toBe("The Review model critic is not verified on this machine.");
  });

  it("sekhemet qualify --override takes --role, so a person's override is the role's", async () => {
    const { k, io, out, record, reg } = setup();
    record("scout", "researcher", "failed");
    expect(
      await runDevCommand(
        "qualify",
        [
          "--override",
          "scout",
          "--role",
          "researcher",
          "--by",
          "B",
          "--reason",
          "small repository",
        ],
        k,
        io,
      ),
    ).toBe(0);
    expect(out.at(-1)).toMatch(/scout: qualified by override: person: B/);
    expect(gateRole(reg(), mock("scout"), "researcher", "scout", deps).override?.by).toBe(
      "person: B",
    );
    // --check names it as running under the override, not refused.
    expect(
      await runDevCommand(
        "qualify",
        ["--models", "scout", "--role", "researcher", "--check"],
        k,
        io,
      ),
    ).toBe(0);
  });
});

describe("CFG-04 (MS-M9-6): assigning a Coding model owes its first-run benchmark", () => {
  it("records m0/pending through the one helper", async () => {
    const { log } = setup();
    await recordWorkerAdopted(log, { worker: "nail-mtp", combination: "c1" });
    const pending = await pendingM0(log);
    expect(pending).toEqual([
      expect.objectContaining({
        worker: "nail-mtp",
        combination: "c1",
        reason: "assigned as the Coding model on this machine",
      }),
    ]);
  });

  it("`models assign worker` records it; assigning another role does not", async () => {
    const { k, io, log, record } = setup();
    record("w2", "worker", "qualified");
    record("critic", "reviewer", "qualified");
    expect(await runDevCommand("models", ["assign", "worker", "w2"], k, io)).toBe(0);
    expect(await runDevCommand("models", ["assign", "reviewer", "critic"], k, io)).toBe(0);
    const events = (await log.getEvents()).filter((e) => e.type === M0_PENDING);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ worker: "w2" });
  });
});

/**
 * The entry point (B1-C3 review blocker): `sekhemet queue`, the built binary,
 * with a verified Coding model and an unverified Planning and Research model.
 * Each is named before the pass with its fallback, and the pass still runs
 * the Coding model. Model loads are off: nothing is loaded.
 */
describe("sekhemet queue verifies every role before the pass (MD-N8-1, W11)", () => {
  it("names the unverified Planning and Research models with their fallbacks, and runs the Coding model", async () => {
    const where = sandboxDirs();
    const env = await scriptedWorkerProject(where);
    const r = spawnSync(
      process.execPath,
      ["--import", env.preload, BIN, "queue", "--worker", SCRIPTED_WORKER, "--researcher", "scout"],
      {
        cwd: where.cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...env.vars, SCRIPTED_WORKER_MODE: "finish", SEKHEMET_MODEL_LOADS: "off" },
      },
    );
    const out = r.stdout;
    expect(out).toMatch(
      /The Planning model \S+ is not verified on this machine .*sekhemet qualify --models \S+ --role planner; the queue runs without it: Seshat does not answer during the run, and issues are not escalated to it\./,
    );
    expect(out).toMatch(
      /The Research model scout is not verified on this machine .*--role researcher; questions are answered from the repository alone\./,
    );
    // Said once each, before the pass; the refused models are not in the residency plan.
    expect(out.match(/The Planning model/g)).toHaveLength(1);
    expect(out.indexOf("The Planning model")).toBeLessThan(out.indexOf("=== c1"));
    expect(out).not.toMatch(/Residency:[^\n]*scout/);
    expect(out).toMatch(/=== c1 \(attempt 1\)/);
  }, 90_000);
});
