import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { type LedgerRow, cli, g2Dirs, g2Env, ledgerRows } from "./support/g2_cli.js";

/**
 * The planner through `sekhemet plan` (planner-pm P1, P2, P13 and NEW-1;
 * FINISH_LINE_PLAN C2d, FINDINGS_C1 TST-01): the built binary spawned in a
 * real repository with an empty home, planning without a model on purpose
 * (`--planner none`, the heuristic every plan falls back to) and offline, so
 * nothing is loaded and nothing leaves the machine. What the planner
 * persisted is read back from the on-disk ledger the command wrote.
 */

const KINDS = ["implement", "interface", "data", "rule", "spike", "characterize", "fix"];

interface Planned {
  status: number | null;
  out: string;
  repo: string;
  home: string;
  rows: LedgerRow[];
}

/** A fresh repository holding `files`, committed. */
function repoWith(files: Record<string, string>): { cwd: string; home: string } {
  const where = g2Dirs();
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], {
      cwd: where.cwd,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(where.cwd, rel, ".."), { recursive: true });
    writeFileSync(join(where.cwd, rel), text);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "seed");
  return where;
}

/** `sekhemet <args>` in the repository, as a person runs it. */
async function sekhemet(
  where: { cwd: string; home: string },
  args: string[],
): Promise<{ status: number | null; out: string }> {
  const r = await cli(args, { cwd: where.cwd, env: g2Env(where.home), timeoutMs: 120_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}

/** `sekhemet plan "<spec>" --planner none --offline`. */
async function plan(where: { cwd: string; home: string }, spec: string): Promise<Planned> {
  // --verbose: these tests read each issue's size and the plan's checks (CLI-07 keeps them behind it).
  const r = await sekhemet(where, ["plan", spec, "--planner", "none", "--offline", "--verbose"]);
  return { ...r, repo: where.cwd, home: where.home, rows: ledgerRows(where.cwd) };
}

interface PlannedCard {
  id: string;
  tier: string;
  title: string;
  status: string;
  kind: string;
  change: string;
  split: string | null;
  splitDepth: number | null;
  estimate: number | null;
  acceptanceCriteria: string[];
  criterionIds: string[] | null;
  interface: { symbol: string; file: string; signature: string }[] | null;
  blockedReason: string | null;
  parentId: string | null;
}

const stories = (rows: LedgerRow[]) =>
  rows
    .filter((r) => r.type === "card/created" && r.payload.tier !== "epic")
    .map((r) => r.payload as unknown as PlannedCard);
const ofType = (rows: LedgerRow[], type: string) =>
  rows.filter((r) => r.type === type).map((r) => ({ ...r.payload, ...(r.private ?? {}) }));

const NEW_PROJECT = { "package.json": JSON.stringify({ name: "app", version: "0.1.0" }) };
const LOGIN =
  "Let users log in with email and password. A retried charge must never charge a customer twice.";

describe("sekhemet plan: at most two questions a pass (PM-P2-3)", () => {
  it(
    "PM-P2-3: a spec with five open points posts the planner's two that most change the backlog, and records the other three as assumptions with their defaults",
    { timeout: 180_000 },
    async () => {
      const FIVE =
        "A notes app that syncs to the cloud or to a local folder. Persist the notes in a backend. Maybe expose a public API. Admin roles can manage users. Make the sharing sensible.";
      const r = await plan(repoWith(NEW_PROJECT), FIVE);
      expect(r.status, r.out).toBe(0);
      const assumptions = ofType(r.rows, "assumption/logged") as {
        category: string;
        statement: string;
        basis: string;
      }[];
      // The design stage's own question (one at a time, design-stage §2.1)
      // is its own; the planner's pass is what the cap is about.
      const design = assumptions.filter((a) => a.basis === "design stage default");
      const asked = (ofType(r.rows, "decision/requested") as { question: string }[]).filter(
        (d) => !design.some((a) => a.statement.startsWith(d.question)),
      );
      expect(asked.map((d) => d.question)).toHaveLength(2);
      const notAsked = assumptions.filter((a) =>
        a.basis.startsWith("Not asked: at most 2 questions per planning pass"),
      );
      expect(notAsked.map((a) => a.category).sort()).toEqual([
        "api_surface",
        "storage",
        "vagueness",
      ]);
      for (const a of notAsked) expect(a.statement).toMatch(/^Assumed .+ for: /);
      // What was asked is not also assumed: the two asked are other open points.
      for (const d of asked)
        expect(notAsked.some((a) => a.statement.includes(d.question))).toBe(false);
    },
  );
});

describe("sekhemet plan in the stack the request or the repository is in (DS-N1-5)", () => {
  it(
    "DS-N1-5: a Python request plans Python source files, never a `.ts` one; a Python repository's own extension wins when the request names none",
    { timeout: 180_000 },
    async () => {
      const scopes = (rows: LedgerRow[]) =>
        rows
          .filter((r) => r.type === "card/created" && r.payload.tier !== "epic")
          .flatMap((r) => (r.payload.scopeFiles as string[] | undefined) ?? []);
      const asked = await plan(repoWith({}), "a Python script that renames photos by date");
      expect(asked.status, asked.out).toBe(0);
      const named = scopes(asked.rows);
      expect(named.length).toBeGreaterThan(0);
      for (const f of named) expect(f, f).toMatch(/\.py$/);
      const pythonRepo = await plan(
        repoWith({ "photos/rename.py": "def rename(path):\n    return path\n" }),
        "Add a dry run that lists the new names without moving any file",
      );
      expect(pythonRepo.status, pythonRepo.out).toBe(0);
      for (const f of scopes(pythonRepo.rows)) expect(f, f).not.toMatch(/\.ts$/);
    },
  );
});

describe("sekhemet plan on a new project: the cards' contract", () => {
  it(
    "PM-P1-5, PM-P1-6, PM-P1-9, PM-P1-12, PM-P1-14, PM-N1-1, PM-P13-2: criteria linted, the retry rule as a concrete criterion, no fragment titles, one change value, points, and every card traced",
    { timeout: 180_000 },
    async () => {
      const r = await plan(repoWith(NEW_PROJECT), LOGIN);
      expect(r.status, r.out).toBe(0);
      // PM-P1-14: the plan is read back from the on-disk SQLite file the command wrote.
      expect(existsSync(join(r.repo, ".sekhemet", "events.db"))).toBe(true);
      const cards = stories(r.rows);
      expect(cards.length).toBeGreaterThan(0);
      // PM-P1-5: a criterion that only repeats its card's title, with no value, is refused in the lint.
      const repeating = cards.find((c) => c.acceptanceCriteria.includes(`${c.title}.`));
      expect(repeating?.blockedReason).toMatch(/refused by the lint \(.*repeats_title.*\)/);
      expect(repeating?.blockedReason).toMatch(/no_value/);
      expect(repeating?.status).toBe("planning");
      // PM-P1-6: the retried-charge rule becomes a criterion naming the original result and one charge.
      expect(cards.flatMap((c) => c.acceptanceCriteria)).toContainEqual(
        expect.stringMatching(
          /retried.*returns the original result and exactly one charge is recorded/,
        ),
      );
      // PM-P1-9: no card titled from a clause fragment.
      for (const c of cards) {
        expect(c.title).not.toMatch(/^(email|password)\b/i);
        expect(c.title).not.toMatch(/happy path/i);
      }
      for (const c of cards) {
        // PM-P1-12: exactly one change value, `feature` on a new project.
        expect(c.change, c.id).toBe("feature");
        // PM-P1-10: a stored kind of the seven, never read from the title.
        expect(KINDS, c.id).toContain(c.kind);
        expect(c.title).not.toMatch(/\(SPIDR/);
        // PM-N1-1: an estimate of 1, 2, 3, 5 or 8.
        expect([1, 2, 3, 5, 8], c.id).toContain(c.estimate);
      }
      // PM-P13-2: each card records the requirement ids and versions it traces to.
      const traces = ofType(r.rows, "trace/linked") as {
        requirementId: string;
        version: number;
        ref: string;
      }[];
      for (const c of cards) {
        const mine = traces.filter((t) => t.ref === c.id);
        expect(mine.length, c.id).toBeGreaterThan(0);
        for (const t of mine) {
          expect(t.requirementId).toMatch(/^REQ-\d+$/);
          expect(t.version).toBe(1);
        }
      }
    },
  );

  it(
    "PM-P1-20: a plan asking for a mechanism of §2.1.10 makes it an epic of its own, never one card",
    { timeout: 120_000 },
    async () => {
      const r = await plan(repoWith(NEW_PROJECT), "Build a repo map of the source tree.");
      expect(r.status, r.out).toBe(0);
      const created = r.rows
        .filter((x) => x.type === "card/created")
        .map((x) => x.payload as unknown as PlannedCard);
      const single = created.filter((c) => c.tier !== "epic" && /repo map/i.test(c.title));
      expect(single).toEqual([]);
      const epics = created.filter((c) => c.tier === "epic" && /repo map/i.test(c.title));
      // The plan's own epic, and the mechanism's: an epic in Backlog, planned apart.
      expect(epics.some((e) => e.status === "backlog")).toBe(true);
    },
  );
});

/** A repository whose two files are each far larger than one card's Zone 3 holds. */
function bigFiles(): Record<string, string> {
  const body = (n: string) =>
    Array.from(
      { length: 300 },
      (_, i) =>
        `export function ${n}${i}(amountCents: number): number {\n  return amountCents - ${i};\n}\n`,
    ).join("\n");
  return {
    "package.json": JSON.stringify({
      name: "app",
      version: "0.1.0",
      devDependencies: { vitest: "3" },
    }),
    "src/refund.ts": body("refund"),
    "src/invoice_email.ts": body("invoiceEmail"),
  };
}
const REFUND =
  "Refund a paid invoice and email the invoice to the customer. Given a paid invoice of 1000 cents, refunding 400 leaves 600. Given an invoice of 1000 cents, emailing it sends 1 email to the customer.";

describe("sekhemet plan on an existing codebase: size, splits and staged tests", () => {
  it(
    "PM-P1-11, PM-P1-12, PM-P1-15, PM-P1-17, PM-P1-18, PM-P1-19, PM-N1-2, PM-12: split axes and kinds stored, Small at the reference Worker's 3,792, examples staged as rows naming their criterion, a criterion with no test case held",
    { timeout: 180_000 },
    async () => {
      const r = await plan(repoWith(bigFiles()), REFUND);
      expect(r.status, r.out).toBe(0);
      const cards = stories(r.rows);
      // PM-P1-11: a story split along an axis records it, and a contract card is `interface`.
      const splits = cards.filter((c) => c.split !== null);
      expect(splits.length).toBeGreaterThan(0);
      for (const c of splits) {
        expect(["spike", "path", "interface", "data", "rules"]).toContain(c.split);
        expect(c.splitDepth).toBe(1);
        expect(KINDS).toContain(c.kind);
      }
      expect(splits.some((c) => c.split === "data" && c.kind === "interface")).toBe(true);
      // PM-P1-12: one change value each; a card pinning what a file does today is `characterize`.
      for (const c of cards) expect(["feature", "characterize"], c.id).toContain(c.change);
      // PM-12: the Small check at the reference Worker (W = 9,984): over 3,792 Zone 3 tokens
      // is held in Planning, never Ready; at or under it passes the size part.
      const over = cards.filter((c) =>
        /Zone 3 content is \d+ tokens, over/.test(c.blockedReason ?? ""),
      );
      expect(over.length).toBeGreaterThan(0);
      for (const c of over) {
        expect(c.blockedReason).toMatch(/over Zone 3's cap of 3792; split it/);
        expect(c.status).toBe("planning");
      }
      expect(r.out).toMatch(/FAIL small: .*Zone 3 content \d+ > 3792 tokens/);
      const sized = cards.filter((c) => !over.includes(c) && c.tier === "story");
      expect(sized.length).toBeGreaterThan(0);
      for (const c of sized) expect(c.blockedReason ?? "").not.toMatch(/INVEST Small/);
      // PM-N1-2: an 8 is proposed for a split in the same plan.
      const eight = cards.filter((c) => c.estimate === 8);
      expect(eight.length).toBeGreaterThan(0);
      for (const c of eight) expect(r.out).toContain(`Proposed split: ${c.id}`);
      // PM-P1-17, PM-P1-19: the staged test's cases each prove a criterion of their own card,
      // one row per example, in the project's framework (Vitest) and test folder.
      const staged = ofType(r.rows, "test/staged") as {
        cardId: string;
        path: string;
        cases: { name: string; criterionId: string }[];
      }[];
      expect(staged.length).toBeGreaterThan(0);
      for (const s of staged) {
        const card = cards.find((c) => c.id === s.cardId);
        expect(s.path).toMatch(/^tests\/.+\.spec\.ts$/);
        for (const c of s.cases) {
          expect(card?.criterionIds).toContain(c.criterionId);
          expect(c.name.startsWith(`${c.criterionId}:`)).toBe(true);
          expect(c.name).toMatch(/\[example \d+\]$/);
        }
      }
      const examples = ofType(r.rows, "test/examples") as {
        cardId: string;
        criterionIds: string[];
        rows: number;
      }[];
      expect(examples.length).toBeGreaterThan(0);
      for (const e of examples) {
        const s = staged.find((x) => x.cardId === e.cardId);
        expect(s?.cases.length).toBe(e.rows);
      }
      // PM-P1-18: a criterion with no staged case keeps its card in Planning, named.
      const missing = cards.find((c) => /has no staged test case/.test(c.blockedReason ?? ""));
      expect(missing?.status).toBe("planning");
      const named = /Criterion (\S+) has no staged test case/.exec(missing?.blockedReason ?? "");
      expect(missing?.criterionIds).toContain(named?.[1]);
      expect(staged.flatMap((s) => s.cases.map((c) => c.criterionId))).not.toContain(named?.[1]);
      // PM-P1-15: the symbol the staged test imports, its file and signature, on the card.
      const withInterface = cards.find((c) => c.id === missing?.id);
      expect(withInterface?.interface?.[0]).toMatchObject({
        symbol: expect.any(String),
        file: expect.stringMatching(/^src\/.+\.ts$/),
        signature: expect.stringMatching(/\(.*\) → /),
      });
    },
  );
});

/** Five independent open points: alternatives, storage, API surface, authorization, vagueness. */
const FIVE =
  "A notes app that syncs to the cloud or to a local folder. Persist the notes in a backend. Maybe expose a public API. Admin roles can manage users. Make the sharing sensible.";

describe("sekhemet plan with open questions", () => {
  it(
    "PM-P2-4, PM-P2-5, PM-P2-6: a spec with five questions is planned; cards wait only on a default_deny question; a question answered by an earlier decision is not asked again",
    { timeout: 240_000 },
    async () => {
      const where = repoWith({});
      const first = await plan(where, FIVE);
      expect(first.status, first.out).toBe(0);
      // PM-P2-5: planned, not refused as under-specified.
      const cards = stories(first.rows);
      expect(cards.length).toBeGreaterThan(0);
      expect(first.out).toMatch(/Plan v1: \d+ issues planned/);
      expect(first.out).not.toMatch(/ rejected/);
      expect(first.out).not.toMatch(/under-specified/i);
      const asked = ofType(first.rows, "decision/requested") as {
        id: string;
        question: string;
        context: string;
      }[];
      // PM-P2-3 (C5): at most two questions a pass — the design stage's second
      // is not posted on top of the planner's two; its default stands as an assumption.
      expect(asked.length, asked.map((d) => d.question).join(" | ")).toBeLessThanOrEqual(2);
      const policyOf = (d: { context: string }) =>
        (JSON.parse(d.context) as { planner?: { policy?: string } }).planner?.policy;
      const deny = asked.filter((d) => policyOf(d) === "default_deny");
      const safe = asked.filter((d) => policyOf(d) === "safe_default");
      expect(deny.length).toBeGreaterThan(0);
      expect(safe.length).toBeGreaterThan(0);
      // PM-P2-4: the cards wait on the default_deny question, never on a safe default.
      for (const c of cards) {
        for (const d of deny) expect(c.blockedReason ?? "", c.id).toContain(d.id);
        for (const d of safe) expect(c.blockedReason ?? "", c.id).not.toContain(d.id);
      }
      expect(
        safe.some((d) =>
          first.out.includes(`Decision ${d.id} is open; planning proceeds on its default`),
        ),
      ).toBe(true);
      // PM-P2-6: the person answers a question; planned again, it is not asked, and its answer
      // is the assumption, with its source.
      const answered = safe.find((d) => /architectural paths/.test(d.question)) ?? safe[0];
      const decided = await sekhemet(where, ["decide", answered?.id as string, "2"]);
      expect(decided.status, decided.out).toBe(0);
      const before = first.rows.length;
      const again = await plan(where, FIVE);
      expect(again.status, again.out).toBe(0);
      const later = again.rows.slice(before);
      const askedAgain = ofType(later, "decision/requested") as { question: string }[];
      expect(askedAgain.map((d) => d.question)).not.toContain(answered?.question);
      const settled = (
        ofType(later, "assumption/logged") as { basis: string; statement: string }[]
      ).find((a) => a.basis.includes(answered?.id as string));
      expect(settled?.basis).toBe(`Settled by decision ${answered?.id}`);
    },
  );
});

describe("the planned cards in the capability report (PM-P1-10)", () => {
  it(
    "PM-P1-10: every module reads a planned card's stored kind: the capability report over HTTP shows no planned card under Other",
    { timeout: 180_000 },
    async () => {
      const r = await plan(repoWith(NEW_PROJECT), LOGIN);
      expect(r.status, r.out).toBe(0);
      const db = new DatabaseSync(join(r.repo, ".sekhemet", "events.db"));
      const log = new EventLog(db);
      const store = new CardStore(db, log);
      // Each planned card runs once, as the runner records its attempts.
      for (const c of stories(r.rows)) {
        const a = await store.runs.startAttempt({
          cardId: c.id,
          attemptNumber: store.runs.nextAttemptNumber(c.id),
          modelId: "m",
        });
        await store.runs.finishAttempt({
          attemptId: a.id,
          status: "passed",
          stopReason: "gate_passed",
          tokensUsed: 1,
          secondsUsed: 1,
          linesAdded: 10,
        });
      }
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(store),
        cardStore: store,
        repoPath: r.repo,
        port: 0,
        streamIntervalMs: 10_000,
        pressureLevel: () => 1,
      });
      try {
        const report = (await (
          await fetch(`http://127.0.0.1:${server.port}/api/capability`)
        ).json()) as { sampleSize: number; types: { type: string; attempts: number }[] };
        expect(report.types.reduce((n, t) => n + t.attempts, 0)).toBe(stories(r.rows).length);
        for (const t of report.types) expect(KINDS).toContain(t.type);
        expect(report.types.map((t) => t.type)).not.toContain("Other");
      } finally {
        await server.close();
        db.close();
      }
    },
  );
});

describe("sekhemet plan with a Planning model, then approve and the queue", () => {
  const PAY = "Compute overtime pay for a week.";
  /** The Planning model's slices, and its edit sketch, in one reply (each parser reads its own keys). */
  const reply = (diffSketch: string) =>
    JSON.stringify({
      slices: [
        {
          kind: "rule",
          title: "Pay time and a half past forty hours",
          keywords: ["overtime", "pay"],
          rationale: "the overtime rule",
          criteria: [
            {
              text: "Given 45 hours at a rate of 20, overtimePay returns 950",
              examples: [{ args: [45, 20], expected: 950 }],
            },
          ],
          interface: [
            {
              symbol: "overtimePay",
              file: "src/pay.ts",
              signature: "overtimePay(number, number) → number",
            },
          ],
        },
      ],
      targetSymbols: [{ filePath: "src/pay.ts", symbol: "overtimePay", change: "add" }],
      preconditions: ["hours and rate are not negative"],
      invariants: ["pay for forty hours or fewer is hours times rate"],
      diffSketch,
    });

  async function planned(diffSketch: string) {
    const { g2Project } = await import("./support/g2_project.js");
    const { SCRIPTED_MODEL, scriptEnv } = await import("./support/g2_model.js");
    const p = await g2Project(g2Dirs(), {
      files: {
        "package.json": JSON.stringify({
          name: "app",
          version: "0.1.0",
          devDependencies: { vitest: "3" },
        }),
      },
      cards: [],
      // The project's check fails until the card's file exists, so the staged test is not vacuous.
      gateArgs: ["-e", "require('node:fs').statSync('src/pay.ts')"],
      qualifyAs: [{}, { role: "planner" }],
    });
    const r = await cli(["plan", PAY, "--planner", SCRIPTED_MODEL, "--offline", "--verbose"], {
      cwd: p.repo,
      preload: p.preload,
      env: { ...p.env, ...scriptEnv(p.record, { other: reply(diffSketch) }) },
      timeoutMs: 120_000,
    });
    return {
      p,
      status: r.status,
      out: r.stdout + r.stderr,
      rows: ledgerRows(p.repo),
      SCRIPTED_MODEL,
      scriptEnv,
    };
  }

  it(
    "PM-P1-15, PM-P1-16, PM-P13-2, PM-14: the sketch is persisted without a patch; a slice tracing to no accepted requirement is offered as a proposed change; the approved card enters Ready at the same Small; the Worker's prompt holds the interface",
    { timeout: 300_000 },
    async () => {
      const r = await planned("Add half the rate for each hour beyond forty.");
      expect(r.status, r.out).toBe(0);
      const card = stories(r.rows).find((c) => c.title === "Pay time and a half past forty hours");
      expect(card).toBeDefined();
      const id = card?.id as string;
      const notes = r.rows
        .filter((x) => x.type === "card/note" && x.cardId === id)
        .map((x) => String(x.payload.text));
      // PM-P1-16: difficulty 4 with a planning model: target symbols, preconditions, invariants,
      // a diff outline and the blast radius, in prose.
      const sketch = notes.find((n) => n.startsWith("Edit sketch from the planner")) ?? "";
      expect(sketch).toContain("- add overtimePay in src/pay.ts");
      expect(sketch).toContain("Preconditions: hours and rate are not negative");
      expect(sketch).toContain("Invariants: pay for forty hours or fewer is hours times rate");
      expect(sketch).toContain("Approach: Add half the rate for each hour beyond forty.");
      expect(sketch).toMatch(/Blast radius: .*src\/pay\.ts/);
      expect(sketch).not.toMatch(/^[+-]{3} |^@@|```diff/m);
      // PM-P13-2: the riskiest-assumption slice traces to no accepted requirement: no card, a proposed change.
      expect(r.out).toMatch(/^Rejected: .*traces to no accepted requirement/m);
      expect(r.out).toMatch(
        /Proposed change \(not an issue\): .*traces to no accepted requirement/,
      );
      // PM-P1-15: the symbol, its file and its signature on the card.
      expect(card?.interface).toEqual([
        {
          symbol: "overtimePay",
          file: "src/pay.ts",
          signature: "overtimePay(number, number) → number",
        },
      ]);
      // PM-14: approved, it passes Ready's entry condition for the same Worker and W.
      const approved = await cli(["approve", id], {
        cwd: r.p.repo,
        env: r.p.env,
        timeoutMs: 60_000,
      });
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      const moved = ledgerRows(r.p.repo).filter(
        (x) => x.type === "card/status_changed" && x.cardId === id,
      );
      expect(moved.at(-1)?.payload.toStatus).toBe("ready");
      // PM-P1-15: the Worker's prompt names the interface the staged test imports.
      const queued = await cli(["queue", "--worker", r.SCRIPTED_MODEL], {
        cwd: r.p.repo,
        preload: r.p.preload,
        env: {
          ...r.p.env,
          ...r.scriptEnv(r.p.record, {
            worker: [[{ name: "finish_card", arguments: { summary: "done" } }]],
          }),
        },
        timeoutMs: 180_000,
      });
      // The scripted Agent writes nothing, so the card does not pass; what it was told is the point.
      expect(queued.stdout).toContain(`=== ${id} (attempt 1)`);
      const { recorded } = await import("./support/g2_model.js");
      const worker = recorded(r.p.record).filter((x) => x.role === "worker");
      expect(worker.length).toBeGreaterThan(0);
      const prompt = worker[0]?.body.messages.map((m) => m.content).join("\n") ?? "";
      expect(prompt).toContain("overtimePay(number, number) → number");
      expect(prompt).toContain("src/pay.ts");
    },
  );

  it(
    "PM-P1-16: a sketch whose outline is a literal patch is refused, and no patch is persisted",
    { timeout: 300_000 },
    async () => {
      const r = await planned(
        "```diff\n--- a/src/pay.ts\n+++ b/src/pay.ts\n@@\n-  return hours * rate;\n+  return 0;\n```",
      );
      expect(r.status, r.out).toBe(0);
      const text = r.rows
        .filter((x) => x.type === "card/note")
        .map((x) => String(x.payload.text))
        .join("\n");
      expect(text).not.toContain("+++ b/src/pay.ts");
      expect(text).not.toContain("```diff");
    },
  );
});

describe("INVEST Small at the resolved Worker's window (PM-13)", () => {
  it(
    "PM-13: when the registry's window for the resolved Worker changes, the Small cap is Zone 3's cap at the new W, 0.50 × (W − 2,400), with no fixed default",
    { timeout: 240_000 },
    async () => {
      const where = repoWith(bigFiles());
      const capOf = (out: string) => Number(/Zone 3 content \d+ > (\d+) tokens/.exec(out)?.[1]);
      const first = await plan(where, REFUND);
      expect(first.status, first.out).toBe(0);
      // The shipped Coding model's 16,384-token window: W = 9,984, the cap 3,792.
      expect(capOf(first.out)).toBe(3792);
      // The registry now says the resolved Worker has a 12,288-token window: W = 5,888.
      const registry = join(where.home, ".sekhemet", "models.json");
      const record = (window: number) =>
        execFileSync(
          process.execPath,
          [join(import.meta.dirname, "support", "g3_registry.mjs"), "nail-mtp", String(window)],
          { env: { ...g2Env(where.home), SEKHEMET_MODEL_REGISTRY: registry }, encoding: "utf8" },
        );
      record(12_288);
      const smaller = await plan(where, REFUND);
      expect(smaller.status, smaller.out).toBe(0);
      expect(capOf(smaller.out)).toBe(Math.floor(0.5 * (12_288 - 6_400 - 2_400)));
      // And a 32,768-token window: W = 26,368, so the same story's Zone 3 now fits.
      record(32_768);
      const larger = await plan(where, REFUND);
      expect(larger.status, larger.out).toBe(0);
      expect(larger.out).not.toMatch(/Zone 3 content \d+ > \d+ tokens/);
      expect(larger.out).toMatch(/steps 4\d > 40/);
    },
  );
});

describe("a Planning model's reply that cannot be used (PM-P1-4)", () => {
  it(
    "PM-P1-4: malformed JSON, then an empty slice list: each refused, asked once more, then the heuristic plans, and the refusals are said",
    { timeout: 240_000 },
    async () => {
      const { g2Project } = await import("./support/g2_project.js");
      const { SCRIPTED_MODEL, scriptEnv, recorded } = await import("./support/g2_model.js");
      const p = await g2Project(g2Dirs(), {
        files: { "package.json": JSON.stringify({ name: "app", version: "0.1.0" }) },
        cards: [],
        qualifyAs: [{}, { role: "planner" }],
      });
      const r = await cli(["plan", LOGIN, "--planner", SCRIPTED_MODEL, "--offline", "--verbose"], {
        cwd: p.repo,
        preload: p.preload,
        env: {
          ...p.env,
          ...scriptEnv(p.record, { other: ["this is not JSON", '{"slices": []}'] }),
        },
        timeoutMs: 120_000,
      });
      const out = r.stdout + r.stderr;
      expect(r.status, out).toBe(0);
      expect(out).toContain("The Planning model's reply was refused: malformed JSON");
      expect(out).toContain("The Planning model's reply was refused: an empty slice list");
      const rows = ledgerRows(p.repo);
      const created = rows.find((x) => x.type === "plan/created")?.payload as { source: string };
      expect(created.source).toBe("heuristic");
      expect(stories(rows).length).toBeGreaterThan(0);
      // Asked twice for slices: the first reply and the one retry.
      const asked = recorded(p.record).filter((x) =>
        x.body.messages.some((m) => /"slices"/.test(m.content)),
      );
      expect(asked).toHaveLength(2);
    },
  );
});
