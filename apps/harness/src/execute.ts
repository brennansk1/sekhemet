import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BoardServiceImpl } from "@sekhemet/board";
import { PlaybookRegistry, SkillsRegistry } from "@sekhemet/context";
import { DeterministicGateRunner, loadGatesConfig } from "@sekhemet/gates";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import { type CardRunResult, CardRunner, type TurnResult } from "@sekhemet/loop";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { readSettings } from "./integrations.js";

export interface ExecutionContext {
  repoPath: string;
  restrictedMode: boolean;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
  log?: (line: string) => void;
  /**
   * Awaited after every Worker turn, between steps. The queue uses it to
   * answer PM messages: it is the one point where the Worker can be unloaded
   * without losing work, because the next step starts from the worktree.
   */
  afterTurn?: (cardId: string, turn: TurnResult) => Promise<void>;
}

/** What a tool call acted on, in a few characters: a path, a command, a note. */
function callTarget(args: Record<string, unknown> | undefined): string | undefined {
  const a = args ?? {};
  const pick = a.path ?? a.file ?? a.command ?? a.cmd ?? a.message ?? a.query;
  if (pick === undefined || pick === null) return undefined;
  const text = typeof pick === "string" ? pick : JSON.stringify(pick);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * The `card/step` ledger payload for one turn (FRONTEND_DESIGN §2.6): enough
 * for the dashboard to say "Step 5 of 32 · editing src/hasher.ts" live and to
 * render the Steps tab before the transcript is written at the end.
 */
export function stepEventPayload(cardId: string, turn: TurnResult) {
  return {
    id: cardId,
    turn: turn.turnIndex,
    calls: turn.toolCalls.map((c, i) => {
      const target = callTarget(c.arguments as Record<string, unknown> | undefined);
      const obs = turn.observations[i];
      return {
        name: c.name,
        ...(target !== undefined ? { target } : {}),
        ...(obs ? { ok: obs.ok, summary: String(obs.summary ?? "").slice(0, 200) } : {}),
      };
    }),
    ...(turn.gateResult
      ? {
          gate: {
            passed: turn.gateResult.passed,
            failed: [...new Set(turn.gateResult.failures.map((f) => String(f.gate ?? f.rung)))],
            errors: turn.gateResult.failures.length,
          },
        }
      : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
  };
}

/**
 * Run one card end to end on a caller-supplied model.
 *
 * The model is a parameter rather than created here so a queue of cards can
 * share one resident checkpoint. Reloading per card costs ~258s on the
 * reference machine, which across six cards alone exceeds the 18-minute
 * Chronicle budget.
 */
export async function executeCard(
  ctx: ExecutionContext,
  card: CardRecord,
  model: LocalInferenceAdapter,
  managerGuidance?: string,
): Promise<CardRunResult> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  // The Planner's repair plan is what attempt 2 runs on; keep it in the ledger
  // so the card's Plan tab can show what the Worker was told.
  if (managerGuidance) {
    try {
      await ctx.cardStore.recordEvent({
        type: "card/repair_plan",
        cardId: card.id,
        actor: "planner",
        payload: { id: card.id, plan: managerGuidance },
      });
    } catch {
      // A ledger hiccup must not cost the retry.
    }
  }
  const gitAdapter = new NodeGitSyncAdapter(ctx.repoPath);
  const gatesConfig = loadGatesConfig(ctx.repoPath);
  // Restricted mode refuses to execute where the OS cannot confine the
  // subprocess, rather than quietly running the agent unsandboxed.
  const sandbox = new ProcessSandbox({ requireConfinement: ctx.restrictedMode });
  const gateRunner = new DeterministicGateRunner(sandbox, {
    repoRoot: ctx.repoPath,
    expectedConfigSha256: gatesConfig.sha256,
  });
  const skills = new SkillsRegistry();
  skills.loadFromDirectory(join(ctx.repoPath, ".sekhemet", "skills"));
  const playbook = new PlaybookRegistry(ctx.repoPath);

  const runner = new CardRunner({
    card,
    repoRoot: ctx.repoPath,
    worktreePath: join(ctx.repoPath, ".sekhemet", "worktrees", card.id),
    stepBudget: card.stepBudget,
    modelAdapter: model,
    gateRunner,
    syncAdapter: gitAdapter,
    scopeFiles: card.scopeFiles,
    agentRole: "implementer",
    agentHarness: "sekhemet",
    // Stop before the host does: a paused card resumes, an OOM takes the machine.
    memoryGuard: {},
    // A retry after a manager review re-attaches to the existing worktree, so
    // the worker resumes from its own last state rather than from scratch.
    useExistingWorktree: existsSync(join(ctx.repoPath, ".sekhemet", "worktrees", card.id)),
    ...(managerGuidance ? { managerGuidance } : {}),
    skillsRegistry: skills,
    playbookRegistry: playbook,
    lifecycle: {
      // Persist the real step count, or the board reports 0/32 for a card that
      // exhausted its budget.
      recordSteps: async (id, stepsUsed) => {
        await ctx.cardStore.updateCard(id, { stepsUsed });
      },
      transition: async (id, to) => {
        const current = await ctx.cardStore.getCard(id);
        if (!current || current.status === to) return;
        await ctx.boardService.transitionCard({
          cardId: id,
          fromStatus: current.status,
          toStatus: to,
          actor: "executor",
          reason: `card runner advanced card to ${to}`,
        });
      },
    },
    onWorktreeReady: async (worktreePath) => {
      // Stage this card's acceptance tests: the oracle for THIS card is present
      // and failing before work begins, and later cards' suites are not there
      // to fail it.
      const staged = card.acceptanceTests ?? [];
      if (staged.length === 0) return;
      const testsDir = join(worktreePath, "tests");
      if (!existsSync(testsDir)) mkdirSync(testsDir, { recursive: true });
      for (const name of staged) {
        const from = join(ctx.repoPath, "acceptance", name);
        if (existsSync(from)) {
          copyFileSync(from, join(testsDir, name));
          log(`   staged acceptance test: tests/${name}`);
        }
      }
    },
    // One ledger event per turn, so the board and the Steps tab follow a
    // running card live instead of waiting for the transcript at the end.
    onTurn: async (cardId, turn) => {
      await ctx.cardStore.recordEvent({
        type: "card/step",
        cardId,
        actor: "executor",
        payload: stepEventPayload(cardId, turn),
      });
      await ctx.afterTurn?.(cardId, turn);
    },
    onProgress: (event) => {
      const prefix = event.turn ? `  [turn ${event.turn}]` : "  ";
      log(`${prefix} ${event.type}: ${event.message}`);
    },
  });

  return runner.run();
}

/**
 * Squash a reviewed card onto main and mark it done.
 *
 * Only a card in Review can be accepted: the harness verifies, a person accepts.
 */
export async function acceptCard(
  ctx: ExecutionContext,
  card: CardRecord,
  actor = "human",
): Promise<string> {
  if (card.status !== "review") {
    throw new Error(
      `Card ${card.id} is in '${card.status}'. Only a card in Review can be accepted.`,
    );
  }

  const gitAdapter = new NodeGitSyncAdapter(ctx.repoPath);

  // With "GitHub PR on accept" on, a person's Accept opens a pull request
  // instead of merging locally, so the team's normal review and CI apply.
  // The queue's --auto-accept (actor "harness") always merges locally: the
  // benchmark needs later cards to build on earlier ones.
  if (actor !== "harness" && readSettings(ctx.repoPath).githubPrOnAccept) {
    const url = await openPullRequest(ctx, card, gitAdapter.branchNameFor(card.id, card.title));
    await ctx.boardService.transitionCard({
      cardId: card.id,
      fromStatus: card.status,
      toStatus: "done",
      actor,
      reason: `accepted: pull request ${url}`,
    });
    await ctx.cardStore
      .recordEvent({
        type: "card/accepted",
        cardId: card.id,
        actor,
        payload: { id: card.id, pr: url },
      })
      .catch(() => undefined);
    await gitAdapter.removeWorktree(card.id);
    return url;
  }

  const sha = await gitAdapter.squashAndMerge(
    card.id,
    "main",
    `feat(${card.id}): ${card.title}`,
    {
      "Agent-Model": card.modelRoute?.executor ?? "local",
      "Agent-Harness": "sekhemet",
      "Agent-Role": "implementer",
      GateStatus: "pass",
    },
    card.title,
  );

  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: card.status,
    toStatus: "done",
    actor,
    reason: "accepted by operator",
  });
  // The merge commit, on the ledger: Done tiles and the card's Thread show it.
  try {
    await ctx.cardStore.recordEvent({
      type: "card/accepted",
      cardId: card.id,
      actor,
      payload: { id: card.id, sha },
    });
  } catch {
    // The merge already happened; a missing ledger line must not undo it.
  }
  await gitAdapter.removeWorktree(card.id);
  return sha;
}

