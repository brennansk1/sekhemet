import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSourceIndex } from "./index/source_index.js";
import type {
  GateDefinition,
  GateFailure,
  GateResult,
  GateRung,
  GateRunner,
  RunGatesOptions,
  RungOutcome,
} from "./types.js";

/**
 * The onboarding baseline (gates rule 15a, NEW-gates-7, GT-BF-2).
 *
 * Onboarding a repository records its pre-existing type errors, lint
 * findings and failing or flaky tests — the suite run twice — as one
 * `project/baseline` event, each keyed by file, rule and a fingerprint that
 * survives line moves. A gate then reports only what is absent from the
 * baseline, so a card is never asked to fix what it did not write; the
 * baseline only shrinks, when a baselined diagnostic disappears. A take-over
 * records the same baseline from its two confined runs (design-stage
 * DS-TO-6).
 */

/** The ledger event that holds the baseline and each shrink of it. */
export const BASELINE_EVENT = "project/baseline";

/** The rungs whose findings are diagnostics: deterministic, so a disappearance shrinks the baseline. */
const STATIC_RUNGS: ReadonlySet<GateRung> = new Set(["parse", "typecheck", "lint"]);

export interface BaselineEntry {
  /** SHA-256 of the gate, file, rule, message without positions, and the source line's text. */
  fingerprint: string;
  gate: string;
  rung: GateRung;
  /** Repository-relative. */
  file: string;
  /** The diagnostic's code (`TS2304`, `lint/style/useConst`), or a failing test's name. */
  rule: string;
  /** A test that failed in one of the two runs only: never shrunk, never counted. */
  flaky?: true;
}

/** One gate's run while the baseline was taken: the command, its exit code, what failed. */
export interface BaselineRun {
  gate: string;
  rung: GateRung;
  /** 1 or 2: the suite runs twice. Static gates run once. */
  run: number;
  command?: string;
  exitCode: number;
  /** The fingerprints that failed in this run. */
  failing: string[];
  /** The gate could not run, and why: its findings are not in the baseline. */
  unavailable?: string;
}

export interface OnboardingBaseline {
  entries: BaselineEntry[];
  runs: BaselineRun[];
  /**
   * Tests that failed in one of the two runs only: not baselined — flaky-test
   * quarantine judges them (rule 34) — and recorded for the person to read.
   */
  flaky: BaselineEntry[];
}

/**
 * A file the source index could only read in part on the base (`recovered`,
 * or a language with no adapter): a project gate's verdict partial on it is
 * pre-existing, forgiven like the rest of the baseline and listed in the
 * evidence (GT-IX-1, review M2).
 */
export interface BaselinePartial {
  file: string;
  reason: string;
}

/** The first line of a failure: `file:line:col RULE: message`, or `file[:line] test > name`. */
const STATIC_HEAD = /^(.+?):\d+(?::\d+)?\s+(\S+?):\s*(.*)$/;

/** A message without the positions a line move changes. */
function withoutPositions(text: string): string {
  return text
    .replace(/\(\d+,\d+\)/g, "")
    .replace(/:\d+(:\d+)?\b/g, "")
    .replace(/\bline \d+\b/gi, "line")
    .trim();
}

