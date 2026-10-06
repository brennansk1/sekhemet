import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { ModelRegistry, assignRole, hostFingerprintHash } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { recommendRoster } from "../src/init.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { PmStore } from "../src/pm/store.js";
import {
  type Place,
  freePort,
  npmRepo,
  place,
  runCli,
  spawnCli,
  tree,
  writeFile,
} from "./support/cli_spawn.js";

// The front door's commands through their door (C2d, FINDINGS_C1 TST-01):
// `onboard`, `trust`, `board --terminal`, `doctor`, `run`, `queue`, `ask`
// and `--help`, each the built binary spawned in a real repository with an
// empty home. Before C2d these criteria were proved by calling the command's
// function in process. No model loads: the real model servers' ports are
// refused in every spawned process, and Seshat's model, where a test needs
// one to answer, is a stand-in at the HTTP boundary.

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A repository with a ledger and one Ready card, as the planner leaves it. */
async function repoWithCard(p: Place): Promise<string> {
  const repo = p.repo;
  git(repo, "init", "-q", "-b", "main");
  writeFile(repo, "src/a.ts", "export const a = 0;\n");
  writeFile(repo, ".gitignore", ".sekhemet/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(repo);
  await new CardStore(db, log).createCard({
    id: "c1",
    tier: "task",
    title: "Write a",
    status: "ready",
    scopeFiles: ["src/a.ts"],
    acceptanceCriteria: ["a is 1"],
  });
  db.close();
  return repo;
}

function workspaceIdOf(repo: string): string {
  const { db, log } = openLocalLedger(repo);
  const id = log.workspaceId() as string;
  db.close();
  return id;
}

describe("onboarding through the command line (SUR-35, SUR-36, SUR-56)", () => {
  /** A repository a team already works in: its CI, its linter and formatter, its hooks. */
  function teamRepo(p: Place): string {
    const repo = p.repo;
    git(repo, "init", "-q", "-b", "main");
    writeFile(
      repo,
      "package.json",
      JSON.stringify({
        name: "demo",
        scripts: {
          test: `node -e "require('fs').writeFileSync(require('path').join(process.cwd(), 'ran-test'), 'x')"`,
        },
        devDependencies: { eslint: "9", prettier: "3" },
      }),
    );
    writeFile(repo, "eslint.config.js", "export default [];\n");
    writeFile(repo, ".prettierrc", "{}\n");
    writeFile(repo, "src/week.ts", "export const total = (xs: number[]) => xs.length;\n");
    writeFile(
      repo,
      ".github/workflows/ci.yml",
      [
        "jobs:",
        "  call:",
        "    uses: ./.github/workflows/reuse.yml",
        "  db:",
        "    runs-on: ubuntu-latest",
        "    services:",
        "      postgres:",
        "        image: postgres",
        "    steps:",
        "      - run: npm run test:db",
        "  t:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: |",
        "          npm ci",
        "          npm run test:e2e",
        "      - run: npm test",
        "        working-directory: web",
        "",
      ].join("\n"),
    );
    writeFile(repo, ".github/workflows/bad.yml", "jobs: [unclosed\n");
    writeFile(repo, ".gitlab-ci.yml", "include:\n  - local: other.yml\njobs: {}\n");
    // A hook the repository ships: it must not run before the person trusts it.
    for (const hook of ["post-checkout", "pre-commit", "post-commit"]) {
      const h = join(repo, ".git", "hooks", hook);
      writeFileSync(h, `#!/bin/sh\ntouch "${join(p.root, `hook-${hook}`)}"\n`);
      chmodSync(h, 0o755);
    }
    git(repo, "add", "-A");
    execFileSync(
      "git",
      [
        "-c",
        "user.email=e@x",
        "-c",
        "user.name=E",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      {
        cwd: repo,
      },
    );
    return repo;
  }

  it(
    "SUR-35: every CI step is listed with its check or the reason, unreadable files with the parser's reason, includes it does not read named",
    { timeout: 120_000 },
    async () => {
      const p = place();
      teamRepo(p);
      const r = await runCli(["onboard"], p, { timeoutMs: 90_000 });
      expect(r.code).toBe(0);
      const ci = r.out.split("\n").filter((l) => /^\s+CI /.test(l));
      // A multi-line step, and a step in its working directory, each a check.
      expect(ci.join("\n")).toMatch(/ci\.yml:\d+ npm run test:e2e → check ci-test-1/);
      expect(ci.join("\n")).toMatch(/ci\.yml:\d+ \(in web\/\) npm test → check ci-test-2/);
      // The steps that became no check say why.
      expect(ci.join("\n")).toMatch(/ci\.yml:\d+ actions\/checkout@v4 → action/);
      expect(ci.join("\n")).toMatch(/ci\.yml:\d+ npm ci → setup/);
      expect(ci.join("\n")).toMatch(/ci\.yml:\d+ npm run test:db → needs service/);
      // A reusable workflow and a GitLab include are named.
      expect(ci.join("\n")).toMatch(/\.\/\.github\/workflows\/reuse\.yml → reusable workflow/);
      expect(ci.join("\n")).toMatch(
        /\.gitlab-ci\.yml:\d+ .*not read \(included CI file other\.yml/,
      );
      // A file the YAML parser cannot read is listed as unreadable, with the parser's reason.
      expect(ci.join("\n")).toMatch(/bad\.yml:\d+ .*→ unreadable \(.+\)/);
      // And the same list is kept beside the drafts.
      expect(existsSync(join(p.repo, ".sekhemet", "onboard", "ci_coverage.json"))).toBe(true);
    },
  );

  it(
    "SUR-36: the team's own linter and formatter, with their configurations, are the static checks; never Sekhemet's",
    { timeout: 120_000 },
    async () => {
      const p = place();
      teamRepo(p);
      const r = await runCli(["onboard"], p, { timeoutMs: 90_000 });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(
        /Proposed checks [^\n]*lint: npx eslint \.; format: npx prettier --check \./,
      );
      const proposed = readFileSync(
        join(p.repo, ".sekhemet", "onboard", "gates.proposed.toml"),
        "utf8",
      );
      expect(proposed).toMatch(/eslint/);
      expect(proposed).toMatch(/prettier/);
      expect(proposed).not.toMatch(/biome/);
    },
  );

  it(
    "SUR-56: untrusted, onboarding starts no language server and runs nothing from the repository; trusted, it runs them confined",
    { timeout: 180_000 },
    async () => {
      const p = place();
      teamRepo(p);
      const before = await runCli(["onboard"], p, { timeoutMs: 90_000 });
      expect(before.code).toBe(0);
      expect(before.out).toMatch(/language server not started: this repository is not trusted yet/);
      expect(before.out).toMatch(/Baseline not taken: [^\n]*not trusted yet/);
      // Nothing of the repository ran: no test script, no install, no git hook.
      expect(existsSync(join(p.repo, "ran-test"))).toBe(false);
      expect(existsSync(join(p.repo, "node_modules"))).toBe(false);
      expect(readdirSync(p.root).filter((f) => f.startsWith("hook-"))).toEqual([]);
      // The person trusts it; now the baseline runs the project's own checks.
      const trusted = await runCli(["trust", "--yes"], p, { timeoutMs: 60_000 });
      expect(trusted.code).toBe(0);
      expect(trusted.out).toMatch(/Trusted this repository/);
      const after = await runCli(["onboard"], p, { timeoutMs: 150_000 });
      expect(after.code).toBe(0);
      expect(after.out).not.toMatch(/not trusted yet/);
      expect(after.out).toMatch(/Baseline: /);
      expect(existsSync(join(p.repo, "ran-test"))).toBe(true);
    },
  );
});

describe("the user directory and the configuration's upgrade (SUR-25, SUR-26, SUR-43)", () => {
  it(
    "SUR-25: with SEKHEMET_CONFIG_DIR set, user config, registry, trust and the rest are read and written only under it",
    { timeout: 120_000 },
    async () => {
      const p = place();
      npmRepo(p);
      const custom = join(p.root, "elsewhere", "sekhemet-user");
      const env = { SEKHEMET_CONFIG_DIR: custom };
      const first = spawnCli(["--yes", "--port", String(await freePort())], p, { env });
      await first.until(/Sekhemet Configuration: http:\/\/127\.0\.0\.1:\d+/);
      await first.stop();
      expect((await runCli(["trust", "--yes"], p, { env })).code).toBe(0);
      expect((await runCli(["doctor"], p, { env, timeoutMs: 120_000 })).code).not.toBeNull();
      // The home holds nothing of Sekhemet's: not ~/.sekhemet, not ~/.config/sekhemet.
      expect(tree(p.home)).toEqual([]);
      // Everything the user directory holds is under the directory named.
      const kept = tree(custom);
      expect(kept.some((f) => f.startsWith("trust"))).toBe(true);
      expect(kept.some((f) => f.startsWith("backups"))).toBe(true);
    },
  );

  it(
    "SUR-26: files in the old ~/.config/sekhemet are moved once, and doctor reports the move",
    { timeout: 120_000 },
    async () => {
      const p = place();
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.repo });
      const old = join(p.home, ".config", "sekhemet");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "config.toml"), '[team]\nmode = "solo"\n');
      writeFileSync(join(old, "models.json"), '{"models":{}}\n');
      // The default place: no SEKHEMET_CONFIG_DIR, so ~/.sekhemet under this home.
      const env = { SEKHEMET_CONFIG_DIR: "", SEKHEMET_MODELS_DIR: p.models };
      const first = await runCli(["doctor"], p, { env, timeoutMs: 120_000 });
      const user = join(p.home, ".sekhemet");
      expect(first.out).toMatch(
        new RegExp(
          `User directory: ${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: moved 2 items from ${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} on \\d{4}-\\d{2}-\\d{2}`,
        ),
      );
      expect(readFileSync(join(user, "config.toml"), "utf8")).toContain('mode = "solo"');
      expect(existsSync(join(old, "config.toml"))).toBe(false);
      // Once: a file put back at the old place later is not moved again over the new one.
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "config.toml"), '[team]\nmode = "team"\n');
      const second = await runCli(["doctor"], p, { env, timeoutMs: 120_000 });
      expect(readFileSync(join(user, "config.toml"), "utf8")).toContain('mode = "solo"');
      expect(second.out).toMatch(
        /User directory: [^\n]*moved 2 items from [^\n]* on \d{4}-\d{2}-\d{2}/,
      );
    },
  );

  it(
    "SUR-43: an upgrade that finds renamed keys backs config.toml up, rewrites them, and doctor reports each change",
    { timeout: 120_000 },
    async () => {
      const p = place();
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.repo });
      const OLD = '# mine\n[machine]\nhours = "09:00-17:00 Mon-Fri" # my hours\n';
      writeFile(p.repo, ".sekhemet/config.toml", OLD);
      // The first command to open the workspace upgrades it.
      const opened = await runCli(["board", "--terminal"], p);
      expect(opened.code).toBe(0);
      const now = readFileSync(join(p.repo, ".sekhemet", "config.toml"), "utf8");
      expect(now).toContain('reserved_hours = "09:00-17:00 Mon-Fri" # my hours');
      expect(now).not.toMatch(/^hours =/m);
      expect(now).toContain("# mine");
      const backups = readdirSync(join(p.repo, ".sekhemet")).filter((f) => f.endsWith(".bak"));
      expect(backups.length).toBe(1);
      expect(readFileSync(join(p.repo, ".sekhemet", backups[0] as string), "utf8")).toBe(OLD);
      const doctor = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      expect(doctor.out).toMatch(
        /Config upgrades: [^\n]*\[machine\] hours → reserved_hours \(backup [^\n]*\.bak/,
      );
    },
  );
});

