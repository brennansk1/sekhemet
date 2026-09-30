import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { REVIEW_DESK_COPY } from "@sekhemet/ui";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as grid from "../../../scripts/capstone/grid.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as runner from "../../../scripts/capstone/runner.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as score from "../../../scripts/capstone/score.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as arm from "../../../scripts/capstone/sekhemet_arm.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import { buildCards, startFakeModel } from "../../../scripts/milestones/stand_in.mjs";
import { recordNotReviewed } from "../src/review_flow.js";
import { startDashboardServer } from "../src/server.js";

/**
 * The capstone's Sekhemet arm, driven end to end (W2b G2; CAPSTONE_SELECTION
 * "Protocol", the Sekhemet arm): the person-simulator gives Seshat
 * `prompt.md`, answers its questions from the frozen FAQ, approves the plan
 * and its criteria, runs the queue, accepts or sends back by
 * `acceptDecision`, accepts and tags release 1, gives `change_request.md` at
 * the fixed point and finishes. A real dashboard server on the run's own seed
 * repository, real git and SQLite, the product's command line for the
 * release tag; the Worker loop builds each issue against the milestone
 * runners' stand-in model server. No model is loaded.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(ROOT, "fixtures", "capstone", "timesheet");
const manifest = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const script = JSON.parse(readFileSync(join(FIXTURE, "stakeholder_script.json"), "utf8"));
const CLI = join(ROOT, "apps", "harness", "dist", "index.js");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** One cheap check standing in for the project's npm checks, which need an installed toolchain. */
const GATES = `[project]
max_files = 3
max_diff_lines = 200

[[gate]]
id = "unit"
rung = "test"
layer = "functional"
command = "node"
args = ["-e", "process.exit(0)"]
timeout_s = 30
parser = "generic"
`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Env = NodeJS.ProcessEnv & { SEKHEMET_CAPSTONE_RUNS: string };

/** A runs root, and a hidden suite and Web-Bench checkout unreadable to this user. */
function sealedEnv(): Env {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "capstone-arm-")));
  const hidden = join(base, "capstone-hidden");
  const webbench = join(base, "webbench-src");
  mkdirSync(hidden);
  mkdirSync(webbench);
  mkdirSync(join(base, "tmp"));
  chmodSync(hidden, 0o000);
  chmodSync(webbench, 0o000);
  cleanups.push(() => {
    chmodSync(hidden, 0o700);
    chmodSync(webbench, 0o700);
    rmSync(base, { recursive: true, force: true });
  });
  return {
    ...process.env,
    SEKHEMET_CAPSTONE_RUNS: join(base, "runs"),
    SEKHEMET_CAPSTONE_HIDDEN: hidden,
    SEKHEMET_WEBBENCH_SRC: webbench,
    TMPDIR: join(base, "tmp"),
  };
}

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
type Call = { name: string; arguments: Record<string, unknown> };
type SeshatTurn = { text: string; toolCalls?: Call[] };

/**
 * A run's repository with the dashboard started on it, as `sekhemet serve`
 * starts it, Seshat answering from `turns` in order (then "Noted.").
 */
async function served(e: Env, turns: SeshatTurn[]) {
  const paths = runner.prepareRun("sekhemet-local", 1, { env: e });
  const repo = realpathSync(paths.repo);
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "gates.toml"), GATES);
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cards = new CardStore(db, log);
  const asked: InferenceRequest[] = [];
  const adapter: LocalInferenceAdapter = {
    modelId: "stand-in",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
    generate: async (req) => {
      // The Planning model's own requests (the plan's draft) get nothing: the planner's rules plan it.
      if (req.role !== "seshat") return { text: "", toolCalls: [], usage };
      asked.push(req);
      const turn = turns[asked.length - 1] ?? { text: "Noted." };
      return {
        text: turn.text,
        toolCalls: (turn.toolCalls ?? []).map((c, i) => ({ id: `t${i}`, ...c })),
        usage,
      };
    },
  };
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cards),
    cardStore: cards,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 50,
    pressureLevel: () => 1,
    pmAdapter: () => adapter,
  });
  cleanups.push(async () => {
    await server.close();
    db.close();
  });
  return { paths, repo, cards, asked, url: `http://127.0.0.1:${server.port}` };
}

