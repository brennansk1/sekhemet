import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script, run by hand and by the capstone runner, checked here.
import * as webbench from "../../../scripts/capstone/webbench.mjs";
// @ts-expect-error: a plain ESM script, run by hand and by the capstone runner, checked here.
import * as agent from "../../../scripts/capstone/webbench_agent.mjs";

/**
 * The capstone's second run, run and scored (W2b G3; CAPSTONE_SELECTION "The
 * second run"; `fixtures/capstone/webbench/choice.md`): Web-Bench's protocol
 * on a tiny project shaped like `projects/fastify`, with real git, a real
 * web server started by Playwright's `webServer`, and `@playwright/test`
 * running one spec that passes on the starting tree and one that fails until
 * the arm fixes it. The specs use Playwright's `request` fixture only, so no
 * browser is launched.
 */

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const temps: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const d of locked.splice(0)) if (existsSync(d)) chmodSync(d, 0o700);
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "capstone-wb-run-")));
  temps.push(dir);
  return dir;
}
function put(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const TASKS = [
  "- id: task-1",
  "  date: 2025-05-12",
  "  level: easy",
  "  description: |",
  "    Serve 'home' at '/'.",
  "",
  "- id: task-2",
  "  date: 2025-05-12",
  "  level: moderate",
  "  description: |",
  "    Serve 'two' at '/two'.",
  "",
  "- id: task-3",
  "  date: 2025-05-12",
  "  level: challenging",
  "  description: |",
  "    Keep both.",
  "",
].join("\n");

/** A Playwright configuration shaped like Web-Bench's fastify project's. */
const CONFIG = `const { defineConfig, devices } = require('@playwright/test')
const PROJECT_DIR = process.env.EVAL_PROJECT_ROOT || 'src'
const PORT = process.env.EVAL_PROJECT_PORT || 3211
module.exports = defineConfig({
  testDir: './test',
  timeout: 60000,
  workers: process.env.MAX_TEST_WORKERS ? +process.env.MAX_TEST_WORKERS : undefined,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'html' : 'line',
  use: { baseURL: \`http://localhost:\${PORT}\` },
  webServer: {
    command: \` npm run db -- \${PROJECT_DIR} && npm run dev -- \${PROJECT_DIR} \${PORT}\`,
    env: { DB_HOST: \`\${PROJECT_DIR}/test.sqlite\` },
    url: \`http://localhost:\${PORT}\`,
    reuseExistingServer: process.env.IS_EVAL_PRODUCTION ? false : true,
    timeout: 60000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
`;
const spec = (path: string, body: string) =>
  `const { test, expect } = require('@playwright/test')\ntest('${path}', async ({ request }) => {\n  const r = await request.get('${path}')\n  expect(await r.text()).toBe('${body}')\n})\n`;
const SERVER = (routes: Record<string, string>) =>
  `const routes = ${JSON.stringify(routes)}\nrequire('http').createServer((q, s) => s.end(routes[q.url] ?? 'none')).listen(process.env.PORT)\n`;
const FIXED = SERVER({ "/": "home", "/two": "two" });

/** A checkout shaped like Web-Bench's, frozen by the product's own script. */
function checkout() {
  const root = temp();
  const src = join(root, "webbench-src");
  const p = "projects/fastify";
  put(src, "LICENSE.md", "  Apache License\n  Version 2.0, January 2004\n");
  put(src, `${p}/tasks.yml`, TASKS);
  put(
    src,
    `${p}/package.json`,
    `${JSON.stringify({ name: "@web-bench/fastify", scripts: { db: "node scripts/init-db.js", dev: "node scripts/dev.js", test: "npx @web-bench/test-util" } })}\n`,
  );
  put(src, `${p}/playwright.config.js`, CONFIG);
  put(
    src,
    `${p}/scripts/init-db.js`,
    "const fs = require('fs')\nif (process.env.DB_HOST) fs.writeFileSync(process.env.DB_HOST, '')\n",
  );
  put(
    src,
    `${p}/scripts/dev.js`,
    "const { execSync } = require('child_process')\nexecSync(`node ${process.argv[2]}/index.js`, { stdio: 'inherit', env: { ...process.env, PORT: process.argv[3] } })\n",
  );
  put(src, `${p}/.evalignore`, "tsconfig.json\n");
  put(src, `${p}/.gitignore`, "test.sqlite\n.env\n");
  put(src, `${p}/src-init/index.js`, SERVER({ "/": "home" }));
  put(src, `${p}/src-init/readme.md`, "# A tiny shop\n");
  put(src, `${p}/src-init/tsconfig.json`, "{}\n");
  put(src, `${p}/src/index.js`, `// THE REFERENCE SOLUTION\n${FIXED}`);
  put(src, `${p}/test/task-1.spec.js`, spec("/", "home"));
  put(src, `${p}/test/task-2.spec.js`, spec("/two", "two"));
  put(src, `${p}/test/task-3.spec.js`, spec("/", "home"));
  put(
    src,
    "libraries/test-util/test.sh",
    "n=${1:-0}\ntasks=$(seq -f \"test/task-%g.spec\" 1 \"$n\" | tr '\\n' ' ' | sed 's/ $//')\necho \"$tasks\"\nnpx playwright test $tasks\n",
  );
  put(src, "libraries/test-util/package.json", '{"name":"@web-bench/test-util"}\n');
  put(src, "libraries/shop-test-util/src/index.js", "module.exports = {}\n");
  put(src, "libraries/shop-test-util/package.json", '{"name":"@web-bench/shop-test-util"}\n');
  put(src, "common/config/rush/pnpm-lock.yaml", "lockfileVersion: '6.0'\n");
  git(src, "init", "-q", "-b", "main");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "fixture");
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, `${JSON.stringify(webbench.freeze(src), null, 2)}\n`);
  const deps = join(root, "webbench-deps");
  put(deps, "node_modules/left-pad/package.json", '{"name":"left-pad","version":"1.3.0"}\n');
  put(deps, "node_modules/left-pad/index.js", "module.exports = (s) => s\n");
  const hidden = join(root, "hidden");
  mkdirSync(hidden, { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: root,
    SEKHEMET_CAPSTONE_RUNS: join(root, "runs"),
    SEKHEMET_CAPSTONE_HIDDEN: hidden,
    SEKHEMET_WEBBENCH_SRC: src,
    SEKHEMET_WEBBENCH_DEPS: deps,
    TMPDIR: join(root, "tmp"),
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  return { root, src, manifest, deps, hidden, env };
}
type Fixture = ReturnType<typeof checkout>;

function files(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out.sort();
}
function readLog(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("Web-Bench's own protocol, ported", () => {
  it("counts pass@1, pass@2 and error@1 as its report does", () => {
    const ok = [true];
    const run = (fails: Record<number, boolean[]>, n: number) =>
      Array.from({ length: n }, (_, i) => fails[i] ?? ok);
    // Web-Bench's report tests: 20 tasks, retry 2.
    const a = run({ 5: [false, true], 7: [false, true], 10: [false, false] }, 11);
    expect(agent.getPassCounts(a, 20, 2)).toEqual([5, 10]);
    expect(agent.getErrorCounts(a, 2)).toEqual([3]);
    expect(agent.rate(5, 20)).toBe(25);
    const b = run({ 10: [false, false] }, 11);
    expect(agent.getPassCounts(b, 20, 2)).toEqual([10, 10]);
    expect(agent.getPassCounts(run({}, 20), 20, 2)).toEqual([20, 20]);
    expect(agent.getPassCounts([[false, false]], 20, 2)).toEqual([0, 0]);
    expect(agent.getErrorCounts([[false, false]], 2)).toEqual([1]);
  });

  it("builds each one-shot request as bench-agent does: the files, the task, then code only or the error", () => {
    const first = webbench.oneShotRequest({
      task: "Serve 'two' at '/two'.\n",
      files: { "index.js": "x" },
    });
    expect(first.system).toBe(agent.getSystemMessage());
    expect(first.message).toBe(
      [
        "```index.js\nx\n```",
        "Serve 'two' at '/two'.\n \n Do not compress the original code in file and return full file.",
        "I only want the returned results to contain code, without any explanations.",
      ].join(agent.PART_SEPARATOR),
    );
    const retry = webbench.oneShotRequest({
      task: "Serve 'two' at '/two'.\n",
      files: { "index.js": "x" },
      error: "Expected: two",
    });
    expect(retry.message).toContain(
      "I got the following error, please help me to fix error and apply changes to origin files, return the full files about  index.js for me.",
    );
    expect(retry.message.endsWith("\nExpected: two")).toBe(true);
    expect(retry.messageSha256).toBe(sha(retry.message));
  });

  it("reads a reply's files as bench-agent does, and never writes outside the tree", () => {
    const dir = temp();
    const reply =
      "Here:\n```typescript\n/libs/a.ts\nexport const a = 1\n```\n```js\nconsole.log(1)\nindex.js\n```\n```\nno name\n```\n```js\n../escape.js\nx\n```";
    const blocks = agent.parseMarkdownCodeBlocks(reply);
    expect(blocks.map((b: { filename: string }) => b.filename)).toEqual([
      "libs/a.ts",
      "index.js",
      "",
      "../escape.js",
    ]);
    const applied = webbench.applyReply(dir, reply);
    expect(applied.written).toEqual(["libs/a.ts", "index.js"]);
    expect(applied.refused).toEqual(["../escape.js"]);
    expect(readFileSync(join(dir, "libs/a.ts"), "utf8")).toBe("export const a = 1");
    expect(existsSync(join(dirname(dir), "escape.js"))).toBe(false);
  });

  it("cleans a failed run's output as its evaluator does: no colour, no progress lines, no absolute paths", () => {
    const out = agent.prettierErrorMessage(
      "\u001b[31m  1) test/task-2.spec.js\u001b[39m\n[1/2] [chromium] › x\n\n<html>\n    at /sealed/scratch/web-bench/projects/fastify/test/task-2.spec.js:2:98\n",
      ["/sealed/scratch/web-bench/projects/fastify", "/sealed/scratch/web-bench"],
    );
    expect(out).toBe("  1) test/task-2.spec.js\n    at ./test/task-2.spec.js:2:98");
  });
});

describe("the contestant's packages", () => {
  it("are the project's, from Web-Bench's lockfile, less the tests' own", () => {
    const lock = [
      "importers:",
      "  ../../projects/express:",
      "    dependencies:",
      "      express:",
      "        specifier: ^4",
      "        version: 4.21.0",
      "  ../../projects/fastify:",
      "    dependencies:",
      "      '@fastify/view':",
      "        specifier: ~11.0.0",
      "        version: 11.0.0",
      "      fastify:",
      "        specifier: ~5.3.0",
      "        version: 5.3.3",
      "    devDependencies:",
      "      '@playwright/test':",
      "        specifier: 1.57.0",
      "        version: 1.57.0",
      "      '@web-bench/test-util':",
      "        specifier: workspace:*",
      "        version: link:../../libraries/test-util",
      "      tsx:",
      "        specifier: ~4.19.3",
      "        version: 4.19.4",
      "  ../../projects/nuxt:",
      "    dependencies:",
      "      nuxt:",
      "        specifier: ^3",
      "        version: 3.0.0",
      "",
    ].join("\n");
    expect(webbench.lockedPackages(lock, "projects/fastify")).toEqual({
      "@fastify/view": "11.0.0",
      fastify: "5.3.3",
      tsx: "4.19.4",
    });
    expect(() => webbench.lockedPackages(lock, "projects/react")).toThrow(/no entry/);
  });
});

describe("the contestant's starting tree", () => {
  it("is src-init alone, with the project's installed packages and nothing else of the checkout", () => {
    const f = checkout();
    const dest = join(f.root, "runs", "tree");
    const m = webbench.materialise({ src: f.src, manifestFile: f.manifest, deps: f.deps, dest });
    expect(files(dest).filter((p) => !p.startsWith(".git/"))).toEqual([
      "index.js",
      "node_modules/left-pad/index.js",
      "node_modules/left-pad/package.json",
      "readme.md",
      "tsconfig.json",
    ]);
    expect(m.packages).toEqual(["left-pad@1.3.0"]);
    expect(git(dest, "log", "--format=%s")).toBe("The starting tree (Web-Bench src-init)");
    expect(git(dest, "ls-files").split("\n")).not.toContain("node_modules/left-pad/index.js");
    expect(m.ignore).toEqual(["test.sqlite", ".env", "tsconfig.json"]);
    expect(webbench.contextFiles(dest, m.ignore)).toEqual({
      "index.js": readFileSync(join(dest, "index.js"), "utf8"),
      "readme.md": "# A tiny shop\n",
    });
  });

  it("refuses a changed checkout, and packages that would carry the tests' own libraries", () => {
    const f = checkout();
    put(f.deps, "node_modules/@web-bench/shop-test-util/index.js", "x\n");
    expect(() =>
      webbench.materialise({
        src: f.src,
        manifestFile: f.manifest,
        deps: f.deps,
        dest: join(f.root, "t1"),
      }),
    ).toThrow(/@web-bench/);
    rmSync(join(f.deps, "node_modules/@web-bench"), { recursive: true });
    put(f.src, "projects/fastify/test/task-2.spec.js", "// weakened\n");
    expect(() =>
      webbench.materialise({
        src: f.src,
        manifestFile: f.manifest,
        deps: f.deps,
        dest: join(f.root, "t2"),
      }),
    ).toThrow(/task-2\.spec\.js/);
  });
});

describe("scoring one task", () => {
  it("runs Web-Bench's test command for tasks 1 to n against a copy of the tree in the sealed scratch root", async () => {
    const f = checkout();
    const tree = join(f.root, "runs", "tree");
    webbench.materialise({ src: f.src, manifestFile: f.manifest, deps: f.deps, dest: tree });
    symlinkSync(f.src, join(tree, "leak"));
    const before = files(tree);
    const one = await webbench.scoreTask({ tree, n: 1, env: f.env, manifestFile: f.manifest });
    expect(one.passed, one.error).toBe(true);
    expect(one.error).toBe("");
    const two = await webbench.scoreTask({ tree, n: 2, env: f.env, manifestFile: f.manifest });
    expect(two.passed).toBe(false);
    expect(two.error).toContain('Expected: "two"');
    expect(two.error).toContain("test/task-2.spec.js");
    expect(two.error).not.toContain(f.root);
    expect(two.error).not.toMatch(/^\[\d+\/\d+\]/m);
    expect(files(tree)).toEqual(before);
    const scratch = `${f.hidden}-scratch`;
    expect(readdirSync(scratch)).toEqual([]);
  }, 120_000);
});

/** A stand-in one-shot model: it changes nothing, except (when told to) the fix on task-2's retry. */
function scriptedAsk(fixOnRetry: boolean) {
  const asked: Array<{ system: string; message: string }> = [];
  const ask = async (request: { system: string; message: string }) => {
    asked.push(request);
    const retry = request.message.includes("I got the following error");
    const text =
      fixOnRetry && retry && request.message.includes("Serve 'two'")
        ? `\`\`\`js\nindex.js\n${FIXED}\`\`\``
        : "Nothing to change.";
    return { text, usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return { asked, ask };
}

describe("a one-shot cell on Web-Bench", () => {
  it("gives task n, then one retry carrying the test output, and scores pass@1 and pass@2 beside the capstone's runs", async () => {
    const f = checkout();
    const s = scriptedAsk(true);
    const r = await webbench.runWebBench({
      armId: "one-shot-opus",
      run: 1,
      env: f.env,
      manifestFile: f.manifest,
      attempt: webbench.oneShotAttempt(s.ask),
    });
    expect(s.asked).toHaveLength(4);
    expect(s.asked.every((q) => q.system === agent.getSystemMessage())).toBe(true);
    expect(s.asked[1].message).not.toContain("I got the following error");
    expect(s.asked[2].message).toContain("I got the following error");
    expect(s.asked[2].message).toContain('Expected: "two"');
    for (const q of s.asked) expect(q.message).not.toContain(f.root);
    const dir = join(f.env.SEKHEMET_CAPSTONE_RUNS, "webbench-one-shot-opus", "1");
    expect(r.paths.dir).toBe(dir);
    const score = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
    expect(score).toMatchObject({
      benchmark: "web-bench",
      arm: "one-shot-opus",
      row: "one-shot",
      run: 1,
      tasks: 3,
      passTasks: [1, 3],
      pass: { "pass@1": 33.33, "pass@2": 100 },
      error: { "error@1": 33.33 },
      stoppedAt: null,
    });
    expect(score.perTask.map((t: { attempts: boolean[] }) => t.attempts)).toEqual([
      [true],
      [false, true],
      [true],
    ]);
    const log = readLog(dir);
    const given = log.filter((e) => e.kind === "given");
    expect(given.map((e) => [e.task, e.attempt])).toEqual([
      ["task-1", 1],
      ["task-2", 1],
      ["task-2", 2],
      ["task-3", 1],
    ]);
    const m = JSON.parse(readFileSync(f.manifest, "utf8"));
    expect(given[1].taskSha256).toBe(m.tasks[1].sha256);
    expect(log.filter((e) => e.kind === "tested").map((e) => e.passed)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    const record = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect(record.checkout.commit).toBe(m.commit);
    expect(record.protocol.retry).toBe(2);
    // Where the port differs from bench-agent and the evaluator, recorded with the run.
    expect(Object.keys(record.protocol.departures).sort()).toEqual([
      "contextFit",
      "fileValidation",
      "messageParts",
      "passRule",
      "playwright",
      "requestRetries",
      "testCommand",
    ]);
    expect(record.protocol.departures.contextFit).toContain("not sent");
    expect(record.protocol.departures.passRule).toContain("exit");
    expect(existsSync(join(dir, "repo", "src"))).toBe(false);
    const stats = webbench.webbenchStats(f.env);
    expect(stats.arms["one-shot-opus"]).toMatchObject({
      row: "one-shot",
      runs: [{ run: 1, "pass@1": 33.33, "pass@2": 100, "error@1": 33.33, stoppedAt: null }],
      mean: { "pass@1": 33.33, "pass@2": 100 },
    });
  }, 180_000);

  it("stops after a task fails both attempts, as Web-Bench's sequential mode does", async () => {
    const f = checkout();
    const s = scriptedAsk(false);
    await webbench.runWebBench({
      armId: "one-shot-haiku",
      run: 2,
      env: f.env,
      manifestFile: f.manifest,
      attempt: webbench.oneShotAttempt(s.ask),
    });
    expect(s.asked).toHaveLength(3);
    const dir = join(f.env.SEKHEMET_CAPSTONE_RUNS, "webbench-one-shot-haiku", "2");
    const score = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
    expect(score.passTasks).toEqual([1, 1]);
    expect(score.pass).toEqual({ "pass@1": 33.33, "pass@2": 33.33 });
    expect(score.stoppedAt).toBe("task-2");
    expect(score.perTask).toHaveLength(2);
  }, 180_000);
});

/** A stand-in `claude` that records what it could read and fixes the app when told the tests failed. */
function fakeClaude(root: string): { bin: string; seen: string } {
  const bin = join(root, "fake-claude.mjs");
  const seen = join(root, "claude-seen.jsonl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { accessSync, appendFileSync, constants, readFileSync, writeFileSync } from "node:fs";
const message = readFileSync(0, "utf8");
let readable = true;
try { accessSync(process.env.SEKHEMET_WEBBENCH_SRC, constants.R_OK); } catch { readable = false; }
appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ message, readable, args: process.argv.slice(2) }) + "\\n");
if (message.includes("did not pass its tests") && message.includes("Serve 'two'"))
  writeFileSync("index.js", ${JSON.stringify(FIXED)});
const ask = message.includes("Keep both") && !message.includes("There is no one to ask");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: ask ? "Should I keep the old route?" : "Done.", usage: { input_tokens: 7, output_tokens: 3 } }));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, seen };
}

