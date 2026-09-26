import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type GateFailure,
  type GateResult,
  type GateRung,
  type GateRunner,
  RERUN_GATES,
  type RunGatesOptions,
  type RungOutcome,
  type SourceFacts,
  type SourceIndex,
  createSourceIndex,
  gateCopy,
} from "@sekhemet/gates";

/**
 * The reachability gate: a card may not add code that nothing uses.
 *
 * Building this harness produced eleven modules that were written, tested and
 * never wired in — dead by the project's own audit rule, "code reachable only
 * from tests is DEAD" — and nothing noticed until an audit weeks later. That
 * is the characteristic way a project decays under an agent that is good at
 * individual changes: each change is fine and the whole stops holding
 * together. This gate catches it at the change that causes it.
 *
 * **What counts as reachable.** An export a card adds is reachable when
 * production code imports it, or when an acceptance test requires it.
 * Acceptance tests count because they are the project's contract: in every
 * fixture, each card's acceptance test imports exactly the exports that card
 * exists to produce, so a leaf built before its caller is still reachable
 * through the contract that asked for it. A card's own unit tests do not
 * count — that is precisely the pattern the audit calls dead.
 *
 * The naive rule, "no production caller fails the card", was rejected before
 * it was written: it would fail every leaf card in every project, because
 * leaves are built before the code that calls them.
 *
 * **It errs toward reachable.** A name is treated as imported wherever it
 * appears in an import clause or is read as `ns.name` through a namespace
 * import, without resolving which module that clause names. A module's every
 * export is used when its namespace is used whole, or when an entry point
 * re-exports it with `export *`, directly or through other barrels (GT-T2-1).
 * Every fact comes from the source index (T2). A gate that wrongly fails a card costs a repair cycle and teaches the
 * model the gate is noise; one that misses some dead code costs a line. Only
 * exports the card itself added are judged, so it never fails a card for code
 * someone else left.
 */

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST = /(^|\/)(tests?|__tests__|acceptance)\/|\.(spec|test)\.[cm]?tsx?$/;
/** Files whose exports are a public surface by position, not by import. */
const ENTRY = /^(index|main|cli|server|bin)\.[cm]?tsx?$/;

export interface UnreachableExport {
  file: string;
  name: string;
}

/** The files a module's names reach through `export *` and `export * as`, itself included. */
function starClosure(index: SourceIndex, file: string, out = new Set<string>()): Set<string> {
  if (out.has(file)) return out;
  out.add(file);
  for (const r of index.facts(file)?.reExports ?? []) {
    if (r.kind === "named") continue;
    const target = index.resolve(file, r.specifier);
    if (target.kind === "file") starClosure(index, target.path, out);
  }
  return out;
}

/**
 * What one user file uses: every name in its import clauses and named
 * re-exports, every member it reads through a namespace, and the files whose
 * whole surface it uses (a namespace used whole, `export * as`).
 */
function usesOf(index: SourceIndex, file: string): { names: Set<string>; whole: Set<string> } {
  const names = new Set<string>();
  const whole = new Set<string>();
  const facts: SourceFacts | undefined = index.facts(file);
  for (const imp of facts?.imports ?? []) {
    for (const b of imp.bindings) {
      names.add(b.imported);
      // A default import is known by the name it is given.
      if (b.imported === "default") names.add(b.local);
    }
    if (!imp.namespace) continue;
    for (const m of imp.namespace.members) names.add(m);
    if (imp.namespace.escapes) {
      const target = index.resolve(file, imp.specifier);
      if (target.kind === "file") for (const f of starClosure(index, target.path)) whole.add(f);
    }
  }
  // `export { x } from "./y"` re-exports x through a barrel, which is use.
  for (const r of facts?.reExports ?? []) {
    for (const n of r.names) names.add(n.imported);
    if (r.kind === "namespace") {
      const target = index.resolve(file, r.specifier);
      if (target.kind === "file") for (const f of starClosure(index, target.path)) whole.add(f);
    }
  }
  return { names, whole };
}