export interface QueueEntry {
  cardId: string;
  /** 1 for the worker's first attempt, 2 for the retry after a manager plan. */
  attempt: number;
  passed: boolean;
  accepted: boolean;
  stopReason: string;
  turns: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface QueueReport {
  startedAt: string;
  model: string;
  entries: QueueEntry[];
  passAt1: number;
  /** Cards passing after at most one manager-guided retry. */
  passAfterEscalation: number;
  managerModel?: string;
  modelSwaps: number;
  totalDurationMs: number;
}

/** Persist a queue scorecard where the dashboard and a human can both find it. */
export function writeQueueReport(repoPath: string, report: QueueReport): string {
  const dir = join(repoPath, ".sekhemet");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "queue_report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // Keep every run, not just the latest: the Runs view compares them.
  try {
    const runs = join(dir, "runs");
    mkdirSync(runs, { recursive: true });
    const stamp = report.startedAt.replace(/[:.]/g, "-");
    writeFileSync(join(runs, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    // History is a convenience; the latest report above is the record.
  }
  return path;
}

/**
 * Collect the evidence a manager needs to diagnose a failed card: its
 * acceptance tests and the scope files exactly as the worker left them.
 */
export function collectCardFiles(
  worktreePath: string,
  card: CardRecord,
): { path: string; content: string }[] {
  const paths = [...(card.acceptanceTests ?? []).map((t) => `tests/${t}`), ...card.scopeFiles];
  return paths.map((path) => {
    const abs = join(worktreePath, path);
    return { path, content: existsSync(abs) ? readFileSync(abs, "utf8").slice(0, 8000) : "" };
  });
}

/**
 * Infer which cards each card builds on.
 *
 * A card depends on another when its spec or criteria name that card's scope
 * file ("use openDatabase from src/db.ts"), and every card depends on a
 * contract card that owns a shared types file. Explicit `dependsOn` is honoured
 * too. Running a card before its prerequisite has merged only spends its
 * budget against an empty file — a live run lost two cards that way.
 */
export function inferDependencies(cards: CardRecord[]): Map<string, string[]> {
  const owner = new Map<string, string>();
  for (const card of cards) for (const file of card.scopeFiles) owner.set(file, card.id);

  const contractCards = cards.filter((c) => c.scopeFiles.some((f) => /(^|\/)types\.ts$/.test(f)));

  const deps = new Map<string, string[]>();
  for (const card of cards) {
    const text = `${card.spec ?? ""}\n${(card.acceptanceCriteria ?? []).join("\n")}`;
    const found = new Set<string>(card.dependsOn ?? []);
    for (const [file, id] of owner) {
      if (id !== card.id && text.includes(file)) found.add(id);
    }
    for (const contract of contractCards) {
      if (contract.id !== card.id) found.add(contract.id);
    }
    deps.set(card.id, [...found]);
  }
  return deps;
}

/**
 * Push the card's branch and open a pull request whose body is the evidence.
 * Uses the user's own git remote and `gh` login; Sekhemet holds no token.
 */
async function openPullRequest(
  ctx: ExecutionContext,
  card: CardRecord,
  branch: string,
): Promise<string> {
  const run = promisify(execFile);
  await run("git", ["push", "-u", "origin", `${branch}:${branch}`], {
    cwd: ctx.repoPath,
    timeout: 120_000,
  });
  const title = card.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "");
  let gates = "";
  try {
    const ev = JSON.parse(
      readFileSync(join(ctx.repoPath, ".sekhemet", "evidence", `latest-${card.id}.json`), "utf8"),
    ) as { rungResults?: { gate: string; passed: boolean; durationMs?: number }[] };
    gates = (ev.rungResults ?? [])
      .map(
        (r) => `- ${r.passed ? "✓" : "✗"} ${r.gate}${r.durationMs ? ` (${r.durationMs} ms)` : ""}`,
      )
      .join("\n");
  } catch {
    // No evidence file: the body says so rather than inventing results.
  }
  const body = [
    card.spec ?? "",
    card.acceptanceCriteria?.length
      ? `### Done when\n${card.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    `### Gates\n${gates || "_No evidence file was found for this card._"}`,
    `_Implemented by the Sekhemet Worker and accepted in the dashboard. Card \`${card.id}\`._`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { stdout } = await run(
    "gh",
    ["pr", "create", "--head", branch, "--base", "main", "--title", title, "--body", body],
    { cwd: ctx.repoPath, timeout: 60_000 },
  );
  return stdout.trim().split("\n").at(-1) ?? "";
}