/**
 * The queue a person runs, as the milestone runners build a card: every
 * Ready issue once through the product's `executeCard` against the stand-in
 * model. The queue's AI review step records, as the product does with the
 * Review role unfilled, that no review ran; `reviewer` may give a Review
 * model's verdict instead.
 */
function standInQueue(
  repo: string,
  cards: CardStore,
  reviewer?: (cardId: string) => { verdict: "met" | "unmet"; text: string } | undefined,
) {
  const plan: Record<string, { path: string; content: string; usage: [number, number] }> = {};
  const passes: string[][] = [];
  const run = async () => {
    const ready = (await cards.listCards({ status: "ready" })).filter((c) => c.tier !== "epic");
    passes.push(ready.map((c) => c.id));
    ready.forEach((c, i) => {
      const n = Object.keys(plan).length + i;
      plan[c.id] ??= {
        path: c.scopeFiles?.[0] ?? `src/part${n}.ts`,
        content: `export const part${n} = ${n};\n`,
        usage: [900, 120],
      };
    });
    const fake = await startFakeModel(plan);
    try {
      const built = await buildCards({
        repo,
        modelUrl: fake.url,
        cards: ready.map((c) => ({ id: c.id })),
        reviewFirst: async (id: string) => {
          const verdict = reviewer?.(id);
          if (verdict)
            await cards.recordDossierEntry({
              cardId: id,
              kind: "review",
              actor: "reviewer",
              ...verdict,
            });
          else await recordNotReviewed({ cardStore: cards }, id, REVIEW_DESK_COPY.noReviewer);
          return undefined;
        },
      });
      return { command: ["stand-in queue"], exit: 0, signal: null, timedOut: false, built };
    } finally {
      await fake.close();
    }
  };
  return { run, passes, plan };
}

const git = (repo: string, ...a: string[]) =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

type Ev = { kind: string; [k: string]: unknown };
const decisions = (log: Ev[], what: string) =>
  log.filter((e) => e.kind === "person" && e.what === what) as (Ev & {
    decision: string;
    why: string;
    basis: Record<string, unknown>;
  })[];

const START = {
  name: "start_project",
  arguments: {
    brief: "A timesheet app for Hollis Bakery with federal overtime and a payroll CSV",
    reason: "the brief and the answers say what to build",
  },
};
const CALIFORNIA = {
  name: "propose_create_card",
  arguments: {
    title: "California daily overtime for the Sacramento shop",
    spec: "Pay daily overtime past 8 hours and double time past 12 for California people.",
    scope_files: ["src/california.ts"],
    acceptance_criteria: [
      "Given a California person who works 13 hours on one day, when the week's pay is computed, then that day is 8 regular, 4 overtime and 1 double-time hours.",
    ],
    reason: "the change letter asks for California's daily overtime",
  },
};

