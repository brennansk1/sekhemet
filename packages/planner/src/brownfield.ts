import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type { CardChange, CardRecord } from "@sekhemet/kernel";
import { gitEnvFor } from "@sekhemet/sync";
import { approvalHold } from "./approval_hold.js";
import { criterionIdsFor } from "./criteria.js";
import type { ExampleRow } from "./criteria.js";
import type { PlannerLedger } from "./ledger.js";
import type { RenderedTest, TestFramework } from "./staging.js";

/**
 * Planning on existing codebases (planner-pm §2.16, NEW-planner-pm-6,
 * PM-N6-1…4): a card's `change` (apart from its `kind`, DEC-26) chosen from
 * what it is asked to do in a repository with history; the scope files no
 * base test reaches (a `characterize` card goes first); the base tests whose
 * expectation a card changes (superseded, their new versions staged by the
 * test-author step); and an upgrade as a tool step plus child `fix` cards
 * from its failing gates, each citing the changelog between the versions.
 * Which red/green rule a `change` selects is the gates' (`redGreenRule`).
 */

const SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/;

function git(root: string, ...args: string[]): string | undefined {
  try {
    // The target repository's own config never runs anything here (the hardened environment).
    return execFileSync("git", args, {
      cwd: root,
      env: gitEnvFor(root),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Files tracked at HEAD: the base. */
function baseFiles(root: string): string[] {
  return (git(root, "ls-tree", "-r", "--name-only", "HEAD") ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * A repository with history (PM-N6-1): a commit at HEAD that tracks source
 * code. A new project — no commit, or none with code — plans features only.
 */
export function repoHasHistory(root: string | undefined): boolean {
  if (!root || !existsSync(join(root, ".git"))) return false;
  return baseFiles(root).some((f) => SOURCE.test(f));
}

/**
 * The one `change` a card makes to existing code (PM-N6-1), from what it is
 * asked to do; in a new project every card is a `feature`.
 */
export function changeOf(text: string, hasHistory: boolean): CardChange {
  if (!hasHistory) return "feature";
  const t = text.toLowerCase();
  if (/\b(upgrade|bump)\b/.test(t) || /\bupdate\b.*\bto\s+v?\d+(\.\d+)+/.test(t)) return "upgrade";
  if (
    /\bcharacteri[sz](e|es|ing|ation)\b|\bpin (down )?(the )?(current|existing) behaviou?r\b/.test(
      t,
    )
  )
    return "characterize";
  if (
    /\b(refactor\w*|restructur\w*|reorgani[sz]\w*|extract\w*|clean(ing)? up|simplif\w*|dedup\w*|rename\w*)\b/.test(
      t,
    )
  )
    return "refactor";
  if (/\b(fix\w*|bug\w*|defect\w*|broken|crash\w*|regression\w*|incorrect\w*|wrong(ly)?)\b/.test(t))
    return "fix";
  return "feature";
}

/** A reader of base content, cached. */
function baseReader(root: string): (file: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (file) => {
    if (!cache.has(file)) cache.set(file, git(root, "show", `HEAD:${file}`));
    return cache.get(file);
  };
}

const IMPORT =
  /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

/** The base files a file imports through relative specifiers. */
function importsOf(file: string, text: string, tracked: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!spec?.startsWith(".")) continue;
    const base = posix.normalize(posix.join(posix.dirname(file), spec));
    const stem = base.replace(/\.[cm]?js$/, "");
    const candidates = [
      base,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.mts`,
      `${stem}.cts`,
      `${stem}.js`,
      `${stem}.mjs`,
      `${stem}.cjs`,
      `${base}/index.ts`,
      `${base}/index.js`,
    ];
    const hit = candidates.find((c) => tracked.has(c));
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * The base's test files that reach each file through their imports,
 * transitively (re-exports included): what executes it on the base, read
 * statically from the committed source.
 */
export function testsReaching(root: string): Map<string, string[]> {
  const files = baseFiles(root);
  const tracked = new Set(files);
  const read = baseReader(root);
  const reached = new Map<string, string[]>();
  for (const test of files.filter((f) => TEST_FILE.test(f) && SOURCE.test(f))) {
    const seen = new Set<string>([test]);
    const queue = [test];
    while (queue.length > 0) {
      const f = queue.shift() as string;
      for (const next of importsOf(f, read(f) ?? "", tracked)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    for (const f of seen) {
      if (f === test) continue;
      reached.set(f, [...(reached.get(f) ?? []), test]);
    }
  }
  return reached;
}

/**
 * PM-N6-2: the scope files on the base that no base test reaches. A file
 * the base does not have has nothing to pin; a test file pins itself.
 */
export function untestedScopeFiles(root: string, scopeFiles: readonly string[]): string[] {
  const tracked = new Set(baseFiles(root));
  const reached = testsReaching(root);
  return scopeFiles.filter(
    (f) => tracked.has(f) && SOURCE.test(f) && !TEST_FILE.test(f) && !reached.has(f),
  );
}

/** A base test asserting a different value for a call a new example row makes. */
export interface SupersededTest {
  /** `file > name`, as the regression gate reads a declaration (gates rule 25a). */
  test: string;
  file: string;
  name: string;
  args: unknown[];
  was: unknown;
  now: unknown;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text.replace(/'([^'\\]*)'/g, '"$1"')) };
  } catch {
    return { ok: false };
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * PM-N6-3: the base tests reaching the symbol's file that assert a
 * different value for a call one of the card's example rows makes — the
 * expectations this card changes. Assertions are read as
 * `expect(sym(args)).toBe|toEqual|toStrictEqual(value)` and
 * `assert.equal|strictEqual|deepEqual|deepStrictEqual(sym(args), value)`,
 * each under the title of the `it`/`test` it is in.
 */
export function supersededTests(
  root: string,
  symbol: { symbol: string; file: string },
  rows: readonly ExampleRow[],
): SupersededTest[] {
  const tests = testsReaching(root).get(symbol.file) ?? [];
  const read = baseReader(root);
  const name = symbol.symbol.replace(/[$]/g, "\\$");
  const patterns = [
    new RegExp(
      `expect\\(\\s*(?:await\\s+)?${name}\\(([^()]*)\\)\\s*\\)\\s*\\.(?:toBe|toEqual|toStrictEqual)\\(([^()]*)\\)`,
      "g",
    ),
    new RegExp(
      `assert\\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\\(\\s*(?:await\\s+)?${name}\\(([^()]*)\\)\\s*,\\s*([^()]*?)\\s*\\)`,
      "g",
    ),
  ];
  const out: SupersededTest[] = [];
  for (const file of tests) {
    const text = read(file) ?? "";
    const titles = [...text.matchAll(/\b(?:it|test)(?:\.\w+)*\(\s*(["'`])((?:(?!\1).)*)\1/g)].map(
      (m) => ({ at: m.index ?? 0, title: m[2] as string }),
    );
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const args = parseJson(`[${m[1]}]`);
        const was = parseJson(String(m[2]).trim());
        if (!args.ok || !was.ok) continue;
        const row = rows.find((r) => sameValue(r.args, args.value));
        if (!row || sameValue(row.expected, was.value)) continue;
        const title = titles.filter((t) => t.at < (m.index ?? 0)).at(-1)?.title;
        if (!title) continue;
        const test = `${file} > ${title}`;
        if (out.some((o) => o.test === test)) continue;
        out.push({
          test,
          file,
          name: title,
          args: args.value as unknown[],
          was: was.value,
          now: row.expected,
        });
      }
    }
  }
  return out;
}

