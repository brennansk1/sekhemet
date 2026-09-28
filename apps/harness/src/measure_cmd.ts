import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerPrompt } from "@sekhemet/context";
import {
  type AbEntry,
  type AttemptFinished,
  BudgetPolicyStore,
  type ChangeFootprint,
  type MeasurementMarker,
  RUN_PROFILE_FLAGS,
  type RunProfile,
  RunProfileRefusal,
  type SuiteRunResult,
  compareRuns,
  evaluateHarnessChange,
  measurementHolder,
  profileSwitchCount,
  readMeasurementMarker,
  resolveRunProfile,
  ruleCredit,
  runProfileHash,
  watchAdmittedChange,
  watchPooled,
  writeMeasurementMarker,
} from "@sekhemet/eval";
import { type CardRecord, measuresModel } from "@sekhemet/kernel";
import { TOOL_CATALOG, cardClassFor, toolsForClass } from "@sekhemet/loop";
import { effectiveConfig } from "./config_apply.js";
import { abVerdictLine, contextVersionGate } from "./context_gate.js";
import { workerContextVersion } from "./qualify.js";
import { ROLE_EVAL_SUBCOMMANDS, type RoleEvalDeps, runRoleEvalCommand } from "./role_eval_cmd.js";
import type { Kernel } from "./wave2.js";

/**
 * Measurement commands (measurement rules 9a, 16b, 16c):
 *
 *   sekhemet measure footprint [--out <file>] [--root <this build's checkout>]
 *   sekhemet measure admit --baseline a.json,b.json --candidate c.json,d.json
 *                          --entry <ab-entry.json> --before <fp.json> --after <fp.json>
 *   sekhemet measure compare <baseline.json> <candidate.json>
 *   sekhemet measure watch <change-id> --kind budget|harness --with a,b --without c,d
 *   sekhemet measure watch-adopted --with <run.json>   (after every suite run)
 *   sekhemet measure rescore <result.json> --work <dir> [--out <file>]
 *   sekhemet measure promote <generated-test card> [--because <change>]
 *   sekhemet measure rule-credit <rule-id>
 *   sekhemet measure seshat | seshat-compare | reviewer | send-backs   (role_eval_cmd.ts, B4.8)
 *
 * A harness change's footprint is computed from the build, never entered:
 * one footprint file per commit, each stamped with that commit, compared
 * without checking anything out.
 */

/** A footprint as recorded: the four counts, how the tokens were counted, and the commit. */
export interface RecordedFootprint extends ChangeFootprint {
  /** Counted by the allocator's estimator, not the Worker's tokenizer (CX-N1-2 brings that). */
  stablePromptTokensEstimated: true;
  commit: string;
  dirty: boolean;
  recordedAt: string;
  /** The build's context version (context rule 27), stamped on the A/B it is part of (CX-N6-2). */
  contextVersion: string;
}

/** The settings `sekhemet run` actually runs; the rest are the queue's. */
const RUN_HONOURS = new Set([
  "roles.worker",
  "policies.stepCap",
  "switches.thinking",
  "switches.workerMethod",
  "switches.seed",
  "switches.prune",
  "armUnderTest",
]);

/**
 * Resolve the one `RunProfile` for `sekhemet run` (MS-M9-4, MS-M9-5). A
 * setting `run` would not honour is refused rather than recorded, so the
 * evidence never names a policy the card did not run with.
 */
/** The `--settings <file>` layer, read whole (SUR-45); refused when the file is missing. */
function settingsLayer(argv: string[]): { settingsFile?: { path: string; text: string } } {
  const i = argv.indexOf("--settings");
  const path = i === -1 ? undefined : argv[i + 1];
  if (i !== -1 && (!path || !existsSync(path)))
    throw new RunProfileRefusal(`--settings: no settings file ${path ?? "(missing)"}`);
  return path ? { settingsFile: { path, text: readFileSync(path, "utf8") } } : {};
}

export function profileForRun(argv: string[], env: Record<string, string | undefined>): RunProfile {
  const profile = resolveRunProfile({ ...settingsLayer(argv), env, argv });
  for (const [key, source] of Object.entries(profile.sources)) {
    if (!RUN_HONOURS.has(key) && source !== "default")
      throw new RunProfileRefusal(
        `sekhemet run does not run ${key} (it runs one issue with the Coding model); it is a queue setting (from ${source}).`,
      );
  }
  return profile;
}

