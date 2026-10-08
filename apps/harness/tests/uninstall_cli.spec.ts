import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GITIGNORE_BLOCK } from "../src/init.js";
import { type Place, place, runCli } from "./support/cli_spawn.js";

/**
 * Upgrade and uninstall (surface item 33, NEW-surface-7; DESIGN_GAPS_C1 b8,
 * FINDINGS_C1 INS-03), through the built command, under a temporary home
 * holding what an install writes: the user directory (models, backups, an
 * integration's settings naming a keychain item, a credential store), the
 * Crawl4AI environment, the link `scripts/install.sh` makes, a recorded
 * workspace — a real git repository with its `.sekhemet/`, its ledger and a
 * real card worktree — a start-at-login unit, and SearXNG's settings. The
 * service tools (`launchctl`, `systemctl`, `docker`) are stand-ins first on
 * PATH that record their calls.
 */

const SECRET = "xoxb-SECRET-never-printed-123";

function seed(p: Place) {
  const user = join(p.home, ".sekhemet");
  const w = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  w(join(user, "config.toml"), '[network]\nmode = "offline"\n');
  w(join(user, "models", "tiny.gguf"), "x".repeat(50_000));
  w(join(user, "backups", "ws_aaaaaaaaaaaa", "set-1", "events.db"), "b".repeat(3_000));
  w(
    join(user, "identity", "ws_aaaaaaaaaaaa", "credentials.json"),
    `{"passwords":{"a":"${SECRET}"}}`,
  );
  w(
    join(user, "repos", "acme.json"),
    JSON.stringify({
      slackWebhookUrl: `https://hooks.slack.test/${SECRET}`,
      keychain: ["acme:slackBotToken"],
    }),
  );
  w(join(user, "searxng", "settings.yml"), `secret_key: "${SECRET}"\n`);
  // The Crawl4AI environment and the install link.
  w(
    join(p.home, ".local", "share", "sekhemet", "crawl4ai", ".venv", "bin", "python"),
    "#!/bin/sh\n",
  );
  mkdirSync(join(p.home, ".local", "bin"), { recursive: true });
  symlinkSync(
    "/opt/sekhemet/apps/harness/dist/index.js",
    join(p.home, ".local", "bin", "sekhemet"),
  );
  w(join(p.home, ".local", "bin", "other-tool"), "#!/bin/sh\n");
  // A recorded workspace: a real repository, its ledger, a real card worktree.
  const repo = realpathSync(p.repo);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], { cwd: repo });
  git("init", "-q", "-b", "main");
  w(join(repo, "README.md"), "# shop\n");
  // init's own `.gitignore` block: the team's shared files under `.sekhemet/`
  // are the repository's, committed with it.
  w(join(repo, ".gitignore"), `${GITIGNORE_BLOCK.join("\n")}\n`);
  w(join(repo, ".sekhemet", "config.toml"), "[review]\nwip = 3\n");
  w(join(repo, ".sekhemet", "gates.toml"), '[[gate]]\nid = "unit"\ncommand = "npm"\n');
  w(join(repo, ".sekhemet", "skills", "house-style.md"), "# House style\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  // A shared file not yet committed is still the team's, not the install's.
  w(join(repo, ".sekhemet", "hooks.toml"), "# hooks\n");
  w(join(repo, ".sekhemet", "events.db"), "L".repeat(8_000));
  w(join(repo, ".sekhemet", "events.db-wal"), "W".repeat(1_000));
  w(join(repo, ".sekhemet", "blobs", "ab", "abcd.json"), "{}");
  w(join(repo, ".sekhemet", "logs", "run.log"), "log\n");
  git("worktree", "add", "-q", "-b", "card/TS-1", join(repo, ".sekhemet", "worktrees", "TS-1"));
  w(
    join(user, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          id: "ws_aaaaaaaaaaaa",
          name: "Shop",
          address: "http://127.0.0.1:4040",
          folder: repo,
          projectRoots: [repo],
          lastOpened: "2026-10-08T00:00:00.000Z",
        },
      ],
    }),
  );
  // A start-at-login unit, as `daemon start --at-login` records it.
  const unit = join(p.home, "unit-dir", "sekhemet.serve.000000000000.plist");
  const unitText = "<plist/>\n";
  w(unit, unitText);
  w(
    join(user, "at-login.json"),
    JSON.stringify({
      registered: [
        {
          folder: repo,
          port: 4050,
          manager: process.platform === "darwin" ? "launchd" : "systemd",
          label: "sekhemet.serve.000000000000",
          unit,
          sha256: createHash("sha256").update(unitText).digest("hex"),
          at: "2026-10-08T00:00:00.000Z",
        },
      ],
    }),
  );
  // Stand-ins for the service tools.
  const bin = join(p.root, "fake-bin");
  const log = join(p.root, "calls.log");
  mkdirSync(bin);
  for (const tool of ["launchctl", "systemctl", "docker"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 0\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return {
    user,
    repo,
    unit,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    git,
  };
}

/**
 * Every path under the home and the repository, with its size and
 * modification time — but the identity-only git config every command writes
 * as it starts (`<user dir>/git/`, sync's git hardening, security item 19),
 * which is no part of what this command does; the home folder's own time
 * moves with it.
 */
function snapshot(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (f.endsWith(join(".sekhemet", "git"))) continue;
      const st = lstatSync(f);
      out.push(st.isDirectory() ? f : `${f} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(f);
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

describe("SUR-58: `sekhemet uninstall --dry-run` lists what the install wrote and changes nothing", () => {
  it("SUR-58: every path with its size, the keychain item by name, the container, each recorded repository; no secret; nothing changed", async () => {
    const p = place("sek-uninstall-dry-");
    const s = seed(p);
    const before = snapshot(p.home, s.repo);
    const r = await runCli(["uninstall", "--dry-run"], p, { cwd: p.root, env: s.env });
    expect(r.code, r.out).toBe(0);
    const row = (path: string) =>
      new RegExp(
        `\\d[\\d.]* (bytes|kB|MB|GB)\\s+${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}  — `,
      );
    expect(r.out).toMatch(row(s.user));
    expect(r.out).toMatch(row(join(p.home, ".local", "share", "sekhemet")));
    expect(r.out).toMatch(row(join(p.home, ".local", "bin", "sekhemet")));
    expect(r.out).toMatch(row(join(s.repo, ".sekhemet")));
    expect(r.out).toMatch(/with 1 card worktree/);
    expect(r.out).toMatch(row(s.unit));
    expect(r.out).toMatch(/sekhemet \/ acme:slackBotToken/);
    expect(r.out).toMatch(/sekhemet-searxng/);
    // Kept: the ledger and the backups, listed apart.
    const kept = r.out.slice(r.out.indexOf("Kept, since a ledger cannot be rebuilt"));
    expect(kept).toMatch(row(join(s.user, "backups")));
    expect(kept).toMatch(/ledger: blobs, events\.db, events\.db-wal/);
    // The repository's own files under `.sekhemet/` are named as never removed.
    expect(r.out).toMatch(
      /never removed, the repository's own: config\.toml, gates\.toml, hooks\.toml, skills/,
    );
    expect(r.out).toMatch(/npm uninstall -g sekhemet/);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain("SECRET");
    // Nothing changed, and no service tool was called.
    expect(snapshot(p.home, s.repo)).toEqual(before);
    expect(s.calls()).toBe("");
  }, 60_000);
});

describe("SUR-59: `sekhemet uninstall --yes` removes them, keeping ledgers and backups unless --include-ledgers", () => {
  it("SUR-59: removes the rest, prunes the card worktree from git, keeps the ledger and backups; --include-ledgers removes those too", async () => {
    const p = place("sek-uninstall-yes-");
    const s = seed(p);
    const r = await runCli(["uninstall", "--yes"], p, { cwd: p.root, env: s.env });
    // The keychain item is named as left: no secret store answers in a test.
    expect(r.out).toMatch(
      /Not removed: sekhemet \/ acme:slackBotToken \(no secret store answers here\)/,
    );
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(SECRET);
    // Removed.
    expect(existsSync(join(s.user, "config.toml"))).toBe(false);
    expect(existsSync(join(s.user, "models"))).toBe(false);
    expect(existsSync(join(s.user, "identity"))).toBe(false);
    expect(existsSync(join(p.home, ".local", "share", "sekhemet"))).toBe(false);
    expect(existsSync(join(p.home, ".local", "bin", "sekhemet"))).toBe(false);
    expect(existsSync(join(p.home, ".local", "bin", "other-tool"))).toBe(true);
    expect(existsSync(join(s.repo, ".sekhemet", "worktrees"))).toBe(false);
    expect(existsSync(join(s.repo, ".sekhemet", "logs"))).toBe(false);
    expect(existsSync(s.unit)).toBe(false);
    // The repository's own files are untouched: nothing it tracks is deleted
    // or changed, and the shared file not yet committed stays too.
    expect(s.git("status", "--porcelain", "--untracked-files=no").toString()).toBe("");
    expect(readFileSync(join(s.repo, ".sekhemet", "config.toml"), "utf8")).toBe(
      "[review]\nwip = 3\n",
    );
    expect(existsSync(join(s.repo, ".sekhemet", "skills", "house-style.md"))).toBe(true);
    expect(readFileSync(join(s.repo, ".sekhemet", "hooks.toml"), "utf8")).toBe("# hooks\n");
    expect(s.calls()).toMatch(/docker rm -f sekhemet-searxng/);
    expect(s.calls()).toMatch(
      process.platform === "darwin" ? /launchctl bootout/ : /systemctl --user disable /,
    );
    // The worktree's record is pruned from git; its branch, the person's history, stays.
    expect(s.git("worktree", "list").toString().trim().split("\n")).toHaveLength(1);
    expect(s.git("branch", "--list", "card/TS-1").toString()).toMatch(/card\/TS-1/);
    // Kept: the ledger and every backup.
    expect(statSync(join(s.repo, ".sekhemet", "events.db")).size).toBe(8_000);
    expect(existsSync(join(s.repo, ".sekhemet", "events.db-wal"))).toBe(true);
    expect(existsSync(join(s.repo, ".sekhemet", "blobs", "ab", "abcd.json"))).toBe(true);
    expect(existsSync(join(s.user, "backups", "ws_aaaaaaaaaaaa", "set-1", "events.db"))).toBe(true);
    expect(r.out).toMatch(/Each project's ledger and every backup were kept/);
    expect(r.out).toMatch(/Now remove the package itself: npm uninstall -g sekhemet/);

    // The workspace list went with the user directory: the ledger is found
    // again only when it is recorded, so record it as a server would.
    writeFileSync(
      join(s.user, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "ws_a",
            name: "Shop",
            address: "http://127.0.0.1:4040",
            folder: s.repo,
            lastOpened: "2026-10-08T00:00:00.000Z",
          },
        ],
      }),
    );
    const all = await runCli(["uninstall", "--yes", "--include-ledgers"], p, {
      cwd: p.root,
      env: s.env,
    });
    expect(all.code, all.out).toBe(0);
    // The ledger went; what is left of `.sekhemet/` is the repository's own.
    expect(readdirSync(join(s.repo, ".sekhemet")).sort()).toEqual([
      "config.toml",
      "gates.toml",
      "hooks.toml",
      "skills",
    ]);
    expect(existsSync(s.user)).toBe(false);
    // The repository itself is the person's: untouched, every tracked file as committed.
    expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# shop\n");
    expect(s.git("status", "--porcelain", "--untracked-files=no").toString()).toBe("");
  }, 90_000);

  it("refuses --dry-run with --yes, changing nothing", async () => {
    const p = place("sek-uninstall-both-");
    const s = seed(p);
    const before = snapshot(p.home, s.repo);
    const r = await runCli(["uninstall", "--dry-run", "--yes"], p, { cwd: p.root, env: s.env });
    expect(r.code).toBe(2);
    expect(snapshot(p.home, s.repo)).toEqual(before);
  }, 60_000);
});
