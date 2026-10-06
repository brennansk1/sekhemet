import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Turn, WORKER, scriptedTurnsProject } from "./support/g6_models.js";
import { BIN, g6Repo, statusOf, write } from "./support/g6_review.js";

/**
 * review-git item 3 (per-package gates in the card's verification, RG-N3-1)
 * at the door (C2d, FINDINGS_C1 TST-01): the built command
 * (`apps/harness/dist/index.js`) spawned as `sekhemet queue` in a real pnpm
 * workspace of three packages, with a scripted Worker whose change touches
 * two of them. Each package's `test` script is its gate set; the test runner
 * is a small script in Vitest's output format (each `check: <name> | <file>
 * | <text>` line is one test that passes when the file holds the text).
 */

const RUNNER = `import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("-") && a !== "run");
const walk = (d) => readdirSync(d).flatMap((n) => {
  if (n === "node_modules" || n.startsWith(".")) return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\\.spec\\.ts$/.test(n) ? [relative(process.cwd(), p)] : [];
});
const files = args.length ? args : walk(process.cwd());
let failed = 0, passed = 0, failedFiles = 0;
for (const f of files) {
  let bad = false;
  for (const line of readFileSync(f, "utf8").split("\\n")) {
    const m = /check: (.+?) \\| (.+?) \\| (.+)$/.exec(line);
    if (!m) continue;
    if (readFileSync(join(ROOT, m[2]), "utf8").includes(m[3])) { passed++; continue; }
    failed++; bad = true;
    console.log(" FAIL  " + f + " > " + m[1]);
    console.log("AssertionError: expected " + m[2] + " to contain " + m[3]);
  }
  if (bad) failedFiles++;
}
console.log(" Test Files  " + (failedFiles ? failedFiles + " failed | " : "") + (files.length - failedFiles) + " passed (" + files.length + ")");
console.log("      Tests  " + (failed ? failed + " failed | " : "") + passed + " passed (" + (failed + passed) + ")");
process.exit(failed ? 1 : 0);
`;

const GATES = `[project]
max_files = 6
max_diff_lines = 200

[[gate]]
id = "unit"
rung = "test"
layer = "functional"
command = "node"
args = ["tools/vitest.mjs", "run"]
parser = "vitest"
timeout_s = 120
`;

const pkg = (name: string, deps: Record<string, string> = {}) =>
  `${JSON.stringify({ name, version: "1.0.0", dependencies: deps, scripts: { test: "node ../../tools/vitest.mjs run" } })}\n`;

const finish = { name: "finish_card", arguments: {} };
const read = (path: string) => ({ name: "read_file", arguments: { path } });
const write_ = (path: string, content: string) => ({
  name: "write_file",
  arguments: { path, content },
});

/** `sekhemet queue` on card c1 (scope packages/a and packages/c) in a three-package workspace. */
async function queue(turns: Turn[]) {
  const r = g6Repo();
  const project = await scriptedTurnsProject(r, turns, {
    stepBudget: 3,
    scope: ["packages/a/**", "packages/c/**"],
    maxFiles: 6,
  });
  const files: Record<string, string> = {
    "package.json": '{ "name": "root", "private": true, "type": "module" }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    ".sekhemet/gates.toml": GATES,
    "tools/vitest.mjs": RUNNER,
    "packages/a/package.json": pkg("@x/a"),
    "packages/a/src/index.ts": 'export const greeting = "hi";\n',
    "packages/a/tests/a1.spec.ts": "check: a greets | packages/a/src/index.ts | greeting\n",
    "packages/b/package.json": pkg("@x/b"),
    "packages/b/src/index.ts": 'export const b = "b";\n',
    "packages/b/tests/b1.spec.ts": 'check: b works | packages/b/src/index.ts | "b"\n',
    "packages/c/package.json": pkg("@x/c"),
    "packages/c/src/index.ts": 'export const c = "c";\n',
    "packages/c/tests/c1.spec.ts": 'check: c works | packages/c/src/index.ts | "c"\n',
  };
  for (const [p, text] of Object.entries(files)) write(r.repo, p, text);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "a workspace of three packages");
  const out = spawnSync(process.execPath, [...project.nodeArgs, BIN, "queue", "--worker", WORKER], {
    cwd: r.repo,
    encoding: "utf8",
    timeout: 150_000,
    env: r.env({ env: project.env }),
  });
  const dir = join(r.repo, ".sekhemet", "evidence");
  const bundles = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) =>
        JSON.parse(readFileSync(join(dir, f), "utf8")) as {
          cardId?: string;
          rungResults?: { gate: string; passed: boolean }[];
        },
    )
    .filter((b) => b.cardId === "c1");
  const gates = new Map(
    bundles.flatMap((b) => b.rungResults ?? []).map((x) => [x.gate, x.passed] as const),
  );
  return { r, out: out.stdout + out.stderr, gates };
}

describe("RG-N3-1: a card touching two workspace packages runs both packages' gate sets", () => {
  it("RG-N3-1: both packages' gates run in the card's verification and pass, and the card enters Review; the untouched package's do not run", async () => {
    const { r, out, gates } = await queue([
      { calls: [read("packages/a/src/index.ts"), read("packages/c/src/index.ts")] },
      {
        calls: [
          write_("packages/a/src/index.ts", 'export const greeting = "hi"; // a\n'),
          write_("packages/c/src/index.ts", 'export const c = "c"; // c\n'),
          finish,
        ],
      },
    ]);
    expect(gates.get("@x/a:test"), out).toBe(true);
    expect(gates.get("@x/c:test"), out).toBe(true);
    expect(gates.has("@x/b:test")).toBe(false);
    expect(await statusOf(r, "c1")).toBe("review");
  }, 200_000);

  it("RG-N3-1: one package's gates failing keeps the card out of Review though the other's pass", async () => {
    const { r, out, gates } = await queue([
      { calls: [read("packages/a/src/index.ts"), read("packages/c/src/index.ts")] },
      {
        calls: [
          write_("packages/a/src/index.ts", 'export const greeting = "hi"; // a\n'),
          // c's own test looks for "c": this change breaks it.
          write_("packages/c/src/index.ts", "export const c = 3;\n"),
          finish,
        ],
      },
    ]);
    expect(gates.get("@x/a:test"), out).toBe(true);
    expect(gates.get("@x/c:test"), out).toBe(false);
    expect(await statusOf(r, "c1")).not.toBe("review");
  }, 200_000);
});
