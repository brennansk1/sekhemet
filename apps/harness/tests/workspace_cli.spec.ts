import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";
import { LOCATOR_PATH, readLocator, registerProject } from "../src/workspace_locator.js";
import { runningServerFor } from "../src/workspaces.js";

/**
 * NEW-surface-11 and kernel rule 38a from the command line: a workspace of
 * many projects with one ledger, found from any project's folder through its
 * locator (SUR-73), refused when the locator disagrees (SUR-80), the
 * locators rewritten by doctor (SUR-78), `project list` (SUR-77) and
 * `project move` (SUR-81, K-N12-7). Real git repositories, a real ledger and
 * the built binary, spawned (DEFINITION_OF_DONE §2A).
 */
const BIN = resolve(import.meta.dirname, "../dist/index.js");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitRepo(dir: string, file: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeFileSync(join(dir, "src", file), `export const x = "${file}";\n`);
  writeFileSync(join(dir, ".gitignore"), ".sekhemet/*\n");
  git("add", "-A");
  git("commit", "-q", "-m", `seed ${file}`);
  return realpathSync(dir);
}

const head = (dir: string): string =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

/** A workspace folder that is project A's root (as before DEC-57) and project B beside it. */
async function workspace(): Promise<{
  root: string;
  ws: string;
  b: string;
  home: string;
  bId: string;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-ws-cli-")));
  dirs.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const ws = gitRepo(join(root, "alpha"), "a.ts");
  const b = gitRepo(join(root, "beta"), "b.ts");
  const { db, log } = openLocalLedger(ws);
  const store = new CardStore(db, log);
  await store.ensureProject({ rootPath: ws, name: "Alpha" });
  const beta = await registerProject(store, log, ws, { rootPath: b, name: "Beta" });
  await store.createCard({ id: "b1", tier: "story", title: "Write b", projectId: beta.id });
  db.close();
  return { root, ws, b, home, bId: beta.id };
}

function sekhemet(args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      SEKHEMET_KEYCHAIN: "off",
      SEKHEMET_MODEL_LOADS: "off",
      BROWSER: "false",
    },
  });
}

async function events(ws: string, type: string) {
  const { db, log } = openLocalLedger(ws);
  try {
    return (await log.getEvents(1, 100_000)).filter((e) => e.type === type);
  } finally {
    db.close();
  }
}

