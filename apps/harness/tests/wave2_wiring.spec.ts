import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, DEFAULT_STEP_BUDGET, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { DecisionStore } from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { learnFromOutcome } from "../src/execute.js";
import {
  type Kernel,
  appliedStepBudget,
  applyTunedPolicy,
  planCommand,
  queuePrelude,
  roleForCard,
  runWave2Command,
} from "../src/wave2.js";
import { skillsLockPath } from "../src/workspace_trust.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function kernel(): Kernel {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-wave2-"));
  dirs.push(repoPath);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  };
  w("src/auth.ts", "export function login(user: string): boolean { return user.length > 0; }\n");
  w(
    "src/session.ts",
    'import { login } from "./auth.js";\nexport const start = () => login("x");\n',
  );
  w("tests/auth.spec.ts", "// tests\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: init");
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

const quiet = { print: () => undefined };

describe("sekhemet plan persists the whole contract (P1, P2, P4-P7, defect 6)", () => {
  it("creates cards with spec, criteria, difficulty, route and budgets from a real codebase map", async () => {
    const k = kernel();
    const out: string[] = [];
    const r = await planCommand(
      k,
      "Implement user authentication with JWT session cookies, password hashing, and rate limiting.",
      { print: (l) => out.push(l) },
    );
    expect(r.created).toBeGreaterThan(0);
    const stories = (await k.cardStore.listCards()).filter((c) => c.parentId === r.epicId);
    for (const s of stories) {
      expect(s.spec).toBeTruthy();
      expect(s.acceptanceCriteria?.length).toBeGreaterThan(0);
      expect(s.difficulty).toBeGreaterThan(0);
      expect(s.modelRoute?.executor).toBeDefined();
      expect(s.tokenBudget).toBeGreaterThan(0);
    }
    expect(out.join("\n")).toContain("INVEST pre-flight:");
  });
});

