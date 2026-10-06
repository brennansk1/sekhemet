import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { cli, g2Dirs, g2Env } from "./support/g2_cli.js";

// `--validate-tools` through its door (C2d, FINDINGS_C1 TST-01; security item
// 4a, SEC-17a): the built `sekhemet improve --validate-tools` spawned over a
// real repository whose ledger records a command the Worker ran by hand on
// three cards. That command is a probe: it writes a marker outside its
// worktree, reads a fake key from the environment and the home folder, and
// connects to a local listener. Validation runs it confined in a scratch
// worktree; nothing it tries may succeed, and the main checkout is untouched.
// macOS only, as the in-process test it replaces (confined_runs.spec.ts):
// the confinement it proves is Seatbelt's.

const darwin = process.platform === "darwin";

describe.runIf(darwin)("`improve --validate-tools` runs a mined command confined (SEC-17a)", () => {
  let server: Server;
  let port = 0;
  let connections = 0;
  beforeEach(async () => {
    connections = 0;
    server = createServer((s) => {
      connections++;
      s.end();
    });
    port = await new Promise((ok) =>
      server.listen(0, "127.0.0.1", () => ok((server.address() as { port: number }).port)),
    );
  });
  afterEach(() => {
    server.close();
  });

  it("SEC-17a: the probe's marker stays absent, the keys unread, its connection never arrives, the scratch worktree is gone and the main checkout untouched", async () => {
    const where = g2Dirs();
    const repo = where.cwd;
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "sek-validate-out-")));
    const marker = join(outside, "marker");
    writeFileSync(join(where.home, ".sekhemet-fake-key"), "home-canary-key");
    const probe = `const fs = require("fs"), net = require("net");
fs.writeFileSync("ran.txt", "x");
try { fs.writeFileSync(${JSON.stringify(marker)}, "escaped") } catch {}
try { fs.writeFileSync(${JSON.stringify(join(outside, "key-read"))}, (process.env.SEKHEMET_CANARY_API_KEY ?? "") + fs.readFileSync(${JSON.stringify(join(where.home, ".sekhemet-fake-key"))}, "utf8")) } catch {}
net.connect(${port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(3));
`;
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    writeFileSync(join(repo, "probe.cjs"), probe);
    // The control: a well-behaved command, run the same way, validates.
    writeFileSync(
      join(repo, "ok.cjs"),
      "process.exit(require('fs').existsSync('ok.cjs') ? 0 : 1)\n",
    );
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    // The Worker ran the probe by hand on three cards: a tool candidate.
    const { db, log } = openLocalLedger(repo);
    try {
      const store = new CardStore(db, log);
      for (const [i, id] of ["c1", "c2", "c3"].entries()) {
        await store.createCard({ id, tier: "task", title: `Probe ${id}`, scopeFiles: ["src/**"] });
        await log.append({
          actor: "executor",
          type: "card/step",
          cardId: id,
          payload: {
            turn: 1,
            calls: [
              { name: "run_cmd", target: `node probe.cjs ${i + 1}`, summary: "ok" },
              { name: "run_cmd", target: `node ok.cjs --times ${i + 1}`, summary: "ok" },
            ],
          },
        });
      }
    } finally {
      db.close();
    }
    const scratch = () =>
      readdirSync(tmpdir())
        .filter((d) => d.startsWith("sekhemet-validate-"))
        .sort();
    const leftovers = scratch();
    const status = git("status", "--porcelain");
    const r = await cli(["improve", "--validate-tools"], {
      cwd: repo,
      env: { ...g2Env(where.home), SEKHEMET_CANARY_API_KEY: "env-canary-key" },
      timeoutMs: 120_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /tool candidate node: node \{path0\} \{n1\} \(used on 3 issues\) \[failed\]/,
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(outside, "key-read"))).toBe(false);
    expect(connections).toBe(0);
    // The scratch worktree is gone, from disk and from git; the checkout is as it was.
    expect(scratch()).toEqual(leftovers);
    expect(
      git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree ")),
    ).toHaveLength(1);
    expect(existsSync(join(repo, "ran.txt"))).toBe(false);
    expect(git("status", "--porcelain")).toBe(status);
    // The control validated, so the probe's failure is its confinement's.
    expect(r.stdout).toMatch(
      /tool candidate node: node \{path0\} --times \{n1\} \(used on 3 issues\) \[validated\]/,
    );
  }, 180_000);
});
