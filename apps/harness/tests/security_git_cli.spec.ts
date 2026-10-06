import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Turn, WORKER, scriptedTurnsProject } from "./support/g6_models.js";
import { BIN, type G6Repo, g6Repo, statusOf } from "./support/g6_review.js";

/**
 * security §2 items 19 to 22 (the git preflight) at the door (C2d,
 * FINDINGS_C1 TST-01): a spawned `sekhemet queue` runs card `c1` with a
 * scripted Worker while the worktree is made hostile under it — a
 * program-running config key, a filter driver,
 * a gitlink, an embedded bare repository. Real git, a real ledger, the built
 * command; a marker file shows whether any named program ran.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const write = (path: string, content: string) => ({
  name: "write_file",
  arguments: { path, content },
});
const finish = { name: "finish_card", arguments: {} };
const SYNC = resolve(import.meta.dirname, "../../../packages/sync/dist/index.js");
const change: Turn["calls"] = [write("src/a.ts", "export const a = 2;\n"), finish];

async function queue(
  turns: Turn[] | ((r: G6Repo) => Turn[]),
  opts: {
    before?: (r: G6Repo) => void;
    env?: Record<string, string>;
    cwd?: (r: G6Repo) => string;
    args?: (r: G6Repo) => string[];
  } = {},
) {
  const r = g6Repo();
  const project = await scriptedTurnsProject(r, typeof turns === "function" ? turns(r) : turns, {
    stepBudget: 3,
  });
  opts.before?.(r);
  const log = join(r.root, "worker-requests.jsonl");
  const out = spawnSync(
    process.execPath,
    [...project.nodeArgs, BIN, "queue", "--worker", WORKER, ...(opts.args?.(r) ?? [])],
    {
      cwd: opts.cwd?.(r) ?? r.repo,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...r.env({ env: project.env }), G6_REQUEST_LOG: log, ...opts.env },
    },
  );
  const attempt = await r.ledger(({ store }) => store.runs.listAttempts("c1").at(-1));
  // What the Worker was told after its first turn: the tool results.
  const told = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((l) => JSON.stringify(JSON.parse(l).messages))
        .join("\n")
    : "";
  return {
    r,
    out: out.stdout + out.stderr,
    status: out.status,
    stopReason: attempt?.stopReason,
    told,
    wt: join(r.repo, ".sekhemet", "worktrees", "c1"),
  };
}

/** A script that writes `marker` when anything runs it. */
function markerScript(r: G6Repo, name: string): { script: string; marker: string } {
  const marker = join(r.root, `${name}.ran`);
  const script = join(r.root, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
  return { script, marker };
}

/** One `run_cmd` turn running `line` under sh, then the change and finish on the next. */
const shell = (line: string): Turn[] => [
  { calls: [{ name: "run_cmd", arguments: { command: "sh", args: ["-c", line] } }] },
  { calls: change },
];

/** Every file under `dir` with its bytes, sorted. */
function treeOf(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p.slice(dir.length)} ${readFileSync(p, "base64")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

/** A repository with installed dependencies, ignored by git: node_modules and a .venv. */
function withDependencies(r: G6Repo): void {
  mkdirSync(join(r.repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(r.repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(r.repo, ".venv", "lib"), { recursive: true });
  writeFileSync(join(r.repo, ".venv", "lib", "site.py"), "x = 1\n");
  writeFileSync(join(r.repo, ".gitignore"), ".sekhemet/\nnode_modules/\n.venv/\n");
  r.git("commit", "-qam", "ignore the installed dependencies");
}

describe("SEC-2a: a repository named by a relative or symlinked path", () => {
  it("SEC-2a: a repository reached through a symlinked path, and one named by a relative --repo, runs its card to Review", async () => {
    const linked = await queue([{ calls: change }], {
      before: (r) => symlinkSync(r.repo, join(r.root, "link")),
      cwd: (r) => join(r.root, "link"),
    });
    expect(linked.stopReason, linked.out).toBe("gate_passed");
    expect(await statusOf(linked.r, "c1")).toBe("review");

    const relative = await queue([{ calls: change }], {
      cwd: (r) => join(r.root, "home"),
      args: () => ["--repo", "../repo"],
    });
    expect(relative.stopReason, relative.out).toBe("gate_passed");
    expect(await statusOf(relative.r, "c1")).toBe("review");
  }, 200_000);
});

describe("SEC-3, SEC-4, SEC-5: no program a repository names runs", () => {
  it("SEC-3: a program-running key added to the repository's config during the card refuses git there, naming the key; the program never runs", async () => {
    let marker = "";
    const run = await queue((r) => {
      const m = markerScript(r, "filter");
      marker = m.marker;
      return [{ sh: `git -C "$REPO" config filter.evil.clean "${m.script}"`, calls: change }];
    });
    expect(run.out).toMatch(/filter\.evil\.clean/);
    expect(run.stopReason, run.out).not.toBe("gate_passed");
    expect(existsSync(marker)).toBe(false);
  }, 150_000);

  it("SEC-4: a .gitattributes selecting a clean filter and a diff driver: status, diff and commit complete without running either", async () => {
    let marker = "";
    const run = await queue((r) => {
      const m = markerScript(r, "driver");
      marker = m.marker;
      // The drivers live in the user's own git config, as git-lfs's do.
      writeFileSync(
        join(r.home, ".gitconfig"),
        `[filter "evil"]\n\tclean = ${m.script}\n\tsmudge = ${m.script}\n[diff "evil"]\n\tcommand = ${m.script}\n\ttextconv = ${m.script}\n`,
      );
      return [
        {
          calls: [
            write(".gitattributes", "* filter=evil diff=evil\n"),
            write("src/a.ts", "export const a = 2;\n"),
            finish,
          ],
        },
      ];
    });
    expect(existsSync(marker)).toBe(false);
    // Git ran: the card's change was committed on its branch.
    const branch = run.r.git("branch", "--list", "--format=%(refname:short)", "sekhemet/*c1*");
    expect(run.r.git("show", `${branch}:src/a.ts`), run.out).toBe("export const a = 2;");
  }, 150_000);

  it("SEC-5: SEKHEMET_GIT_HARDENED=1 in the environment without the hardened keys: they are applied, and the user's fsmonitor never runs", async () => {
    let marker = "";
    const run = await queue(
      (r) => {
        const m = markerScript(r, "fsmonitor");
        marker = m.marker;
        writeFileSync(join(r.home, ".gitconfig"), `[core]\n\tfsmonitor = ${m.script}\n`);
        return [{ calls: change }];
      },
      { env: { SEKHEMET_GIT_HARDENED: "1" } },
    );
    expect(run.stopReason, run.out).toBe("gate_passed");
    expect(existsSync(marker)).toBe(false);
  }, 150_000);
});

describe("SEC-6, SEC-6a: what a worktree may not hold", () => {
  it("SEC-6: a staged gitlink fails the card's integrity check", async () => {
    const run = await queue([
      {
        sh: 'git update-index --add --cacheinfo "160000,$(git rev-parse HEAD),vendored" && git update-index --skip-worktree vendored',
        calls: change,
      },
    ]);
    expect(run.out).toMatch(/gitlink/);
    expect(run.stopReason, run.out).not.toBe("gate_passed");
    expect(await statusOf(run.r, "c1")).not.toBe("review");
  }, 150_000);

  it("SEC-6a: an embedded bare repository refuses git there, naming its path", async () => {
    const run = await queue([
      {
        sh: 'mkdir -p sub/evil/objects sub/evil/refs && echo "ref: refs/heads/main" > sub/evil/HEAD',
        calls: change,
      },
    ]);
    expect(run.out).toMatch(/sub\/evil/);
    expect(run.stopReason, run.out).not.toBe("gate_passed");
    expect(await statusOf(run.r, "c1")).not.toBe("review");
  }, 150_000);

  it("SEC-6a: a .gitmodules with a carriage return refuses git there, naming the file", async () => {
    const run = await queue([
      { sh: `printf '[submodule "x"]\\r\\n\\tpath = x\\r\\n' > .gitmodules`, calls: change },
    ]);
    expect(run.out).toMatch(/\.gitmodules/);
    expect(run.stopReason, run.out).not.toBe("gate_passed");
  }, 150_000);
});

describe("SEC-1, SEC-6b, SEC-7, SEC-8, SEC-8a: what the Worker's commands may write", () => {
  it("SEC-1: a command creating sub/.git/config under the worktree fails and leaves no such file (macOS; on Linux the preflight names nested_git)", async () => {
    const run = await queue(shell("mkdir -p sub/.git && echo x > sub/.git/config; echo WROTE=$?"));
    expect(existsSync(join(run.wt, "sub", ".git", "config"))).toBe(false);
    if (process.platform === "darwin") {
      expect(run.told).toMatch(/sub\/\.git: Operation not permitted/);
      expect(run.told).toMatch(/WROTE=1/);
    } else {
      expect(run.out).toMatch(/nested_git/);
    }
  }, 150_000);

  it("SEC-6b: a command naming a path outside the card's recorded root cannot write it", async () => {
    let outside = "";
    const run = await queue((r) => {
      outside = join(r.root, "outside.txt");
      return shell(`touch "${outside}"; echo ABS=$?; touch ../../../outside-rel.txt; echo REL=$?`);
    });
    expect(run.told).toMatch(/ABS=1/);
    expect(run.told).toMatch(/REL=1/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(run.r.root, "outside-rel.txt"))).toBe(false);
  }, 150_000);

  it("SEC-7, SEC-8a: a bundler cache is written inside the card's worktree; the main node_modules and .venv stay byte-identical, the linked ones refuse writes", async () => {
    let before = { modules: "", venv: "" };
    const run = await queue(
      shell(
        "mkdir -p node_modules/.vite/deps && echo x > node_modules/.vite/deps/chunk.js; echo VITE=$?; echo evil >> node_modules/left-pad/index.js; echo PAD=$?; echo evil > .venv/lib/injected.py; echo VENV=$?",
      ),
      {
        before: (r) => {
          withDependencies(r);
          before = {
            modules: treeOf(join(r.repo, "node_modules")),
            venv: treeOf(join(r.repo, ".venv")),
          };
        },
      },
    );
    expect(run.told).toMatch(/VITE=0/);
    expect(run.told).toMatch(/PAD=1/);
    expect(run.told).toMatch(/VENV=1/);
    expect(readFileSync(join(run.wt, "node_modules", ".vite", "deps", "chunk.js"), "utf8")).toBe(
      "x\n",
    );
    expect(existsSync(join(run.r.repo, "node_modules", ".vite", "deps", "chunk.js"))).toBe(false);
    expect(treeOf(join(run.r.repo, "node_modules"))).toBe(before.modules);
    expect(treeOf(join(run.r.repo, ".venv"))).toBe(before.venv);
  }, 150_000);

  it("SEC-8: a card's commands cannot write another card's dependency caches", async () => {
    let other = "";
    const run = await queue(
      (r) => {
        other = join(r.repo, ".sekhemet", "worktrees", "c2", "node_modules", ".vite");
        return shell(`echo x > "${join(other, "stolen")}"; echo STOLE=$?`);
      },
      {
        before: (r) => {
          withDependencies(r);
          // Another card's worktree, with its own caches, live beside this one.
          const made = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `const { NodeGitSyncAdapter } = await import(${JSON.stringify(SYNC)});
               await new NodeGitSyncAdapter(${JSON.stringify(r.repo)}).createWorktree("c2", "main", "Other");`,
            ],
            { encoding: "utf8", env: r.env() },
          );
          if (made.status !== 0) throw new Error(made.stderr);
        },
      },
    );
    expect(existsSync(other)).toBe(true);
    expect(run.told).toMatch(/STOLE=1/);
    expect(existsSync(join(other, "stolen"))).toBe(false);
  }, 150_000);
});

describe.runIf(process.platform === "darwin")(
  "SEC-38: git metadata is not writable from a card's command (macOS)",
  () => {
    it("SEC-38: writing the worktree's .git, sub/.GIT/config or .git through a symlink fails, and each target is left as it was", async () => {
      const run = await queue(
        shell(
          "printf x >> .git; echo ROOTGIT=$?; mkdir -p sub/.GIT; echo x > sub/.GIT/config; echo UPPER=$?; ln -s .git gl; printf x >> gl; echo LINK=$?",
        ),
      );
      const pointer = readFileSync(join(run.wt, ".git"), "utf8");
      expect(run.told, run.out).toMatch(/ROOTGIT=1/);
      expect(run.told).toMatch(/UPPER=1/);
      expect(run.told).toMatch(/LINK=1/);
      expect(pointer).toMatch(/^gitdir: .*\/\.git\/worktrees\/c1\n$/);
      expect(existsSync(join(run.wt, "sub", ".GIT", "config"))).toBe(false);
    }, 150_000);
  },
);
