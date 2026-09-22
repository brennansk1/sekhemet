import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  type GateFailure,
  type GateResult,
  type GateRung,
  type GateRunner,
  type RungOutcome,
  exportsFromSource,
  moduleExports,
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
 * appears in an import clause, without resolving which module that clause
 * names. A gate that wrongly fails a card costs a repair cycle and teaches the
 * model the gate is noise; one that misses some dead code costs a line. Only
 * exports the card itself added are judged, so it never fails a card for code
 * someone else left.
 */

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST = /(^|\/)(tests?|__tests__|acceptance)\/|\.(spec|test)\.[cm]?tsx?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".sekhemet", "coverage"]);
/** Files whose exports are a public surface by position, not by import. */
const ENTRY = /^(index|main|cli|server|bin)\.[cm]?tsx?$/;

export interface UnreachableExport {
  file: string;
  name: string;
}

function walk(dir: string, root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, root, out);
    else if (SOURCE.test(name)) out.push(relative(root, full));
  }
}

/** Every name that appears in an import clause of a file. */
function importedNames(file: string): Set<string> {
  const names = new Set<string>();
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return names;
  }
  for (const m of src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    const clause = m[1] ?? "";
    const braced = /\{([^}]*)\}/.exec(clause)?.[1];
    for (const part of (braced ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.add(name);
    }
    const bare = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, " ")
      .trim();
    for (const word of bare.split(/\s+/)) if (/^[A-Za-z_$][\w$]*$/.test(word)) names.add(word);
  }
  // `export { x } from "./y"` re-exports x through a barrel, which is use.
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Source files the card changed against `base`, committed or not. */
export function changedSources(root: string, base: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", base], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && SOURCE.test(f) && !TEST.test(f) && existsSync(join(root, f)));
  } catch {
    // Not a git repository, or no such base: judge nothing rather than guess.
    return [];
  }
}

/** The exports a file had at `base`; empty for a file the card created. */
function exportsAtBase(root: string, file: string, base: string): Set<string> {
  try {
    const src = execFileSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(exportsFromSource(src));
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

export function findUnreachable(
  root: string,
  base = "main",
  contract: CardContract = {},
): UnreachableExport[] {
  const changed = changedSources(root, base);
  if (!changed.length) return [];

  const all: string[] = [];
  walk(root, root, all);
  // Who counts as a user: production source, and the acceptance contract.
  const users = all.filter((f) => !TEST.test(f) || /(^|\/)acceptance\//.test(f));
  const staged = all.filter((f) => /(^|\/)tests?\//.test(f));
  const byFile = new Map<string, Set<string>>();
  const declaredContract = new Set((contract.tests ?? []).map((c) => basename(c)));
  // A name the card was asked to produce is required by that request.
  const askedFor = (name: string) =>
    new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`).test(contract.text ?? "");
  const namesUsedOutside = (file: string): Set<string> => {
    const out = new Set<string>();
    for (const u of [...users, ...staged]) {
      if (u === file) continue;
      // A card's own unit tests do not make its code reachable; a staged
      // acceptance test does. Staged tests are copied from acceptance/, so a
      // test that exists there too is the contract.
      if (TEST.test(u) && !/(^|\/)acceptance\//.test(u)) {
        const declared = declaredContract.has(basename(u));
        const byLayout = existsSync(join(root, "acceptance", basename(u)));
        if (!declared && !byLayout) continue;
      }
      let names = byFile.get(u);
      if (!names) {
        names = importedNames(join(root, u));
        byFile.set(u, names);
      }
      for (const n of names) out.add(n);
    }
    return out;
  };

  const dead: UnreachableExport[] = [];
  for (const file of changed) {
    if (ENTRY.test(basename(file))) continue;
    const now = moduleExports(join(root, file)) ?? [];
    const before = exportsAtBase(root, file, base);
    const added = now.filter((n) => !before.has(n));
    if (!added.length) continue;
    const used = namesUsedOutside(file);
    for (const name of added) if (!used.has(name) && !askedFor(name)) dead.push({ file, name });
  }
  return dead;
}

export function reachabilityGate(
  root: string,
  base = "main",
  contract: CardContract = {},
): GateFailure[] {
  return findUnreachable(root, base, contract).map(({ file, name }) => ({
    rung: "hygiene",
    gate: "reachability",
    layer: "hygiene",
    exitCode: 1,
    errorExcerpt: `${file}: export ${name} is used by nothing in production and required by no acceptance test`,
    suggestedFixFiles: [file],
    location: { file, line: 0, column: 0 },
    expected: "every export this card adds is used or required",
    actual: `${name} has no caller`,
    // Completable in one step, as every remedy must be: the model already
    // knows the name and the file, and each option is a single edit.
    suggestedAction: `Nothing uses ${name}. Either wire it into the code that needs it, or remove the export (keep it unexported if it is a local helper). If a later card genuinely needs it, say so with note rather than leaving it dangling.`,
  }));
}

/** Wrap a gate runner so every verification refuses code nothing uses. */
export function withReachabilityGate(
  inner: GateRunner,
  contract: CardContract = {},
  base = "main",
): GateRunner {
  return {
    runGates: async (rungs: GateRung[], cwd: string): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd);
      const started = Date.now();
      const failures = reachabilityGate(cwd, base, contract);
      const outcome: RungOutcome = {
        gate: "reachability",
        rung: "hygiene",
        layer: "hygiene",
        passed: failures.length === 0,
        exitCode: failures.length === 0 ? 0 : 1,
        durationMs: Date.now() - started,
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