/** The names a file exports itself: its own exports (a default one by its local name) and its named re-exports. */
function ownExports(facts: SourceFacts | undefined): string[] {
  const names = new Set<string>();
  for (const e of facts?.exports ?? []) {
    if (e.name === "default") {
      if (e.local) names.add(e.local);
    } else if (e.name !== "export=") names.add(e.name);
  }
  for (const r of facts?.reExports ?? []) {
    if (r.kind === "named") for (const n of r.names) names.add(n.exported);
    else if (r.kind === "namespace" && r.namespace) names.add(r.namespace);
  }
  return [...names].sort();
}

/** Source files the card changed against `base`, committed or not. */
export function changedSources(root: string, base: string): string[] {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    // Files the card created and has not committed are the card's too (gates
    // rule 15, GT-N2-4); ignored files are not.
    const listed = `${git(["diff", "--name-only", base])}\n${git(["ls-files", "--others", "--exclude-standard"])}`;
    return [...new Set(listed.split("\n").map((f) => f.trim()))].filter(
      (f) => f && SOURCE.test(f) && !TEST.test(f) && existsSync(join(root, f)),
    );
  } catch {
    // Not a git repository, or no such base: judge nothing rather than guess.
    return [];
  }
}

/** The exports a file had at `base`; empty for a file the card created. */
function exportsAtBase(index: SourceIndex, root: string, file: string, base: string): Set<string> {
  try {
    const src = execFileSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(ownExports(index.factsOfText(file, src)));
  } catch {
    return new Set();
  }
}

/**
 * New exports the card added that nothing in production or the contract uses.
 *
 * The contract is everything that asked for this card's work: its acceptance
 * tests, wherever they live — a repository with an `acceptance/` directory
 * declares them by layout, but most do not — and its own spec and acceptance
 * criteria. A card whose spec says "export a" has been asked for `a`, even
 * before any test or caller exists; a gate that ignored the spec failed every
 * such card in the harness's own test suite.
 */
export interface CardContract {
  tests?: readonly string[];
  /** The card's spec and acceptance criteria, as one text. */
  text?: string;
}

/**
 * Which exports are judged: those the card added against its base (the
 * gate), or every export of every production source file — the audit of a
 * whole repository, where the base is not read (GT-T2-4).
 */
export type ReachabilityScope = "added" | "every";

/** A file the gate read facts from that did not parse cleanly (GT-IX-1). */
export interface PartialFile {
  file: string;
  reason: string;
}

/** What the gate found: the unreachable exports, and the files its verdict is partial on. */
export interface ReachabilityVerdict {
  unreachable: UnreachableExport[];
  /** Files read whose parse was `recovered` or `unsupported`, each with why. */
  partial: PartialFile[];
  /** The files judged: those whose exports were candidates. */
  judged: string[];
}

export function findUnreachable(
  root: string,
  base = "main",
  contract: CardContract = {},
  scope: ReachabilityScope = "added",
): UnreachableExport[] {
  return judgeReachability(root, base, contract, scope).unreachable;
}

/** The gate's whole verdict: unreachable exports and the files it could only read in part. */
export function judgeReachability(
  root: string,
  base = "main",
  contract: CardContract = {},
  scope: ReachabilityScope = "added",
): ReachabilityVerdict {
  const index = createSourceIndex(root);
  const files =
    scope === "every"
      ? index.files().filter((f) => SOURCE.test(f) && !TEST.test(f) && !f.endsWith(".d.ts"))
      : changedSources(root, base);
  if (!files.length) return { unreachable: [], partial: [], judged: [] };
  const entries = entryFiles(index);
  const candidates: UnreachableExport[] = [];
  for (const file of files) {
    if (entries.has(file)) continue;
    const before = scope === "every" ? new Set<string>() : exportsAtBase(index, root, file, base);
    for (const name of ownExports(index.facts(file))) {
      if (!before.has(name)) candidates.push({ file, name });
    }
  }
  const read = new Set<string>(files);
  const unreachable = unreachableAmong(index, candidates, contract, entries, read);
  const partial: PartialFile[] = [];
  for (const file of [...read].sort()) {
    const facts = index.facts(file);
    if (facts && facts.parseStatus !== "ok") {
      partial.push({ file, reason: facts.parseReason ?? facts.parseStatus });
    }
  }
  return { unreachable, partial, judged: files };
}

