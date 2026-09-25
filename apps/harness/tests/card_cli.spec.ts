import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { cardMessages } from "../src/collaborate.js";
import { openLocalLedger } from "../src/ledger_cmds.js";

/**
 * worker-loop NEW-worker-loop-10 (WL-N10-1..3) from the command line:
 * `sekhemet card message|pause|hand-back|take-over <card> …`, over the same
 * functions the dashboard calls, with surface S10's exit codes — 0 done,
 * 1 refused (no such card, not paused), 2 a usage error. Tested by spawning
 * the built binary, as cli_exit.spec does.
 */
const BIN = resolve(import.meta.dirname, "../dist/index.js");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function project(): Promise<{ cwd: string; home: string }> {
  const root = mkdtempSync(join(tmpdir(), "sek-card-cli-"));
  dirs.push(root);
  const cwd = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(home);
  const git = (...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeFileSync(join(cwd, "src", "a.ts"), "");
  writeFileSync(join(cwd, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(cwd);
  await new CardStore(db, log).createCard({
    id: "c1",
    tier: "story",
    title: "Write a",
    scopeFiles: ["src/a.ts"],
  });
  db.close();
  return { cwd, home };
}

function sekhemet(args: string[], where: { cwd: string; home: string }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: where.cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: where.home,
      SEKHEMET_CONFIG_DIR: join(where.home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      BROWSER: "false",
    },
  });
}

async function withStore<T>(cwd: string, fn: (store: CardStore) => Promise<T>): Promise<T> {
  const { db, log } = openLocalLedger(cwd);
  try {
    return await fn(new CardStore(db, log));
  } finally {
    db.close();
  }
}

describe("NEW-worker-loop-10 from the command line: sekhemet card …", () => {
  it("WL-N10-1: `card message` posts a message for the agent; no text is exit 2, no card exit 1", async () => {
    const where = await project();
    const ok = sekhemet(["card", "message", "c1", "Use", "named", "exports."], where);
    expect(ok.status, ok.stderr).toBe(0);
    const messages = await withStore(where.cwd, (s) => cardMessages(s, "c1"));
    expect(messages).toMatchObject([{ kind: "message", text: "Use named exports." }]);
    const empty = sekhemet(["card", "message", "c1"], where);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toMatch(/needs text/);
    const missing = sekhemet(["card", "message", "nope", "hi"], where);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no card nope/);
  }, 120_000);

  it("WL-N10-2: `card pause` asks for a pause; `card hand-back` is refused (exit 1) until the card is paused, then returns it to Ready with the note", async () => {
    const where = await project();
    const paused = sekhemet(["card", "pause", "c1"], where);
    expect(paused.status, paused.stderr).toBe(0);
    expect(
      await withStore(where.cwd, (s) => s.cardEvents("c1", ["card/pause_requested"])),
    ).toHaveLength(1);
    const refused = sekhemet(["card", "hand-back", "c1", "go"], where);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/not paused/);
    await withStore(where.cwd, async (s) => {
      await s.updateCardStatus("c1", "in_progress", "setup", "harness", { override: true });
      await s.updateCard("c1", { stopReason: "paused" }, "harness");
    });
    const back = sekhemet(["card", "hand-back", "c1", "Also", "export", "b."], where);
    expect(back.status, back.stderr).toBe(0);
    await withStore(where.cwd, async (s) => {
      expect((await s.getCard("c1"))?.status).toBe("ready");
      expect((await cardMessages(s, "c1")).at(-1)).toMatchObject({
        kind: "hand_back",
        text: "Also export b.",
      });
    });
  }, 120_000);

  it("WL-N10-3: `card take-over` moves the card to In Progress and names its worktree", async () => {
    const where = await project();
    const r = sekhemet(["card", "take-over", "c1"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(join(".sekhemet", "worktrees", "c1"));
    await withStore(where.cwd, async (s) => {
      expect((await s.getCard("c1"))?.status).toBe("in_progress");
      expect(await s.cardEvents("c1", ["card/taken_over"])).toHaveLength(1);
    });
  }, 120_000);

  it("a missing or unknown verb, or a missing card id, is a usage error (exit 2)", async () => {
    const where = await project();
    for (const args of [["card"], ["card", "frob", "c1"], ["card", "pause"]]) {
      const r = sekhemet(args, where);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/message\|pause\|hand-back\|take-over/);
    }
  }, 120_000);
});
