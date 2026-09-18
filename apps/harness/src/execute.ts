import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardServiceImpl } from "@sekhemet/board";
import { PlaybookRegistry, SkillsRegistry } from "@sekhemet/context";
import { DeterministicGateRunner, loadGatesConfig } from "@sekhemet/gates";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import { type CardRunResult, CardRunner } from "@sekhemet/loop";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";

export interface ExecutionContext {
  repoPath: string;
  restrictedMode: boolean;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
  log?: (line: string) => void;
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
export async function acceptCard(ctx: ExecutionContext, card: CardRecord): Promise<string> {
  if (card.status !== "review") {
    throw new Error(
      `Card ${card.id} is in '${card.status}'. Only a card in Review can be accepted.`,
    );
  }

  const gitAdapter = new NodeGitSyncAdapter(ctx.repoPath);
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
    actor: "human",
    reason: "accepted by operator",
  });
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