/**
 * The files whose exports are a public surface by position: an entry-point
 * name (`index.ts`, `main.ts`, …) and every workspace package's declared
 * entry points (IX-5).
 */
function entryFiles(index: SourceIndex): Set<string> {
  const out = new Set(
    index.files().filter((f) => SOURCE.test(f) && !TEST.test(f) && ENTRY.test(basename(f))),
  );
  for (const pkg of index.workspace()?.packages ?? []) {
    for (const e of pkg.entryPoints) if (e.file) out.add(e.file);
  }
  return out;
}

/** Of `candidates`, the exports nothing in production or the contract uses. */
function unreachableAmong(
  index: SourceIndex,
  candidates: readonly UnreachableExport[],
  contract: CardContract,
  entries: ReadonlySet<string>,
  read: Set<string>,
): UnreachableExport[] {
  if (!candidates.length) return [];
  const root = index.root;
  const all = index.files();
  // Who counts as a user: production source, and the acceptance contract.
  const users = all.filter((f) => !TEST.test(f) || /(^|\/)acceptance\//.test(f));
  const staged = all.filter((f) => /(^|\/)tests?\//.test(f));
  const declaredContract = new Set((contract.tests ?? []).map((c) => basename(c)));
  // A name the card was asked to produce is required by that request.
  const askedFor = (name: string) =>
    new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`).test(contract.text ?? "");
  const counted = [...users, ...staged].filter((u) => {
    // A card's own unit tests do not make its code reachable; a staged
    // acceptance test does. Staged tests are copied from acceptance/, so a
    // test that exists there too is the contract.
    if (!TEST.test(u) || /(^|\/)acceptance\//.test(u)) return true;
    return declaredContract.has(basename(u)) || existsSync(join(root, "acceptance", basename(u)));
  });
  for (const u of counted) read.add(u);
  const uses = new Map(counted.map((u) => [u, usesOf(index, u)] as const));
  // An entry point's `export *`, followed through barrels, is a public surface.
  const publicSurface = new Set<string>();
  for (const entry of entries) {
    read.add(entry);
    for (const f of starClosure(index, entry)) {
      read.add(f);
      if (f !== entry) publicSurface.add(f);
    }
  }
  const usedOutside = (file: string, name: string): boolean => {
    if (publicSurface.has(file)) return true;
    for (const [u, use] of uses) {
      if (u === file) continue;
      if (use.names.has(name) || use.whole.has(file)) return true;
    }
    return false;
  };
  return candidates.filter(({ file, name }) => !usedOutside(file, name) && !askedFor(name));
}

/**
 * The failures for a verdict: each unreachable export, and each file read
 * that did not parse (GT-IX-1). A file the card changed is the Worker's to
 * repair; any other is a named failure routed to a person (`forPerson`,
 * review M2), unless the onboarding baseline recorded it (`baselined`).
 */
function verdictFailures(
  verdict: ReachabilityVerdict,
  baselined: ReadonlySet<string> = new Set(),
): GateFailure[] {
  const judged = new Set(verdict.judged);
  const elsewhere: GateFailure[] = verdict.partial
    .filter((p) => !judged.has(p.file) && !baselined.has(p.file))
    .map(({ file, reason }) => ({
      rung: "hygiene",
      gate: "reachability",
      layer: "hygiene",
      exitCode: 1,
      errorExcerpt: `${file}: does not parse cleanly (${reason}); the card did not change it, so the verdict on what it uses is partial`,
      suggestedFixFiles: [],
      location: { file, line: 0, column: 0 },
      expected: `${file} parses without errors, or the onboarding baseline records it`,
      actual: reason,
      minimalRepro: RERUN_GATES,
      suggestedAction: gateCopy.sourceNotParsedForPerson("reachability", file, reason),
      forPerson: true,
    }));
  const unparsed: GateFailure[] = verdict.partial
    .filter((p) => judged.has(p.file) && !baselined.has(p.file))
    .map(({ file, reason }) => ({
      rung: "hygiene",
      gate: "reachability",
      layer: "hygiene",
      exitCode: 1,
      errorExcerpt: `${file}: does not parse cleanly (${reason}), so its exports cannot be judged`,
      suggestedFixFiles: [file],
      location: { file, line: 0, column: 0 },
      expected: `${file} parses without errors`,
      actual: reason,
      minimalRepro: RERUN_GATES,
      suggestedAction: gateCopy.sourceNotParsed("reachability", file, reason),
    }));
  return [
    ...unparsed,
    ...elsewhere,
    ...verdict.unreachable.map(
      ({ file, name }): GateFailure => ({
        rung: "hygiene",
        gate: "reachability",
        layer: "hygiene",
        exitCode: 1,
        errorExcerpt: `${file}: export ${name} is used by nothing in production and required by no acceptance test`,
        suggestedFixFiles: [file],
        location: { file, line: 0, column: 0 },
        expected: "every export this card adds is used or required",
        actual: `${name} has no caller`,
        minimalRepro: RERUN_GATES,
        // Completable in one step, as every remedy must be: the model already
        // knows the name and the file, and each option is a single edit.
        suggestedAction: gateCopy.unusedExport(name),
      }),
    ),
  ];
}

export function reachabilityGate(
  root: string,
  base = "main",
  contract: CardContract = {},
  scope: ReachabilityScope = "added",
): GateFailure[] {
  return verdictFailures(judgeReachability(root, base, contract, scope));
}

/** The evidence's note for a partial verdict (GT-IX-1). */
export function partialNote(partial: readonly PartialFile[]): string | undefined {
  if (partial.length === 0) return undefined;
  return `partial: ${partial.map((p) => `${p.file} (${p.reason})`).join("; ")}`;
}

/** What the reachability gate reads from the onboarding baseline. */
export interface ReachabilityOptions {
  /**
   * Files the source index could read only in part at onboarding (GT-IX-1,
   * review M2): a partial verdict on one is pre-existing — forgiven, and
   * listed in the evidence as baselined.
   */
  baselinePartial?: readonly { file: string; reason: string }[];
}

/** Wrap a gate runner so every verification refuses code nothing uses. */
export function withReachabilityGate(
  inner: GateRunner,
  contract: CardContract = {},
  base = "main",
  options: ReachabilityOptions = {},
): GateRunner {
  const baselined = new Set((options.baselinePartial ?? []).map((p) => p.file));
  return {
    // GT-M6-5: the gate this wrapper adds, for `note`'s enum.
    gateIds: [...(inner.gateIds ?? []), "reachability"],
    runGates: async (
      rungs: GateRung[],
      cwd: string,
      runOptions?: RunGatesOptions,
    ): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd, runOptions);
      const started = Date.now();
      const verdict = judgeReachability(cwd, base, contract);
      const failures = verdictFailures(verdict, baselined);
      const open = verdict.partial.filter((p) => !baselined.has(p.file));
      const known = verdict.partial.filter((p) => baselined.has(p.file));
      const note = [
        partialNote(open),
        known.length
          ? `partial on files the onboarding baseline recorded, not counted: ${known.map((p) => p.file).join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("; ");
      const outcome: RungOutcome = {
        gate: "reachability",
        rung: "hygiene",
        layer: "hygiene",
        // GT-IX-1: a verdict read from a file that did not parse is never a
        // pass — unless the onboarding baseline recorded that file (M2).
        passed: failures.length === 0 && open.length === 0,
        exitCode: failures.length === 0 ? 0 : 1,
        durationMs: Date.now() - started,
        ...(verdict.partial.length
          ? {
              partial: verdict.partial.map((p) =>
                baselined.has(p.file) ? { ...p, baselined: true } : p,
              ),
            }
          : {}),
        ...(note ? { note } : {}),
      };
      return {
        ...res,
        passed: res.passed && failures.length === 0,
        failures: [...res.failures, ...failures],
        rungResults: [...(res.rungResults ?? []), outcome],
      };
    },
  };
}
