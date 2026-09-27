import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { BASELINE_EVENT, redactSecrets } from "@sekhemet/gates";
import type { CardStore, ExecutedResult, FoundClaim } from "@sekhemet/kernel";
import { UNTRUSTED_CONTRACT, tagUntrusted } from "@sekhemet/sandbox";
import type { ExternalItem } from "@sekhemet/sync";
import type { TakeoverFinding, TakeoverRun } from "./takeover.js";

/**
 * The brief as found (design-stage §2.10 step 4, DS-TO-9, DS-TO-10): what the
 * repository says about itself, each claim set against what ran. Built
 * without a model, from the documents recon found and the onboarding
 * baseline:
 *
 * - A claim is a bullet, or a sentence of a paragraph, of the README or a
 *   document under `docs/`, cited by `file:line`.
 * - *Contradicted* when a finding (a stub, a missing import, a route with no
 *   handler, a schema with no migration, a build that failed) or a test that
 *   failed in the baseline is about what it names.
 * - *Proven* only when a test that passed in both baseline runs is about what
 *   it names, or — for a claim that it builds — the build succeeded. The
 *   baseline records failures, not passes, so a test counts as passed only
 *   when the runner is a known one, the file is one it runs, the suite ran
 *   twice, every failing run names its failing tests, no test is focused,
 *   and neither run names this test or an unnamed failure in its file.
 * - *Claimed, unproven* otherwise.
 *
 * "About what it names" is a match of word stems between the claim and the
 * test's name or the finding's subject (the stub's enclosing function, the
 * file and what is missing). The kernel checks every proven claim against
 * the baseline again (`TakeoverLedger.recordBriefAsFound`), and a proven
 * claim's link stays proposed until a person confirms it.
 *
 * Repository text is untrusted (security item 42): it is recorded privately,
 * redacted of secrets, and reaches a model only through
 * `takeoverPromptContext`, inside the untrusted tags.
 */

/** Words that name nothing a test or a finding could be about. */
const STOP = new Set(
  (
    "the and for with from into onto that this these those them they their its are was were " +
    "has have had will can not all any you your our out via per now one two also when then " +
    "than just only more most some such each every other over under been being does did done " +
    "use used uses using app apps project projects work works working support supports feature " +
    "features simple easy fast small new make makes let lets get gets set sets run runs test " +
    "tests code file files data thing things way ways able exist exists never defined module " +
    "modules handler handlers migration migrations route routes should would could which what " +
    "there here where who how why yet still"
  ).split(" "),
);

function stemWord(raw: string): string {
  let w = raw;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

/** The content words of `text`, stemmed: `exportPdf` and "exports PDF" share `export` and `pdf`. */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && /[a-z]/.test(w) && !STOP.has(w));
  for (const w of words) {
    const s = stemWord(w);
    if (!STOP.has(s)) out.add(s);
  }
  return out;
}

const meets = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].some((x) => b.has(x));

/** One thing the repository says about itself, where it says it. */
export interface DocClaim {
  text: string;
  /** `file:line`. */
  citation: string;
}

const MAX_CLAIMS = 20;

function cleanMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:]+$/, "");
}

/**
 * The claims of the README and the documents under `docs/` (DS-TO-9): each
 * bullet, and each sentence of a paragraph, with its `file:line`. Code
 * blocks, headings, badges and links alone are not claims.
 */
