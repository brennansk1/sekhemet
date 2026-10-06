import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { REASONING_BUDGET_TOKENS } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { ledgerRows, until } from "./support/g2_cli.js";
import {
  type Engine,
  type EngineTurn,
  lastTurn,
  startEngine,
  workerRequests,
} from "./support/g4_engine.js";
import { type Evidence, latestEvidence } from "./support/g4_gate.js";
import { queueProject, runQueueOn, runQueueToReport } from "./support/g4_queue.js";

/**
 * The Worker's loop as a person runs it (worker-loop §2; FINISH_LINE_PLAN C2d,
 * FINDINGS_C1 TST-01): `sekhemet queue` spawned as the built binary
 * (`apps/harness/dist/index.js`, through `support/g2_cli.ts`) over a real
 * repository and ledger. The Worker is a scripted engine in its own process
 * on a real socket (`support/g4_engine.ts`), which records every request the
 * binary sends it; no model is loaded and nothing leaves the machine. Where a
 * person acts during or between runs, they act over HTTP on a real dashboard
 * server over the same ledger.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FAKE_LSP = join(REPO_ROOT, "packages", "context", "tests", "support", "fake_lsp.mjs");

const BASE = {
  "src/a.ts": "",
  "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
};
const card = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  tier: "story" as const,
  title: "Write a",
  scopeFiles: ["src/a.ts"],
  stepBudget: 6,
  spec: "Export a from src/a.ts",
  ...over,
});
const WRITE_A: EngineTurn["calls"] = [
  { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
];
const FINISH = { name: "finish_card" };
const toolNames = (r: { body: { tools?: { function?: { name: string } }[] } }) =>
  (r.body.tools ?? []).map((t) => t.function?.name);

async function run(
  files: Record<string, string>,
  cards: ReturnType<typeof card>[],
  turns: EngineTurn[],
  extra: Record<string, string> = {},
  args: string[] = [],
) {
  const p = await queueProject({ files, cards });
  const engine = await startEngine(p.home, turns);
  const r = await runQueueOn(p, engine, extra, args);
  return { p, engine, r, out: `${r.stdout}\n${r.stderr}` };
}

describe("tool arms and what each step records (WL-M2, WL-M3, WL-T3-1)", () => {
  it("WL-M2-5, WL-T3-1: each step's phase, format errors, prose-only replies and tokens are in the evidence and the step rows, under the arm recorded; the fixed arm never offers tool_search", async () => {
    const turns: EngineTurn[] = [
      { calls: [{ name: "launch_rockets", arguments: {} }] },
      { text: "I will now write the file." },
      { calls: [...(WRITE_A ?? []), FINISH] },
    ];
    const progressive = await run(BASE, [card()], turns);
    expect(progressive.r.stdout, progressive.out).toMatch(/PASSED \(gate_passed\)/);
    const e = latestEvidence(progressive.p.repo, "c1") as Evidence;
    expect(e.settings.toolSet).toBe("progressive");
    expect(e.steps.map((s) => [s.step, s.phase, s.formatErrors, s.proseOnly])).toEqual([
      [1, "find", 1, 0],
      [2, "find", 0, 1],
      [3, "verify", 0, 0],
    ]);
    for (const s of e.steps) expect([s.promptTokens, s.answerTokens]).toEqual([10, 5]);
    const rows = ledgerRows(progressive.p.repo).filter((r) => r.type === "step/recorded");
    expect(rows.map((r) => [r.payload.phase, r.payload.formatErrors, r.payload.proseOnly])).toEqual(
      [
        ["find", 1, 0],
        ["find", 0, 1],
        ["verify", 0, 0],
      ],
    );
    expect(toolNames(workerRequests(progressive.engine)[0] as never)).toContain("tool_search");

    // The fixed arm, named by the run's profile: tool_search is not offered,
    // so a call to it is a call to a tool not offered.
    const fixed = await run(
      BASE,
      [card()],
      [
        { calls: [{ name: "tool_search", arguments: { query: "write" } }] },
        { calls: [...(WRITE_A ?? []), FINISH] },
      ],
      {},
      ["--tool-arm", "fixed"],
    );
    expect(fixed.r.stdout, fixed.out).toMatch(/PASSED \(gate_passed\)/);
    const f = latestEvidence(fixed.p.repo, "c1") as Evidence;
    expect(f.settings.toolSet).toBe("fixed");
    for (const req of workerRequests(fixed.engine))
      expect(toolNames(req as never)).not.toContain("tool_search");
    expect(f.steps[0]?.formatErrors).toBe(1);
  });

  it("WL-M2-7: under progressive loading, a tool_search query naming a code symbol loads read_symbol and names the read_symbol call to make", async () => {
    const t = await run(
      { ...BASE, "src/types.ts": "export interface ChronicleEvent {\n  id: string;\n}\n" },
      [card()],
      [
        { calls: [{ name: "tool_search", arguments: { query: "ChronicleEvent" } }] },
        { calls: [...(WRITE_A ?? []), FINISH] },
      ],
    );
    expect(t.r.stdout, t.out).toMatch(/PASSED \(gate_passed\)/);
    const [first, second] = workerRequests(t.engine);
    expect(toolNames(first as never)).not.toContain("read_symbol");
    expect(toolNames(second as never)).toContain("read_symbol");
    const reply = lastTurn(second as never);
    expect(reply).toMatch(
      /read_symbol\([^)]*src\/types\.ts[^)]*ChronicleEvent|read_symbol[^\n]*ChronicleEvent[^\n]*src\/types\.ts|read_symbol[^\n]*src\/types\.ts[^\n]*ChronicleEvent/,
    );
  });

  it("WL-M3-3: with thinking `all` every Worker request thinks, and its allowance is REASONING_BUDGET_TOKENS.high over the same request with thinking off", async () => {
    const turns: EngineTurn[] = [{ calls: [...(WRITE_A ?? []), FINISH] }];
    const off = await run(BASE, [card()], turns, { SEKHEMET_THINKING: "off" });
    const all = await run(BASE, [card()], turns, { SEKHEMET_THINKING: "all" });
    expect(all.r.stdout, all.out).toMatch(/PASSED \(gate_passed\)/);
    const [o] = workerRequests(off.engine);
    const [a] = workerRequests(all.engine);
    expect(o?.body.think).toBe(false);
    expect(a?.body.think).toBe(true);
    expect(Number(a?.body.options?.num_predict) - Number(o?.body.options?.num_predict)).toBe(
      REASONING_BUDGET_TOKENS.high,
    );
    expect(latestEvidence(all.p.repo, "c1")?.settings.thinking).toBe("all");
  });
});

describe("budgets (WL-T3-11, WL-T3-13)", () => {
  it("WL-T3-11: a card created without a step budget gets the one default of 40 and is set at Planning; one created with 40 explicitly keeps it", async () => {
    const t = await run(
      BASE,
      [
        {
          id: "c1",
          tier: "story",
          title: "Write a",
          scopeFiles: ["src/a.ts"],
          spec: "Export a from src/a.ts",
        } as ReturnType<typeof card>,
        card({ id: "c2", title: "Write a again", stepBudget: 40 }),
      ],
      [{ calls: [...(WRITE_A ?? []), FINISH] }, { calls: [FINISH] }],
    );
    expect(t.r.stdout, t.out).toMatch(/=== c1/);
    const rows = ledgerRows(t.p.repo);
    const created = (id: string) =>
      rows.find((r) => r.type === "card/created" && r.cardId === id)?.payload;
    expect(created("c1")?.stepBudget).toBe(40);
    expect(created("c2")?.stepBudget).toBe(40);
    const set = rows.filter((r) => r.type === "card/budget_set");
    expect(set.map((r) => r.cardId)).toEqual(["c1"]);
    expect(set[0]?.payload.from).toBe(40);
    const started = (id: string) =>
      rows.find((r) => r.type === "attempt/started" && r.cardId === id);
    expect(started("c2")).toBeDefined();
    expect(rows.filter((r) => r.type === "card/budget_set" && r.cardId === "c2")).toEqual([]);
  });

  it("WL-T3-13: under pass_at_k = 2 the step budget applies to each sample, and the attempt records each sample's steps", async () => {
    const t = await run(
      {
        ...BASE,
        ".sekhemet/gates.toml": `[project]\npass_at_k = 2\n\n[[gate]]\nid = "unit"\nrung = "test"\ncommand = "sh"\nargs = ["-c", "echo 'error: always' >&2; exit 1"]\nparser = "generic"\n`,
      },
      [card({ stepBudget: 2 })],
      [
        { calls: [...(WRITE_A ?? []), FINISH] },
        { calls: [FINISH] },
        { calls: [...(WRITE_A ?? []), FINISH] },
        { calls: [FINISH] },
      ],
    );
    const e = latestEvidence(t.p.repo, "c1") as Evidence & { sampleSteps?: number[] };
    expect(e, t.out).toBeDefined();
    expect(e.sampleSteps).toEqual([2, 2]);
    expect(e.steps.map((s) => s.sample)).toEqual([1, 1, 2, 2]);
    // Four Worker steps on a budget of two: the budget is each sample's.
    expect(workerRequests(t.engine)).toHaveLength(4);
  });
});

describe("a question the Worker cannot wait for (WL-N4)", () => {
  it("WL-N4-1, WL-N4-2: ask posts a non-blocking decision with the assumption; a person's answer during a step reaches the Worker at the next step boundary, saying it contradicts the assumption", async () => {
    const p = await queueProject({
      files: BASE,
      cards: [card({ stepBudget: 5, spec: "Write the module." })],
    });
    const answered = join(p.home, "answered");
    const engine = await startEngine(p.home, [
      {
        calls: [
          {
            name: "ask",
            arguments: {
              question: "Which locale formats invoice totals?",
              assumption: "the en-US locale",
            },
          },
        ],
      },
      // Step 2 is answered only after the person has answered.
      { waitFor: answered, calls: [{ name: "read_file", arguments: { path: "src/a.ts" } }] },
      { calls: [{ name: "read_file", arguments: { path: "src/main.ts" } }] },
      { calls: [...(WRITE_A ?? []), FINISH] },
    ]);
    const running = runQueueOn(p, engine);
    // A person on the dashboard, over the same ledger, while the card runs.
    const { db, log } = openLocalLedger(p.repo);
    const cardStore = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: p.repo,
      port: 0,
      streamIntervalMs: 1000,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      type Decision = {
        id: string;
        cardId: string;
        kind: string;
        question: string;
        options: string[];
      };
      let pending: Decision | undefined;
      await until(() => workerRequests(engine).length >= 2, 60_000);
      for (let i = 0; i < 100 && !pending; i++) {
        const list = (await (await fetch(`${base}/api/decisions?status=pending`)).json()) as {
          decisions: Decision[];
        };
        pending = list.decisions[0];
        if (!pending) await new Promise((r) => setTimeout(r, 100));
      }
      // WL-N4-1: the question, the card and the Worker's assumption; the Worker went on.
      expect(pending).toMatchObject({
        cardId: "c1",
        kind: "worker_question",
        question: "Which locale formats invoice totals?",
      });
      expect(pending?.options[0]).toContain("the en-US locale");
      const res = await fetch(`${base}/api/decisions/${pending?.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ option: 1 }),
      });
      expect(res.status).toBe(200);
      writeFileSync(answered, "");
      const r = await running;
      expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    } finally {
      await server.close();
      db.close();
    }
    const asks = workerRequests(engine);
    const text = (i: number) => JSON.stringify(asks[i]?.body.messages ?? []);
    // WL-N4-2: never mid-step: not in step 2's request, in step 3's, saying it contradicts.
    expect(text(1)).not.toContain("contradicts");
    expect(text(2)).toContain("contradicts your assumption");
    expect(ledgerRows(p.repo).filter((e) => e.type === "decision/delivered")).toHaveLength(1);
  });
});

describe("a send-back's comments and the second attempt (WL-N10-4, WL-N5-1)", () => {
  it("WL-N10-4, WL-N5-1: each comment on a diff line, with its file and line, is in the next attempt's instructions; each attempt appends attempt/finished with its real number", async () => {
    const p = await queueProject({ files: BASE, cards: [card()] });
    const first = await startEngine(p.home, [{ calls: [...(WRITE_A ?? []), FINISH] }]);
    const r1 = await runQueueOn(p, first);
    expect(r1.stdout, r1.stderr).toMatch(/PASSED \(gate_passed\)/);

    // The reviewer sends it back from the dashboard with two line comments.
    const { db, log } = openLocalLedger(p.repo);
    const cardStore = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: p.repo,
      port: 0,
      streamIntervalMs: 1000,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const res = await fetch(`${base}/api/cards/c1/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({
          reason: "two fixes",
          comments: [
            { file: "src/a.ts", line: 1, text: "name it with a unit" },
            { file: "src/main.ts", line: 2, text: "log through the logger" },
          ],
        }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    } finally {
      await server.close();
      db.close();
    }

    const second = await startEngine(join(p.home), [{ calls: [FINISH] }]);
    const r2 = await runQueueOn(p, second);
    expect(r2.stdout, r2.stderr).toMatch(/=== c1 \(attempt 2\)/);
    const prompt = JSON.stringify(workerRequests(second)[0]?.body.messages ?? []);
    expect(prompt).toContain("src/a.ts:1 — name it with a unit");
    expect(prompt).toContain("src/main.ts:2 — log through the logger");

    const finished = ledgerRows(p.repo).filter((e) => e.type === "attempt/finished");
    expect(finished.map((e) => e.payload.attemptNumber)).toEqual([1, 2]);
    for (const e of finished) {
      expect(e.payload).toMatchObject({
        cardId: "c1",
        rung: expect.any(Number),
        toolArm: expect.any(String),
        role: "worker",
        modelId: "scripted-worker:latest",
        ruleIds: expect.any(Array),
        exemplarIds: expect.any(Array),
        steps: expect.any(Number),
        tokensUsed: expect.any(Number),
        builtBy: { kind: "worker", id: "scripted-worker:latest" },
        stopReason: expect.any(String),
      });
    }
  });
});

describe("outcomes are read from the ledger (WL-N5-2)", () => {
  it("WL-N5-2: the capability report counts the attempt from attempt/finished, unchanged when the evidence files and queue report are gone or say otherwise", async () => {
    const t = await run(BASE, [card()], [{ calls: [...(WRITE_A ?? []), FINISH] }]);
    expect(t.r.stdout, t.out).toMatch(/PASSED \(gate_passed\)/);
    const { db, log } = openLocalLedger(t.p.repo);
    const cardStore = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: t.p.repo,
      port: 0,
      streamIntervalMs: 1000,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      type Report = { types: { type: string; attempts: number; passes: number }[] };
      const before = (await (await fetch(`${base}/api/capability`)).json()) as Report;
      expect(before.types.map((x) => [x.attempts, x.passes])).toEqual([[1, 1]]);
      // The files a reader might have used instead: gone, then contradicting.
      rmSync(join(t.p.repo, ".sekhemet", "evidence"), { recursive: true, force: true });
      writeFileSync(
        join(t.p.repo, ".sekhemet", "queue_report.json"),
        JSON.stringify({ cards: [{ id: "c1", passed: false }] }),
      );
      const after = (await (await fetch(`${base}/api/capability`)).json()) as Report;
      expect(after.types).toEqual(before.types);
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("language-server tools (WL-N6, WL-N7, GT-BF-3)", () => {
  /** A `typescript-language-server` on PATH: the test LSP, logging each start in the worktree it serves. */
  const lspOnPath = (home: string): string => {
    const bin = join(home, "lsp-bin");
    mkdirSync(bin, { recursive: true });
    const source = readFileSync(FAKE_LSP, "utf8").replace(
      'if (m.method === "initialize") {',
      `if (m.method === "initialize") {
    try {
      const here = fileURLToPath(m.params.rootUri);
      __mkdir(join(here, ".sekhemet"), { recursive: true });
      __append(join(here, ".sekhemet", "lsp-starts.log"), JSON.stringify({ at: Date.now(), nodeOptions: process.env.NODE_OPTIONS ?? null, init: m.params.initializationOptions ?? null }) + "\\n");
    } catch {}`,
    );
    const server = join(bin, "typescript-language-server");
    writeFileSync(
      server,
      `#!${process.execPath}\nimport { appendFileSync as __append, mkdirSync as __mkdir } from "node:fs";\n${source}`,
    );
    chmodSync(server, 0o755);
    return `${bin}:${process.env.PATH ?? ""}`;
  };
  const FILES = {
    "src/a.ts": "export function greet() {}\ngreet();\n",
    "src/b.ts": 'import { greet } from "./a.js";\ngreet();\n',
    "lib/c.ts": 'import { greet } from "../src/a.js";\ngreet();\n',
    // The project's own typecheck and suite: a card with tool-applied lines must pass both.
    ".sekhemet/gates.toml": `[project]\nmax_files = 3\nmax_diff_lines = 1\n\n[[gate]]\nid = "types"\nrung = "typecheck"\ncommand = "sh"\nargs = ["-c", "exit 0"]\nparser = "generic"\n\n[[gate]]\nid = "unit"\nrung = "test"\ncommand = "sh"\nargs = ["-c", "exit 0"]\nparser = "generic"\n`,
  };
  const RENAME = {
    name: "rename_symbol",
    arguments: { path: "src/a.ts", symbol: "greet", new_name: "welcome" },
  };

  it("WL-N6-1, GT-BF-3, WL-N7-2: rename_symbol applies every site in one call through a language server started on the first symbol request, heap-capped and told what to exclude; its lines are tool-applied, outside max_diff_lines", async () => {
    const p = await queueProject({
      files: FILES,
      cards: [card({ scopeFiles: ["src/**", "lib/**"], spec: "Rename greet to welcome" })],
    });
    const engine = await startEngine(p.home, [
      { calls: [{ name: "read_file", arguments: { path: "src/a.ts" } }] },
      { calls: [RENAME] },
      { calls: [FINISH] },
    ]);
    const r = await runQueueToReport(p, engine, { PATH: lspOnPath(p.home) });
    expect(r.stdout).toMatch(/PASSED \(gate_passed\)/);
    const wt = join(p.repo, ".sekhemet", "worktrees", "c1");
    expect(readFileSync(join(wt, "src", "b.ts"), "utf8")).toBe(
      'import { welcome } from "./a.js";\nwelcome();\n',
    );
    expect(readFileSync(join(wt, "lib", "c.ts"), "utf8")).toContain("welcome();");
    // Started once, after the first Worker request, with the heap capped and the exclusions sent.
    const starts = readFileSync(join(wt, ".sekhemet", "lsp-starts.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(starts).toHaveLength(1);
    expect(starts[0].at).toBeGreaterThan(workerRequests(engine)[1]?.at ?? Number.POSITIVE_INFINITY);
    expect(starts[0].nodeOptions).toMatch(/--max-old-space-size=\d+/);
    expect(JSON.stringify(starts[0].init)).toContain("node_modules");
    // GT-BF-3: the five renamed lines are the tool's, not the Worker's (max_diff_lines = 1).
    const e = latestEvidence(p.repo, "c1") as Evidence & {
      toolApplied?: { lines: number; limit: number };
    };
    expect(e.toolApplied?.lines).toBeGreaterThan(1);
    expect(e.toolApplied?.limit).toBe(500);
    expect(e.rungResults.find((o) => o.gate === "bounds")?.passed).toBe(true);
    for (const g of ["types", "unit"])
      expect(e.rungResults.find((o) => o.gate === g)?.passed, g).toBe(true);
  });

  it("WL-N6-2: a rename reaching a file outside the card's scope is refused, naming the file, and nothing is changed", async () => {
    const p = await queueProject({
      files: FILES,
      cards: [card({ scopeFiles: ["src/**"], spec: "Rename greet to welcome" })],
    });
    const engine = await startEngine(p.home, [{ calls: [RENAME] }, { calls: [FINISH] }]);
    const r = await runQueueToReport(p, engine, { PATH: lspOnPath(p.home) });
    expect(r.stdout).toMatch(/=== c1/);
    const refused = lastTurn(workerRequests(engine)[1] as never);
    expect(refused).toContain("lib/c.ts");
    const wt = join(p.repo, ".sekhemet", "worktrees", "c1");
    expect(readFileSync(join(wt, "src", "a.ts"), "utf8")).toBe(FILES["src/a.ts"]);
    expect(readFileSync(join(wt, "lib", "c.ts"), "utf8")).toBe(FILES["lib/c.ts"]);
  });

  it("WL-N7-3: with no language server installed, a symbol request falls back and says so, and no gate fails because of it", async () => {
    const p = await queueProject({
      files: {
        ...FILES,
        "tool.py": "def greet():\n  return 1\n",
        ".sekhemet/gates.toml": FILES[".sekhemet/gates.toml"].replace(
          "max_diff_lines = 1",
          "max_diff_lines = 200",
        ),
      },
      cards: [
        card({ scopeFiles: ["src/**", "lib/**", "tool.py"], spec: "Export a from src/a.ts" }),
      ],
    });
    const engine = await startEngine(p.home, [
      {
        calls: [
          { name: "find_references", arguments: { symbol: "greet", file: "src/a.ts" } },
          { name: "find_references", arguments: { symbol: "greet", file: "tool.py" } },
        ],
      },
      {
        calls: [
          { name: "read_file", arguments: { path: "src/a.ts" } },
          {
            name: "write_file",
            arguments: {
              path: "src/a.ts",
              content: "export function greet() {}\ngreet();\nexport const a = 1;\n",
            },
          },
          FINISH,
        ],
      },
    ]);
    // PATH without any language server.
    const r = await runQueueOn(p, engine, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const replies = lastTurn(workerRequests(engine)[1] as never);
    expect(replies).toContain("TypeScript language service");
    expect(replies).toMatch(/python language server is unavailable/);
    expect(replies).toContain("tool.py");
  });
});

describe("a Worker whose model goes down (WL-N12-2)", () => {
  it("WL-N12-2: an engine killed mid-stream is retried once after a wait, then the card stops model_unavailable naming what failed, returns to Ready at its checkpoint, and the queue starts no further card", async () => {
    const p = await queueProject({
      files: BASE,
      cards: [card(), card({ id: "c2", title: "Write b", spec: "Export b" })],
    });
    const engine: Engine = await startEngine(p.home, [{ calls: WRITE_A }, { die: true }]);
    const started = Date.now();
    const r = await runQueueOn(p, engine);
    expect(engine.proc.signalCode).toBe("SIGKILL");
    expect(r.stdout, r.stderr).toMatch(/\(model_unavailable\)/);
    expect(r.stdout).not.toMatch(/=== c2/);
    // The policy's one wait (2 s) before the one retry.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    const rows = ledgerRows(p.repo);
    const status = rows
      .filter((e) => e.type === "card/status_changed" && e.cardId === "c1")
      .map((e) => e.payload.toStatus);
    expect(status.at(-1)).toBe("ready");
    expect(rows.some((e) => e.cardId === "c2" && e.type === "attempt/started")).toBe(false);
    // The retry, then the stop naming what failed.
    expect(r.stdout).toMatch(/the Coding model did not answer \(.+\); retrying once/);
    const e = latestEvidence(p.repo, "c1") as Evidence & { stopDetail?: Record<string, unknown> };
    expect(e.stopReason).toBe("model_unavailable");
    expect(JSON.stringify(e.stopDetail)).toMatch(/fetch failed|ECONNREFUSED|terminated|socket/);
    // The checkpoint holds the step the Worker finished before the engine died.
    const wt = join(p.repo, ".sekhemet", "worktrees", "c1");
    expect(existsSync(wt)).toBe(true);
    expect(
      execFileSync("git", ["log", "--format=%s", "-1"], { cwd: wt, encoding: "utf8" }),
    ).not.toBe("seed\n");
  });
});
