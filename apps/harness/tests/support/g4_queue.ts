import { spawn } from "node:child_process";
import type { CardStore, CreateCardInput, EventLog } from "@sekhemet/kernel";
import { BIN, type CliResult, g2Dirs, until } from "./g2_cli.js";
import { SCRIPTED_MODEL, type ToolCall, type Turn, scriptEnv } from "./g2_model.js";
import { type G2Project, g2Project } from "./g2_project.js";

/**
 * `sekhemet <args>` as a subprocess: the built binary, `preload` loaded with
 * `node --import` (a scripted model at the HTTP boundary).
 */
function bin(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; preload?: string; timeoutMs?: number },
): Promise<CliResult> {
  const pre = opts.preload ? ["--import", opts.preload] : [];
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...pre, BIN, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
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
    }, opts.timeoutMs ?? 180_000);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

/** `sekhemet <args>` started and left running; `stop()` kills it and waits for it to exit. */
function binStart(
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

/** `sekhemet gate <card>`: the card's verification as a person runs it (gates rule 8, T1). */
export function gateCard(
  p: { repo: string; env: Record<string, string> },
  card = "c1",
  extra: Record<string, string> = {},
): Promise<CliResult> {
  return bin(["gate", card], { cwd: p.repo, env: { ...p.env, ...extra }, timeoutMs: 120_000 });
}

/**
 * `sekhemet queue` as a person runs it, for the gates, worker-loop and
 * runtime entry-point tests (FINISH_LINE_PLAN C2d): the built binary
 * (`apps/harness/dist/index.js`, spawned here) over a real
 * repository and ledger, its Worker `g2_model.ts`'s scripted model at the
 * HTTP boundary (no model is loaded, nothing leaves the machine).
 */
export async function queueProject(opts: {
  /** The base's files; `.sekhemet/gates.toml` here replaces the default passing gate. */
  files: Record<string, string>;
  cards: CreateCardInput[];
  seed?: (store: CardStore, log: EventLog) => Promise<void>;
}): Promise<G2Project> {
  return g2Project(g2Dirs(), opts);
}

/** `sekhemet queue --worker <scripted>` with the Worker's turns; `extra` adds environment. */
export function runQueue(
  p: G2Project,
  worker: Turn[],
  extra: Record<string, string> = {},
  args: string[] = [],
): Promise<CliResult> {
  return bin(["queue", "--worker", SCRIPTED_MODEL, ...args], {
    cwd: p.repo,
    preload: p.preload,
    env: { ...p.env, ...scriptEnv(p.record, { worker }), ...extra },
    timeoutMs: 180_000,
  });
}

export const FINISH: ToolCall[] = [{ name: "finish_card" }];

export const write = (path: string, content: string): ToolCall[] => [
  { name: "write_file", arguments: { path, content } },
];

/** `sekhemet queue` with its Worker served by a `g4_engine.ts` engine (a separate process). */
export function runQueueOn(
  p: G2Project,
  engine: { preload: string; env: Record<string, string> },
  extra: Record<string, string> = {},
  args: string[] = [],
): Promise<CliResult> {
  return bin(["queue", "--worker", SCRIPTED_MODEL, ...args], {
    cwd: p.repo,
    preload: engine.preload,
    env: { ...p.env, ...engine.env, ...extra },
    timeoutMs: 180_000,
  });
}

/**
 * `sekhemet queue` on an engine, read until its report line, then stopped:
 * for runs whose process stays up after the report (a language server the
 * run started keeps it alive; reported as a finding of C2d, not judged here).
 */
export async function runQueueToReport(
  p: G2Project,
  engine: { preload: string; env: Record<string, string> },
  extra: Record<string, string> = {},
): Promise<{ stdout: string }> {
  const q = binStart(["queue", "--worker", SCRIPTED_MODEL], {
    cwd: p.repo,
    preload: engine.preload,
    env: { ...p.env, ...engine.env, ...extra },
  });
  try {
    await until(() => /Report: \S+queue_report\.json/.test(q.output()), 120_000);
    return { stdout: q.output() };
  } finally {
    await q.stop();
  }
}
