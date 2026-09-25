import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerPrompt } from "@sekhemet/context";
import {
  type AbEntry,
  type AttemptFinished,
  BudgetPolicyStore,
  type ChangeFootprint,
  type RunProfile,
  RunProfileRefusal,
  type SuiteRunResult,
  evaluateHarnessChange,
  profileSwitchCount,
  resolveRunProfile,
  ruleCredit,
  watchAdmittedChange,
} from "@sekhemet/eval";
import type { CardRecord } from "@sekhemet/kernel";
import { TOOL_CATALOG, cardClassFor, toolsForClass } from "@sekhemet/loop";
import type { Kernel } from "./wave2.js";

/**
 * Measurement commands (measurement rules 9a, 16b, 16c):
 *
 *   sekhemet measure footprint [--out <file>] [--root <harness checkout>]
 *   sekhemet measure admit --baseline a.json,b.json --candidate c.json,d.json
 *                          --entry <ab-entry.json> --before <fp.json> --after <fp.json>
 *   sekhemet measure watch <change-id> --kind budget|harness --with a,b --without c,d
 *   sekhemet measure rule-credit <rule-id>
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
}

/** The settings `sekhemet run` actually runs; the rest are the queue's. */
const RUN_HONOURS = new Set([
  "roles.worker",
  "policies.stepCap",
  "switches.thinking",
  "switches.workerMethod",
  "armUnderTest",
]);

/**
 * Resolve the one `RunProfile` for `sekhemet run` (MS-M9-4, MS-M9-5). A
 * setting `run` would not honour is refused rather than recorded, so the
 * evidence never names a policy the card did not run with.
 */
export function profileForRun(argv: string[], env: Record<string, string | undefined>): RunProfile {
  const i = argv.indexOf("--settings");
  const path = i === -1 ? undefined : argv[i + 1];
  if (i !== -1 && (!path || !existsSync(path)))
    throw new RunProfileRefusal(`--settings: no settings file ${path ?? "(missing)"}`);
  const profile = resolveRunProfile({
    ...(path ? { settingsFile: { path, text: readFileSync(path, "utf8") } } : {}),
    env,
    argv,
  });
  for (const [key, source] of Object.entries(profile.sources)) {
    if (!RUN_HONOURS.has(key) && source !== "default")
      throw new RunProfileRefusal(
        `sekhemet run does not run ${key} (it runs one card with the Worker); it is a queue setting (from ${source}).`,
      );
  }
  return profile;
}

/**
 * Resolve the one `RunProfile` for `sekhemet queue`, the path every measured
 * run takes (MS-M9-1, MS-M9-4): configuration (`[models] executor` and
 * `planner`, `[loop] default_step_budget`, else the step budget `tune
 * --apply` set), the experiment switches, the Researcher a person set in
 * the environment, then flags. The queue does not read a settings file yet —
 * the command line's share is SUR-44/45 (B3.3) — so `--settings` is refused
 * here rather than recorded without being applied.
 */
export function profileForQueue(
  argv: string[],
  env: Record<string, string | undefined>,
  configured: { worker?: string; manager?: string; maxTurns?: number },
  tunedStepBudget?: number,
): RunProfile {
  if (argv.includes("--settings"))
    throw new RunProfileRefusal(
      "the queue does not read --settings yet (surface SUR-45); pass the settings as their own flags",
    );
  const stepCap = configured.maxTurns ?? tunedStepBudget;
  return resolveRunProfile({
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

/**
 * The mark a measured run leaves in the repository it prepared (review M5):
 * the suite runner's fixture copies and M0's workspaces. `--auto-accept`
 * stands in for the person who accepts each card only there; in a
 * person's own repository a person accepts (the human is the rate limiter).
 */
export interface MeasurementMarker {
  purpose: "frozen suite" | "m0";
  by: string;
  createdAt: string;
}

const MARKER = [".sekhemet", "measurement.json"] as const;

export function writeMeasurementMarker(
  repoPath: string,
  purpose: MeasurementMarker["purpose"],
  by: string,
): MeasurementMarker {
  const marker: MeasurementMarker = { purpose, by, createdAt: new Date().toISOString() };
  mkdirSync(join(repoPath, MARKER[0]), { recursive: true });
  writeFileSync(join(repoPath, ...MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export function readMeasurementMarker(repoPath: string): MeasurementMarker | undefined {
  try {
    const m = JSON.parse(
      readFileSync(join(repoPath, ...MARKER), "utf8"),
    ) as Partial<MeasurementMarker>;
    return m.purpose === "frozen suite" || m.purpose === "m0"
      ? (m as MeasurementMarker)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Why the queue refuses `--auto-accept` here, or undefined when it may run. */
export function autoAcceptRefusal(argv: string[], repoPath: string): string | undefined {
  if (!argv.includes("--auto-accept") || readMeasurementMarker(repoPath)) return undefined;
  return "--auto-accept merges cards no person accepted, so it runs only in a repository a measured run prepared (the frozen suite, m0), which carries .sekhemet/measurement.json. Here a person accepts each card: the human is the rate limiter.";
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

const readRuns = (list: string | undefined): SuiteRunResult[] =>
  (list ?? "")
    .split(",")
    .filter(Boolean)
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as SuiteRunResult);

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

/** `sekhemet measure …`; returns the exit code. */
export async function runMeasureCommand(
  args: string[],
  k: Kernel,
  print: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  const [sub] = args;
  try {
    if (sub === "footprint") {
      // The harness's own source, not the project the command runs in.
      const f = computeFootprint(flag(args, "--root") ?? HARNESS_ROOT);
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
        payload: { ...result, before: before.commit, after: after.commit },
      });
      print(result.reason);
      return 0;
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
      if (v.status !== "rolled back") {
        await k.log.append({ actor: "harness", type: "measure/watched", payload: { ...v, kind } });
        print(v.reason);
        return 0;
      }
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
      const demoted = await demoteGeneratedTests(k, changeId, v.reason);
      await k.log.append({
        actor: "harness",
        type: "measure/rolled_back",
        payload: { ...v, kind, action, demoted },
      });
      print(
        `${v.reason}; ${action}${demoted.length ? `; ${demoted.length} generated test(s) demoted to advisory` : ""}`,
      );
      return 0;
    }
    if (sub === "rule-credit") {
      const ruleId = args[1];
      if (!ruleId) throw new Error("Usage: sekhemet measure rule-credit <rule-id>");
      const records = (await k.log.getEventsByTypes(["attempt/finished"])).map(
        (e) => e.payload as AttemptFinished,
      );
      const c = ruleCredit(records, ruleId);
      await k.log.append({ actor: "harness", type: "learning/credit", payload: c });
      print(
        `${ruleId}: credit ${c.credit} over ${c.pairs} pair(s) (${c.helpful} helpful, ${c.harmful} harmful) — ${c.status}${c.retiredAt ? ` at ${c.retiredAt.look} pairs, P = ${c.retiredAt.p.toFixed(4)}` : ""}`,
      );
      return 0;
    }
    print(
      "Usage: sekhemet measure footprint [--out <file>] | watch <change> --kind budget|harness --with a,b --without c,d | admit --baseline a,b --candidate c,d --entry <file> --before <fp> --after <fp> | rule-credit <rule-id>",
    );
    return 1;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
