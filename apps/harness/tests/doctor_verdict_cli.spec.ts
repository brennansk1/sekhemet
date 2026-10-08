import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CardStore, SCHEMA_VERSION } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { type Place, cliEnv, place, runCli, spawnCli, writeFile } from "./support/cli_spawn.js";

// `doctor`'s verdict, its next steps and the catalogue's C5 rows through
// their door (surface item 20b, NEW-surface-8; FINDINGS_C1 CLI-02;
// DESIGN_GAPS_C1 b11): the built `apps/harness/dist/index.js doctor`
// spawned in a real folder with an empty home, a real git repository and a
// real ledger where a test needs one. No model loads, and the owner's model
// servers are refused at the socket (support/cli_spawn.ts); where a test
// needs Ollama to answer, a preload answers its model list itself.

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

function gitRepo(p: Place): string {
  git(p.repo, "init", "-q", "-b", "main");
  writeFile(p.repo, "src/a.ts", "export const a = 0;\n");
  writeFile(p.repo, ".gitignore", ".sekhemet/\n");
  git(p.repo, "add", "-A");
  git(p.repo, "commit", "-q", "-m", "seed");
  return p.repo;
}

/** A git repository with a ledger and one card, as the planner leaves it. */
async function repoWithLedger(p: Place, status: "ready" | "in_progress" = "ready") {
  gitRepo(p);
  const { db, log } = openLocalLedger(p.repo);
  const store = new CardStore(db, log);
  await store.createCard({
    id: "c1",
    tier: "task",
    title: "Write a",
    status,
    scopeFiles: ["src/a.ts"],
    acceptanceCriteria: ["a is 1"],
  });
  return { db, log, store };
}

/** The doctor's line for one row: its mark, its name, and what it says. */
function row(out: string, name: string): string {
  return out.split("\n").find((l) => l.includes(` ${name}: `)) ?? `(no ${name} row)\n${out}`;
}

/** The line after a row: its `Do:` step, when the row is not a pass. */
function stepOf(out: string, name: string): string {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.includes(` ${name}: `));
  return i === -1 ? `(no ${name} row)` : (lines[i + 1] ?? "");
}