/** The import specifier from a test file to a source file (`.ts` imported as `.js`). */
function importPath(testPath: string, file: string): string {
  let rel = posix.relative(posix.dirname(testPath), file).replace(/\.tsx?$/, ".js");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/**
 * PM-N6-3: the new version of each superseded base test, written by the
 * test-author step (never the Worker): a test of the same title — which is
 * how the regression gate finds it — asserting the card's new value.
 */
export function renderSupersedingTest(input: {
  framework: TestFramework;
  testPath: string;
  symbol: { symbol: string; file: string };
  superseded: readonly (SupersededTest & { criterionId: string })[];
}): RenderedTest {
  const { framework, symbol } = input;
  const lines: string[] = [];
  if (framework === "vitest") lines.push('import { describe, expect, it } from "vitest";');
  if (framework === "node") {
    lines.push(
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
    );
  }
  lines.push(`import { ${symbol.symbol} } from "${importPath(input.testPath, symbol.file)}";`, "");
  lines.push(
    "// Staged by the test-author step: the new version of each base test this card supersedes.",
  );
  lines.push('describe("superseded expectations", () => {');
  for (const s of input.superseded) {
    const call = `await ${symbol.symbol}(${s.args.map((a) => JSON.stringify(a)).join(", ")})`;
    lines.push(`  it(${JSON.stringify(s.name)}, async () => {`);
    lines.push(
      framework === "node"
        ? `    assert.deepEqual(${call}, ${JSON.stringify(s.now)});`
        : `    expect(${call}).toEqual(${JSON.stringify(s.now)});`,
    );
    lines.push("  });");
  }
  lines.push("});", "");
  return {
    source: lines.join("\n"),
    cases: input.superseded.map((s) => ({ name: s.name, criterionId: s.criterionId })),
  };
}

/* ------------------------------------------------------------------------ */
/* Upgrades (PM-N6-4)                                                       */
/* ------------------------------------------------------------------------ */

function semver(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The changelog entries after the installed version up to and including the
 * proposed one, newest first: each `## [x.y.z]` / `## x.y.z` section's
 * non-blank lines.
 */
export function changelogBetween(
  text: string,
  from: string,
  to: string,
): { version: string; lines: string[] }[] {
  const lo = semver(from);
  const hi = semver(to);
  if (!lo || !hi) return [];
  const out: { version: string; lines: string[] }[] = [];
  let current: { version: string; lines: string[] } | undefined;
  for (const line of text.split("\n")) {
    const heading = /^#{1,4}\s*\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/.exec(line);
    if (heading) {
      const v = semver(heading[1] as string);
      current =
        v && compare(v, lo) > 0 && compare(v, hi) <= 0
          ? { version: heading[1] as string, lines: [] }
          : undefined;
      if (current) out.push(current);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      current = undefined;
      continue;
    }
    if (current && line.trim()) current.lines.push(line.trim());
  }
  return out.sort((a, b) =>
    compare(
      semver(b.version) as [number, number, number],
      semver(a.version) as [number, number, number],
    ),
  );
}

/** The package manager's tool step for the version change, by the lockfile present. */
function toolStep(root: string, pkg: string, to: string): { command: string[]; lockfile: string } {
  const at = `${pkg}@${to}`;
  if (existsSync(join(root, "pnpm-lock.yaml")))
    return { command: ["pnpm", "add", at], lockfile: "pnpm-lock.yaml" };
  if (existsSync(join(root, "yarn.lock")))
    return { command: ["yarn", "add", at], lockfile: "yarn.lock" };
  return { command: ["npm", "install", at], lockfile: "package-lock.json" };
}

const slug = (s: string) =>
  s
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

export const UPGRADE_EVENT = "upgrade/planned";

/**
 * PM-N6-4: plan an upgrade as a card whose work is a tool step (the package
 * manager changes the version and the lockfile) — recorded with the
 * changelog entries between the installed and proposed versions — then the
 * gates; its adaptations are child `fix` cards (`planUpgradeFixes`). It
 * waits in Planning for a person's approval of its criteria (PM-N7-5).
 */
export async function planUpgrade(
  ledger: PlannerLedger,
  input: {
    root: string;
    pkg: string;
    from: string;
    to: string;
    changelog?: string;
    epicId?: string;
    projectId?: string;
  },
): Promise<{ cardId: string; command: string[]; entries: { version: string; lines: string[] }[] }> {
  const { store } = ledger;
  const step = toolStep(input.root, input.pkg, input.to);
  const entries = input.changelog ? changelogBetween(input.changelog, input.from, input.to) : [];
  const cardId = `upgrade_${slug(input.pkg)}_${slug(input.to)}`;
  const criteria = [
    `${input.pkg} is at ${input.to} in package.json and ${step.lockfile}, and every test that passed on the base still passes`,
  ];
  await store.createCard(
    {
      id: cardId,
      tier: "story",
      title: `Upgrade ${input.pkg} from ${input.from} to ${input.to}`,
      status: "planning",
      spec: [
        `Upgrade ${input.pkg} from ${input.from} to ${input.to}.`,
        `Tool step (run by the package manager, not written by hand): ${step.command.join(" ")}.`,
        "Then the gates run; each failing site becomes a child fix card that cites the changelog.",
        entries.length > 0
          ? `Changelog between the versions:\n${entries.map((e) => `${e.version}: ${e.lines.join(" ")}`).join("\n")}`
          : "No changelog was given for the versions between.",
      ].join("\n"),
      scopeFiles: ["package.json", step.lockfile],
      acceptanceCriteria: criteria,
      criterionIds: criterionIdsFor(cardId, criteria.length),
      kind: "implement",
      change: "upgrade",
      labels: ["upgrade"],
      blockedReason: approvalHold(cardId),
      ...(input.epicId ? { parentId: input.epicId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    "planner",
  );
  await ledger.log.append({
    actor: "planner",
    type: UPGRADE_EVENT,
    cardId,
    payload: {
      cardId,
      package: input.pkg,
      from: input.from,
      to: input.to,
      command: step.command,
      lockfile: step.lockfile,
      entries: entries.map((e) => e.version),
    },
    // The changelog's words are free text: the erasable private part.
    private: { changelog: entries },
  });
  return { cardId, command: step.command, entries };
}

/** The failing files of the upgrade card's latest attempt, from its gate records. */
function failingFiles(ledger: PlannerLedger, cardId: string): string[] {
  const attempt = ledger.store.runs.listAttempts(cardId).at(-1);
  if (!attempt) return [];
  const files = new Set<string>();
  for (const r of ledger.store.runs.listGateResults(attempt.id)) {
    if (r.passed) continue;
    for (const f of r.failures ?? []) {
      const file = (f as { location?: { file?: string } }).location?.file;
      if (file) files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * PM-N6-4: one child `fix` card per file failing the upgrade card's gates,
 * each citing the changelog entries between the versions; a file that
 * already has one gets none. They wait in Planning for approval (PM-N7-5).
 */
export async function planUpgradeFixes(
  ledger: PlannerLedger,
  upgradeCardId: string,
): Promise<{ created: string[] }> {
  const { store } = ledger;
  const card = await store.getCard(upgradeCardId);
  if (!card || card.change !== "upgrade") {
    throw new Error(`${upgradeCardId} is not an upgrade card`);
  }
  const planned = (await ledger.log.getEventsByCardAndTypes(upgradeCardId, [UPGRADE_EVENT])).at(-1);
  const p = (planned?.payload ?? {}) as { package?: string; from?: string; to?: string };
  const entries = ((planned?.private as { changelog?: unknown } | undefined)?.changelog ?? []) as {
    version: string;
    lines: string[];
  }[];
  const cited = Array.isArray(entries)
    ? entries.map((e) => `${e.version}: ${e.lines.join(" ")}`)
    : [];
  const children = await store.listCards({ parentId: upgradeCardId });
  const covered = new Set(children.flatMap((c: CardRecord) => c.scopeFiles));
  const created: string[] = [];
  for (const file of failingFiles(ledger, upgradeCardId)) {
    if (covered.has(file)) continue;
    const id = `${upgradeCardId}_fix_${slug(file)}`;
    const criteria = [
      `${file} passes its gates with ${p.package ?? "the dependency"} at ${p.to ?? "the new version"}`,
    ];
    await store.createCard(
      {
        id,
        tier: "task",
        parentId: upgradeCardId,
        title: `Adapt ${file} to ${p.package ?? "the dependency"} ${p.to ?? ""}`.trim(),
        status: "planning",
        spec: [
          `After upgrading ${p.package ?? "the dependency"} from ${p.from ?? "?"} to ${p.to ?? "?"}, ${file} fails its gates. Adapt it.`,
          cited.length > 0
            ? `The changelog between the versions says:\n${cited.join("\n")}`
            : "No changelog was given for the versions between.",
        ].join("\n"),
        scopeFiles: [file],
        acceptanceCriteria: criteria,
        criterionIds: criterionIdsFor(id, criteria.length),
        kind: "implement",
        change: "fix",
        labels: ["upgrade-fix"],
        blockedReason: approvalHold(id),
        ...(card.projectId ? { projectId: card.projectId } : {}),
      },
      "planner",
    );
    created.push(id);
  }
  return { created };
}