/**
 * The command line with every setting the profile owns taken out — its flags
 * and `--settings <file>` — so the profile's own flags can stand in for them
 * (SUR-45): what the queue reads is what the evidence records.
 */
export function withoutProfileFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const path = RUN_PROFILE_FLAGS[a];
    if (a === "--settings") {
      i++;
      continue;
    }
    if (path === undefined) {
      out.push(a);
      continue;
    }
    const boolean = path.startsWith("policies.") && path !== "policies.stepCap";
    if (!boolean) i++;
  }
  return out;
}

/**
 * Resolve the one `RunProfile` for `sekhemet queue`, the path every measured
 * run takes (MS-M9-1, MS-M9-4; SUR-44, SUR-45): configuration (`[models]
 * executor` and `planner`, `[loop] default_step_budget`, else the step budget
 * `tune --apply` set), a `--settings` file as one layer (its path, SHA-256
 * and contents recorded), the experiment switches, the Researcher a person
 * set in the environment, then flags.
 */
export function profileForQueue(
  argv: string[],
  env: Record<string, string | undefined>,
  configured: { worker?: string; manager?: string; maxTurns?: number },
  tunedStepBudget?: number,
): RunProfile {
  const stepCap = configured.maxTurns ?? tunedStepBudget;
  return resolveRunProfile({
    ...settingsLayer(argv),
    config: {
      roles: {
        ...(configured.worker ? { worker: configured.worker } : {}),
        ...(configured.manager ? { manager: configured.manager } : {}),
      },
      ...(stepCap && stepCap > 0 ? { policies: { stepCap } } : {}),
    },
    env,
    argv,
    envRoles: true,
  });
}

// The marker's one definition is in @sekhemet/eval (measurement_marker.ts),
// shared with independent mode's measurement setup.
export { type MeasurementMarker, measurementHolder, readMeasurementMarker, writeMeasurementMarker };

/** Why the queue refuses `--auto-accept` here, or undefined when it may run. */
export function autoAcceptRefusal(
  argv: string[],
  repoPath: string,
  teamMode: "solo" | "team" = effectiveConfig(repoPath).config.team.mode,
): string | undefined {
  if (!argv.includes("--auto-accept")) return undefined;
  // review-git §2.5.6, RG-S5-9 (DEC-35): never in the Team setup — no marker
  // or setting enables it there.
  if (teamMode === "team") {
    return "--auto-accept is not available in the Team setup: on a team every issue is accepted by a person (DEC-35).";
  }
  if (readMeasurementMarker(repoPath)) return undefined;
  return "--auto-accept merges issues no person accepted, so it runs only in a repository a measured run prepared (the frozen suite, m0), which carries .sekhemet/measurement.json. Here a person accepts each issue: the human is the rate limiter.";
}

/**
 * Hand the profile's switches to the code that reads them as experiment
 * switches: the prune arm is read by the prompt assembly from
 * `SEKHEMET_PRUNE` (MS-T7-6), so a flag or settings file that named it sets
 * it for this process. The seed is applied to the model by the card runner.
 */
export function applyProfileSwitches(
  profile: RunProfile,
  env: Record<string, string | undefined> = process.env,
): void {
  if (profile.switches.prune !== undefined) env.SEKHEMET_PRUNE = profile.switches.prune;
}

/** Non-test TypeScript lines under packages/*\/src and apps/*\/src (the footprint's lines of code). */
function sourceLines(root: string): number {
  let lines = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(entry) &&
        !/\.(spec|test)\.tsx?$/.test(entry) &&
        !entry.endsWith(".d.ts")
      ) {
        const text = readFileSync(full, "utf8");
        lines += text.split("\n").filter((l) => l.trim() !== "").length;
      }
    }
  };
  for (const top of ["packages", "apps"]) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, "src");
      if (existsSync(src) && statSync(src).isDirectory()) walk(src);
    }
  }
  return lines;
}

/** The card every footprint renders, so two builds' stable zones are compared on one input. */
const FOOTPRINT_CARD: CardRecord = {
  id: "card_footprint",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: ["src/ledger.ts"],
  stepBudget: 40,
  stepsUsed: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  spec: "Store ledger entries in order and list them back.",
  acceptanceCriteria: ["append adds one entry", "list returns the entries in order"],
  acceptanceTests: ["ledger.spec.ts"],
};

