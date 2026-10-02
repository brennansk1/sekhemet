import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  type GateFailure,
  type GateResult,
  type GateRung,
  type GateRunner,
  RERUN_GATES,
  type RunGatesOptions,
  type RungOutcome,
  type SourceIndex,
  announceGateStart,
  createSourceIndex,
  gateCopy,
} from "@sekhemet/gates";
import { blockLines, isHeading, markdownBlocks } from "./markdown.js";
import { changedSources } from "./reachability_gate.js";

/**
 * The architecture gate: a card may not break an invariant the project's
 * brief declares.
 *
 * Building this harness produced three incompatible definitions of one
 * partition key, each reasonable where it was written, and nothing noticed
 * until an audit. An invariant stated only in prose is a hope; this gate makes
 * the ones that can be checked into gates.
 *
 * The brief's `## Invariants` section is read line by line. Two sentence forms
 * are enforced, because they are the two ways that audit found the whole
 * decaying — a boundary crossed, and a definition duplicated:
 *
 *   - `src/db/` does not import `src/cli.ts`
 *   - `PartitionKey` is defined only in `src/types.ts`
 *
 * Anything else in the section is reported as **not enforced** — visible to
 * the human, never silently treated as holding. Like the other project gates,
 * it judges only files the card changed, so a card is never failed for a
 * violation someone else left.
 */

export type Invariant =
  | { kind: "no-import"; from: string; to: string; text: string }
  | { kind: "defined-only"; name: string; file: string; text: string };

export interface ParsedInvariants {
  rules: Invariant[];
  unenforced: string[];
}

const NO_IMPORT = /^`([^`]+)`\s+(?:does|must)\s+not\s+import\s+`([^`]+)`\.?$/i;
const DEFINED_ONLY = /^`([A-Za-z_$][\w$]*)`\s+is\s+defined\s+only\s+in\s+`([^`]+)`\.?$/i;

export function parseInvariants(brief: string): ParsedInvariants {
  const rules: Invariant[] = [];
  const unenforced: string[] = [];
  let inSection = false;
  // Read as Markdown (DEC-44): comments are not declarations (a brief shows
  // the forms as examples in one), a `#` line in a code block is not a
  // heading, and an item wrapped onto a second line is one invariant. A code
  // block's lines are still read, so nothing in the section goes unreported.
  for (const block of markdownBlocks(brief)) {
    if (isHeading(block)) {
      inSection = /^invariants\b/i.test(block.text.trim());
      continue;
    }
    if (!inSection) continue;
    for (const line of blockLines(block)) {
      const imp = NO_IMPORT.exec(line);
      const def = DEFINED_ONLY.exec(line);
      if (imp?.[1] && imp[2])
        rules.push({ kind: "no-import", from: imp[1], to: imp[2], text: line });
      else if (def?.[1] && def[2])
        rules.push({ kind: "defined-only", name: def[1], file: def[2], text: line });
      else unenforced.push(line);
    }
  }
  return { rules, unenforced };
}

/** The two sentence forms the gate enforces, as a person restates an invariant in them (GT-N1-1). */
export const INVARIANT_FORMS = [
  "`A/` does not import `B`",
  "`Name` is defined only in `path`",
] as const;

/** An Invariants line the gate cannot check, and the forms it could be restated in. */
export interface UnenforcedInvariant {
  line: string;
  restate: string[];
}

/**
 * The brief's invariant lines that match neither enforced form (gates rule
 * 26, GT-N1-1): shown to a person as "not enforced" — on the board's gate
 * contract and in every card's evidence — never silently treated as holding.
 * Empty without a brief.
 */
export function unenforcedInvariants(briefPath: string): UnenforcedInvariant[] {
  if (!existsSync(briefPath)) return [];
  return parseInvariants(readFileSync(briefPath, "utf8")).unenforced.map((line) => ({
    line,
    restate: [...INVARIANT_FORMS],
  }));
}

/** The evidence's note for the lines the gate did not enforce, if any. */
function unenforcedNote(lines: readonly UnenforcedInvariant[]): string | undefined {
  if (lines.length === 0) return undefined;
  const n = lines.length;
  return `${n} invariant ${n === 1 ? "line" : "lines"} in the brief ${n === 1 ? "is" : "are"} not enforced: ${lines
    .map((l) => `"${l.line}"`)
    .join(
      "; ",
    )}. Restate ${n === 1 ? "it" : "each"} as ${INVARIANT_FORMS.join(" or ")} for the architecture check to verify it.`;
}

const stripExt = (p: string): string => p.replace(/\.[cm]?[jt]sx?$/, "");

/** Does `file` fall under `pattern` — the same file, or inside a directory ending `/`? */
function covers(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  return stripExt(file) === stripExt(pattern) || file.startsWith(`${pattern}/`);
}

/**
 * Repository-relative targets of a file's relative imports and re-exports,
 * of every kind (static, type, dynamic, `require`), from the source index
 * (T2): a comment or a string naming a path is not an import. A target the
 * resolver cannot find is judged by the path as written, so a crossing into a
 * file not created yet is still a crossing.
 */