describe("board --terminal (SUR-27)", () => {
  it(
    "SUR-27: the board in NAMING's column and state names, a WIP limit only where one is set",
    { timeout: 60_000 },
    async () => {
      const p = place();
      const repo = await repoWithCard(p);
      // [review] wip is set for this project: In review shows count / limit.
      writeFile(repo, ".sekhemet/config.toml", "[review]\nwip = 2\n");
      const r = await runCli(["board", "--terminal"], p);
      expect(r.code).toBe(0);
      const heads = r.out.split("\n").filter((l) => /^\S/.test(l));
      expect(heads.map((h) => h.split(/\s{2,}/)[0])).toEqual([
        "Backlog",
        "To do",
        "In progress",
        "In review",
        "Done",
      ]);
      const line = (name: string) => heads.find((h) => h.startsWith(name)) ?? "";
      expect(line("In review")).toMatch(/^In review\s+0\/2$/);
      // Backlog and Done have no limit set: a count alone.
      expect(line("Backlog")).toMatch(/^Backlog\s+0$/);
      expect(line("Done")).toMatch(/^Done\s+0$/);
      expect(line("To do")).toMatch(/^To do\s+1\b/);
      // The card is listed under To do, in the board's words; never a stored state's name.
      expect(r.out).toMatch(/To do[^\n]*\n[^\n]*Write a/);
      expect(r.out).not.toMatch(/\b(in_progress|parked|rejected|ready)\b/);
    },
  );
});