describe("planning looks for what already exists (reuse before rebuild)", () => {
  it("puts the survey in the brief and tells each card what it can use instead of writing", async () => {
    const k = kernel();
    const out: string[] = [];
    const queries: string[] = [];
    await planCommand(
      k,
      "a billing service that charges customers monthly, handles refunds, and emails invoices",
      {
        print: (l) => out.push(l),
        research: {
          libraries: async (q) => {
            queries.push(q);
            return q.includes("invoices")
              ? [
                  {
                    name: "nodemailer",
                    ecosystem: "npm",
                    version: "6.0.0",
                    license: "MIT-0",
                    usable: true,
                    description: "Send emails with invoices attached",
                    url: "https://www.npmjs.com/package/nodemailer",
                  },
                ]
              : [];
          },
          repos: async () => [],
        },
      },
    );
    // Only short keyword queries leave the machine.
    expect(queries.every((q) => q.split(" ").length <= 4)).toBe(true);
    expect(out.join("\n")).toMatch(/emails invoices: nodemailer \(MIT-0\) may already cover this/);
    const brief = readFileSync(join(k.repoPath, ".sekhemet", "brief.md"), "utf8");
    expect(brief).toMatch(/## Prior art\n- \*\*a billing service/);
    expect(brief).toContain("nodemailer (MIT-0");
    const cards = await k.cardStore.listCards();
    const invoices = cards.find((c) => c.tier !== "epic" && /emails invoices/i.test(c.title));
    expect(invoices).toBeDefined();
    const notes = (await k.cardStore.getDossier(invoices?.id ?? "")).notes.map((n) => n.text);
    expect(notes.some((n) => /Before writing this yourself.*nodemailer/.test(n))).toBe(true);
  });

  it("plans with the named model: its behaviours become the cards' criteria", async () => {
    const k = kernel();
    const planner = new MockInferenceAdapter("planner", [
      {
        text: JSON.stringify({
          slices: [
            {
              kind: "interface",
              title: "Billing types",
              keywords: ["billing"],
              rationale: "types first",
              behaviour: "An Invoice has an id, a customer id, an amount in cents and a due date.",
            },
            {
              kind: "path",
              title: "Charge monthly",
              keywords: ["charge", "monthly"],
              rationale: "happy path",
              behaviour:
                "Given a customer on a 500-cent monthly plan, running billing on the 1st creates one 500-cent charge.",
            },
          ],
        }),
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ]);
    await planCommand(k, "a billing service that charges customers monthly", {
      ...quiet,
      sketcher: planner,
    });
    const criteria = (await k.cardStore.listCards()).flatMap((c) => c.acceptanceCriteria ?? []);
    expect(criteria.join("\n")).toContain("creates one 500-cent charge");
    // Money is at stake: the riskiest assumption is planned even though the
    // model did not propose it.
    const titles = (await k.cardStore.listCards()).map((c) => c.title);
    expect(titles.some((t) => /^Riskiest assumption/.test(t))).toBe(true);
  });

  it("searches nothing when no sources are given", async () => {
    const k = kernel();
    const out: string[] = [];
    await planCommand(k, "a billing service that charges customers monthly", {
      print: (l) => out.push(l),
    });
    expect(out.join("\n")).not.toMatch(/looked for what already exists/);
  });
});

describe("queue prelude (P3, P10, P11, P16, P19-P22, P20)", () => {
  it("sweeps decision deadlines, reports signals and orders Ready by WSJF from config", async () => {
    const k = kernel();
    mkdirSync(join(k.repoPath, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(k.repoPath, ".sekhemet", "config.toml"),
      '[prioritization]\nmodel = "wsjf"\nvalue_by_priority = { "1" = 8, "4" = 1 }\n',
    );
    await k.cardStore.createCard({
      id: "low",
      tier: "task",
      title: "low",
      status: "ready",
      priority: 4,
      difficulty: 3,
    });
    await k.cardStore.createCard({
      id: "high",
      tier: "task",
      title: "high",
      status: "ready",
      priority: 1,
      difficulty: 3,
    });
    await k.cardStore.createCard({ id: "waits", tier: "task", title: "w", status: "ready" });
    await new DecisionStore({ store: k.cardStore, log: k.log }).request({
      id: "req1",
      cardId: "waits",
      question: "Which?",
      options: [
        { label: "A", consequence: "a", effortDelta: "0", riskNote: "Low." },
        { label: "B", consequence: "b", effortDelta: "0", riskNote: "Low." },
      ],
      previewSketches: [],
      recommendation: { optionIndex: 0, rationale: "r" },
      policy: "safe_default",
      defaultIfNoAnswer: { optionIndex: 0, deadline: "2026-01-01T00:00:00Z" },
      category: "storage",
      createdAt: "2026-01-01T00:00:00Z",
    });
    // Under safe_default work proceeds on the default: the card is not parked
    // (planner-pm §2.10.3, kernel rule 27).
    expect((await k.cardStore.getCard("waits"))?.status).toBe("ready");
    const ready = (await k.cardStore.listCards({ status: "ready" })).filter(
      (c) => c.id !== "waits",
    );
    const { ordered, lines } = await queuePrelude(k, [...ready].reverse(), {
      ...quiet,
      now: new Date("2026-09-19T00:00:00Z"),
    });
    expect(ordered.map((c) => c.id)).toEqual(["high", "low"]);
    expect(lines.join("\n")).toMatch(/safe default was applied/);
    expect(lines.join("\n")).toMatch(/Ready ordered by WSJF/);
    expect((await k.cardStore.getCard("waits"))?.status).toBe("ready");
  });

  it("routes a card the planner marked for escalation to the escalation model (P6)", () => {
    const card = { modelRoute: { executor: "escalation" } } as never;
    expect(roleForCard(card, 1, false)).toBe("escalation");
    expect(roleForCard({} as never, 1, true)).toBe("worker");
    expect(roleForCard({} as never, 2, true)).toBe("escalation");
  });
});

describe("goal and decide commands (P17, P18, P9, P11)", () => {
  it("drafts a goal, approves it into cards, and reports status", async () => {
    const k = kernel();
    const out: string[] = [];
    const io = { print: (l: string) => out.push(l) };
    await runWave2Command(
      "goal",
      ["Users can log in, the test suite passes, and coverage is at least 80%."],
      k,
      io,
    );
    const id = /Draft (goal_\w+) saved/.exec(out.join("\n"))?.[1] as string;
    expect(id).toBeTruthy();
    expect(await k.cardStore.listCards()).toHaveLength(0);
    expect(await runWave2Command("goal", ["approve", id], k, io)).toBe(0);
    expect((await k.cardStore.listCards()).length).toBeGreaterThan(1);
    await runWave2Command("goal", ["status"], k, io);
    expect(out.join("\n")).toContain(`${id} [active]`);
  });

  it("lists and answers decisions", async () => {
    const k = kernel();
    await k.cardStore.createCard({ id: "c", tier: "task", title: "c", status: "ready" });
    await new DecisionStore({ store: k.cardStore, log: k.log }).request({
      id: "r",
      cardId: "c",
      question: "Store?",
      options: [
        { label: "SQLite", consequence: "local", effortDelta: "0", riskNote: "Low." },
        { label: "Postgres", consequence: "server", effortDelta: "+1h", riskNote: "Server." },
      ],
      previewSketches: [],
      recommendation: { optionIndex: 0, rationale: "local" },
      policy: "default_deny",
      defaultIfNoAnswer: { deadline: "2099-01-01T00:00:00Z" },
      category: "storage",
      createdAt: "",
    });
    const out: string[] = [];
    await runWave2Command("decide", [], k, { print: (l) => out.push(l) });
    const id = out[0]?.split(" ")[0] as string;
    expect(out.join("\n")).toContain("1. SQLite (recommended)");
    expect(await runWave2Command("decide", [id, "2"], k, quiet)).toBe(0);
    expect((await k.cardStore.getCard("c"))?.status).toBe("ready");
  });
});

describe("skills, release, ci and improve commands (C10, Y17, Y18, E10, E14, E15, E17)", () => {
  it("approves and revokes skills in the lock file", async () => {
    const k = kernel();
    mkdirSync(join(k.repoPath, ".sekhemet", "skills", "db"), { recursive: true });
    writeFileSync(
      join(k.repoPath, ".sekhemet", "skills", "db", "SKILL.md"),
      "---\ntriggers: [db]\n---\nUse WAL.",
    );
    expect(await runWave2Command("skills", ["approve", "db"], k, quiet)).toBe(0);
    // S9, SEC-31: the lock is in the user directory, never the repository.
    const lock = JSON.parse(readFileSync(skillsLockPath(k.repoPath), "utf8"));
    expect(Object.keys(lock.skills)).toEqual(["db"]);
    await runWave2Command("skills", ["revoke", "db"], k, quiet);
    expect(
      Object.keys(JSON.parse(readFileSync(skillsLockPath(k.repoPath), "utf8")).skills),
    ).toEqual([]);
  });

  it("refuses to approve a skill whose own checks did not pass, and still approves a hand-written one (MS-T8-5)", async () => {
    const k = kernel();
    for (const name of ["distilled", "failing", "checked"]) {
      mkdirSync(join(k.repoPath, ".sekhemet", "skills", name), { recursive: true });
      writeFileSync(
        join(k.repoPath, ".sekhemet", "skills", name, "SKILL.md"),
        "---\ntriggers: [x]\n---\nDo x.",
      );
    }
    const checked = (name: string, status: string) =>
      k.log.append({ actor: "harness", type: "learning/skill_checked", payload: { name, status } });
    await checked("distilled", "unchecked");
    await checked("failing", "checked");
    await checked("failing", "discarded");
    await checked("checked", "unchecked");
    await checked("checked", "checked");
    const out: string[] = [];
    expect(
      await runWave2Command("skills", ["approve", "distilled"], k, { print: (l) => out.push(l) }),
    ).toBe(1);
    expect(out.join("\n")).toMatch(/distilled is not approved: its own checks are unchecked/);
    expect(await runWave2Command("skills", ["approve", "failing"], k, quiet)).toBe(1);
    expect(await runWave2Command("skills", ["approve", "checked"], k, quiet)).toBe(0);
    // A hand-written project skill has no such record: a person may approve it.
    mkdirSync(join(k.repoPath, ".sekhemet", "skills", "handwritten"), { recursive: true });
    writeFileSync(
      join(k.repoPath, ".sekhemet", "skills", "handwritten", "SKILL.md"),
      "---\ntriggers: [y]\n---\nDo y.",
    );
    expect(await runWave2Command("skills", ["approve", "handwritten"], k, quiet)).toBe(0);
  });

  it("proposes a release and tags only with --confirm; ci is typed-unavailable without act", async () => {
    const k = kernel();
    const out: string[] = [];
    await runWave2Command("release", [], k, { print: (l) => out.push(l) });
    expect(out[0]).toMatch(/-> v0\.1\.0 \(minor/);
    expect(execFileSync("git", ["tag"], { cwd: k.repoPath, encoding: "utf8" }).trim()).toBe("");
    await runWave2Command("release", ["--confirm"], k, quiet);
    expect(execFileSync("git", ["tag"], { cwd: k.repoPath, encoding: "utf8" }).trim()).toBe(
      "v0.1.0",
    );
    expect(await runWave2Command("ci", [], k, quiet)).toBe(2);
  });

  it("improve mines the ledger for tool and skill candidates, and keeps no variant archive (DEC-25 R31)", async () => {
    const k = kernel();
    for (const id of ["c1", "c2", "c3"]) {
      await k.cardStore.createCard({
        id,
        tier: "task",
        title: `Add ledger migration ${id}`,
        scopeFiles: ["src/db.ts"],
      });
      await k.cardStore.updateCardStatus(id, "done", "test setup", "harness", { override: true });
      await k.cardStore.updateCard(id, { stepsUsed: 3 });
      await k.log.append({
        actor: "executor",
        type: "card/step",
        cardId: id,
        payload: {
          turn: 1,
          calls: [
            { name: "read_file", target: "src/db.ts", summary: "ok" },
            { name: "run_cmd", target: `node scripts/migrate.js ${id}.sql`, summary: "ok" },
            { name: "check", target: "test", summary: "pass" },
          ],
        },
      });
    }
    const out: string[] = [];
    expect(await runWave2Command("improve", [], k, { print: (l) => out.push(l) })).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/tool candidate node: node \{path0\} \{path1\}/);
    expect(text).toMatch(/skill candidate .*ledger/);
    // MS-T8-5: a distilled candidate has no checks of its own, so it stays unchecked.
    expect(text).toMatch(/skill candidate .*: unchecked — no checks/);
    const [checked] = await k.log.getEventsByTypes(["learning/skill_checked"]);
    expect(checked?.payload).toMatchObject({ status: "unchecked" });
    expect(text).not.toMatch(/variant archive/);
    expect(existsSync(join(k.repoPath, ".sekhemet", "variants.json"))).toBe(false);
  });
});

describe("tune --apply and the learning guard (E8, E17)", () => {
  /** One card outcome through the card runner's one observer of the guard (review minor). */
  const observe = (k: Kernel, i: number, passed: boolean, lines: string[]) =>
    learnFromOutcome(
      {
        repoPath: k.repoPath,
        restrictedMode: false,
        cardStore: k.cardStore,
        boardService: {} as never,
      },
      { id: `c${i}`, tier: "task", title: "Card", scopeFiles: [] } as never,
      { passed, tokensUsed: 0, turns: [] } as never,
      (l) => lines.push(l),
    );

  it("applies within 15%, and with no history before the change reports insufficient data (rule 18)", async () => {
    const k = kernel();
    const applied = applyTunedPolicy(k.repoPath, { stepBudget: 20, maxFailedChecks: 3 }, "tune");
    // WL-T3-11: from the one default of 40, a move of at most 15% lands on 34.
    expect(DEFAULT_STEP_BUDGET).toBe(40);
    expect(applied.stepBudget).toBe(34);
    expect(appliedStepBudget(k.repoPath)).toBe(34);
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) observe(k, i, i < 2, lines);
    // No history before the change: nothing to compare with, and nothing flagged.
    expect(lines.join("\n")).toMatch(/insufficient data/);
    await new Promise((r) => setTimeout(r, 50));
    expect(await k.log.getEventsByTypes(["learning/insufficient"])).toHaveLength(1);
    expect(await k.log.getEventsByTypes(["learning/flagged"])).toHaveLength(0);
    expect(appliedStepBudget(k.repoPath)).toBe(34);
  });

  it("with history, a drop is flagged and the budget is left as it was: only a paired suite run rolls back (rule 18)", async () => {
    const k = kernel();
    const lines: string[] = [];
    // Ten passing cards before the change are its history.
    for (let i = 0; i < 10; i++) observe(k, i, true, lines);
    applyTunedPolicy(k.repoPath, { stepBudget: 20, maxFailedChecks: 3 }, "tune");
    for (let i = 10; i < 20; i++) observe(k, i, i < 12, lines);
    expect(lines.join("\n")).toMatch(/advisory: pass rate 20% over 10 cards vs 100% before/);
    await new Promise((r) => setTimeout(r, 50));
    expect(await k.log.getEventsByTypes(["learning/flagged"])).toHaveLength(1);
    expect(appliedStepBudget(k.repoPath)).toBe(34);
  });
});

describe("qualify and m0 need a model resolver", () => {
  it("qualify runs the deterministic suite through the resolver", async () => {
    const k = kernel();
    process.env.SEKHEMET_MODEL_REGISTRY = join(k.repoPath, "models.json");
    const out: string[] = [];
    const code = await runWave2Command("qualify", ["--models", "silent"], k, {
      print: (l) => out.push(l),
      model: (n) => new MockInferenceAdapter(n, [], { exhaustion: "default" }),
    });
    expect(code).toBe(1);
    expect(out[0]).toMatch(/^silent: .* not qualified/);
    expect(await runWave2Command("m0", [], k, quiet)).toBe(1);
    expect(existsSync(join(k.repoPath, "models.json"))).toBe(true);
    Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_REGISTRY");
  });
});

describe("the CLI reaches the wave-2 wiring (production path)", () => {
  it("sekhemet plan persists contracts; sekhemet goal and decide run through main", async () => {
    const { main } = await import("../src/index.js");
    const { vi } = await import("vitest");
    const k = kernel();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      await main([
        "plan",
        "Implement password hashing and rate limiting for login.",
        "--repo",
        k.repoPath,
      ]);
      const db = new DatabaseSync(join(k.repoPath, ".sekhemet", "events.db"));
      initSchema(db);
      const store = new CardStore(db, new EventLog(db));
      const stories = (await store.listCards()).filter((c) => c.tier !== "epic");
      expect(stories.length).toBeGreaterThan(0);
      expect(stories.every((s) => (s.acceptanceCriteria?.length ?? 0) > 0 && s.difficulty)).toBe(
        true,
      );
      expect(lines.join("\n")).toContain("INVEST pre-flight:");
      await main([
        "goal",
        "The test suite passes and coverage is at least 80%.",
        "--repo",
        k.repoPath,
      ]);
      expect(lines.join("\n")).toMatch(/Draft goal_\w+ saved/);
      await main(["decide", "--repo", k.repoPath]);
      expect(lines.join("\n")).toMatch(/No decisions waiting|recommended/);
    } finally {
      spy.mockRestore();
      process.exitCode = 0;
    }
  });
});