/** A process that has exited: its pid names no live process. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
}

const SCHEMA = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../data/schemas/cli/doctor.schema.json"), "utf8"),
);

describe("doctor ends with one verdict, and every check that is not a pass names its next step (SUR-61, SUR-62, SUR-64)", () => {
  it(
    "SUR-61, SUR-62, SUR-64: in a folder that is no repository it is Not ready, exit 1, each warning and failure followed by its Do line, with no raw git error, no pnpm and no skills warning",
    { timeout: 180_000 },
    async () => {
      const p = place("sek-doctor-verdict-");
      const r = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toMatch(/All critical checks passed|One or more checks FAILED/);
      // SUR-62: every row that is not a pass is followed by its own Do line.
      const lines = r.out.split("\n");
      const notPass = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s+[!✗] /.test(l));
      expect(notPass.length).toBeGreaterThan(0);
      for (const { l, i } of notPass) {
        expect(l, l).not.toMatch(/Do: /);
        expect(lines[i + 1], `after: ${l}`).toMatch(/^\s+Do: \S.*\.$/);
      }
      // SUR-61: the verdict names the first missing step and its Do.
      expect(lines.filter((l) => /^(Ready to run an issue|Not ready)/.test(l))).toHaveLength(1);
      expect(r.out).toMatch(/^Not ready: [^\n]+\. Do: [^\n]+\.$/m);
      // SUR-64: no raw git outside a repository; it names `git init`.
      expect(r.out).not.toMatch(/Command failed|fatal: not a git repository/);
      expect(row(r.out, "Git repository")).toMatch(
        /✗ Git repository: \S+ is not inside a git repository/,
      );
      expect(stepOf(r.out, "Git repository")).toMatch(/Do: run `git init` in /);
      // SUR-64: no package.json probes no package manager; no .sekhemet/ is not warned about skills.
      expect(row(r.out, "Package manager")).toMatch(/✓ Package manager: no package\.json here/);
      expect(r.out).not.toMatch(/ pnpm: /);
      expect(row(r.out, "Skills")).toMatch(/✓ Skills: /);
    },
  );

  it(
    "SUR-64: an npm project probes npm, never pnpm; a pnpm project whose pnpm is missing fails naming it, with its Do line",
    { timeout: 240_000 },
    async () => {
      const p = place("sek-doctor-pm-");
      gitRepo(p);
      writeFile(p.repo, "package.json", JSON.stringify({ name: "shop" }));
      const npm = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(npm.out, "Package manager")).toMatch(
        /✓ Package manager: npm \S+, the project's package manager/,
      );
      expect(npm.out).not.toMatch(/pnpm/);
      // The same folder, now a pnpm project, on a PATH whose pnpm does not run.
      writeFile(p.repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
      const bin = join(p.root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "pnpm"), "#!/bin/sh\necho 'pnpm: broken install' >&2\nexit 1\n");
      chmodSync(join(bin, "pnpm"), 0o755);
      const pnpm = await runCli(["doctor"], p, {
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
        timeoutMs: 150_000,
      });
      expect(pnpm.code).toBe(1);
      expect(row(pnpm.out, "Package manager")).toMatch(
        /✗ Package manager: pnpm, the project's package manager, is not runnable/,
      );
      expect(stepOf(pnpm.out, "Package manager")).toMatch(/Do: install pnpm/);
    },
  );

  it(
    "SUR-61: with the engine found, the Coding model verified and a git repository, it says Ready to run an issue and exits 0",
    { timeout: 240_000 },
    async () => {
      const p = place("sek-doctor-ready-");
      gitRepo(p);
      const worker = "qwen-scripted-worker:latest";
      writeFile(p.repo, ".sekhemet/config.toml", `[models]\nexecutor = "${worker}"\n`);
      // The engine: a llama-server that reports a build at the floor.
      const engine = join(p.root, "llama-server");
      writeFileSync(engine, "#!/bin/sh\necho 'version: 10809 (0a1b2c3)' >&2\n");
      chmodSync(engine, 0o755);
      // Ollama serves the Coding model: its model list answered in process.
      const preload = join(p.root, "ollama.mjs");
      writeFileSync(
        preload,
        `const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:11434")) return real(input, init);
  const body = new URL(url).pathname === "/api/tags" ? { models: [{ name: ${JSON.stringify(worker)} }] } : {};
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};
`,
      );
      const env = {
        SEKHEMET_LLAMA_SERVER: engine,
        NODE_OPTIONS: `--import=${preload}`,
      };
      // The Coding model verified for its combination on this host, by the
      // built modules in the command's own environment (as `qualify` records it).
      const record = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { ModelRegistry, ModelRoster, QUALIFICATION_SUITE_VERSION } = await import(${JSON.stringify(resolve(import.meta.dirname, "../../../packages/models/dist/index.js"))});
const { qualificationCombination } = await import(${JSON.stringify(resolve(import.meta.dirname, "../dist/qualify.js"))});
const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
const adapter = new ModelRoster({ registry }).resolve(${JSON.stringify(worker)}, "worker");
registry.recordCombinationQualification(adapter.modelId, qualificationCombination(adapter, { registry, role: "worker" }), {
  suiteVersion: QUALIFICATION_SUITE_VERSION, passRate: 1, status: "qualified", toolCallChecks: true,
});`,
        ],
        { cwd: p.repo, encoding: "utf8", env: cliEnv(p, env) },
      );
      expect(record.status, record.stderr).toBe(0);
      const r = await runCli(["doctor"], p, { env, timeoutMs: 150_000 });
      expect(row(r.out, "Inference engine")).toMatch(/✓ Inference engine: llama-server b10809/);
      expect(row(r.out, "Role verification")).toMatch(
        /✓ Role verification: Coding model qwen-scripted-worker:latest: verified/,
      );
      expect(r.out).not.toMatch(/^\s+✗ /m);
      expect(r.out).toMatch(/^Ready to run an issue\.$/m);
      expect(r.code, r.out).toBe(0);
    },
  );

  it(
    "SUR-61, SUR-62: --json carries the verdict, ready, and each not-pass check's do, and matches the schema",
    { timeout: 180_000 },
    async () => {
      const p = place("sek-doctor-json-");
      const s = spawnCli(["doctor", "--json"], p);
      const code = await s.exited;
      const stdout = s
        .out()
        .split("\n")
        .filter((l) => l.startsWith("{"));
      expect(stdout).toHaveLength(1);
      const v = JSON.parse(stdout[0] as string) as {
        ready: boolean;
        verdict: string;
        message: string;
        exitCode: number;
        checks: { name: string; status: string; detail: string; do?: string }[];
      };
      const valid = new AjvJsonSchemaValidator().getValidator(SCHEMA)(v);
      expect(valid.errorMessage).toBeUndefined();
      expect(code).toBe(1);
      expect(v.ready).toBe(false);
      expect(v.verdict).toMatch(/^Not ready: .+\. Do: .+\.$/);
      expect(v.message).toBe(v.verdict);
      for (const c of v.checks) {
        if (c.status === "pass") expect(c.do, c.name).toBeUndefined();
        else expect(c.do, c.name).toMatch(/\S.*\.$/);
      }
    },
  );
});

describe("the catalogue's ledger, lock and sweep rows (SUR-63)", () => {
  it(
    "SUR-63: a ledger whose chain verifies passes with its schema version; an entry edited outside Sekhemet fails, naming the entry, with `sekhemet log` and a restore as the step",
    { timeout: 240_000 },
    async () => {
      const p = place("sek-doctor-chain-");
      const { db } = await repoWithLedger(p);
      db.close();
      const good = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(good.out, "Activity log")).toMatch(
        new RegExp(
          `✓ Activity log: \\d+ entries, the hash chain verifies; schema version ${SCHEMA_VERSION}`,
        ),
      );
      // A hand edit: the append-only trigger dropped first, as a person outside Sekhemet could.
      const raw = new DatabaseSync(join(p.repo, ".sekhemet", "events.db"));
      raw.exec("DROP TRIGGER IF EXISTS events_no_update");
      raw.prepare("UPDATE events SET payload = ? WHERE seq = 2").run('{"edited":true}');
      raw.close();
      const bad = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(bad.code).toBe(1);
      expect(row(bad.out, "Activity log")).toMatch(
        /✗ Activity log: the hash chain of \S+events\.db does not verify at entry 2/,
      );
      expect(stepOf(bad.out, "Activity log")).toMatch(
        /Do: run `sekhemet log` to see the entry; .*`sekhemet restore --latest`/,
      );
    },
  );

  it(
    "SUR-63: a ledger at a schema version newer than this build's fails, naming both versions",
    { timeout: 180_000 },
    async () => {
      const p = place("sek-doctor-schema-");
      const { db } = await repoWithLedger(p);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      db.close();
      const r = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(r.code).toBe(1);
      expect(row(r.out, "Activity log")).toMatch(
        new RegExp(
          `✗ Activity log: \\S+ is at schema version ${SCHEMA_VERSION + 1}, newer than this build's ${SCHEMA_VERSION}`,
        ),
      );
      expect(stepOf(r.out, "Activity log")).toMatch(/Do: upgrade Sekhemet/);
    },
  );

  it(
    "SUR-63: a runner lease and an accept lock left by processes that are gone are named with their files, and the step says the next run takes them over",
    { timeout: 180_000 },
    async () => {
      const p = place("sek-doctor-locks-");
      const { db } = await repoWithLedger(p);
      db.close();
      const free = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(free.out, "Locks")).toMatch(/✓ Locks: no runner or accept lock is held/);
      const gone = deadPid();
      const now = new Date().toISOString();
      writeFileSync(
        join(p.repo, ".sekhemet", "runner.lock"),
        JSON.stringify({ pid: gone, token: "t", startedAt: now, heartbeatAt: now, kind: "queue" }),
      );
      writeFileSync(
        join(p.repo, ".git", "sekhemet-accept.lock"),
        JSON.stringify({ pid: gone, at: now }),
      );
      const r = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      const line = row(r.out, "Locks");
      expect(line).toMatch(
        new RegExp(`! Locks: a runner lease from pid ${gone}, whose process is gone`),
      );
      expect(line).toContain(join(p.repo, ".sekhemet", "runner.lock"));
      expect(line).toMatch(new RegExp(`an accept lock from pid ${gone}, whose process is gone`));
      expect(line).toContain("sekhemet-accept.lock");
      expect(stepOf(r.out, "Locks")).toMatch(/Do: nothing is needed: the next run takes them over/);
    },
  );

  it(
    "SUR-63: an attempt left running by a stopped run is named as awaiting the sweep, and `sekhemet run` sweeps it, after which the row passes",
    { timeout: 300_000 },
    async () => {
      const p = place("sek-doctor-crashed-");
      const { db, store } = await repoWithLedger(p, "in_progress");
      await store.runs.startAttempt({ cardId: "c1", attemptNumber: 1, modelId: "m" });
      db.close();
      const r = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(r.out, "Crashed attempts")).toMatch(
        /! Crashed attempts: 1 issue stopped mid-attempt with no end recorded \(a crash or a kill\): c1; the next start-up sweep returns it to Ready/,
      );
      expect(stepOf(r.out, "Crashed attempts")).toMatch(/Do: run `sekhemet run`/);
      // The step, followed: the queue's start-up pass sweeps it (whatever it then runs).
      const swept = await runCli(["run"], p, { timeoutMs: 150_000 });
      expect(swept.out).toMatch(/c1/);
      const after = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(after.out, "Crashed attempts")).toMatch(/✓ Crashed attempts: /);
    },
  );
});

describe("a workspace inside a git repository, and `git clean -xdf` (SUR-82)", () => {
  it(
    "SUR-82: warns that `git clean -xdf` deletes the Activity log, names the newest backup's age, and gives `sekhemet backup` as the step; outside a repository it passes",
    { timeout: 300_000 },
    async () => {
      const p = place("sek-doctor-clean-");
      const { db } = await repoWithLedger(p);
      db.close();
      const none = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      const line = row(none.out, "Workspace in a git repository");
      expect(line).toMatch(
        /! Workspace in a git repository: the workspace folder \S+ lies inside the git repository \S+: `git clean -xdf` there deletes the Activity log/,
      );
      expect(line).toMatch(/there is no backup of it yet/);
      expect(stepOf(none.out, "Workspace in a git repository")).toMatch(
        /Do: run `sekhemet backup` before any `git clean -xdf` there\./,
      );
      const made = await runCli(["backup"], p, { timeoutMs: 120_000 });
      expect(made.code, made.out).toBe(0);
      const backed = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(backed.out, "Workspace in a git repository")).toMatch(
        /the newest backup is less than an hour old/,
      );
      // The same ledger in a folder that is no repository: nothing to warn about.
      const q = place("sek-doctor-noclean-");
      const { db: db2 } = openLocalLedger(q.repo);
      db2.close();
      const plain = await runCli(["doctor"], q, { timeoutMs: 150_000 });
      expect(row(plain.out, "Workspace in a git repository")).toMatch(
        /✓ Workspace in a git repository: the workspace folder is not inside a git repository/,
      );
    },
  );
});

describe("the Team server's address (TEAM-47)", () => {
  it(
    "TEAM-47: a Team setup whose public_url is not https fails naming the TLS front; an https one passes; Solo has no row",
    { timeout: 300_000 },
    async () => {
      const p = place("sek-doctor-team-");
      gitRepo(p);
      const config = join(p.home, "user-config.toml");
      const team = (url: string) =>
        writeFileSync(config, `[team]\nmode = "team"\n\n[identity]\npublic_url = "${url}"\n`);
      team("http://team.example:4040");
      const env = { SEKHEMET_USER_CONFIG: config };
      const plain = await runCli(["doctor"], p, { env, timeoutMs: 200_000 });
      expect(plain.code).toBe(1);
      expect(row(plain.out, "Team address")).toMatch(
        /✗ Team address: \[identity\] public_url is http:\/\/team\.example:4040, which is not https/,
      );
      expect(stepOf(plain.out, "Team address")).toMatch(
        /Do: serve the Team server behind TLS — your reverse proxy \(the `builtin` profile\) or the identity proxy with your certificate \(the `proxy` profile\), docs\/reference\/INSTALL\.md › For a team/,
      );
      team("https://team.example");
      const tls = await runCli(["doctor"], p, { env, timeoutMs: 200_000 });
      expect(row(tls.out, "Team address")).toMatch(
        /✓ Team address: people open https:\/\/team\.example, over TLS/,
      );
      const solo = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(solo.out).not.toMatch(/ Team address: /);
    },
  );
});

describe("the credential store's step matches what serve allows (SUR-86)", () => {
  it(
    "SUR-86: a store at the old place names the Team server as what moves it, and a Solo serve beside it refuses to start, as the step says",
    { timeout: 240_000 },
    async () => {
      const p = place("sek-doctor-store-");
      const { db } = await repoWithLedger(p);
      db.close();
      const root = join(p.home, ".sekhemet", "identity");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "credentials.json"), "{}", { mode: 0o600 });
      const r = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(r.out, "Credential store")).toMatch(
        /! Credential store: .*still at the old place/,
      );
      const step = stepOf(r.out, "Credential store");
      expect(step).toMatch(/Do: set \[team\] mode = "team" in \S+ and run `sekhemet serve`/);
      expect(step).toMatch(/a Solo server refuses to start beside a store/);
      // What the step warns of: Solo `serve` does not start beside the store.
      const serve = await runCli(["serve", "--port", "0"], p, { timeoutMs: 60_000 });
      expect(serve.code).not.toBe(0);
      expect(serve.out).toMatch(/will not start in Solo/);
    },
  );
});

describe.runIf(process.platform === "linux")("socat on Linux (SUR-93)", () => {
  /** This PATH's programs, socat left out, as symbolic links in one folder. */
  function pathWithoutSocat(p: Place): string {
    const bin = join(p.root, "no-socat");
    mkdirSync(bin, { recursive: true });
    const seen = new Set<string>();
    for (const dir of [dirname(process.execPath), ...(process.env.PATH ?? "").split(":")]) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (n === "socat" || seen.has(n)) continue;
        seen.add(n);
        try {
          symlinkSync(join(dir, n), join(bin, n));
        } catch {
          // A name taken by an earlier folder wins, as on the PATH.
        }
      }
    }
    return bin;
  }

  it(
    "SUR-93: socat on the PATH passes; without it the row fails, says the named ports get no route, and gives installing socat as its step",
    { timeout: 240_000 },
    async () => {
      const p = place("sek-doctor-socat-");
      gitRepo(p);
      const found = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(row(found.out, "Port relays")).toMatch(/✓ Port relays: socat found/);
      const missing = await runCli(["doctor"], p, {
        env: { PATH: pathWithoutSocat(p) },
        timeoutMs: 150_000,
      });
      expect(missing.code).toBe(1);
      expect(row(missing.out, "Port relays")).toMatch(
        /✗ Port relays: socat is not on the PATH, so an issue's named ports .* get no route/,
      );
      expect(stepOf(missing.out, "Port relays")).toMatch(
        /Do: install socat \(`sudo apt install socat`/,
      );
    },
  );
});

describe.runIf(process.platform !== "linux")("socat elsewhere (SUR-93)", () => {
  it(
    "SUR-93: outside Linux there is no port-relay row: macOS needs no relay",
    { timeout: 180_000 },
    async () => {
      const p = place("sek-doctor-socat-mac-");
      gitRepo(p);
      const r = await runCli(["doctor"], p, { timeoutMs: 150_000 });
      expect(r.out).not.toMatch(/ Port relays: /);
    },
  );
});