describe("NEW-surface-11: the command line in a workspace of many projects", () => {
  it("SUR-78: registering a project writes its locator, and none in the folder that holds the ledger", async () => {
    const w = await workspace();
    expect(readLocator(w.b)).toMatchObject({ workspaceFolder: w.ws });
    expect(readLocator(w.b)?.workspaceId).toMatch(/^ws_[0-9a-f]{12}$/);
    expect(existsSync(join(w.ws, LOCATOR_PATH))).toBe(false);
    // The locator is ignored by git like the rest of `.sekhemet/`.
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: w.b, encoding: "utf8" }).trim(),
    ).toBe("");
  });

  it("SUR-73, SUR-77: `project list --json` from a subfolder of project B acts on the workspace and creates no ledger there", async () => {
    const w = await workspace();
    const run = sekhemet(["project", "list", "--json"], join(w.b, "src"), w.home);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim()) as {
      ok: boolean;
      workspace: { folder: string; id: string };
      projects: { id: string; name: string; root: string; state: string; current: boolean }[];
    };
    expect(out.ok).toBe(true);
    expect(out.workspace.folder).toBe(w.ws);
    expect(out.projects.map((p) => [p.name, p.root, p.state, p.current])).toEqual([
      ["Alpha", w.ws, "active", false],
      ["Beta", w.b, "active", true],
    ]);
    expect(existsSync(join(w.b, ".sekhemet", "events.db"))).toBe(false);
    expect(existsSync(join(w.b, "src", ".sekhemet"))).toBe(false);
    // The text list marks the folder's project.
    const text = sekhemet(["project", "list"], w.ws, w.home);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/\* proj_\w+ {2}Alpha {2}active/);
    expect(text.stdout).toContain(`Beta  active  ${w.b}`);
  });

  it("SUR-75: a card verb given a card of project B works from the workspace folder and from B's folder", async () => {
    const w = await workspace();
    for (const cwd of [w.ws, w.b]) {
      const run = sekhemet(["card", "message", "b1", "Use", "named", "exports."], cwd, w.home);
      expect(run.status, run.stderr).toBe(0);
    }
    expect(await events(w.ws, "card/message")).toHaveLength(2);
    expect(existsSync(join(w.b, ".sekhemet", "events.db"))).toBe(false);
  });

  it("SUR-80: a locator whose id, folder or root its ledger does not confirm is refused with exit 1 and the fix, and acts on nothing", async () => {
    const w = await workspace();
    const path = join(w.b, LOCATOR_PATH);
    const good = readFileSync(path, "utf8");
    const cases: [string, string][] = [
      [good.replace(/ws_[0-9a-f]{12}/, "ws_000000000000"), "ws_000000000000"],
      [good.replace(w.ws, join(w.root, "gone")), "holds no Sekhemet workspace"],
    ];
    for (const [text, named] of cases) {
      writeFileSync(path, text);
      const run = sekhemet(["project", "list"], w.b, w.home);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(named);
      expect(run.stderr).toContain("sekhemet doctor");
      expect(existsSync(join(w.b, ".sekhemet", "events.db"))).toBe(false);
    }
    // A root the ledger does not register.
    const stray = gitRepo(join(w.root, "stray"), "s.ts");
    mkdirSync(join(stray, ".sekhemet"), { recursive: true });
    writeFileSync(join(stray, LOCATOR_PATH), good);
    const run = sekhemet(["project", "list"], stray, w.home);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`has no project whose folder is ${stray}`);
    expect(existsSync(join(stray, ".sekhemet", "events.db"))).toBe(false);
  });

  it("SUR-78: `sekhemet doctor` in the workspace folder rewrites a missing or disagreeing locator and reports it", async () => {
    const w = await workspace();
    const path = join(w.b, LOCATOR_PATH);
    const good = readFileSync(path, "utf8");
    rmSync(path);
    const run = sekhemet(["doctor"], w.ws, w.home);
    expect(run.stdout).toContain("Project locators");
    expect(run.stdout).toContain(`Beta: wrote its locator in ${w.b}`);
    expect(readFileSync(path, "utf8")).toBe(good);
    const again = sekhemet(["doctor"], w.ws, w.home);
    expect(again.stdout).toContain("2 projects, every locator agrees with the Activity log");
  });

  it("SUR-81, K-N12-7: `project move` records the person's move after checking the repository, rewrites the locator at both places, and refuses otherwise", async () => {
    const w = await workspace();
    // An accepted card of B whose merge the new folder must hold.
    const merge = head(w.b);
    {
      const { db, log } = openLocalLedger(w.ws);
      await log.append({
        actor: "human",
        type: "card/accepted",
        payload: { id: "b1", sha: merge, principal: log.localPrincipal() },
        principal: log.localPrincipal(),
      });
      db.close();
    }
    const before = (await events(w.ws, "project/updated")).length;
    // Another repository: its history lacks the merge.
    const other = gitRepo(join(w.root, "other"), "o.ts");
    const refused = sekhemet(["project", "move", w.bId, other], w.ws, w.home);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(merge.slice(0, 12));
    // A folder inside project A's root nests: project_nested.
    const inside = gitRepo(join(w.ws, "nested"), "n.ts");
    const nested = sekhemet(["project", "move", w.bId, inside], w.ws, w.home);
    expect(nested.status).toBe(1);
    expect(nested.stderr).toContain("Alpha");
    rmSync(inside, { recursive: true, force: true });
    expect((await events(w.ws, "project/updated")).length).toBe(before);
    // The person moved the repository: a clone holds the same history.
    const moved = join(w.root, "beta-moved");
    execFileSync("git", ["clone", "-q", w.b, moved]);
    const ok = sekhemet(["project", "move", w.bId, moved], w.ws, w.home);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`Beta is now at ${realpathSync(moved)}`);
    const updates = await events(w.ws, "project/updated");
    expect(updates.at(-1)?.payload).toMatchObject({ id: w.bId, rootPath: realpathSync(moved) });
    expect(updates.at(-1)?.principal).toMatch(/^p_/);
    expect(readLocator(moved)?.workspaceFolder).toBe(w.ws);
    expect(existsSync(join(w.b, LOCATOR_PATH))).toBe(false);
    // The moved folder now finds its workspace.
    const list = sekhemet(["project", "list", "--json"], moved, w.home);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout).projects.find((p: { current: boolean }) => p.current).name).toBe(
      "Beta",
    );
  });

  it("K-N12-7: a project with no accepted merge moves only on the person's confirmation", async () => {
    const w = await workspace();
    const target = gitRepo(join(w.root, "fresh"), "f.ts");
    const ask = sekhemet(["project", "move", "Beta", target], w.ws, w.home);
    expect(ask.status).toBe(1);
    expect(ask.stderr).toContain("--yes");
    const yes = sekhemet(["project", "move", "Beta", target, "--yes"], w.ws, w.home);
    expect(yes.status, yes.stderr).toBe(0);
    expect(readLocator(target)?.workspaceFolder).toBe(w.ws);
  });
});