function relativeImports(index: SourceIndex, file: string): string[] {
  const facts = index.facts(file);
  const specifiers = [
    ...(facts?.imports ?? []).map((i) => i.specifier),
    ...(facts?.reExports ?? []).map((r) => r.specifier),
  ].filter((s) => /^\.{1,2}\//.test(s));
  return specifiers.map((s) => {
    const target = index.resolve(file, s);
    return target.kind === "file" ? target.path : normalize(join(dirname(file), s));
  });
}

/**
 * Whether a file declares `name` at its top level (GT-T2-2): an import of
 * the name, a comment naming it or a local variable inside a function is not
 * a second definition.
 */
function definesName(index: SourceIndex, file: string, name: string): boolean {
  return (index.facts(file)?.declarations ?? []).some((d) => d.topLevel && d.name === name);
}

export interface ArchitectureOptions {
  /** Where the brief is; defaults to the checked-out tree's `.sekhemet/brief.md`. */
  briefPath?: string;
  base?: string;
  /**
   * Files the onboarding baseline recorded as readable only in part
   * (GT-IX-1, review M2): pre-existing, never the Worker's to repair.
   */
  baselinePartial?: readonly { file: string; reason: string }[];
}

export function architectureGate(root: string, options: ArchitectureOptions = {}): GateFailure[] {
  const briefPath = options.briefPath ?? join(root, ".sekhemet", "brief.md");
  if (!existsSync(briefPath)) return [];
  const { rules } = parseInvariants(readFileSync(briefPath, "utf8"));
  if (!rules.length) return [];

  const failures: GateFailure[] = [];
  const fail = (file: string, rule: Invariant, actual: string, action: string): void => {
    failures.push({
      rung: "hygiene",
      gate: "architecture",
      layer: "hygiene",
      exitCode: 1,
      errorExcerpt: `${file}: breaks the brief's invariant "${rule.text}"`,
      suggestedFixFiles: [file],
      location: { file, line: 0, column: 0 },
      expected: rule.text.replace(/`/g, ""),
      actual,
      minimalRepro: RERUN_GATES,
      suggestedAction: action,
    });
  };

  const index = createSourceIndex(root);
  const known = new Set((options.baselinePartial ?? []).map((p) => p.file));
  for (const file of changedSources(root, options.base ?? "main")) {
    // GT-IX-1: a file that did not parse cleanly is not judged as holding —
    // the Worker's to repair unless the onboarding baseline recorded it (M2).
    const facts = index.facts(file);
    if (facts && facts.parseStatus !== "ok" && !known.has(file)) {
      const reason = facts.parseReason ?? facts.parseStatus;
      failures.push({
        rung: "hygiene",
        gate: "architecture",
        layer: "hygiene",
        exitCode: 1,
        errorExcerpt: `${file}: does not parse cleanly (${reason}), so the brief's invariants cannot be judged on it`,
        suggestedFixFiles: [file],
        location: { file, line: 0, column: 0 },
        expected: `${file} parses without errors`,
        actual: reason,
        minimalRepro: RERUN_GATES,
        suggestedAction: gateCopy.sourceNotParsed("architecture", file, reason),
      });
    }
    for (const rule of rules) {
      if (rule.kind === "no-import") {
        if (!covers(rule.from, file)) continue;
        const crossing = relativeImports(index, file).find((t) => covers(rule.to, t));
        if (crossing) {
          fail(
            file,
            rule,
            `${file} imports ${crossing}`,
            gateCopy.architectureImport(rule.from, rule.to, file),
          );
        }
      } else if (!covers(rule.file, file) && definesName(index, file, rule.name)) {
        fail(
          file,
          rule,
          `${file} defines ${rule.name}`,
          gateCopy.architectureHome(rule.name, rule.file, file),
        );
      }
    }
  }
  return failures;
}

/** Wrap a gate runner so every verification enforces the brief's invariants. */
export function withArchitectureGate(
  inner: GateRunner,
  options: ArchitectureOptions = {},
): GateRunner {
  return {
    // GT-M6-5: the gate this wrapper adds, for `note`'s enum.
    gateIds: [...(inner.gateIds ?? []), "architecture"],
    runGates: async (
      rungs: GateRung[],
      cwd: string,
      runOptions?: RunGatesOptions,
    ): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd, runOptions);
      // DB-N2-10: the page names this check while it runs.
      announceGateStart(runOptions, { gate: "architecture", rung: "hygiene" });
      const started = Date.now();
      const failures = architectureGate(cwd, options);
      const note = unenforcedNote(
        unenforcedInvariants(options.briefPath ?? join(cwd, ".sekhemet", "brief.md")),
      );
      const partial = failures
        .filter((f) => f.gate === "architecture" && /does not parse cleanly/.test(f.errorExcerpt))
        .map((f) => ({ file: f.location?.file ?? "", reason: f.actual }));
      const outcome: RungOutcome = {
        gate: "architecture",
        rung: "hygiene",
        layer: "hygiene",
        passed: failures.length === 0,
        exitCode: failures.length === 0 ? 0 : 1,
        durationMs: Date.now() - started,
        // GT-N1-1: what the gate did not check is in every card's evidence.
        ...(note ? { note } : {}),
        // GT-IX-1: the files its verdict is partial on.
        ...(partial.length ? { partial } : {}),
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
