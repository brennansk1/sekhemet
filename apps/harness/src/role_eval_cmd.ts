import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  type ModelHold,
  ModelRegistry,
  type ReasoningLevel,
  hostFingerprintHash,
} from "@sekhemet/models";
import { plural } from "@sekhemet/ui";
import { withRunSettings } from "./benchmark_runner.js";
import { REVIEW_THINKING_TOKENS } from "./learning/review.js";
import { REVIEW_METHODS, type ReviewMethod, reviewMethod } from "./learning/review_copy.js";
import {
  type ReviewerAbRecord,
  loadSeededDefects,
  reviewerAB,
  runSeededDefects,
} from "./learning/review_eval.js";
import { sendBackCatches } from "./learning/send_back_catch.js";
import { roleModelName, sharedQueue } from "./model_access.js";
import {
  type SeshatEvalResult,
  compareSkillRuns,
  loadPmConversations,
  runSeshatEval,
} from "./pm/eval.js";
import { DEFAULT_PM_MODEL } from "./pm/service.js";

/**
 * The role evaluations B4.8's prompts are admitted by (planner-pm PM-P6-13,
 * PM-N9-4; review-git RG-P8-13, -14; PROMPT_STANDARD rules 35.4 and 38):
 *
 *   sekhemet measure seshat [--model <id>] [--runs 2] [--only a,b] [--out <file>]
 *   sekhemet measure seshat-compare <a.json> <b.json>
 *   sekhemet measure reviewer [--model <id>] [--only a,b] [--out <file>]
 *   sekhemet measure reviewer --method prove [--reasoning <level>] [--thinking-cap <n>] [--model <id>]
 *   sekhemet measure send-backs
 *
 * Each result is written as JSON (under `.sekhemet/evals/` unless `--out`
 * names a file) and recorded on the ledger, with the asset's hash, the
 * model and, for Seshat, the skill's version. A model is held for the run
 * and released after it. A comparison of two skill versions reads two
 * result files, each from its own build of the harness (a frozen snapshot
 * at the commit of each skill version).
 */

export const MEASURE_SESHAT = "measure/seshat_evaluated";
export const MEASURE_REVIEWER = "measure/reviewer_seeded";
export const MEASURE_SEND_BACKS = "measure/send_backs_caught";

export const ROLE_EVAL_SUBCOMMANDS = ["seshat", "seshat-compare", "reviewer", "send-backs"];

export interface RoleEvalDeps {
  repoPath: string;
  log: EventLog;
  cardStore: CardStore;
  /** The harness checkout the assets live in; this build's by default. */
  harnessRoot?: string;
  /** Hold a model for one role; the process's shared scheduler by default. */
  acquire?: (role: "planner" | "reviewer", model: string) => Promise<ModelHold>;
  registry?: ModelRegistry;
  now?: () => Date;
}

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function outFile(deps: RoleEvalDeps, args: readonly string[], kind: string): string {
  const named = flag(args, "--out");
  if (named) return resolve(deps.repoPath, named);
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return join(deps.repoPath, ".sekhemet", "evals", `${kind}-${stamp}.json`);
}

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function withModel<T>(
  deps: RoleEvalDeps,
  role: "planner" | "reviewer",
  model: string,
  work: (adapter: LocalInferenceAdapter) => Promise<T>,
): Promise<T> {
  const acquire =
    deps.acquire ??
    ((r: "planner" | "reviewer", name: string) =>
      sharedQueue(
        { queue: r === "planner" ? "chat" : "reviewer", role: r, name },
        { registry: deps.registry ?? new ModelRegistry(), ledger: deps.log },
      )());
  const hold = await acquire(role, model);
  try {
    return await work(hold.adapter);
  } finally {
    hold.release();
    // CLAUDE.md, models rule 23: a measurement leaves no model resident.
    await hold.adapter.unload?.().catch(() => undefined);
  }
}