describe("doctor (SUR-83, SUR-86, SUR-88, SUR-89)", () => {
  it(
    "SUR-83: no backup set while the ledger has events warns with `sekhemet backup`; a fresh set shows its path and age",
    { timeout: 180_000 },
    async () => {
      const p = place();
      await repoWithCard(p);
      const none = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      expect(none.out).toMatch(/! Backup: [^\n]*no backup[^\n]*Do: run `sekhemet backup`/i);
      const made = await runCli(["backup"], p, { timeoutMs: 60_000 });
      expect(made.code).toBe(0);
      const set = (made.out.match(/(\/\S+\/backups\/ws_\w+\/\S+?)(?:\s|\.?$)/m) ?? [])[1];
      expect(set).toBeTruthy();
      const fresh = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      const line = fresh.out.split("\n").find((l) => /Backup:/.test(l)) ?? "";
      expect(line).toMatch(/^\s+✓ Backup:/);
      expect(line).toContain(set as string);
      expect(line).toMatch(/(\d+ (minutes?|hours?) old|just now|less than an hour old)/);
      // 49 hours later (the process's clock moved on), with an event recorded since: a warning.
      const { db, log } = openLocalLedger(p.repo);
      await log.append({ type: "test/noted", actor: "harness", payload: { n: 2 } });
      db.close();
      const later = join(p.root, "later.mjs");
      writeFileSync(
        later,
        `const R = Date; const shift = 49 * 3600 * 1000;
class Later extends R { constructor(...a) { if (a.length === 0) super(R.now() + shift); else super(...a); } static now() { return R.now() + shift; } }
globalThis.Date = Later;
`,
      );
      const stale = await runCli(["doctor"], p, {
        timeoutMs: 120_000,
        env: { NODE_OPTIONS: `--import=${later}` },
      });
      expect(stale.out).toMatch(
        /! Backup: [^\n]*49 hours old[^\n]*recorded since[^\n]*Do: run `sekhemet backup`/,
      );
    },
  );

  it(
    "SUR-86: doctor names the workspace's credential store, warns on one left at the old place, and reports the move with its date",
    { timeout: 180_000 },
    async () => {
      const p = place();
      const repo = await repoWithCard(p);
      const ws = workspaceIdOf(repo);
      const root = join(p.home, ".sekhemet", "identity");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "credentials.json"), "{}", { mode: 0o600 });
      const left = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      const before = left.out.split("\n").find((l) => /Credential store:/.test(l)) ?? "";
      expect(before).toMatch(/^\s+! Credential store:/);
      expect(before).toContain(join(root, ws));
      expect(before).toContain(join(root, "credentials.json"));
      // Starting the workspace's Team server claims the store: it is moved, once, on the ledger.
      // (A Solo server refuses to start beside a credential store; see the digest.)
      const team = join(p.root, "team.toml");
      writeFileSync(team, '[team]\nmode = "team"\nworkspace = "Northwind"\n');
      const serve = spawnCli(["serve", "--port", String(await freePort())], p, {
        env: { SEKHEMET_USER_CONFIG: team },
      });
      await serve.until(/http:\/\/127\.0\.0\.1:\d+/, 60_000);
      await serve.stop();
      const after = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      const line = after.out.split("\n").find((l) => /Credential store:/.test(l)) ?? "";
      expect(line).toMatch(/^\s+✓ Credential store:/);
      expect(line).toContain(`this workspace's store is ${join(root, ws)}`);
      expect(line).toMatch(
        new RegExp(
          `moved credentials\\.json from ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to ${join(root, ws).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} on \\d{4}-\\d{2}-\\d{2}`,
        ),
      );
      expect(existsSync(join(root, ws, "credentials.json"))).toBe(true);
      expect(existsSync(join(root, "credentials.json"))).toBe(false);
    },
  );

  it(
    "SUR-88: lines in the workspace's lost-record log are a warning with their count and the file's path",
    { timeout: 180_000 },
    async () => {
      const p = place();
      const repo = await repoWithCard(p);
      const ws = workspaceIdOf(repo);
      const clean = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      expect(clean.out).toMatch(/✓ Lost records: every record was written/);
      // Two records the ledger could not take (a full disk), in the user directory's log.
      const file = join(p.home, ".sekhemet", "logs", ws, "lost-records.ndjson");
      mkdirSync(join(p.home, ".sekhemet", "logs", ws), { recursive: true });
      writeFileSync(
        file,
        [
          JSON.stringify({
            at: new Date().toISOString(),
            what: "step 3",
            error: "database or disk is full",
          }),
          JSON.stringify({
            at: new Date().toISOString(),
            what: "step 4",
            error: "database or disk is full",
          }),
          "",
        ].join("\n"),
      );
      const warned = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      const line = warned.out.split("\n").find((l) => /Lost records:/.test(l)) ?? "";
      expect(line).toMatch(/^\s+! Lost records: 2 records could not be written/);
      expect(line).toContain(file);
    },
  );

  it(
    "SUR-89: without --verify-weights no unverified file is read and the count, size and time are a warning; a wrong size fails unread; --verify-weights hashes and times it",
    { timeout: 240_000 },
    async () => {
      const p = place();
      await repoWithCard(p);
      const registryPath = join(p.home, "registry.json");
      const env = { SEKHEMET_MODEL_REGISTRY: registryPath };
      const weights = join(p.root, "w.gguf");
      writeFileSync(weights, "weights");
      const sha = createHash("sha256").update("weights").digest("hex");
      new ModelRegistry(registryPath).recordWeights("nail-mtp", {
        path: weights,
        volume: "internal",
        sha256: sha,
      });
      // Unreadable to this process: reading it would fail, so a warning proves it was not read.
      chmodSync(weights, 0o000);
      try {
        const quiet = await runCli(["doctor"], p, { env, timeoutMs: 120_000 });
        const line = quiet.out.split("\n").find((l) => /Weights' hashes:/.test(l)) ?? "";
        expect(line).toMatch(
          /^\s+! Weights' hashes: 1 model file \(7 bytes\) not verified yet: reading it takes about \d+ s; run `sekhemet doctor --verify-weights` to check it/,
        );
      } finally {
        chmodSync(weights, 0o644);
      }
      // --verify-weights hashes every registered file and says how long it took.
      const asked = await runCli(["doctor", "--verify-weights"], p, { env, timeoutMs: 120_000 });
      expect(asked.out).toMatch(
        /✓ Weights' hashes: 1 model file matches its registered SHA-256 \(read in \d+ s\)/,
      );
      // A file whose size changed fails without being read, flag or not.
      writeFileSync(weights, "weights, but longer");
      chmodSync(weights, 0o000);
      try {
        const resized = await runCli(["doctor"], p, { env, timeoutMs: 120_000 });
        const line = resized.out.split("\n").find((l) => /Weights' hashes:/.test(l)) ?? "";
        expect(line).toMatch(/^\s+✗ Weights' hashes:/);
        expect(line).toMatch(/the file is 19 bytes, not the 7 bytes verified before/);
      } finally {
        chmodSync(weights, 0o644);
      }
      // Same size, different bytes: --verify-weights reads it and fails on the hash.
      writeFileSync(weights, "weightz");
      const differs = await runCli(["doctor", "--verify-weights"], p, { env, timeoutMs: 120_000 });
      expect(differs.out).toMatch(
        /✗ Weights' hashes: [^\n]*nail-mtp: the file's hash differs from the registered one/,
      );
    },
  );
});

describe("run and queue resolve the Coding model one way (SUR-11)", () => {
  it(
    "SUR-11: with no Worker named, run, run <issue> and queue use the roster's for this machine's tier; the roster never outranks a person's assignment",
    { timeout: 120_000 },
    async () => {
      const p = place();
      const repo = await repoWithCard(p);
      const registryPath = join(p.home, "registry.json");
      const env = { SEKHEMET_MODEL_REGISTRY: registryPath };
      const roster = recommendRoster(totalmem()).worker;
      const named = (out: string) => (out.match(/Refusing (\S+) as the Coding model/) ?? [])[1];
      // Nothing names one: the roster's, for run, run <issue> and queue alike.
      for (const args of [["run"], ["run", "c1"], ["queue"]])
        expect(named((await runCli(args, p, { env })).out), args.join(" ")).toBe(roster);
      // A person's assignment on this machine: the roster default never outranks it.
      assignRole(new ModelRegistry(registryPath), {
        role: "worker",
        model: "assigned-worker",
        scope: "personal",
        by: "person: Ada",
        host: hostFingerprintHash(),
        qualification: "qualified",
      });
      for (const args of [["run"], ["run", "c1"], ["queue"]])
        expect(named((await runCli(args, p, { env })).out), args.join(" ")).toBe("assigned-worker");
      // A flag outranks the assignment.
      expect(named((await runCli(["queue", "--worker", "flagged"], p, { env })).out)).toBe(
        "flagged",
      );
    },
  );
});

describe("ask and the front door's help (SUR-51, SUR-52)", () => {
  /** Seshat's model, a stand-in answering at the HTTP boundary of the spawned process. */
  function standInSeshat(p: Place, reply: string): Record<string, string> {
    const file = join(p.root, "seshat-stand-in.mjs");
    writeFileSync(
      file,
      `const real = globalThis.fetch;
const REPLY = ${JSON.stringify(reply)};
const json = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^http:\\/\\/(127\\.0\\.0\\.1|localhost):11434\\//.test(url)) return real(input, init);
  const path = new URL(url).pathname;
  const listed = { name: "dirk-27b:latest", model: "dirk-27b:latest", size: 1 };
  if (path === "/api/tags" || path === "/api/ps") return json({ models: [listed] });
  if (path === "/api/show") return json({ model_info: { "general.architecture": "qwen3" }, parameters: "num_ctx 32768" });
  const body = JSON.parse(String(init?.body ?? "{}"));
  const message = { role: "assistant", content: path === "/api/chat" ? REPLY : "" };
  const final = { model: body.model, message, response: path === "/api/generate" ? "" : undefined, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 };
  return body.stream ? new Response(JSON.stringify(final) + "\\n") : json(final);
};
`,
    );
    // Loads are on in this process: the stand-in answers before anything leaves it.
    return { NODE_OPTIONS: `--import=${file}`, SEKHEMET_MODEL_LOADS: "" };
  }

  it(
    "SUR-51: ask posts the person's question to Seshat's thread, prints the reply, records both, exit 0",
    { timeout: 120_000 },
    async () => {
      const p = place();
      const repo = await repoWithCard(p);
      const r = await runCli(["ask", "What is left before the release?"], p, {
        env: standInSeshat(p, "One issue is left: Write a."),
        timeoutMs: 100_000,
      });
      expect(r.out).toContain("One issue is left: Write a.");
      expect(r.code).toBe(0);
      // The same thread the dashboard shows, the person's message first.
      const { db, log } = openLocalLedger(repo);
      const thread = await new PmStore(log).thread();
      db.close();
      expect(thread.map((m) => [m.role, m.state])).toEqual([
        ["user", "done"],
        ["pm", "done"],
      ]);
      expect(thread[0]).toMatchObject({
        text: "What is left before the release?",
        context: { view: "terminal" },
      });
    },
  );

  it(
    "SUR-51: with no model able to answer, ask says why and exits 1, the question kept",
    { timeout: 120_000 },
    async () => {
      const p = place();
      const repo = await repoWithCard(p);
      const r = await runCli(["ask", "What is left?"], p, { timeoutMs: 100_000 });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(
        /No model is answering for Seshat on this machine right now\. Your message is kept/,
      );
      const { db, log } = openLocalLedger(repo);
      const thread = await new PmStore(log).thread();
      db.close();
      expect(thread[0]).toMatchObject({ role: "user", text: "What is left?" });
    },
  );

  it(
    "SUR-52: --help lists ask among the eight front-door commands and not board; board and board --terminal still run, under dev --help",
    { timeout: 60_000 },
    async () => {
      const p = place();
      await repoWithCard(p);
      const help = await runCli(["--help"], p);
      expect(help.code).toBe(0);
      const front = help.out.split("\n").filter((l) => /^ {2}sekhemet\b/.test(l));
      expect(front.length).toBe(8);
      expect(front.some((l) => /^ {2}sekhemet ask "<question>"/.test(l))).toBe(true);
      expect(front.some((l) => /^ {2}sekhemet board\b/.test(l))).toBe(false);
      const dev = await runCli(["dev", "--help"], p);
      expect(dev.out).toMatch(/^ {2}board \[--terminal\]$/m);
      const board = await runCli(["board", "--terminal"], p);
      expect(board.code).toBe(0);
      expect(board.out).toMatch(/^To do\s+1/m);
      const s = spawnCli(["board", "--port", String(await freePort())], p);
      await s.until(/http:\/\/127\.0\.0\.1:\d+/, 60_000);
      await s.stop();
    },
  );
});
