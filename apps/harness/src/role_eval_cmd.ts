import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { type LocalInferenceAdapter, type ModelHold, ModelRegistry } from "@sekhemet/models";
import { plural } from "@sekhemet/ui";
import { loadSeededDefects, runSeededDefects } from "./learning/review_eval.js";
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