const list = (v: string | undefined) =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** `sekhemet measure seshat | seshat-compare | reviewer | send-backs`; returns the exit code. */
export async function runRoleEvalCommand(
  sub: string,
  args: readonly string[],
  deps: RoleEvalDeps,
  print: (line: string) => void,
): Promise<number> {
  const root = deps.harnessRoot ?? HARNESS_ROOT;
  const registry = () => deps.registry ?? new ModelRegistry();

  if (sub === "seshat") {
    let set: ReturnType<typeof loadPmConversations>;
    try {
      set = loadPmConversations(root);
    } catch (err) {
      print(
        `Not run: ${err instanceof Error ? err.message : String(err)}. A person confirms the drafts first: fixtures/pm_conversations/drafts/README.md.`,
      );
      return 1;
    }
    const model =
      flag(args, "--model") ??
      roleModelName("planner", undefined, { registry: registry() }) ??
      DEFAULT_PM_MODEL;
    const runs = Number(flag(args, "--runs") ?? 2);
    if (!Number.isInteger(runs) || runs < 1) {
      print("--runs takes a whole number of at least 1.");
      return 2;
    }
    const only = list(flag(args, "--only"));
    print(
      `Holding ${set.conversations.length} scripted conversations with Seshat on ${model}, ${plural(runs, "run")}…`,
    );
    const result = await withModel(deps, "planner", model, (adapter) =>
      runSeshatEval(set, adapter, {
        runs,
        ...(only ? { only } : {}),
        say: print,
        ...(deps.now ? { now: deps.now } : {}),
      }),
    );
    const file = outFile(deps, args, "seshat");
    write(file, result);
    await deps.log.append({
      actor: "harness",
      type: MEASURE_SESHAT,
      payload: {
        assetHash: result.assetHash,
        assetVersion: result.assetVersion,
        skillVersion: result.skillVersion,
        model: result.model,
        runs: result.runs.map((r) => ({ run: r.run, met: r.met, total: r.total })),
        items: result.runs.flatMap((r) =>
          r.conversations.map((c) => ({
            run: r.run,
            id: c.id,
            met: c.met,
            failed: [...new Set(c.items.filter((i) => !i.ok).map((i) => i.item))],
          })),
        ),
        passes: result.passes,
        partial: result.partial === true,
      },
    });
    print(result.line);
    print(`Recorded in ${file}.`);
    return 0;
  }

  if (sub === "seshat-compare") {
    const [a, b] = args.filter((x) => !x.startsWith("--"));
    if (!a || !b) {
      print("Usage: sekhemet measure seshat-compare <a.json> <b.json>");
      return 2;
    }
    try {
      const read = (f: string) =>
        JSON.parse(readFileSync(resolve(deps.repoPath, f), "utf8")) as SeshatEvalResult;
      print(compareSkillRuns(read(a), read(b)).line);
      return 0;
    } catch (err) {
      print(`Not compared: ${err instanceof Error ? err.message : String(err)}.`);
      return 1;
    }
  }

  if (
    sub === "reviewer" &&
    ["--method", "--reasoning", "--thinking-cap"].some((f) => args.includes(f))
  )
    return reviewerPairedAB(args, deps, print, root, registry());

  if (sub === "reviewer") {
    let set: ReturnType<typeof loadSeededDefects>;
    try {
      set = loadSeededDefects(root);
    } catch (err) {
      print(`Not run: ${err instanceof Error ? err.message : String(err)}.`);
      return 1;
    }
    const model =
      flag(args, "--model") ?? roleModelName("reviewer", undefined, { registry: registry() });
    if (!model) {
      print(
        "No Review model is configured: name one with --model <id>, or assign the Review role on Configuration.",
      );
      return 1;
    }
    const only = list(flag(args, "--only"));
    print(`Reviewing ${set.items.length} seeded defects on ${model}…`);
    const run = await withModel(deps, "reviewer", model, (adapter) =>
      runSeededDefects(set, adapter, {
        ...(only ? { only } : {}),
        say: print,
        ...(deps.now ? { now: deps.now } : {}),
      }),
    );
    const file = outFile(deps, args, "reviewer");
    write(file, run);
    await deps.log.append({
      actor: "harness",
      type: MEASURE_REVIEWER,
      payload: {
        assetHash: run.assetHash,
        assetVersion: run.assetVersion,
        model: run.model,
        items: run.report.items,
        // F25: the reviews that happened and those that failed, each with its reason.
        reviewed: run.report.reviewed,
        failed: run.report.failed,
        caught: run.report.caught,
        recall: run.report.recall,
        perItem: run.scores.map((s) => ({
          id: s.id,
          caught: s.caught,
          falsePositives: s.falsePositives,
          ...(s.failed !== undefined ? { failed: s.failed } : {}),
        })),
        passes: run.report.passes,
        partial: run.partial === true,
      },
    });
    print(run.report.line);
    print(`Recorded in ${file}.`);
    return 0;
  }

  if (sub === "send-backs") {
    const report = await sendBackCatches(deps.cardStore);
    await deps.log.append({
      actor: "harness",
      type: MEASURE_SEND_BACKS,
      payload: {
        total: report.total,
        caught: report.caught,
        unanchored: report.unanchored,
        share: report.share,
        verdict: report.verdict,
      },
    });
    print(report.line);
    return 0;
  }

  print(`Unknown role evaluation ${sub}; the evaluations are ${ROLE_EVAL_SUBCOMMANDS.join(", ")}.`);
  return 2;
}

const LEVELS: readonly ReasoningLevel[] = ["off", "low", "medium", "high"];

/**
 * `sekhemet measure reviewer --method prove [--reasoning <level>]
 * [--thinking-cap <n>]` (R3b, R3c; review-git RG-P8-17): the registered
 * seeded-defect set reviewed twice on one held Review model — once with the
 * role's current method and settings, once with the candidate's — paired
 * item by item, written as one result file and one `measure/settings_tuned`
 * event of kind `paired_ab`. It adopts nothing (PROMPT_STANDARD 35.4: the
 * admission reads this record on each candidate model).
 */