describe("the Sekhemet arm, driven end to end against a stand-in model", () => {
  it("gives prompt.md, answers from the FAQ, approves the plan, builds, sends back and accepts, tags release 1, gives the change and finishes", async () => {
    const e = sealedEnv();
    const s = await served(e, [
      { text: "Thanks, I read it all. Which day does your work week start on?" },
      { text: "Here is the plan.", toolCalls: [START] },
      { text: "I have one change for the Sacramento shop.", toolCalls: [CALIFORNIA] },
    ]);
    // The Review model's first verdict on the first issue it sees is a failure; later ones pass.
    let reviewed = 0;
    const queue = standInQueue(s.repo, s.cards, () =>
      reviewed++ === 0
        ? { verdict: "unmet", text: "The week total is not shown on the manager's grid." }
        : { verdict: "met", text: "Every criterion is shown by a passing check." },
    );
    // Short budgets: the stand-in plans issues whose criteria the product's
    // lint holds in Planning, which no person's act can release, so release 1
    // ends when its budget does. The protocol's budgets are the record's.
    const budget = {
      ...runner.AGENTIC,
      budgetMinutes: { "release-1": 0.3, "change-request": 0.3 },
    };
    const began = Date.now();
    const r = await arm.driveSekhemet({
      run: 1,
      url: s.url,
      env: e,
      pollMs: 25,
      stallPollMs: 200,
      runQueue: queue.run,
      cliEnv: process.env,
      budget,
    });
    expect(r).toMatchObject({ ok: true });
    const log = grid.readLog(grid.runPaths("sekhemet-local", 1, e)) as Ev[];

    // The frozen input, hash-checked and held whole by the product.
    const given = log.find((l) => l.kind === "given");
    expect(given).toMatchObject({
      phase: "release-1",
      frozen: "prompt.md",
      frozenSha256: manifest.files["prompt.md"].sha256,
    });
    const received = log.find((l) => l.kind === "received");
    expect(received?.match).toBeTruthy();
    // Committed as a project document, the frozen bytes whole (PM-N10-2).
    expect(received?.document).toMatchObject({
      path: expect.stringMatching(/^docs\/product\/inputs\//),
      sha256: manifest.files["prompt.md"].sha256,
      whole: true,
    });
    expect(s.asked[0]?.prompt).toContain(
      readFileSync(join(FIXTURE, "prompt.md"), "utf8").trim().slice(-500),
    );

    // Seshat's question answered only with the FAQ's words.
    const answers = decisions(log, "answer Seshat");
    expect(answers.length).toBe(1);
    const faq = new Set([
      script.defaultAnswer,
      ...script.phases.flatMap((p: { topics: { answer: string }[] }) =>
        p.topics.map((t) => t.answer),
      ),
    ]);
    const thread = (await (await fetch(`${s.url}/api/pm/thread`)).json()) as {
      messages: { role: string; text: string }[];
    };
    const answered = thread.messages.filter((m) => m.role === "user")[1]?.text ?? "";
    for (const part of answered.split("\n\n")) expect(faq.has(part), part).toBe(true);

    // The plan approved as sent, then its criteria as shown.
    const plans = decisions(log, "approve the plan");
    expect(plans[0]).toMatchObject({
      decision: "approve",
      basis: { kind: "start_project", applied: true },
    });
    expect(decisions(log, "approve the plan's criteria").length).toBeGreaterThan(0);

    // Sent back on the AI review's failure, with its words; accepted once all passed.
    const back = decisions(log, "send back");
    expect(back[0]?.why).toBe("the AI review did not pass");
    expect(back[0]?.basis.reason).toContain("The week total is not shown on the manager's grid.");
    expect(back[0]?.basis.status).toBe(200);
    const accepted = decisions(log, "accept");
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    for (const a of accepted) {
      expect(a.why).toBe("all checks passed and the AI review passed");
      expect(a.basis.status).toBe(200);
    }
    // The issue sent back was built again, and accepted.
    expect(accepted[0]?.basis.issue).toBe(back[0]?.basis.issue);
    expect(queue.passes.filter((p) => p.includes(back[0]?.basis.issue as string)).length).toBe(2);

    // When nothing is Ready she pulls the next issue with the product's own
    // `/ready`, typed in Seshat's composer, and the queue builds it.
    const pulls = decisions(log, "move to Ready");
    expect(pulls.length).toBeGreaterThan(0);
    const sent = thread.messages.filter((m) => m.role === "user").map((m) => m.text);
    for (const p of pulls) {
      expect(p.basis.via).toBe(`/ready ${p.basis.issue}`);
      expect(sent).toContain(`/ready ${p.basis.issue}`);
    }
    const moved = pulls.filter((p) => p.basis.moved === true);
    expect(moved.length).toBeGreaterThan(0);
    for (const p of moved) {
      expect(p.basis.reply).toBe(`Moved ${p.basis.issue} to Ready.`);
      expect(queue.passes.some((pass) => pass.includes(p.basis.issue as string))).toBe(true);
    }

    // What the person cannot move is left where the product holds it, with its reason.
    const stalled = log.find((l) => l.kind === "no_ready_issue" && l.phase === "release-1") as
      | (Ev & { waiting: { id: string; status: string; why: string | null }[] })
      | undefined;
    expect(stalled?.waiting.length).toBeGreaterThan(0);
    expect(stalled?.waiting.some((w) => w.status === "planning" && w.why)).toBe(true);

    // Release 1 at the fixed point, never at a stall: the board waited on
    // until release 1's budget ended. She accepts it on the product (which
    // may refuse), then the tag.
    const finished = log.find((l) => l.kind === "release_1_finished") as Ev & {
      releaseOneTag: string;
      reason: string;
      at: string;
    };
    expect(finished).toBeTruthy();
    expect(finished.reason).toBe("the phase's time budget was spent while nothing could be moved");
    expect(Date.parse(finished.at) - began).toBeGreaterThanOrEqual(0.3 * 60_000);
    const release = decisions(log, "accept release 1");
    expect(release.length).toBe(1);
    expect(typeof release[0]?.basis.status).toBe("number");
    const change = log.findIndex((l) => l.kind === "change_given");
    expect(change).toBeGreaterThan(log.indexOf(finished));
    expect(log[change]).toMatchObject({
      given: "change_request.md",
      frozenSha256: manifest.files["change_request.md"].sha256,
    });
    const releaseOne = git(s.repo, "rev-parse", "release-1^{commit}");
    expect(releaseOne).toBe(finished.releaseOneTag);
    // release-1 holds what was accepted: the accepted issue's file is on the tag.
    const acceptedFile = queue.plan[accepted[0]?.basis.issue as string]?.path as string;
    expect(git(s.repo, "ls-tree", "-r", "--name-only", "release-1").split("\n")).toContain(
      acceptedFile,
    );

    // The change phase: Seshat's proposal applied, its criteria approved, the queue run on it.
    const california = plans.find((p) => p.basis.kind === "create_card");
    expect(california?.basis).toMatchObject({ phase: "change-request", applied: true });
    const lateQueue = log.filter((l) => l.kind === "queue" && l.phase === "change-request");
    expect(lateQueue.length).toBeGreaterThan(0);

    // The product's own release command, run as a person runs it: nothing proposed, nothing tagged.
    const tag = arm.cliReleaseTag({ cli: CLI })(s.repo)("SLICE-1");
    expect(tag).toMatchObject({ ok: false, tag: null });
    expect(tag.command).toEqual(["sekhemet", "release", "--confirm", "SLICE-1", "--repo", s.repo]);
    expect(tag.output).toMatch(/No release is proposed for SLICE-1|not proven/);

    // The checkout is what was accepted: its files are the integration branch's.
    expect(git(s.repo, "rev-parse", "HEAD")).toBe(git(s.repo, "rev-parse", "main"));
    expect(git(s.repo, "status", "--porcelain", "--untracked-files=no")).toBe("");

    // Every decision simulated, zero hands-on minutes; every role's tokens
    // from the ledger (measurement rule 4a), so none is left out.
    for (const p of log.filter((l) => l.kind === "person"))
      expect(p).toMatchObject({ simulated: true, minutes: 0 });
    const tokens = log.filter((l) => l.kind === "usage") as (Ev & {
      inputTokens: number;
      byRole: Record<string, { inputTokens: number; requests: number }>;
    })[];
    expect(tokens.map((t) => t.phase)).toEqual(["release-1", "change-request"]);
    expect(tokens[0]?.inputTokens).toBeGreaterThan(0);
    for (const t of tokens) expect(t.notCounted).toBeUndefined();
    // The Coding model's steps and Seshat's answers, each charged to its role.
    expect(tokens[0]?.byRole.worker?.inputTokens).toBeGreaterThan(0);
    expect(tokens[0]?.byRole.seshat?.requests).toBeGreaterThan(0);
    expect(tokens[1]?.byRole.seshat?.requests).toBeGreaterThan(0);
    expect(score.effort(log)).toMatchObject({ tokensNotCounted: null });

    // The budgets recorded, and the run counts.
    const record = JSON.parse(readFileSync(grid.runPaths("sekhemet-local", 1, e).record, "utf8"));
    expect(record.agentic).toMatchObject({
      budgetMinutes: { "release-1": 360, "change-request": 180 },
      maxReplies: 20,
    });
    expect(log.find((l) => l.kind === "start")?.budget).toEqual({
      ...record.agentic,
      budgetMinutes: budget.budgetMinutes,
    });
    expect(score.runValidity(log, "sekhemet-local")).toEqual([]);
    expect(log.at(-1)?.kind).toBe("end");
  }, 240_000);

  it("stops answering Seshat at the reply cap", async () => {
    const e = sealedEnv();
    const s = await served(e, [
      { text: "Which day does your work week start on?" },
      { text: "And who approves a manager's own hours?" },
      { text: "One more: how are minutes rounded?" },
    ]);
    const queue = standInQueue(s.repo, s.cards);
    const r = await arm.driveSekhemet({
      run: 1,
      url: s.url,
      env: e,
      pollMs: 25,
      runQueue: queue.run,
      budget: { ...runner.AGENTIC, maxReplies: 1 },
    });
    expect(r.releaseOne.conversation).toBe("the reply cap was reached");
    const log = grid.readLog(grid.runPaths("sekhemet-local", 1, e)) as Ev[];
    expect(
      decisions(log, "answer Seshat").filter((d) => d.basis.phase === "release-1").length,
    ).toBe(1);
    // No plan was proposed, so nothing was built; the run still reaches the change and its end.
    expect(queue.passes.length).toBe(0);
    expect(log.some((l) => l.kind === "change_given")).toBe(true);
  }, 120_000);
});

describe("the Sekhemet arm's person at a terminal", () => {
  function stubCli(dir: string, body: string): string {
    const file = join(dir, "sekhemet-stub.mjs");
    writeFileSync(file, body);
    return file;
  }

  it("runs `sekhemet queue --repo <repo>`, its output kept", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "capstone-cli-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const cli = stubCli(
      dir,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\nconsole.log("No Ready issues.");\n`,
    );
    const q = await arm.cliQueue({ cli })({
      repo: dir,
      deadline: Date.now() + 60_000,
      logFile: join(dir, "queue.log"),
    });
    expect(JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"))).toEqual([
      "queue",
      "--repo",
      dir,
    ]);
    expect(q).toMatchObject({
      exit: 0,
      timedOut: false,
      command: ["sekhemet", "queue", "--repo", dir],
    });
    expect(readFileSync(join(dir, "queue.log"), "utf8")).toContain("No Ready issues.");
  });

  it("gives the queue Ctrl+C when the phase's budget is spent", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "capstone-cli-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const cli = stubCli(
      dir,
      `process.on("SIGINT", () => { console.log("Stopping after the current turn"); process.exit(130); });\nsetInterval(() => {}, 1000);\n`,
    );
    const began = Date.now();
    const q = await arm.cliQueue({ cli, grace: { second: 5_000, kill: 5_000 } })({
      repo: dir,
      deadline: Date.now() + 300,
      logFile: join(dir, "queue.log"),
    });
    expect(q).toMatchObject({ timedOut: true, exit: 130 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(readFileSync(join(dir, "queue.log"), "utf8")).toContain(
      "Stopping after the current turn",
    );
  });

  it("treats a stall as waiting: nothing she can move ends release 1 only when its budget does", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "capstone-stall-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const paths = { log: join(dir, "log.jsonl"), input: dir };
    const refusal = "The command failed: ISSUE-2 waits on ISSUE-9, which is not done";
    const messages: { id: string; seq: number; role: string; text: string; state?: string }[] = [];
    const board = [
      { id: "ISSUE-1", status: "done" },
      { id: "ISSUE-2", status: "backlog" },
    ];
    const d = {
      get: async (path: string) => {
        if (path === "/api/board") return { status: 200, json: { cards: board } };
        if (path === "/api/pm/thread") return { status: 200, json: { messages } };
        return { status: 404, json: { error: "No accepted brief for that project" } };
      },
      post: async (path: string, body: { text?: string }) => {
        if (path !== "/api/pm/messages") return { status: 404, json: null, text: "" };
        const mine = { id: `m${messages.length}`, seq: messages.length + 1, role: "user" };
        messages.push({ ...mine, text: body.text ?? "" });
        messages.push({
          id: `m${messages.length}`,
          seq: messages.length + 1,
          role: "pm",
          text: refusal,
          state: "done",
        });
        return { status: 200, json: { message: mine } };
      },
    };
    let queued = 0;
    const ctx = {
      paths,
      d,
      pollMs: 5,
      stallPollMs: 20,
      approved: new Set(),
      decided: new Set(),
      runQueue: async () => {
        queued += 1;
        return { exit: 0, timedOut: false };
      },
    };
    const began = Date.now();
    const why = await arm.work(ctx, "release-1", Date.now() + 400);
    expect(Date.now() - began).toBeGreaterThanOrEqual(390);
    expect(why).toBe("the phase's time budget was spent while nothing could be moved");
    expect(queued).toBe(0);
    const log = grid.readLog(paths) as Ev[];
    // She tried the product's own move once for that board, and logged its answer.
    const pulls = decisions(log, "move to Ready");
    expect(pulls.length).toBe(1);
    expect(pulls[0]?.basis).toMatchObject({
      issue: "ISSUE-2",
      via: "/ready ISSUE-2",
      moved: false,
      reply: refusal,
    });
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
      "/ready ISSUE-2",
    ]);
    const stalled = log.filter((l) => l.kind === "no_ready_issue");
    expect(stalled.length).toBe(1);
    expect(stalled[0]).toMatchObject({ phase: "release-1", waiting: [{ id: "ISSUE-2" }] });
  });

  it("waits for Seshat to be idle, and says when it is not by the deadline", async () => {
    const phases = ["thinking", "thinking", "idle"];
    const d = {
      get: async () => ({ status: 200, json: { status: { phase: phases.shift() ?? "idle" } } }),
    };
    expect(await arm.awaitIdle({ d, pollMs: 5 }, Date.now() + 5_000)).toBe(true);
    expect(phases).toEqual([]);
    const busy = { get: async () => ({ status: 200, json: { status: { phase: "thinking" } } }) };
    const began = Date.now();
    expect(await arm.awaitIdle({ d: busy, pollMs: 5 }, Date.now() + 100)).toBe(false);
    expect(Date.now() - began).toBeGreaterThanOrEqual(95);
  });

  it("reads the checks from the evidence and the AI review from the dossier", () => {
    expect(
      arm.checksOf({
        rungResults: [
          { gate: "unit", passed: true },
          { gate: "osv", passed: false, skipped: true },
          { gate: "lint", passed: false },
        ],
      }),
    ).toEqual([
      { id: "unit", passed: true },
      { id: "lint", passed: false },
    ]);
    const none = REVIEW_DESK_COPY.noReviewer;
    expect(arm.aiReview([{ verdict: "not_reviewed", text: none }], none)).toMatchObject({
      review: null,
      reviewerConfigured: false,
    });
    expect(
      arm.aiReview([{ verdict: "not_reviewed", text: "The review failed: timeout" }], none),
    ).toMatchObject({ review: null, reviewerConfigured: true });
    expect(arm.aiReview([], none)).toMatchObject({ review: null, reviewerConfigured: true });
    expect(
      arm.aiReview(
        [
          { verdict: "met", text: "a" },
          { verdict: "coverage", text: "2 of 2 files read" },
        ],
        none,
      ),
    ).toMatchObject({ review: { passed: true } });
    const failed = arm.aiReview(
      [
        { verdict: "met", text: "a" },
        { verdict: "unclear", text: "no check shows the CSV header" },
      ],
      none,
    );
    expect(failed).toMatchObject({ review: { passed: false } });
    expect(failed.failed).toEqual(["unclear: no check shows the CSV header"]);
  });

  it("brings the checkout up to the integration branch, as the product's notice says", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "capstone-checkout-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const g = (...a: string[]) => git(dir, ...a);
    g("init", "-q", "-b", "main");
    g("config", "user.name", "Jane Doe");
    g("config", "user.email", "jane@example.com");
    writeFileSync(join(dir, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-q", "-m", "one");
    const first = g("rev-parse", "HEAD");
    // The branch moves by plumbing, as Accept moves it: the files stay behind.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: "two\n",
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["mktree"], {
      cwd: dir,
      input: `100644 blob ${blob}\ta.txt\n`,
      encoding: "utf8",
    }).trim();
    const moved = g("commit-tree", tree, "-p", first, "-m", "two");
    g("update-ref", "refs/heads/main", moved);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
    const paths = { log: join(dir, "..", `${sha(dir).slice(0, 8)}.jsonl`) };
    cleanups.push(() => rmSync(paths.log, { force: true }));
    const ctx = { repo: dir, branch: "main", synced: first, paths };
    const ev = arm.catchUp(ctx, "a test");
    expect(ev).toMatchObject({ ok: true, from: first, to: moved });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two\n");
    expect(g("status", "--porcelain")).toBe("");
    expect(arm.catchUp(ctx, "again")).toBeNull();
  });
});

describe("the Sekhemet arm's tokens, from the product's ledger", () => {
  it("counts every role since a point: card steps as the Coding model's, model/usage by role", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "arm-tokens-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".sekhemet"));
    const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const step = (i: number, o: number, cached?: number) =>
      log.appendNow({
        actor: "worker",
        type: "card/step",
        payload: {
          id: "c1",
          turn: 0,
          calls: [],
          usage: {
            promptTokens: i,
            completionTokens: o,
            durationMs: 1,
            ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
          },
        },
      });
    const use = (role: string, i: number, o: number, cached?: number) =>
      log.appendNow({
        actor: "harness",
        type: "model/usage",
        payload: {
          role,
          purpose: "answer",
          model: "m",
          promptTokens: i,
          ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
          completionTokens: o,
          thinkingTokens: 0,
          answerTokens: o,
          durationMs: 1,
        },
      });
    step(5, 5);
    use("seshat", 5, 5);
    const since = arm.ledgerSeq(dir);
    step(900, 120, 600);
    step(100, 30);
    use("seshat", 2000, 300, 1500);
    use("planner", 700, 90);
    use("reviewer", 400, 20);
    db.close();
    expect(arm.ledgerTokens(dir, since)).toEqual({
      inputTokens: 4100,
      outputTokens: 560,
      cacheReadTokens: 2100,
      byRole: {
        worker: { inputTokens: 1000, outputTokens: 150, cacheReadTokens: 600, requests: 2 },
        seshat: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 1500, requests: 1 },
        planner: { inputTokens: 700, outputTokens: 90, cacheReadTokens: 0, requests: 1 },
        reviewer: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 0, requests: 1 },
      },
    });
    // No ledger yet: nothing counted.
    expect(arm.ledgerTokens(join(dir, "none"), 0)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      byRole: {},
    });
  });
});
