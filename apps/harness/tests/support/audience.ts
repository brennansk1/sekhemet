import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardStore, type EventLog } from "@sekhemet/kernel";
import type { Page } from "playwright-core";
import { SMALL, writeGguf } from "../../../../packages/models/tests/support/gguf_fixture.js";
import { openLocalLedger } from "../../src/ledger_cmds.js";
import { freePort } from "./cli_spawn.js";
import { BIN, g2Env } from "./g2_cli.js";
import { guardedImports, killTree } from "./hygiene.js";

/**
 * The audience end-to-end tests' workspace (DEFINITION_OF_DONE §6.4; W10):
 * a real git repository holding a real ledger, seeded through the kernel's
 * own store as the planner and the runner would leave it, then served by the
 * built `sekhemet serve` (`apps/harness/dist/index.js`) as a subprocess with
 * a throwaway home, the model-port guard and no model loads. The tests drive
 * it in Chromium as a person would.
 */
export interface Served {
  base: string;
  repo: string;
  home: string;
  project: string;
  /** The server's output so far. */
  out: () => string;
  stop: () => Promise<void>;
}

export interface Seed {
  store: CardStore;
  log: EventLog;
  project: string;
  repo: string;
}

/** A fresh repository with a project in its ledger, seeded; the project's id. */
async function seeded(
  repo: string,
  opts: { name?: string; seed?: (s: Seed) => Promise<void> },
): Promise<string> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada Lovelace");
  git("config", "user.email", "ada@example.com");
  writeFileSync(join(repo, "README.md"), `# ${opts.name ?? "Timesheets"}\n`);
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: start");
  const { db, log } = openLocalLedger(repo);
  try {
    const store = new CardStore(db, log);
    const project = (await store.ensureProject({ name: opts.name ?? "Timesheets", rootPath: repo }))
      .id;
    await opts.seed?.({ store, log, project, repo });
    return project;
  } finally {
    db.close();
  }
}

export async function serveWorkspace(opts: {
  name?: string;
  /** Serve this existing repository as it is: no commit, no project, no seed (a take-over). */
  repo?: string;
  /** A model file in the models folder, so the dashboard offers the first-run question as on a set-up machine. */
  model?: boolean;
  seed?: (s: Seed) => Promise<void>;
}): Promise<Served> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-aud-")));
  const repo = opts.repo ?? join(root, "repo");
  const home = join(root, "home");
  mkdirSync(home);
  let project = "";
  if (!opts.repo) {
    mkdirSync(repo);
    project = await seeded(repo, opts);
  }
  const models = join(home, "models");
  if (opts.model) writeGguf(join(models, "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama" });
  const port = await freePort();
  // Not `trackChild`: that kills it after each test, and the server serves the whole file.
  // `stop()` kills its process group; vitest's global teardown kills anything left under the run's folder.
  const child: ChildProcess = spawn(
    process.execPath,
    [...guardedImports(), BIN, "serve", "--repo", repo, "--port", String(port)],
    {
      cwd: repo,
      env: { ...g2Env(home), SEKHEMET_MODELS_DIR: models },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let text = "";
  child.stdout?.on("data", (d) => {
    text += String(d);
  });
  child.stderr?.on("data", (d) => {
    text += String(d);
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (!text.includes(base)) {
    if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}:\n${text}`);
    if (Date.now() > deadline) throw new Error(`serve did not start in 60 s:\n${text}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const exited = new Promise<void>((r) => child.once("close", () => r()));
  return {
    base,
    repo,
    home,
    project,
    out: () => text,
    stop: async () => {
      killTree(child);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Where keyboard focus is, and whether a person can see it (DoD §6.4: never lost or hidden). */
export async function focusState(
  page: Page,
): Promise<{ lost: boolean; hidden: boolean; label: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement)
      return { lost: true, hidden: true, label: "" };
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hidden =
      r.width === 0 ||
      r.height === 0 ||
      style.visibility === "hidden" ||
      style.display === "none" ||
      r.bottom < 0 ||
      r.right < 0 ||
      r.top > window.innerHeight ||
      r.left > window.innerWidth;
    const label =
      el.getAttribute("aria-label") ??
      (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return { lost: false, hidden, label };
  });
}

/** Whether a person sees the element: in the viewport and not covered at its centre. */
export async function seen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(r.height / 2, 8);
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    return Boolean(top && (top === el || el.contains(top) || top.contains(el)));
  }, selector);
}