/** The trimmed text of a line of a file in the tree, or "" when it cannot be read. */
function sourceLine(root: string, file: string, line: number | undefined): string {
  if (line === undefined || line < 1) return "";
  const path = join(root, file);
  try {
    if (!existsSync(path)) return "";
    return (readFileSync(path, "utf8").split("\n")[line - 1] ?? "").trim();
  } catch {
    return "";
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * A failure's baseline key, or undefined when it is about no one file or the
 * gate could not run: those are never baselined.
 */
export function failureFingerprint(
  f: GateFailure,
  root: string,
): Omit<BaselineEntry, "flaky"> | undefined {
  const file = f.location.file.replace(/^\.\//, "");
  if (!file || file === "." || f.notRun) return undefined;
  const head = f.errorExcerpt.split("\n")[0] ?? "";
  if (f.rung === "test") {
    // A failing test's identity: its gate, file and name, without the line.
    const title = head.replace(/^\S+\s*/, "");
    if (!title || title === "(the file failed)") return undefined;
    return {
      fingerprint: sha256(`test\0${f.gate}\0${file}\0${title}`),
      gate: f.gate,
      rung: f.rung,
      file,
      rule: title,
    };
  }
  const m = STATIC_HEAD.exec(head);
  const rule = m?.[2] ?? f.gate;
  const message = withoutPositions(m?.[3] ?? f.actual);
  return {
    fingerprint: sha256(
      `${f.gate}\0${file}\0${rule}\0${message}\0${sourceLine(root, file, f.location.line)}`,
    ),
    gate: f.gate,
    rung: f.rung,
    file,
    rule,
  };
}

/**
 * Take the baseline: the static rungs once, the test rung twice, on the tree
 * as it stands. The runner must not cache verdicts (`verdictCache: false`),
 * or the second run is the first one's answer.
 */
export async function captureBaseline(options: {
  runner: GateRunner;
  root: string;
  rungs: readonly GateRung[];
  /** The declared gates, to record each run's command. */
  gates?: readonly GateDefinition[];
  /** A workspace's packages, so their own gates are baselined too (rule 34a). */
  workspace?: { base: string; changed: readonly string[] };
}): Promise<OnboardingBaseline> {
  const { runner, root } = options;
  const command = (id: string) => {
    const g = options.gates?.find((d) => d.id === id);
    return g ? [g.command, ...g.args].join(" ") : undefined;
  };
  const runs: BaselineRun[] = [];
  const record = (res: GateResult, run: number) => {
    for (const o of res.rungResults ?? []) {
      if (o.skipped) continue;
      const own = res.failures.filter((f) => f.gate === o.gate);
      const unavailable =
        o.unavailable || (own.length > 0 && own.every((f) => f.notRun))
          ? (o.reason ?? own[0]?.actual ?? "it could not run")
          : undefined;
      const cmd = command(o.gate);
      runs.push({
        gate: o.gate,
        rung: o.rung,
        run,
        ...(cmd ? { command: cmd } : {}),
        exitCode: o.exitCode,
        failing: own
          .map((f) => failureFingerprint(f, root)?.fingerprint)
          .filter((x): x is string => x !== undefined),
        ...(unavailable ? { unavailable } : {}),
      });
    }
  };
  const keyed = (failures: readonly GateFailure[]) =>
    failures
      .map((f) => failureFingerprint(f, root))
      .filter((x): x is Omit<BaselineEntry, "flaky"> => x !== undefined);

  const entries: BaselineEntry[] = [];
  const flaky: BaselineEntry[] = [];
  const statics = options.rungs.filter((r) => STATIC_RUNGS.has(r));
  // In a workspace, every package's own gates too, as a card's run has them
  // (rule 34a): their pre-existing findings are baselined under their ids.
  const run = (rungs: GateRung[]) =>
    options.workspace
      ? runner.runGates(rungs, root, { workspace: options.workspace })
      : runner.runGates(rungs, root);
  if (statics.length > 0) {
    const res = await run([...statics]);
    record(res, 1);
    entries.push(...keyed(res.failures));
  }
  if (options.rungs.includes("test")) {
    const first = await run(["test"]);
    record(first, 1);
    const second = await run(["test"]);
    record(second, 2);
    const a = keyed(first.failures);
    const b = keyed(second.failures);
    const inB = new Set(b.map((e) => e.fingerprint));
    const inA = new Set(a.map((e) => e.fingerprint));
    // Minor 1: a test that failed in one run only is left to quarantine.
    for (const e of a) {
      if (inB.has(e.fingerprint)) entries.push(e);
      else flaky.push({ ...e, flaky: true });
    }
    for (const e of b) if (!inA.has(e.fingerprint)) flaky.push({ ...e, flaky: true });
  }
  return { entries, runs, flaky };
}

/**
 * The files the source index reads only in part in the tree at `root`
 * (`recovered`, or no adapter): recorded with the baseline, so a project
 * gate's partial verdict on one is pre-existing (GT-IX-1, review M2).
 */
export function partialFiles(root: string): BaselinePartial[] {
  const index = createSourceIndex(root);
  const out: BaselinePartial[] = [];
  for (const file of index.files()) {
    const facts = index.facts(file);
    if (facts && facts.parseStatus !== "ok") {
      out.push({ file, reason: facts.parseReason ?? facts.parseStatus });
    }
  }
  return out;
}

/** Count of each fingerprint: the same diagnostic twice in one file is two entries. */
function counts(entries: readonly { fingerprint: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.fingerprint, (out.get(e.fingerprint) ?? 0) + 1);
  return out;
}

export interface BaselineOptions {
  baseline: readonly BaselineEntry[];
  /**
   * Every judged run's shrink (rule 15a, review M4): the baselined
   * diagnostics it no longer found — empty when all were still there — and
   * the static gates it judged, each of which ran and had its output read.
   * Called once per run that judged a gate, never for a flaky test; a card's
   * shrink is its last judged run's, per gate.
   */
  onShrink?: (gone: BaselineEntry[], gates: string[]) => void | Promise<void>;
  /** The `gates.toml` hash the baseline was taken with (minor 4). */
  gatesSha256?: string | undefined;
  /** The `gates.toml` hash in force: a baseline taken with another is not applied. */
  currentGatesSha256?: string | undefined;
}

/** The evidence's word when the baseline was taken with another `gates.toml` (minor 4). */
export const REBASELINE_NEEDED =
  "the onboarding baseline was taken with another gates.toml, so it is not applied: re-baseline needed (sekhemet onboard)";

/** Whether a gate's run can say a diagnostic disappeared: it ran, and every failure was read. */
function judged(o: RungOutcome, failures: readonly GateFailure[]): boolean {
  if (o.skipped || o.unavailable || o.exitCode < 0 || !STATIC_RUNGS.has(o.rung)) return false;
  if (o.exitCode !== 0 && o.parsedInFull !== true) return false;
  return failures.every((f) => f.gate !== o.gate || (f.location.file !== "." && !f.notRun));
}

/** The outcome's note with one more clause. */
const withNote = (o: RungOutcome, note: string): RungOutcome => ({
  ...o,
  note: o.note ? `${o.note}; ${note}` : note,
});

/**
 * Wrap the declared gates so only failures absent from the baseline count
 * (GT-BF-2). A gate whose every failure is baselined passes, and its outcome
 * says how many pre-existing findings it did not count.
 */
export function withBaseline(inner: GateRunner, options: BaselineOptions): GateRunner {
  const stale =
    options.gatesSha256 !== undefined &&
    options.currentGatesSha256 !== undefined &&
    options.gatesSha256 !== options.currentGatesSha256;
  /** One run's judgement against the baseline. */
  const judge = (res: GateResult, cwd: string) => {
    const remaining = counts(options.baseline);
    const kept: GateFailure[] = [];
    const forgiven: GateFailure[] = [];
    const seen: string[] = [];
    for (const f of res.failures) {
      const key = failureFingerprint(f, cwd);
      if (key) seen.push(key.fingerprint);
      const left = key ? (remaining.get(key.fingerprint) ?? 0) : 0;
      if (key && left > 0) {
        remaining.set(key.fingerprint, left - 1);
        forgiven.push(f);
      } else {
        kept.push(f);
      }
    }
    return { kept, forgiven, seen };
  };
  /** A failed gate every failure of which is baselined: forgiven only if it ran in full and was read in full (B1, M1). */
  const wouldForgive = (o: RungOutcome, j: ReturnType<typeof judge>) =>
    !o.passed &&
    !o.unavailable &&
    !o.skipped &&
    j.forgiven.some((f) => f.gate === o.gate) &&
    !j.kept.some((f) => f.gate === o.gate);
  return {
    ...(inner.gateIds ? { gateIds: inner.gateIds } : {}),
    runGates: async (
      rungs: GateRung[],
      cwd: string,
      runOptions?: RunGatesOptions,
    ): Promise<GateResult> => {
      let res = await inner.runGates(rungs, cwd, runOptions);
      if (options.baseline.length === 0) return res;
      if (stale) {
        return {
          ...res,
          ...(res.rungResults
            ? { rungResults: res.rungResults.map((o) => withNote(o, REBASELINE_NEEDED)) }
            : {}),
        };
      }
      let j = judge(res, cwd);
      // B1: every failure an impacted-only run found is baselined — the full
      // suite runs, and is what is judged.
      if (
        !runOptions?.fullSuite &&
        (res.rungResults ?? []).some((o) => o.fullSuite === false && wouldForgive(o, j))
      ) {
        res = await inner.runGates(rungs, cwd, { ...(runOptions ?? {}), fullSuite: true });
        j = judge(res, cwd);
      }
      // A gate whose failures may not be forgiven keeps every one of them.
      const standing = new Map<string, string>();
      for (const o of res.rungResults ?? []) {
        if (!wouldForgive(o, j)) continue;
        if (o.fullSuite === false) standing.set(o.gate, "only the impacted tests ran");
        else if (o.parsedInFull !== true) {
          standing.set(
            o.gate,
            `its output was not read in full (${o.parseGap ?? "no reading of it was recorded"})`,
          );
        }
      }
      const kept = [...j.kept, ...j.forgiven.filter((f) => standing.has(f.gate))];
      const baselined = new Map<string, number>();
      for (const f of j.forgiven) {
        if (!standing.has(f.gate)) baselined.set(f.gate, (baselined.get(f.gate) ?? 0) + 1);
      }
      const outcomes = (res.rungResults ?? []).map((o): RungOutcome => {
        const why = standing.get(o.gate);
        if (why) {
          return withNote(
            o,
            `every failure is in the onboarding baseline, but ${why}: the failure stands`,
          );
        }
        const n = baselined.get(o.gate) ?? 0;
        if (n === 0) return o;
        const note = `${n} pre-existing ${n === 1 ? "finding" : "findings"} from the onboarding baseline not counted`;
        const ownLeft = kept.some((f) => f.gate === o.gate);
        return withNote(
          { ...o, ...(!o.passed && !ownLeft && !o.unavailable ? { passed: true } : {}) },
          note,
        );
      });
      if (options.onShrink) {
        const observed = counts(j.seen.map((fingerprint) => ({ fingerprint })));
        const ran = new Set(outcomes.filter((o) => judged(o, res.failures)).map((o) => o.gate));
        const gone: BaselineEntry[] = [];
        const left = new Map(observed);
        for (const e of options.baseline) {
          if (e.flaky || !ran.has(e.gate)) continue;
          const n = left.get(e.fingerprint) ?? 0;
          if (n > 0) left.set(e.fingerprint, n - 1);
          else gone.push(e);
        }
        // Every judged run, an empty shrink too (M4).
        if (ran.size > 0) await options.onShrink(gone, [...ran].sort());
      }
      const passed =
        kept.length === 0 && outcomes.every((o) => o.passed || (o.skipped && !o.unavailable));
      return {
        ...res,
        passed: res.passed || passed,
        failures: kept,
        ...(res.rungResults ? { rungResults: outcomes } : {}),
      };
    },
  };
}

/**
 * The baseline in force, folded from the ledger: the last recorded baseline,
 * less every shrink recorded after it — a shrink found on a card's tree only
 * once that card is accepted, since a rejected card's fix never reaches the
 * integration branch. Undefined when no baseline was recorded.
 */
export function baselineFromEvents(events: readonly { type: string; payload: unknown }[]):
  | {
      entries: BaselineEntry[];
      /** Files only partly readable at onboarding (GT-IX-1, review M2). */
      partial: BaselinePartial[];
      /** The `gates.toml` hash the baseline was taken with (minor 4). */
      gatesSha256?: string;
    }
  | undefined {
  const accepted = new Set(
    events
      .filter((e) => e.type === "card/accepted")
      .map((e) => (e.payload as { id?: string } | null)?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  let entries: BaselineEntry[] | undefined;
  let partial: BaselinePartial[] = [];
  let gatesSha256: string | undefined;
  // Per card and per gate, the fingerprints its last judged run found gone
  // (review M4): a later run that found a diagnostic again takes it back.
  let perCard = new Map<string, Map<string, Map<string, number>>>();
  const remove = (fp: string, times: number) => {
    for (let i = 0; i < times && entries; i++) {
      const at = entries.findIndex((x) => x.fingerprint === fp);
      if (at === -1) return;
      entries.splice(at, 1);
    }
  };
  const settle = () => {
    for (const [card, gates] of perCard) {
      if (!accepted.has(card)) continue;
      for (const fps of gates.values()) for (const [fp, n] of fps) remove(fp, n);
    }
    perCard = new Map();
  };
  for (const e of events) {
    if (e.type !== BASELINE_EVENT) continue;
    const p = (e.payload ?? {}) as {
      kind?: string;
      entries?: BaselineEntry[];
      partial?: BaselinePartial[];
      gatesSha256?: string;
      fingerprints?: string[];
      gates?: string[];
      card?: string;
    };
    if (p.kind === "recorded" && Array.isArray(p.entries)) {
      perCard = new Map();
      entries = [...p.entries];
      partial = Array.isArray(p.partial) ? [...p.partial] : [];
      gatesSha256 = typeof p.gatesSha256 === "string" ? p.gatesSha256 : undefined;
    } else if (p.kind === "shrink" && entries && Array.isArray(p.fingerprints)) {
      const found = counts(p.fingerprints.map((fingerprint) => ({ fingerprint })));
      if (p.card === undefined) {
        for (const [fp, n] of found) remove(fp, n);
        continue;
      }
      const gateOf = new Map(entries.map((x) => [x.fingerprint, x.gate] as const));
      const gates = Array.isArray(p.gates)
        ? p.gates
        : [...new Set(p.fingerprints.map((fp) => gateOf.get(fp) ?? ""))];
      const mine = perCard.get(p.card) ?? new Map<string, Map<string, number>>();
      for (const g of gates) {
        const fps = new Map<string, number>();
        for (const [fp, n] of found) if ((gateOf.get(fp) ?? "") === g) fps.set(fp, n);
        mine.set(g, fps);
      }
      perCard.set(p.card, mine);
    }
  }
  settle();
  return entries
    ? { entries, partial, ...(gatesSha256 !== undefined ? { gatesSha256 } : {}) }
    : undefined;
}
