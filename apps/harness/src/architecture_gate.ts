import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { GateFailure, GateResult, GateRung, GateRunner, RungOutcome } from "@sekhemet/gates";
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
  for (const raw of brief.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw.trim());
    if (heading) {
      inSection = /^invariants\b/i.test(heading[1] ?? "");
      continue;
    }
    if (!inSection) continue;
    const line = raw
      .trim()
      .replace(/^[-*]\s+/, "")
      .trim();
    if (!line) continue;
    const imp = NO_IMPORT.exec(line);
    const def = DEFINED_ONLY.exec(line);
    if (imp?.[1] && imp[2]) rules.push({ kind: "no-import", from: imp[1], to: imp[2], text: line });
    else if (def?.[1] && def[2])
      rules.push({ kind: "defined-only", name: def[1], file: def[2], text: line });
    else unenforced.push(line);
  }
  return { rules, unenforced };
}

const stripExt = (p: string): string => p.replace(/\.[cm]?[jt]sx?$/, "");

/** Does `file` fall under `pattern` — the same file, or inside a directory ending `/`? */
function covers(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  return stripExt(file) === stripExt(pattern) || file.startsWith(`${pattern}/`);
}

/** Repository-relative targets of a file's relative imports. */
function relativeImports(root: string, file: string): string[] {
  const src = readFileSync(join(root, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from\s+|import\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    if (m[1]) out.push(normalize(join(dirname(file), m[1])));
  }
  return out;
}

function definesName(root: string, file: string, name: string): boolean {
  const src = readFileSync(join(root, file), "utf8");
  return new RegExp(
    `\\b(?:interface|type|class|function|enum|const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b`,
  ).test(src);
}

export interface ArchitectureOptions {
  /** Where the brief is; defaults to the checked-out tree's `.sekhemet/brief.md`. */
  briefPath?: string;
  base?: string;
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
      suggestedAction: action,
    });
  };

  for (const file of changedSources(root, options.base ?? "main")) {
    for (const rule of rules) {
      if (rule.kind === "no-import") {
        if (!covers(rule.from, file)) continue;
        const crossing = relativeImports(root, file).find((t) => covers(rule.to, t));
        if (crossing) {
          fail(
            file,
            rule,
            `${file} imports ${crossing}`,
            `The brief declares that ${rule.from} does not import ${rule.to}. Remove that import from ${file} and reach what you need another way — pass it in, or move the shared piece below both. If the invariant is wrong for this card, say so with note; do not work around it.`,
          );
        }
      } else if (!covers(rule.file, file) && definesName(root, file, rule.name)) {
        fail(
          file,
          rule,
          `${file} defines ${rule.name}`,
          `${rule.name} has one home: ${rule.file}. Delete the definition in ${file} and import it from ${rule.file} instead. If ${rule.file} lacks something you need, say so with note.`,
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
    runGates: async (rungs: GateRung[], cwd: string): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd);
      const started = Date.now();
      const failures = architectureGate(cwd, options);
      const outcome: RungOutcome = {
        gate: "architecture",
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
