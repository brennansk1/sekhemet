import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { onPath } from "./builtin.js";

/**
 * Half-done patterns across languages: skipped, focused and todo tests, and
 * "not implemented" stubs (DEC-44). ast-grep (MIT) is used as a separate
 * program when it is installed — it parses with tree-sitter and runs no
 * repository code — and a line-based text scan stands in when it is absent,
 * with every finding naming which one found it.
 *
 * The test-smell lint reads the test patterns (gates rule 6a, GT-TQ-6); the
 * stub patterns serve the take-over's half-done detection (DS-TO-8).
 */

export type HalfDoneKind = "skip" | "only" | "todo" | "stub";

export interface HalfDoneFinding {
  /** Repository-relative. */
  file: string;
  /** 1-based. */
  line: number;
  kind: HalfDoneKind;
  text: string;
  tool: "ast-grep" | "text";
}

type Lang = "ts" | "py" | "rs";

function langOf(file: string): Lang | undefined {
  const ext = extname(file).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts";
  if (ext === ".py") return "py";
  if (ext === ".rs") return "rs";
  return undefined;
}

// --- The text fallback ------------------------------------------------------

const TEXT_RULES: Record<Lang, { kind: HalfDoneKind; re: RegExp }[]> = {
  ts: [
    { kind: "skip", re: /\b(?:it|test|describe|suite|bench)\.(?:skip|skipIf|runIf)\b/ },
    { kind: "skip", re: /(?:^|[^\w$.])(?:xit|xtest|xdescribe)\s*\(/ },
    { kind: "only", re: /\b(?:it|test|describe|suite|bench)\.only\b/ },
    { kind: "only", re: /(?:^|[^\w$.])(?:fit|fdescribe)\s*\(/ },
    { kind: "todo", re: /\b(?:it|test|describe)\.todo\b/ },
    { kind: "stub", re: /throw\s+new\s+Error\s*\(\s*["'`][^"'`]*not.?implemented/i },
  ],
  py: [
    { kind: "skip", re: /@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.skip)\b/ },
    { kind: "skip", re: /\bpytest\.skip\s*\(/ },
    { kind: "stub", re: /\braise\s+NotImplementedError\b/ },
  ],
  rs: [
    { kind: "skip", re: /#\[ignore\b/ },
    { kind: "stub", re: /\b(?:todo|unimplemented)!\s*\(/ },
  ],
};

function isComment(lang: Lang, line: string): boolean {
  const t = line.trim();
  if (lang === "py") return t.startsWith("#");
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function textScan(root: string, files: readonly string[]): HalfDoneFinding[] {
  const out: HalfDoneFinding[] = [];
  for (const file of files) {
    const lang = langOf(file);
    const path = join(root, file);
    if (!lang || !existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isComment(lang, line)) return;
      const hit = TEXT_RULES[lang].find((r) => r.re.test(line));
      if (hit) out.push({ file, line: i + 1, kind: hit.kind, text: line.trim(), tool: "text" });
    });
  }
  return out;
}

// --- ast-grep ---------------------------------------------------------------

/** The rules, one YAML document each, as `ast-grep scan --inline-rules` reads them. */
function astGrepRules(): string {
  const any = (patterns: string[]) =>
    `  any:\n${patterns.map((p) => `    - pattern: ${JSON.stringify(p)}`).join("\n")}`;
  const tsRules = (language: string) => [
    `id: skip-${language}\nlanguage: ${language}\nrule:\n${any([
      "it.skip($$$)",
      "test.skip($$$)",
      "describe.skip($$$)",
      "it.skipIf($$$)",
      "test.skipIf($$$)",
      "it.runIf($$$)",
      "test.runIf($$$)",
      "xit($$$)",
      "xtest($$$)",
      "xdescribe($$$)",
    ])}`,
    `id: only-${language}\nlanguage: ${language}\nrule:\n${any([
      "it.only($$$)",
      "test.only($$$)",
      "describe.only($$$)",
      "fit($$$)",
      "fdescribe($$$)",
    ])}`,
    `id: todo-${language}\nlanguage: ${language}\nrule:\n${any(["it.todo($$$)", "test.todo($$$)"])}`,
    `id: stub-${language}\nlanguage: ${language}\nrule:\n  pattern: "throw new Error($MSG)"\nconstraints:\n  MSG:\n    regex: "(?i)not.?implemented"`,
  ];
  return [
    ...tsRules("TypeScript"),
    ...tsRules("Tsx"),
    ...tsRules("JavaScript"),
    `id: skip-Python\nlanguage: Python\nrule:\n  kind: decorator\n  regex: "pytest\\\\.mark\\\\.(skip|skipif|xfail)|unittest\\\\.skip"`,
    `id: stub-Python\nlanguage: Python\nrule:\n${any(["raise NotImplementedError", "raise NotImplementedError($$$)"])}`,
    `id: skip-Rust\nlanguage: Rust\nrule:\n  kind: attribute_item\n  regex: "^#\\\\[ignore"`,
    `id: stub-Rust\nlanguage: Rust\nrule:\n${any(["todo!($$$)", "unimplemented!($$$)"])}`,
  ].join("\n---\n");
}

interface AstGrepMatch {
  file: string;
  ruleId: string;
  text: string;
  range: { start: { line: number } };
}

/** Run ast-grep over the files; undefined when it cannot, so the text scan stands in. */
function astGrepScan(
  program: string,
  root: string,
  files: readonly string[],
): HalfDoneFinding[] | undefined {
  const present = files.filter((f) => langOf(f) && existsSync(join(root, f)));
  if (present.length === 0) return [];
  // Run from a private empty directory with absolute paths: ast-grep finds
  // its project configuration (`sgconfig.yml`: rule directories, custom
  // languages) from its working directory upward, and the repository's must
  // never add to or change the harness's rules.
  const cwd = mkdtempSync(join(tmpdir(), "sekhemet-sg-"));
  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync(
      program,
      [
        "scan",
        "--inline-rules",
        astGrepRules(),
        "--json=stream",
        ...present.map((f) => join(root, f)),
      ],
      { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (r.error || r.status === null || (r.status !== 0 && r.status !== 1)) return undefined;
  const out: HalfDoneFinding[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    let m: AstGrepMatch;
    try {
      m = JSON.parse(line) as AstGrepMatch;
    } catch {
      return undefined;
    }
    const kind = m.ruleId.split("-")[0] as HalfDoneKind;
    out.push({
      file: isAbsolute(m.file) ? relative(root, m.file).split(sep).join("/") : m.file,
      line: m.range.start.line + 1,
      kind,
      text: m.text.split("\n")[0]?.trim() ?? "",
      tool: "ast-grep",
    });
  }
  return out;
}

/**
 * The installed ast-grep program, if any: `ast-grep`, or its short name
 * `sg` only when `sg --version` says it is ast-grep — on Linux `sg` is also
 * shadow-utils' switch-group command.
 */
export function astGrepProgram(): string | undefined {
  if (onPath("ast-grep")) return "ast-grep";
  if (!onPath("sg")) return undefined;
  const r = spawnSync("sg", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 && /ast-grep/i.test(`${r.stdout}`) ? "sg" : undefined;
}

/**
 * Find half-done patterns in `files` (repository-relative). `astGrep: false`
 * forces the text scan; a program name forces that program.
 */
export function scanHalfDone(
  root: string,
  files: readonly string[],
  options: { astGrep?: string | false } = {},
): HalfDoneFinding[] {
  const program = options.astGrep === false ? undefined : (options.astGrep ?? astGrepProgram());
  const found = program ? astGrepScan(program, root, files) : undefined;
  const all = found ?? textScan(root, files);
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