/** The OS isolation the protocol needs, done here by permissions: attach for scoring, detach for the arm. */
function permissionSealing(f: Fixture) {
  const dirs = () => [f.src, f.hidden, `${f.hidden}-scratch`].filter((d) => existsSync(d));
  const detach = () => {
    for (const d of dirs()) chmodSync(d, 0o000);
    locked.push(...dirs());
  };
  const attach = () => {
    for (const d of dirs()) chmodSync(d, 0o700);
  };
  return { attach, detach };
}

describe("an agentic cell on Web-Bench", () => {
  it("is refused while the checkout is readable to the contestant", async () => {
    const f = checkout();
    await expect(
      webbench.runWebBench({
        armId: "claude-code-haiku",
        run: 1,
        env: f.env,
        manifestFile: f.manifest,
        attempt: webbench.claudeCodeAttempt({ env: f.env }),
        networkProbe: async () => false,
      }),
    ).rejects.toThrow(/readable by this user/);
  }, 60_000);

  it("is refused while GitHub or Hugging Face can be reached from this machine", async () => {
    const f = checkout();
    if (process.getuid?.() === 0) return;
    const fake = fakeClaude(f.root);
    const env = { ...f.env, SEKHEMET_CLAUDE_BIN: fake.bin };
    const probed: string[] = [];
    await expect(
      webbench.runWebBench({
        armId: "claude-code-haiku",
        run: 1,
        env,
        manifestFile: f.manifest,
        sealing: permissionSealing(f),
        attempt: webbench.claudeCodeAttempt({ env }),
        networkProbe: async (host: string) => {
          probed.push(host);
          return host === "raw.githubusercontent.com";
        },
      }),
    ).rejects.toThrow(/raw\.githubusercontent\.com can be reached/);
    // Every host that serves Web-Bench's tests is probed; none of the arm's work began.
    expect(probed).toEqual(webbench.WEBBENCH_HOSTS);
    expect(webbench.WEBBENCH_HOSTS).toEqual(
      expect.arrayContaining(["github.com", "raw.githubusercontent.com", "huggingface.co"]),
    );
    expect(existsSync(fake.seen)).toBe(false);
    const log = readLog(join(f.env.SEKHEMET_CAPSTONE_RUNS, "webbench-claude-code-haiku", "1"));
    expect(log.find((e) => e.kind === "stopped")).toMatchObject({ why: "not isolated" });
  }, 60_000);

  it("probes a host by connecting to it: a listening port is reachable, a closed one is not", async () => {
    const server = createServer((_req, res) => res.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    expect(await webbench.tcpProbe("127.0.0.1", { port, timeoutMs: 2000 })).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await webbench.tcpProbe("127.0.0.1", { port, timeoutMs: 2000 })).toBe(false);
  });

  it("drives Claude Code task by task in one session, sealed while it works, the retry carrying the test output", async () => {
    const f = checkout();
    if (process.getuid?.() === 0) return; // root reads through mode 000
    const fake = fakeClaude(f.root);
    const env = { ...f.env, SEKHEMET_CLAUDE_BIN: fake.bin };
    await webbench.runWebBench({
      armId: "claude-code-haiku",
      run: 1,
      env,
      manifestFile: f.manifest,
      sealing: permissionSealing(f),
      attempt: webbench.claudeCodeAttempt({ env }),
      networkProbe: async () => false,
    });
    const seen = readFileSync(fake.seen, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(seen.every((s: { readable: boolean }) => s.readable === false)).toBe(true);
    const m = seen.map((s: { message: string }) => s.message);
    expect(m[0]).toBe("Serve 'home' at '/'.\n");
    expect(m[1]).toBe("Serve 'two' at '/two'.\n");
    expect(m[2].startsWith("Serve 'two' at '/two'.\n")).toBe(true);
    expect(m[2]).toContain('Expected: "two"');
    expect(m[3]).toBe("Keep both.\n");
    expect(m[4]).toBe(webbench.NO_ANSWER);
    expect(seen).toHaveLength(5);
    const ids = seen.map((s: { args: string[] }) => s.args[s.args.length - 1]);
    expect(new Set(ids).size).toBe(1);
    expect(seen[0].args).toContain("--session-id");
    expect(seen[1].args).toContain("--resume");
    const dir = join(f.env.SEKHEMET_CAPSTONE_RUNS, "webbench-claude-code-haiku", "1");
    const score = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
    expect(score.pass).toEqual({ "pass@1": 33.33, "pass@2": 100 });
    expect(score.row).toBe("harness");
    const settings = JSON.parse(readFileSync(join(dir, "input", "claude-settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain(`Read(/${resolve(f.src)}/**)`);
  }, 180_000);
});

/** A stand-in dashboard: the calls the person makes, one Ready issue per message, built by the stand-in queue. */
async function standInDashboard(repo: string) {
  const messages: Array<Record<string, unknown>> = [];
  const cards: Array<{ id: string; status: string; message: string }> = [];
  let seq = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.url === "/api/session") return send(200, { csrf: "t" });
      if (req.url === "/api/pm/thread") return send(200, { messages, status: { phase: "idle" } });
      if (req.url === "/api/board") return send(200, { cards });
      if (req.url === "/api/pm/messages" && req.method === "POST") {
        const { text } = JSON.parse(body);
        const mine = { id: `m${++seq}`, seq, role: "user", text };
        messages.push(mine);
        const question = text.includes("Keep both") && !text.includes("There is no one");
        messages.push({
          id: `m${++seq}`,
          seq,
          role: "pm",
          state: "done",
          text: question ? "Which routes should stay?" : "One issue is Ready.",
          proposals: [],
        });
        if (!question) cards.push({ id: `c${cards.length + 1}`, status: "ready", message: text });
        return send(200, { message: mine });
      }
      return send(404, { error: "not in the stand-in" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runQueue = async () => {
    for (const c of cards.filter((x) => x.status === "ready")) {
      if (c.message.includes("did not pass its tests") && c.message.includes("Serve 'two'"))
        writeFileSync(join(repo, "index.js"), FIXED);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "--allow-empty", "-m", `built ${c.id}`);
      c.status = "done";
    }
    return { exit: 0, timedOut: false };
  };
  return { url, runQueue, messages, close: () => server.close() };
}

describe("the Sekhemet cell on Web-Bench", () => {
  it("gives Seshat task n, works the board until nothing is Ready, and scores the tree the person holds", async () => {
    const f = checkout();
    if (process.getuid?.() === 0) return;
    const prepared = webbench.prepareWebBench({
      armId: "sekhemet-local",
      run: 1,
      env: f.env,
      manifestFile: f.manifest,
      sealing: permissionSealing(f),
    });
    const d = await standInDashboard(realpathSync(prepared.paths.repo));
    try {
      await webbench.runWebBench({
        armId: "sekhemet-local",
        run: 1,
        env: f.env,
        manifestFile: f.manifest,
        sealing: permissionSealing(f),
        attempt: webbench.sekhemetAttempt({ url: d.url, runQueue: d.runQueue, pollMs: 20 }),
        networkProbe: async () => false,
      });
    } finally {
      d.close();
    }
    const mine = d.messages.filter((m) => m.role === "user").map((m) => m.text as string);
    expect(mine[0]).toBe("Serve 'home' at '/'.\n");
    expect(mine[2]).toContain('Expected: "two"');
    expect(mine).toContain(webbench.NO_ANSWER);
    const dir = join(f.env.SEKHEMET_CAPSTONE_RUNS, "webbench-sekhemet-local", "1");
    const score = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
    expect(score.pass).toEqual({ "pass@1": 33.33, "pass@2": 100 });
    const log = readLog(dir);
    expect(log.some((e) => e.kind === "person" && e.what === "answer Seshat")).toBe(true);
  }, 180_000);
});