async function reviewerPairedAB(
  args: readonly string[],
  deps: RoleEvalDeps,
  print: (line: string) => void,
  root: string,
  registry: ModelRegistry,
): Promise<number> {
  const method = flag(args, "--method");
  const level = flag(args, "--reasoning");
  const capText = flag(args, "--thinking-cap");
  if (method !== undefined && !(REVIEW_METHODS as readonly string[]).includes(method)) {
    print(`--method is ${REVIEW_METHODS.join(" or ")}, not ${method}.`);
    return 2;
  }
  if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
    print(`--reasoning is ${LEVELS.join(", ")}, not ${level}.`);
    return 2;
  }
  const cap = capText === undefined ? undefined : Number(capText);
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 256)) {
    print("--thinking-cap takes a whole number of tokens, at least 256.");
    return 2;
  }
  let set: ReturnType<typeof loadSeededDefects>;
  try {
    set = loadSeededDefects(root);
  } catch (err) {
    print(`Not run: ${err instanceof Error ? err.message : String(err)}.`);
    return 1;
  }
  const model = flag(args, "--model") ?? roleModelName("reviewer", undefined, { registry });
  if (!model) {
    print(
      "No Review model is configured: name one with --model <id>, or assign the Review role on Configuration.",
    );
    return 1;
  }
  let currentMethod: ReviewMethod;
  try {
    currentMethod = reviewMethod();
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const set_ = registry.roleSettings(model, "reviewer")?.values ?? {};
  const current = {
    reviewMethod: currentMethod,
    reasoningLevel: set_.reasoningLevel ?? "off",
    reasoningCapTokens: set_.reasoningCapTokens ?? REVIEW_THINKING_TOKENS,
  };
  const candidate = {
    reviewMethod: (method as ReviewMethod | undefined) ?? currentMethod,
    reasoningLevel: (level as ReasoningLevel | undefined) ?? current.reasoningLevel,
    reasoningCapTokens: cap ?? current.reasoningCapTokens,
  };
  const only = list(flag(args, "--only"));
  const words = (a: typeof current) =>
    `method ${a.reviewMethod}, reasoning ${a.reasoningLevel}, thinking cap ${a.reasoningCapTokens.toLocaleString("en-US")}`;
  print(
    `Reviewing ${only?.length ?? set.items.length} seeded defects on ${model} twice, paired: current (${words(current)}) and candidate (${words(candidate)})…`,
  );
  const record: ReviewerAbRecord = await withModel(
    deps,
    "reviewer",
    model,
    (adapter: LocalInferenceAdapter) =>
      reviewerAB(set, {
        current: { method: current.reviewMethod, adapter },
        candidate: {
          method: candidate.reviewMethod,
          adapter: withRunSettings(adapter, "reviewer", {
            reasoningLevel: candidate.reasoningLevel,
            reasoningCapTokens: candidate.reasoningCapTokens,
          }),
        },
        ...(only ? { only } : {}),
        say: print,
        ...(deps.now ? { now: deps.now } : {}),
      }),
  );
  const file = outFile(deps, args, "reviewer-ab");
  write(file, { ...record, arms: { ...record.arms }, settings: { current, candidate } });
  const arm = (id: string, values: typeof current, a: ReviewerAbRecord["arms"]["current"]) => ({
    id,
    values,
    items: a.scores.map((x) => ({ id: x.id, score: x.caught ? 1 : 0 })),
    score: a.report.recall,
    failed: a.report.failed,
    passes: a.report.passes && record.partial !== true,
  });
  await deps.log.append({
    actor: "harness",
    type: "measure/settings_tuned",
    payload: {
      runId: `ab_${(deps.now?.() ?? new Date()).getTime().toString(36)}`,
      kind: "paired_ab",
      role: "reviewer",
      model,
      host: hostFingerprintHash(),
      setHash: set.hash,
      candidates: [
        arm("current", current, record.arms.current),
        arm("candidate", candidate, record.arms.candidate),
      ],
      incumbent: "current",
      survivor: record.verdict === "best" ? "candidate" : "current",
      comparison: {
        better: record.gained,
        worse: record.lost,
        ties: record.pairs.length - record.gained - record.lost,
        p: record.p,
      },
      verdict: record.verdict,
      partial: record.partial === true,
    },
  });
  const r = (a: ReviewerAbRecord["arms"]["current"]) =>
    `caught ${a.report.caught} of ${a.report.reviewed} seeded defects reviewed${a.report.failed ? ` (${a.report.failed} failed)` : ""}`;
  print(
    `Candidate ${r(record.arms.candidate)} (${words(candidate)}); current ${r(record.arms.current)} (${words(current)}).`,
  );
  print(
    `${record.gained} gained, ${record.lost} lost, p = ${record.p.toFixed(3)}: ${record.verdict === "best" ? "the candidate is better" : record.verdict === "worse" ? "the candidate is worse" : "no clear difference"}${record.partial ? "; a partial run (--only), never the admission's verdict" : ""}. Nothing is adopted.`,
  );
  print(`Recorded in ${file}.`);
  return 0;
}