/**
 * The footprint of the running build (rule 16c's "simpler"): stable-zone
 * prompt tokens of one fixed card's first prompt (the system prompt, the
 * static prefix and the tool schemas), the tool catalog's size, the switch
 * count (experiment switches plus `RunProfile` flags) and the lines of code.
 */
export function computeFootprint(root: string): RecordedFootprint {
  const tools = toolsForClass(cardClassFor(FOOTPRINT_CARD), TOOL_CATALOG);
  const pack = buildWorkerPrompt({ card: FOOTPRINT_CARD, tools }).pack;
  const git = (...a: string[]) => {
    try {
      return execFileSync("git", a, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  return {
    stablePromptTokens:
      pack.zoneTokens.system + pack.zoneTokens.static + pack.zoneTokens.toolSchemas,
    stablePromptTokensEstimated: true,
    tools: TOOL_CATALOG.length,
    switches: profileSwitchCount(),
    linesOfCode: sourceLines(root),
    commit: git("rev-parse", "--short=12", "HEAD") || "unknown",
    dirty: git("status", "--porcelain") !== "",
    recordedAt: new Date().toISOString(),
    contextVersion: workerContextVersion(),
  };
}

/** apps/harness/dist/measure_cmd.js → the repository root. */
const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function readFootprint(path: string): RecordedFootprint {
  const f = JSON.parse(readFileSync(path, "utf8")) as Partial<RecordedFootprint>;
  if (f.dirty === true)
    throw new Error(
      `${path}: recorded on a dirty checkout, so its commit ${f.commit} does not name the code it counted; commit, then record it again`,
    );
  if (typeof f.commit !== "string" || f.commit === "unknown")
    throw new Error(
      `${path}: the footprint is not stamped with its commit; record it with sekhemet measure footprint`,
    );
  for (const k of ["stablePromptTokens", "tools", "switches", "linesOfCode"] as const) {
    if (typeof f[k] !== "number") throw new Error(`${path}: the footprint has no ${k}`);
  }
  return f as RecordedFootprint;
}

const listOf = (list: string | undefined): string[] => (list ?? "").split(",").filter(Boolean);

const readRuns = (list: string | undefined): SuiteRunResult[] =>
  listOf(list).map((p) => JSON.parse(readFileSync(p, "utf8")) as SuiteRunResult);

/**
 * Demote every generated test promoted because of a change that was rolled
 * back (MS-T8-10): its card carries `promoted-by:<change>`, loses it, gains
 * `advisory`, and says why in its spec.
 */
export async function demoteGeneratedTests(
  k: Kernel,
  changeId: string,
  reason: string,
): Promise<string[]> {
  const tag = `promoted-by:${changeId}`;
  const demoted: string[] = [];
  for (const card of await k.cardStore.listCards()) {
    const labels = card.labels ?? [];
    if (!labels.includes(tag)) continue;
    await k.cardStore.updateCard(
      card.id,
      {
        labels: [...labels.filter((l) => l !== tag && l !== "advisory"), "advisory"],
        spec: `${card.spec ?? ""}\n\nDemoted to advisory: ${changeId} was rolled back (${reason}).`.trim(),
      },
      "harness",
    );
    demoted.push(card.id);
  }
  return demoted;
}

interface RecordedRun {
  path: string;
  sha256?: string;
}

interface AdoptedChange {
  version: string;
  baselineRuns: RecordedRun[];
  baselineProfileHash?: string;
  baselineMode: string;
  baselineWorker?: string;
  /** Later comparable runs already pooled, and the looks already tested. */
  laterRuns: RecordedRun[];
  testedLooks: number[];
}

/** Adopted harness changes still being watched (not rolled back, not kept at the last look). */
async function adoptedChanges(k: Kernel): Promise<AdoptedChange[]> {
  const rolled = new Set(
    (await k.log.getEventsByTypes(["measure/rolled_back"])).map(
      (e) => (e.payload as { changeId: string }).changeId,
    ),
  );
  const watched = new Map<string, { runs: RecordedRun[]; testedLooks: number[]; status: string }>();
  for (const e of await k.log.getEventsByTypes(["measure/watched"])) {
    const p = e.payload as {
      changeId: string;
      runs?: RecordedRun[];
      testedLooks?: number[];
      status: string;
    };
    // Only the pooled watch's records carry its runs; a person's one-off
    // `measure watch` does not end the pooled watch.
    if (!Array.isArray(p.runs)) continue;
    watched.set(p.changeId, {
      runs: p.runs ?? [],
      testedLooks: p.testedLooks ?? [],
      status: p.status,
    });
  }
  return (await k.log.getEventsByTypes(["measure/admission"]))
    .map(
      (e) =>
        e.payload as {
          adopted?: boolean;
          version: string;
          baselineRuns?: (string | RecordedRun)[];
          baselineProfileHash?: string;
          baselineMode?: string;
          baselineWorker?: string;
        },
    )
    .filter(
      (p) =>
        p.adopted === true && !rolled.has(p.version) && watched.get(p.version)?.status !== "kept",
    )
    .map((p) => ({
      version: p.version,
      baselineRuns: (p.baselineRuns ?? []).map((b) => (typeof b === "string" ? { path: b } : b)),
      ...(p.baselineProfileHash ? { baselineProfileHash: p.baselineProfileHash } : {}),
      baselineMode: p.baselineMode ?? "sequential",
      ...(p.baselineWorker ? { baselineWorker: p.baselineWorker } : {}),
      laterRuns: watched.get(p.version)?.runs ?? [],
      testedLooks: watched.get(p.version)?.testedLooks ?? [],
    }));
}

/** Why a later run cannot be pooled with an adopted change's baseline, or undefined (review B1). */
function notComparable(r: SuiteRunResult, c: AdoptedChange): string | undefined {
  if (r.abEntry) return "it is an arm of an A/B (it carries an A/B entry)";
  if (r.runProfile?.armUnderTest)
    return `it names an arm under test (${r.runProfile.armUnderTest})`;
  if ((r.mode ?? "sequential") !== c.baselineMode)
    return `it ran ${r.mode ?? "sequential"}, the baseline ${c.baselineMode}`;
  if (c.baselineWorker !== r.worker)
    return `its Coding model is ${r.worker ?? "unrecorded"}, the baseline's ${c.baselineWorker ?? "unrecorded"}`;
  const hash = r.runProfile ? runProfileHash(r.runProfile) : undefined;
  if (hash !== c.baselineProfileHash) return "its RunProfile differs from the baseline's";
  return undefined;
}

/** A recorded run, checked against the hash it was recorded with. */
function readRecordedRun(b: RecordedRun, since: string): SuiteRunResult {
  if (b.sha256 && sha256File(b.path) !== b.sha256)
    throw new Error(`${b.path} changed since it ${since}; its record no longer matches`);
  return JSON.parse(readFileSync(b.path, "utf8")) as SuiteRunResult;
}

const sha256File = (p: string): string =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * Act on a watch verdict (rule 18, MS-T8-3, MS-T8-10): record it; on a
 * resolved loss roll back a budget change itself, flag a harness change
 * for a person to revert, and demote the generated tests it promoted.
 */
async function actOnWatch(
  k: Kernel,
  v: ReturnType<typeof watchAdmittedChange>,
  kind: "budget" | "harness",
): Promise<string> {
  if (v.status !== "rolled back") {
    await k.log.append({ actor: "harness", type: "measure/watched", payload: { ...v, kind } });
    return v.reason;
  }
  return rollBack(k, v.changeId, v.reason, kind, v);
}

async function rollBack(
  k: Kernel,
  changeId: string,
  reason: string,
  kind: "budget" | "harness",
  verdict: object = {},
): Promise<string> {
  let action: string;
  if (kind === "budget") {
    const restored = new BudgetPolicyStore(
      join(k.repoPath, ".sekhemet", "budget_policy.json"),
    ).rollback(changeId);
    action = `restored the step budget to ${restored.stepBudget}`;
  } else {
    // A harness change is code: the harness flags it for its revert and
    // pins nothing itself.
    action = `revert ${changeId}: a harness change is code, and a person reverts it`;
  }
  const demoted = await demoteGeneratedTests(k, changeId, reason);
  await k.log.append({
    actor: "harness",
    type: "measure/rolled_back",
    payload: { ...verdict, changeId, reason, kind, action, demoted },
  });
  return `${reason}; ${action}${demoted.length ? `; ${demoted.length} generated test(s) demoted to advisory` : ""}`;
}

/** `sekhemet measure …`; returns the exit code. */
export async function runMeasureCommand(
  args: string[],
  k: Kernel,
  print: (line: string) => void = (l) => console.log(l),
  /** The role evaluations' model and asset root, when a caller supplies them (tests). */
  evalDeps: Partial<Pick<RoleEvalDeps, "acquire" | "harnessRoot" | "registry" | "now">> = {},
): Promise<number> {
  const [sub] = args;
  // B4.8: the measurements that admit Seshat's and the Reviewer's prompts
  // (PM-P6-13, RG-P8-13, RG-P8-14).
  if (sub && ROLE_EVAL_SUBCOMMANDS.includes(sub)) {
    return runRoleEvalCommand(
      sub,
      args.slice(1),
      { repoPath: k.repoPath, log: k.log, cardStore: k.cardStore, ...evalDeps },
      print,
    );
  }
  try {
    if (sub === "footprint") {
      // The harness's own source, not the project the command runs in. The
      // prompt tokens, tools, switches and context version are this build's,
      // so a --root naming another checkout would stamp its commit and lines
      // on this build's numbers: refused (minor 4).
      const root = flag(args, "--root");
      if (root !== undefined && resolve(root) !== resolve(HARNESS_ROOT)) {
        throw new Error(
          `--root ${root} is not this build's checkout (${resolve(HARNESS_ROOT)}): a footprint's prompt tokens, tools, switches and context version are this build's. Run that checkout's own \`sekhemet measure footprint\` instead.`,
        );
      }
      const f = computeFootprint(root ?? HARNESS_ROOT);
      const out = flag(args, "--out");
      if (out) writeFileSync(out, `${JSON.stringify(f, null, 2)}\n`);
      print(
        `Footprint at ${f.commit}${f.dirty ? " (dirty)" : ""}: ${f.stablePromptTokens} stable-zone tokens (estimated), ${f.tools} tools, ${f.switches} switches, ${f.linesOfCode} lines of code${out ? ` — recorded in ${relative(process.cwd(), out) || out}` : ""}`,
      );
      if (f.dirty)
        print("A dirty checkout's footprint names a commit it does not match; commit first.");
      return 0;
    }
    if (sub === "admit") {
      const beforePath = flag(args, "--before");
      const afterPath = flag(args, "--after");
      if (!beforePath || !afterPath)
        throw new Error("admit needs --before and --after footprint files");
      const before = readFootprint(beforePath);
      const after = readFootprint(afterPath);
      const entryPath = flag(args, "--entry");
      if (!entryPath)
        throw new Error("admit needs --entry, the A/B's entry naming its cost measure");
      const entryText = readFileSync(entryPath, "utf8");
      const baselineFirst = readRuns(flag(args, "--baseline"))[0];
      const baselineMeta = {
        profileHash: baselineFirst?.runProfile
          ? runProfileHash(baselineFirst.runProfile)
          : undefined,
        mode: baselineFirst?.mode ?? "sequential",
        worker: baselineFirst?.worker,
      };
      const entry = JSON.parse(entryText) as AbEntry;
      const result = evaluateHarnessChange({
        // Every run must carry this hash: the entry existed before it ran (review M2).
        entrySha256: createHash("sha256").update(entryText).digest("hex"),
        baseline: readRuns(flag(args, "--baseline")),
        candidate: readRuns(flag(args, "--candidate")),
        entry,
        change: { before, after },
        version: after.commit,
      });
      await k.log.append({
        actor: "harness",
        type: "measure/admission",
        payload: {
          ...result,
          before: before.commit,
          after: after.commit,
          // An adopted change is watched after later suite runs, against
          // the runs it was compared with (MS-T8-3): recorded by resolved
          // path and hash, with what a later run must match to be compared.
          adopted: result.verdict !== "not adopted",
          baselineRuns: listOf(flag(args, "--baseline")).map((p) => ({
            path: resolve(p),
            sha256: sha256File(p),
          })),
          baselineProfileHash: baselineMeta.profileHash,
          baselineMode: baselineMeta.mode,
          ...(baselineMeta.worker ? { baselineWorker: baselineMeta.worker } : {}),
        },
      });
      print(result.reason);
      // CX-N6-2: the line SUITE_RUNS.md records the verdict with, for the release gate.
      if (after.contextVersion) {
        print(
          `Record in SUITE_RUNS.md: ${abVerdictLine(result.verdict, after.contextVersion, new Date().toISOString().slice(0, 10))}`,
        );
      }
      return 0;
    }
    if (sub === "context-gate") {
      // `sekhemet measure context-gate [--suite-runs <file>]` (CX-N6-2, the release gate).
      const file =
        flag(args, "--suite-runs") ?? join(HARNESS_ROOT, "docs", "reference", "SUITE_RUNS.md");
      const gate = contextVersionGate(
        existsSync(file) ? readFileSync(file, "utf8") : "",
        workerContextVersion(),
      );
      print(gate.reason);
      return gate.ok ? 0 : 1;
    }
    if (sub === "compare") {
      // `sekhemet measure compare <baseline.json> <candidate.json>` (MS-M12-2..4).
      const [, a, b] = args;
      if (!a || !b)
        throw new Error("Usage: sekhemet measure compare <baseline.json> <candidate.json>");
      const [baseline] = readRuns(a);
      const [candidate] = readRuns(b);
      const v = compareRuns(baseline as SuiteRunResult, candidate as SuiteRunResult);
      await k.log.append({
        actor: "harness",
        type: "measure/compared",
        payload: { ...v, baseline: a, candidate: b },
      });
      print(v.reason);
      return v.comparable ? 0 : 1;
    }
    if (sub === "watch") {
      // `sekhemet measure watch <change> --kind budget|harness --with a,b --without c,d`
      const changeId = args[1];
      const kind = flag(args, "--kind");
      if (kind === "rule")
        throw new Error(
          "a project rule is kept or retired by its paired credit (sekhemet measure rule-credit), never by the suite (rule 16b)",
        );
      if (!changeId || (kind !== "budget" && kind !== "harness"))
        throw new Error(
          "Usage: sekhemet measure watch <change-id> --kind budget|harness --with a,b --without c,d",
        );
      const v = watchAdmittedChange({
        changeId,
        withChange: readRuns(flag(args, "--with")),
        without: readRuns(flag(args, "--without")),
      });
      print(await actOnWatch(k, v, kind));
      return 0;
    }
    if (sub === "rescore") {
      // `sekhemet measure rescore <result.json> --work <dir> [--out <file>]`
      // (SUITE_RUNS, ref-r1): read only; the rescored result goes next to the original.
      const [, resultPath] = args;
      const work = flag(args, "--work");
      if (!resultPath || !work)
        throw new Error(
          "Usage: sekhemet measure rescore <result.json> --work <dir> [--out <file>]",
        );
      const { rescoreSuiteResult } = await import("./rescore.js");
      const outFlag = flag(args, "--out");
      const r = rescoreSuiteResult(resultPath, work, ...(outFlag ? [outFlag] : []));
      print(
        r.profileMismatch.length
          ? `${r.profileMismatch.length} of ${r.cards} issue(s) ran with a different profile: ${r.profileMismatch.map((c) => `${c} (${(r.differences[c] ?? []).join(", ")})`).join("; ")}`
          : `all ${r.cards} issue(s) ran with the run's settings plus their repository's configuration`,
      );
      print(`was ${r.previous.length} named; rescored result in ${r.out}`);
      return 0;
    }
    if (sub === "watch-adopted") {
      // `sekhemet measure watch-adopted --with <run.json>`: run by the suite
      // runner after every run (MS-T8-3, review B1). Each adopted harness
      // change not yet decided pools its later comparable runs and is tested
      // only at its planned looks; a run that is not comparable is named and
      // skipped, and one change's problem never stops the others.
      const newRuns = listOf(flag(args, "--with"));
      const changes = await adoptedChanges(k);
      if (changes.length === 0) {
        print("no adopted change to watch");
        return 0;
      }
      const toldNotWatchable = new Set(
        (await k.log.getEventsByTypes(["measure/not_watchable"])).map(
          (e) => (e.payload as { changeId: string }).changeId,
        ),
      );
      for (const c of changes) {
        // An admission from before the baseline's profile was recorded
        // cannot be matched with later runs: said once, then left.
        if (!c.baselineProfileHash) {
          if (!toldNotWatchable.has(c.version)) {
            const why = "admitted before B2.4's profile record; re-admit to watch";
            await k.log.append({
              actor: "harness",
              type: "measure/not_watchable",
              payload: { changeId: c.version, why },
            });
            print(`${c.version}: not watchable: ${why}`);
          }
          continue;
        }
        try {
          const without = c.baselineRuns.map((b) => readRecordedRun(b, "was admitted"));
          const pooled = [...c.laterRuns];
          for (const path of newRuns) {
            const r = JSON.parse(readFileSync(path, "utf8")) as SuiteRunResult;
            const why = notComparable(r, c);
            if (why) {
              await k.log.append({
                actor: "harness",
                type: "measure/not_comparable",
                payload: { changeId: c.version, run: resolve(path), why },
              });
              print(`${c.version}: ${path} is not comparable (${why}); not watched with it`);
              continue;
            }
            pooled.push({ path: resolve(path), sha256: sha256File(path) });
          }
          const withRuns = pooled.map((b) => readRecordedRun(b, "was watched"));
          const v = watchPooled({
            changeId: c.version,
            without,
            withRuns,
            testedLooks: c.testedLooks,
          });
          await k.log.append({
            actor: "harness",
            type: "measure/watched",
            payload: { ...v, kind: "harness", runs: pooled },
          });
          if (v.status === "rolled back") {
            print(await rollBack(k, v.changeId, v.reason, "harness"));
          } else print(v.reason);
        } catch (err) {
          print(
            `${c.version}: not watched this time: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return 0;
    }
    if (sub === "promote") {
      // `sekhemet measure promote <card> [--because <change>]`: a person
      // promotes a generated test from advisory (MS-T8-10's other half).
      const cardId = args[1];
      const card = cardId ? await k.cardStore.getCard(cardId) : undefined;
      if (!card)
        throw new Error(
          "Usage: sekhemet measure promote <generated-test card> [--because <change>]",
        );
      const labels = card.labels ?? [];
      if (!labels.some((l) => l === "mutation-hardening" || l === "generated-test"))
        throw new Error(
          `${cardId} is not a generated test; only a generated test is promoted from advisory`,
        );
      const adopted = (await adoptedChanges(k)).map((c) => c.version);
      if (!flag(args, "--because") && adopted.length > 1)
        throw new Error(
          `${adopted.length} changes are adopted (${adopted.join(", ")}): name one with --because <change>`,
        );
      const because = flag(args, "--because") ?? adopted.at(-1);
      const next = [
        ...labels.filter((l) => l !== "advisory" && !l.startsWith("promoted")),
        "promoted",
        ...(because ? [`promoted-by:${because}`] : []),
      ];
      await k.cardStore.updateCard(card.id, { labels: next }, "human");
      await k.log.append({
        actor: "human",
        type: "measure/promoted",
        payload: { cardId: card.id, ...(because ? { because } : {}) },
      });
      print(
        `promoted ${card.id} from advisory${because ? `, labelled with the change in force, ${because}: a rollback of it demotes this test again` : ""}`,
      );
      return 0;
    }
    if (sub === "rule-credit") {
      const ruleId = args[1];
      if (!ruleId) throw new Error("Usage: sekhemet measure rule-credit <rule-id>");
      // WL-N5-2: the one reader of attempt outcomes.
      // Only attempts that measure the Worker, numbered by the card's model
      // tries, so a resume after a halt is its first (B4.0a review M2).
      const tries = new Map<string, number>();
      const measured = k.cardStore.runs
        .readAttemptOutcomes()
        .filter(measuresModel)
        .sort((a, b) => a.attemptNumber - b.attemptNumber || a.seq - b.seq);
      const records: AttemptFinished[] = measured.map((o) => ({
        cardId: o.cardId,
        projectId: o.projectId ?? "",
        cardClass: o.cardClass ?? "",
        attemptNumber: tries.set(o.cardId, (tries.get(o.cardId) ?? 0) + 1).get(o.cardId) as number,
        builtBy: o.builtBy.kind,
        stopReason: o.stopReason,
        rules: o.ruleIds,
        withheldRules: o.withheldRuleIds,
      }));
      const c = ruleCredit(records, ruleId);
      await k.log.append({ actor: "harness", type: "learning/credit", payload: c });
      print(
        `${ruleId}: credit ${c.credit} over ${c.pairs} pair(s) (${c.helpful} helpful, ${c.harmful} harmful) — ${c.status}${c.retiredAt ? ` at ${c.retiredAt.look} pairs, P = ${c.retiredAt.p.toFixed(4)}` : ""}`,
      );
      return 0;
    }
    print(
      "Usage: sekhemet measure footprint [--out <file>] | compare <baseline> <candidate> | watch <change> --kind budget|harness --with a,b --without c,d | watch-adopted --with <run> | rescore <result.json> --work <dir> [--out <file>] | promote <card> [--because <change>] | admit --baseline a,b --candidate c,d --entry <file> --before <fp> --after <fp> | rule-credit <rule-id>",
    );
    return 1;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