describe("the first run in a repository that belongs to a workspace (SUR-79)", () => {
  it("refuses a first run where the history carries a Ledger-Head trailer, naming the workspace on this machine; --new-workspace starts one anyway", async () => {
    const w = await workspace();
    // A clone of B whose history carries an accepted merge's Ledger-Head trailer.
    const { db, log } = openLocalLedger(w.ws);
    const head = log.lastSeq();
    const hash = (db.prepare("SELECT hash FROM events WHERE seq = ?").get(head) as { hash: string })
      .hash;
    db.close();
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", `feat: merged\n\nLedger-Head: ${head}:${hash}`],
      { cwd: w.b },
    );
    const clone = join(w.root, "beta-clone");
    execFileSync("git", ["clone", "-q", w.b, clone]);
    // The machine's list names the workspace, so the refusal can say where it is.
    const list = join(w.home, ".sekhemet", "workspaces.json");
    mkdirSync(join(w.home, ".sekhemet"), { recursive: true });
    writeFileSync(
      list,
      JSON.stringify({
        workspaces: [
          {
            id: "ws_x",
            name: "alpha",
            address: "http://127.0.0.1:7420",
            folder: w.ws,
            lastOpened: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const refused = sekhemet(["--yes", "--terminal"], clone, w.home);
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).toContain(w.ws);
    expect(refused.stdout + refused.stderr).toContain("--new-workspace");
    expect(existsSync(join(clone, ".sekhemet"))).toBe(false);
    const anyway = sekhemet(["--yes", "--terminal", "--new-workspace"], clone, w.home);
    expect(anyway.stdout + anyway.stderr).not.toContain("belongs to a Sekhemet workspace");
    expect(existsSync(join(clone, ".sekhemet", "config.toml"))).toBe(true);
  });

  it("SUR-73: the bare command in a project of a workspace starts no first run there", async () => {
    const w = await workspace();
    const run = sekhemet(["--yes", "--terminal"], w.b, w.home);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout + run.stderr).not.toMatch(/Set up here|No models found yet/);
    expect(existsSync(join(w.b, ".sekhemet", "config.toml"))).toBe(false);
    expect(existsSync(join(w.b, ".sekhemet", "events.db"))).toBe(false);
  });
});

describe("one server per workspace (SUR-76)", () => {
  it("`sekhemet serve` in a project's folder names the server already serving its workspace and starts none", async () => {
    const w = await workspace();
    const { db, log } = openLocalLedger(w.ws);
    const store = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: w.ws,
      port: 0,
      streamIntervalMs: 10_000,
      pressureLevel: () => 1,
    });
    try {
      const address = `http://127.0.0.1:${server.port}`;
      mkdirSync(join(w.home, ".sekhemet"), { recursive: true });
      writeFileSync(
        join(w.home, ".sekhemet", "workspaces.json"),
        JSON.stringify({
          workspaces: [
            {
              id: log.workspaceId(),
              name: "alpha",
              address,
              folder: w.ws,
              lastOpened: "2026-10-01T00:00:00.000Z",
            },
          ],
        }),
      );
      // Spawned without blocking: the server in this process must answer it.
      const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (done) => {
          const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
            cwd: w.b,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: w.home,
              SEKHEMET_CONFIG_DIR: join(w.home, ".sekhemet"),
              SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
              SEKHEMET_KEYCHAIN: "off",
              SEKHEMET_MODEL_LOADS: "off",
              BROWSER: "false",
            },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += String(d);
          });
          child.stderr.on("data", (d) => {
            stderr += String(d);
          });
          const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
          child.on("exit", (status) => {
            clearTimeout(kill);
            done({ status, stdout, stderr });
          });
        },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(`This workspace is already served at ${address}/`);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("a Team server is found too: the probe needs no sign-in, and answers only the workspace's id", async () => {
    const w = await workspace();
    const db = new DatabaseSync(join(w.ws, ".sekhemet", "events.db"));
    const log = new EventLog(db, { setup: "team" });
    const store = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: w.ws,
      port: 0,
      streamIntervalMs: 10_000,
      pressureLevel: () => 1,
      identity: {
        dir: join(w.root, "identity"),
        passwordList: join(w.root, "list.txt"),
        settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      },
    });
    try {
      const address = `http://127.0.0.1:${server.port}`;
      // The list of workspaces is a signed-in person's: refused without a session.
      expect((await fetch(`${address}/api/workspaces`)).status).toBe(401);
      const list = join(w.home, "workspaces.json");
      writeFileSync(
        list,
        JSON.stringify({
          workspaces: [
            {
              id: log.workspaceId(),
              name: "alpha",
              address,
              folder: w.ws,
              lastOpened: "2026-10-01T00:00:00.000Z",
            },
          ],
        }),
      );
      expect(await runningServerFor(list, { folder: w.ws, id: log.workspaceId() })).toBe(address);
      // Another workspace's id is not this server's.
      expect(await runningServerFor(list, { folder: w.ws, id: "ws_other" })).toBeUndefined();
    } finally {
      await server.close();
      db.close();
    }
  });
});
