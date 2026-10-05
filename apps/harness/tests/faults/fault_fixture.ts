import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { expect } from "vitest";

/**
 * The C.6 fault-injection suite's shared parts (FINISH_LINE_PLAN C.6, W8;
 * §A Reliability and Recovery). Every fault is real (DEFINITION_OF_DONE
 * §2A): a process killed with SIGKILL, a disk image filled to ENOSPC, a
 * volume detached, a file truncated, a clock moved, a port taken — never a
 * mock of the part under test. Each test ends in the steady state C.6 names:
 * the ledger verifies, no issue is lost, the issue ends in a recorded stop
 * reason, and `resume` (the next run of the issue) continues.
 */

/** The harness as built: a child process imports it from here. */
export const DIST = resolve(import.meta.dirname, "../../dist");
export const BIN = join(DIST, "index.js");
export const darwin = process.platform === "darwin";
/** Slow faults run in `pnpm release-gate` (`SEKHEMET_SLOW_FAULTS=1`), the fast ones in `pnpm gate`. */
export const slowFaults = process.env.SEKHEMET_SLOW_FAULTS === "1";
export const MB = 1024 * 1024;

const dirs: string[] = [];
const children: ChildProcess[] = [];
const mounts: string[] = [];

/** Undo what a test made: children killed, images detached, folders removed. */
export function cleanUp(): void {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const m of mounts.splice(0)) {
    try {
      execFileSync("hdiutil", ["detach", "-force", m], { stdio: "ignore" });
    } catch {
      // Already detached (the test detached it itself).
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** Keep a child to be killed at the end of the test. */
export function track<T extends ChildProcess>(child: T): T {
  children.push(child);
  return child;
}

export const GATES = `[project]\nmax_files = 5\nmax_diff_lines = 2000\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`;

/** A git repository with one source file and a gate that passes, under `parent`. */
export function projectRepo(parent: string, name = "repo"): string {
  const repo = join(parent, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(join(repo, ".sekhemet", "gates.toml"), GATES);
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return repo;
}

export interface Ledger {
  path: string;
  db: DatabaseSync;
  log: EventLog;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
}

/** The workspace's ledger in `folder/.sekhemet/events.db`, opened as the harness opens it. */
export function openLedger(folder: string): Ledger {
  mkdirSync(join(folder, ".sekhemet"), { recursive: true });
  const path = join(folder, ".sekhemet", "events.db");
  const db = new DatabaseSync(path);
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  return { path, db, log, cardStore, boardService: new BoardServiceImpl(cardStore) };
}

/** A Ready issue writing `files`. */
export async function readyCard(
  l: Ledger,
  id: string,
  files: string[] = ["src/a.ts"],
  stepBudget = 8,
): Promise<CardRecord> {
  const card = await l.cardStore.createCard({
    id,
    tier: "task",
    title: `Write ${files.join(" and ")}`,
    scopeFiles: files,
    stepBudget,
    spec: `Write ${files.join(" and ")}`,
  });
  await l.boardService.transitionCard({
    cardId: card.id,
    fromStatus: card.status,
    toStatus: "ready",
    actor: "human",
  });
  return (await l.cardStore.getCard(card.id)) as CardRecord;
}

/** One scripted Worker step (the `MockInferenceAdapter` "scripted" turn shape). */
export const step = (name: string, args: Record<string, unknown>) => ({
  text: "",
  toolCalls: [{ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});
export const write = (path: string, content: string) => step("write_file", { path, content });
export const finish = () => step("finish_card", {});

/**
 * C.6's steady state after a fault: the ledger's chain verifies, the issue
 * is still there, and it ends in a recorded stop reason — on the issue and
 * on its last attempt, which is finished, not left running.
 */
export async function expectRecordedStop(l: Ledger, cardId: string, reason: string): Promise<void> {
  expect(l.cardStore.verifyLedger()).toMatchObject({ valid: true });
  const card = await l.cardStore.getCard(cardId);
  expect(card, `issue ${cardId} is lost`).toBeTruthy();
  expect(card?.stopReason).toBe(reason);
  expect(card?.status).not.toBe("in_progress");
  const attempt = l.cardStore.runs.listAttempts(cardId).at(-1);
  expect(attempt?.status).not.toBe("running");
  expect(attempt?.stopReason).toBe(reason);
}

/** Poll until `ok()` or fail after `ms`. */
export async function waitFor(
  ok: () => boolean,
  ms = 30_000,
  what = "the condition",
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A real HFS+ volume of `mb` megabytes, attached at a fresh mount point (macOS, no root). */
export function smallVolume(mb: number): { mount: string; image: string } {
  const d = tempDir("sek-fault-vol-");
  const image = join(d, "vol.dmg");
  execFileSync(
    "hdiutil",
    ["create", "-size", `${mb}m`, "-fs", "HFS+", "-volname", "sekfault", image],
    {
      stdio: "ignore",
    },
  );
  const mnt = join(d, "mnt");
  mkdirSync(mnt);
  execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt, image], { stdio: "ignore" });
  mounts.push(mnt);
  return { mount: realpathSync(mnt), image };
}

/** Write zeros to `path` until its volume answers ENOSPC; returns that error. */
export function fillVolume(path: string): NodeJS.ErrnoException {
  const fd = openSync(path, "w");
  const chunk = Buffer.alloc(MB);
  try {
    for (;;) writeSync(fd, chunk);
  } catch (err) {
    return err as NodeJS.ErrnoException;
  } finally {
    closeSync(fd);
  }
}

/**
 * A fake OpenAI-compatible engine in its own process: it streams the
 * scripted replies in order — a tool call, or `text` — and a step with `die`
 * kills its own process with SIGKILL after the stream's first chunk; one
 * with `hang` never answers.
 */
const ENGINE = `
import { createServer } from "node:http";
const script = JSON.parse(process.argv[2]);
let n = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const step = script[n++] ?? { finish: true };
    if (step.hang) return;
    let streamed = true;
    try { streamed = JSON.parse(body).stream === true; } catch {}
    if (!streamed) {
      res.writeHead(200, { "content-type": "application/json" });
      const message = step.text !== undefined
        ? { role: "assistant", content: step.text }
        : { role: "assistant", content: "", tool_calls: [{ id: "c" + n, type: "function", function: step.finish ? { name: "finish_card", arguments: "{}" } : { name: "write_file", arguments: JSON.stringify({ path: step.path, content: step.content }) } }] };
      const whole = JSON.stringify({ choices: [{ message, finish_reason: step.text !== undefined ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      if (step.die) { res.write(whole.slice(0, 20)); setTimeout(() => process.kill(process.pid, "SIGKILL"), 50); return; }
      res.end(whole);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write("data: " + JSON.stringify(o) + "\\n\\n");
    if (step.text !== undefined) {
      send({ choices: [{ delta: { content: step.text } }] });
      if (step.die) { setTimeout(() => process.kill(process.pid, "SIGKILL"), 50); return; }
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.write("data: [DONE]\\n\\n");
      res.end();
      return;
    }
    const call = step.finish
      ? { name: "finish_card", arguments: "{}" }
      : { name: "write_file", arguments: JSON.stringify({ path: step.path, content: step.content }) };
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + n, function: { name: call.name } }] } }] });
    if (step.die) { setTimeout(() => process.kill(process.pid, "SIGKILL"), 50); return; }
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: call.arguments } }] } }] });
    send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    res.write("data: [DONE]\\n\\n");
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

export async function fakeEngine(script: unknown[]): Promise<{ url: string; proc: ChildProcess }> {
  const dir = tempDir("sek-fault-engine-");
  const file = join(dir, "engine.mjs");
  writeFileSync(file, ENGINE);
  const proc = track(
    spawn(process.execPath, [file, JSON.stringify(script)], {
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const port = await new Promise<string>((ok) => proc.stdout?.once("data", (d) => ok(String(d))));
  return { url: `http://127.0.0.1:${port.trim()}`, proc };
}

/** The context `executeCard` runs a card with, on this repository and workspace. */
export function context(
  repo: string,
  l: Ledger,
  extra: Record<string, unknown> = {},
): Parameters<typeof import("../../src/execute.js").executeCard>[0] {
  return {
    repoPath: repo,
    workspaceFolder: repo,
    restrictedMode: false,
    cardStore: l.cardStore,
    boardService: l.boardService,
    log: () => {},
    headroomCheck: false,
    freeSpaceFloorBytes: 1,
    ...extra,
  } as Parameters<typeof import("../../src/execute.js").executeCard>[0];
}