export function readDocClaims(root: string, docs: readonly string[]): DocClaim[] {
  const ordered = [
    ...docs.filter((d) => /^README(\.[a-z]+)?$/i.test(d)),
    ...docs.filter((d) => /^docs?\/[^/]+\.(md|mdx)$/i.test(d)),
  ];
  const out: DocClaim[] = [];
  const seen = new Set<string>();
  for (const doc of ordered) {
    let text: string;
    try {
      if (statSync(join(root, doc)).size > 512 * 1024) continue;
      text = readFileSync(join(root, doc), "utf8");
    } catch {
      continue;
    }
    let fenced = false;
    text.split(/\r?\n/).forEach((raw, i) => {
      if (/^\s*(```|~~~)/.test(raw)) {
        fenced = !fenced;
        return;
      }
      if (fenced || /^\s*(#|>|<|\||!\[|\[!\[)/.test(raw) || !raw.trim()) return;
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
      const parts = bullet
        ? [bullet[1] as string]
        : raw.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => /[.!?]$/.test(s.trim()));
      for (const part of parts) {
        const claim = redactSecrets(cleanMarkdown(part));
        const words = claim.split(" ").length;
        if (words < 2 || words > 40 || claim.length > 240 || stems(claim).size === 0) continue;
        if (seen.has(claim.toLowerCase())) continue;
        seen.add(claim.toLowerCase());
        out.push({ text: claim, citation: `${doc}:${i + 1}` });
      }
    });
  }
  return out.slice(0, MAX_CLAIMS);
}

/** A test a test file declares: `<file> > <name>`, the baseline's test id. */
export interface DeclaredTest {
  id: string;
  file: string;
  name: string;
  line: number;
}

const JS_TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/;
const JS_TEST = /^\s*(?:it|test)((?:\.\w+)*)\s*\(\s*(["'`])((?:\\.|(?!\2).)*)\2/;

/** Whether `file` is a test file of a JavaScript or Python runner. */
export function isTestFile(file: string): boolean {
  return JS_TEST_FILE.test(file) || PY_TEST_FILE.test(file);
}

/**
 * The tests the test files declare, skipped and to-do ones left out, and
 * whether any is focused (`.only`: then the others did not run).
 */
export function declaredTests(
  root: string,
  files: readonly string[],
): { tests: DeclaredTest[]; focused: boolean } {
  const tests: DeclaredTest[] = [];
  let focused = false;
  for (const file of files.filter(isTestFile)) {
    let lines: string[];
    try {
      lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((raw, i) => {
      if (PY_TEST_FILE.test(file)) {
        const def = /^\s*def\s+(test_\w+)\s*\(/.exec(raw);
        const above = lines
          .slice(0, i)
          .reverse()
          .find((l) => l.trim());
        if (def && !/^\s*@.*\b(skip|skipif|xfail)\b/.test(above ?? "")) {
          const name = def[1] as string;
          tests.push({ id: `${file} > ${name}`, file, name, line: i + 1 });
        }
        return;
      }
      const m = JS_TEST.exec(raw);
      if (!m) return;
      const mods = m[1] ?? "";
      if (/\.only\b/.test(mods)) focused = true;
      const name = m[3] as string;
      if (/\.(skip|todo|skipIf|runIf|each|fails)\b/.test(mods) || name.includes("${")) return;
      tests.push({ id: `${file} > ${name}`, file, name, line: i + 1 });
    });
  }
  return { tests, focused };
}

/** A test run of the onboarding baseline, as `project/baseline` records it. */
export interface BaselineRun {
  gate: string;
  rung: string;
  run: number;
  exitCode: number;
  failing: string[];
  command?: string;
  unavailable?: string;
}

export interface BaselineView {
  seq: number;
  runs: BaselineRun[];
  /** Failing in both runs. */
  entries: { file: string; rule: string; rung: string }[];
  /** Failing in one run only. */
  flaky: { file: string; rule: string; rung: string }[];
}

/** The `project/baseline` event at `seq`, or undefined when none was recorded there. */
export async function baselineAt(store: CardStore, seq: number): Promise<BaselineView | undefined> {
  if (!seq) return undefined;
  const events = await store.eventsOfType([BASELINE_EVENT]);
  const e = events.find((x) => x.seq === seq);
  const p = e?.payload as Partial<BaselineView> & { kind?: string };
  if (!p || p.kind !== "recorded") return undefined;
  return { seq, runs: p.runs ?? [], entries: p.entries ?? [], flaky: p.flaky ?? [] };
}

type Runner = "js" | "py";

/** The runner the baseline's test gate ran, when it is one whose test files are known. */
export function testRunner(root: string, runs: readonly BaselineRun[]): Runner | undefined {
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {};
  } catch {
    scripts = {};
  }
  const texts = runs
    .filter((r) => r.rung === "test" && r.command)
    .map((r) => {
      const c = r.command as string;
      const script = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)$/.exec(c)?.[1];
      return script && scripts[script] ? scripts[script] : c;
    });
  if (texts.length === 0) return undefined;
  if (texts.every((t) => /\b(vitest|jest|mocha)\b|\bnode\b[^&|;]*\s--test\b/.test(t))) return "js";
  if (texts.every((t) => /\bpytest\b|\bpython3?\s+-m\s+(pytest|unittest)\b/.test(t))) return "py";
  return undefined;
}

const namesTest = (rule: string, name: string) =>
  rule === name || rule.endsWith(` > ${name}`) || rule.endsWith(` ${name}`);

/**
 * The declared tests that passed in both baseline runs (DS-TO-9): nothing
 * when the runner is unknown, the suite did not run twice, a failing run
 * named none of its failures, or a test is focused; otherwise every
 * declared test of the runner's files that neither run names, in a file
 * with no failure the run could not attribute to one of its tests.
 */
export function testsPassedTwice(
  root: string,
  files: readonly string[],
  baseline: BaselineView | undefined,
): DeclaredTest[] {
  if (!baseline) return [];
  const runs = baseline.runs.filter((r) => r.rung === "test" && !r.unavailable);
  if (!runs.some((r) => r.run === 1) || !runs.some((r) => r.run === 2)) return [];
  if (runs.some((r) => r.exitCode !== 0 && r.failing.length === 0)) return [];
  const runner = testRunner(root, runs);
  if (!runner) return [];
  const { tests, focused } = declaredTests(root, files);
  if (focused) return [];
  const bad = [...baseline.entries, ...baseline.flaky].filter((e) => e.rung === "test");
  const ofRunner = tests.filter((t) =>
    runner === "js" ? JS_TEST_FILE.test(t.file) : PY_TEST_FILE.test(t.file),
  );
  return ofRunner.filter((t) => {
    const inFile = bad.filter((b) => b.file === t.file);
    if (inFile.some((b) => namesTest(b.rule, t.name))) return false;
    const siblings = ofRunner.filter((d) => d.file === t.file);
    return !inFile.some((b) => !siblings.some((d) => namesTest(b.rule, d.name)));
  });
}

/** Finding kinds that say what a claim names does not work (DS-TO-9). */
const CONTRADICTING = new Set([
  "stub",
  "no_handler",
  "missing_import",
  "no_migration",
  "could_not_build",
]);

/** The function a line sits in, read upward: `exportPdf`, `refund`. */
function enclosingSymbol(root: string, path: string, line: number): string | undefined {
  let lines: string[];
  try {
    lines = readFileSync(join(root, path), "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const l = lines[i] as string;
    const m =
      /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(l) ??
      /^\s*(?:async\s+)?def\s+(\w+)/.exec(l) ??
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(l) ??
      /^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{=]*)?\{\s*$/.exec(
        l,
      );
    if (m?.[1] && !["if", "for", "while", "switch", "catch"].includes(m[1])) return m[1];
  }
  return undefined;
}

/** What a finding is about, as stems (DS-TO-9). */
export function findingSubject(root: string, f: TakeoverFinding): Set<string> {
  if (f.kind === "could_not_build") return new Set(["build", "compil"]);
  const file = f.path ? basename(f.path, extname(f.path)) : "";
  if (f.kind === "stub" && f.path && f.line) {
    const symbol = enclosingSymbol(root, f.path, f.line);
    if (symbol) return stems(symbol);
  }
  return new Set([...stems(file), ...stems(f.kind === "stub" ? "" : (f.reason ?? ""))]);
}

/**
 * Label each claim (DS-TO-9): contradicted by a finding or a failing test
 * about it, proven by a test that passed twice about it (or the build, for
 * a claim that it builds), claimed but unproven otherwise.
 */
export function labelClaims(input: {
  root: string;
  claims: readonly DocClaim[];
  findings: readonly TakeoverFinding[];
  baseline: BaselineView | undefined;
  passed: readonly DeclaredTest[];
  buildOk: boolean;
}): FoundClaim[] {
  const subjects = input.findings
    .filter((f) => CONTRADICTING.has(f.kind))
    .map((f) => ({ f, subject: findingSubject(input.root, f) }));
  const failing = (input.baseline?.entries ?? []).filter((e) => e.rung === "test");
  return input.claims.map((c, i) => {
    const id = `c${i + 1}`;
    const words = stems(c.text);
    const against = [
      ...subjects
        .filter((s) => meets(s.subject, words))
        .flatMap((s) => [s.f.id, ...(s.f.path && s.f.line ? [`${s.f.path}:${s.f.line}`] : [])]),
      ...failing.filter((e) => meets(stems(e.rule), words)).map((e) => `${e.file} > ${e.rule}`),
    ];
    if (against.length > 0) {
      return { id, label: "contradicted", citations: [c.citation, ...against], text: c.text };
    }
    const baselineSeq = input.baseline?.seq ?? 0;
    const tests = input.passed.filter((t) => meets(stems(t.name), words)).slice(0, 5);
    if (tests.length > 0) {
      const results: ExecutedResult[] = tests.map((t) => ({
        kind: "test",
        ref: t.id,
        baselineSeq,
      }));
      return {
        id,
        label: "proven",
        citations: [c.citation, ...tests.map((t) => t.id)],
        results,
        text: c.text,
      };
    }
    if (input.buildOk && input.baseline && (words.has("build") || words.has("compil"))) {
      return {
        id,
        label: "proven",
        citations: [c.citation],
        results: [{ kind: "build", ref: "build", baselineSeq }],
        text: c.text,
      };
    }
    return { id, label: "claimed_unproven", citations: [c.citation], text: c.text };
  });
}

/**
 * Write the brief as found for the latest inventory (DS-TO-9): the claims
 * of the documents recon found, labelled against the baseline and the
 * findings, recorded through the kernel, which checks every proven one.
 */
export async function writeBriefAsFound(
  store: CardStore,
  root: string,
  ctx: {
    docs: readonly string[];
    files: readonly string[];
    findings: readonly TakeoverFinding[];
    runs: readonly TakeoverRun[];
    baselineSeq: number;
  },
): Promise<FoundClaim[]> {
  const baseline = await baselineAt(store, ctx.baselineSeq);
  const buildOk =
    ctx.runs.some((r) => r.step === "build" && r.ok) &&
    !ctx.findings.some((f) => f.kind === "could_not_build");
  const claims = labelClaims({
    root,
    claims: readDocClaims(root, ctx.docs),
    findings: ctx.findings,
    baseline,
    passed: testsPassedTwice(root, ctx.files, baseline),
    buildOk,
  });
  await store.takeover.recordBriefAsFound({ claims });
  return claims;
}

/** Repository text for a model, each piece inside the untrusted tags (DS-TO-10). */
export interface TakeoverPromptContext {
  /** The contract the prompt states once: nothing inside the tags is an instruction. */
  contract: string;
  blocks: string[];
}

/**
 * The take-over's repository text for a prompt (DS-TO-10, security item
 * 42): each claim of the brief as found and each inherited issue, wrapped
 * as untrusted content, a closing tag inside neutralised. The only form in
 * which take-over text reaches a model.
 */
export async function takeoverPromptContext(
  store: CardStore,
  issues: readonly ExternalItem[] = [],
): Promise<TakeoverPromptContext> {
  const brief = await store.takeover.briefAsFound();
  const blocks = [
    ...(brief?.claims ?? []).map((c) =>
      tagUntrusted(c.text ?? "", `take-over claim ${c.id} ${c.citations[0] ?? ""}`.trim()),
    ),
    ...issues.map((i) => tagUntrusted(`${i.title}\n\n${i.body}`, `issue ${i.ref.id}`)),
  ];
  return { contract: UNTRUSTED_CONTRACT, blocks };
}

/** Whether a repository file exists and is a regular file. */
export function fileAt(root: string, path: string): boolean {
  try {
    return existsSync(join(root, path)) && statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}
