import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";

/**
 * The built command line for the design-stage, measurement and context
 * entry-point tests (FINISH_LINE_PLAN C2d; FINDINGS_C1 TST-01): the binary
 * `apps/harness/dist/index.js` spawned as a person runs it, in a throwaway
 * home, never reaching a real model or the network. Spawned asynchronously,
 * so a local HTTP stub served by the test process answers it.
 */
export const BIN = resolve(import.meta.dirname, "../../dist/index.js");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh directory removed after the test, with its real path. */
export function scratch(prefix = "sek-g2-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** Remove `d` after the test (a fixture that made its own directory). */
export function track(d: string): string {
  dirs.push(d);
  return d;
}

/** An empty working directory and an empty home under one scratch root. */
export function g2Dirs(): { cwd: string; home: string; root: string } {
  const root = scratch();
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  return { cwd, home, root };
}

/** The environment of a person's shell, with a throwaway home and no model loads. */
export function g2Env(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const configDir = join(home, ".sekhemet");
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    SEKHEMET_CONFIG_DIR: configDir,
    SEKHEMET_MODEL_REGISTRY: join(configDir, "models.json"),
    SEKHEMET_MACHINE_PROFILE: join(configDir, "machine.json"),
    SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
    SEKHEMET_KEYCHAIN: "off",
    SEKHEMET_MODEL_LOADS: "off",
    BROWSER: "false",
    ...extra,
  };
}

/**
 * A PATH whose `gh` refuses before any request (research's GitHub reads go
 * through `gh`): `bin` is written under `home` and put first.
 */
export function pathWithoutGh(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  writeFileSync(gh, '#!/bin/sh\necho "gh: not logged in (test stub)" >&2\nexit 4\n');
  chmodSync(gh, 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `sekhemet <args>` as a subprocess. `preload` is a module loaded with
 * `node --import` (a scripted model at the HTTP boundary); `input` is written
 * to stdin and closed.
 */
export function cli(
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    preload?: string;
    input?: string;
    timeoutMs?: number;
  },
): Promise<CliResult> {
  const pre = opts.preload ? ["--import", opts.preload] : [];
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...pre, BIN, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += String(b);
    });
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`sekhemet ${args.join(" ")} timed out\n${stdout}\n${stderr}`));
    }, opts.timeoutMs ?? 60_000);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
}

/**
 * `sekhemet <args>` started and left running (a card a person is waiting on);
 * the caller stops it with `stop()`, which kills it and resolves when it exited.
 */
export function cliStart(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; preload?: string },
): { output: () => string; stop: () => Promise<void> } {
  const pre = opts.preload ? ["--import", opts.preload] : [];
  const child = spawn(process.execPath, [...pre, BIN, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => {
    out += String(b);
  });
  child.stderr.on("data", (b) => {
    out += String(b);
  });
  const exited = new Promise<void>((r) => child.on("close", () => r()));
  return {
    output: () => out,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

/** Wait until `check` holds, polling every 100 ms, for at most `ms`. */
export async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface LedgerRow {
  seq: number;
  type: string;
  cardId: string | null;
  payload: Record<string, unknown>;
  /** The private part, parsed, when the event has one. */
  private?: Record<string, unknown>;
}

/** Every event of the repository's ledger, read-only, after the process exited. */
export function ledgerRows(repo: string): LedgerRow[] {
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT e.seq AS seq, e.type AS type, e.card_id AS cardId, e.payload AS payload, p.body AS body
         FROM events e LEFT JOIN event_private p ON p.event_id = e.id ORDER BY e.seq`,
      )
      .all() as {
      seq: number;
      type: string;
      cardId: string | null;
      payload: string;
      body: string | null;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      cardId: r.cardId,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      ...(r.body ? { private: parsePrivate(r.body) } : {}),
    }));
  } finally {
    db.close();
  }
}

function parsePrivate(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { raw: body };
  }
}

/** Every byte the ledger holds, public and private, as one string. */
export function ledgerText(repo: string): string {
  return ledgerRows(repo)
    .map((r) => `${JSON.stringify(r.payload)}\n${JSON.stringify(r.private ?? {})}`)
    .join("\n");
}
