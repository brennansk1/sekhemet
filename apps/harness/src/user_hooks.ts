import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type HookHandler,
  type LifecycleHookContext,
  LifecycleHookEngine,
  type LifecycleHookEvent,
  type TomlTable,
  parseToml,
} from "@sekhemet/kernel";

/**
 * User hooks (K12): shell commands the user attaches to lifecycle events,
 * the way Claude Code and git hooks work. Declared in .sekhemet/hooks.toml:
 *
 *   [[hook]]
 *   event = "post-tool"          # any LifecycleHookEvent
 *   tool = "write_file"          # optional: only for this tool (pre/post-tool)
 *   command = "pnpm exec biome format --write $SEKHEMET_TOOL_TARGET"
 *   timeout_s = 30
 *
 * The hook gets the event's context as JSON on stdin and as environment
 * variables (SEKHEMET_EVENT, SEKHEMET_CARD, SEKHEMET_TOOL, SEKHEMET_TOOL_TARGET).
 * Exit 0 continues. Exit 2 blocks the action, and stderr is the reason, which
 * the model is told. On exit 0, a JSON object on stdout with "message" (or
 * "inject": [...]) adds text to the next model turn.
 *
 * Hooks run with the user's rights, outside the sandbox (hooks.ts explains
 * why), so the file is trusted configuration like a git hook. It is also
 * protected: agents may not edit .sekhemet/ (the gates' protected globs).
 */

const EVENTS = new Set<LifecycleHookEvent>([
  "card/start",
  "pre-step",
  "pre-tool",
  "post-tool",
  "pre-gate",
  "post-gate",
  "card/end",
  "review/return",
  "playbook/propose",
  "turn-stopping",
]);

export interface UserHook {
  event: LifecycleHookEvent;
  command: string;
  tool?: string;
  timeoutMs: number;
}

export function loadUserHooks(repoPath: string): { hooks: UserHook[]; errors: string[] } {
  const path = join(repoPath, ".sekhemet", "hooks.toml");
  if (!existsSync(path)) return { hooks: [], errors: [] };
  const errors: string[] = [];
  let parsed: TomlTable;
  try {
    parsed = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      hooks: [],
      errors: [`hooks.toml: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const raw = Array.isArray(parsed.hook) ? (parsed.hook as TomlTable[]) : [];
  const hooks: UserHook[] = [];
  raw.forEach((h, i) => {
    const event = String(h.event ?? "") as LifecycleHookEvent;
    const command = typeof h.command === "string" ? h.command.trim() : "";
    if (!EVENTS.has(event)) return errors.push(`hook ${i + 1}: unknown event "${String(h.event)}"`);
    if (!command) return errors.push(`hook ${i + 1}: missing command`);
    hooks.push({
      event,
      command,
      ...(typeof h.tool === "string" ? { tool: h.tool } : {}),
      timeoutMs: Math.max(1, Number(h.timeout_s ?? 30)) * 1000,
    });
  });
  return { hooks, errors };
}

function target(ctx: LifecycleHookContext): string {
  const a = ctx.toolArgs ?? {};
  for (const k of ["path", "file", "target", "file_path"])
    if (typeof a[k] === "string") return a[k] as string;
  return "";
}

/** One hook as an engine handler: run the command, read its verdict. */
export function hookHandler(hook: UserHook, cwd: string): HookHandler {
  return (ctx: LifecycleHookContext) =>
    new Promise((resolve, reject) => {
      if (hook.tool && ctx.toolName !== hook.tool) return resolve({});
      const child = spawn("/bin/sh", ["-c", hook.command], {
        cwd,
        env: {
          ...process.env,
          SEKHEMET_EVENT: hook.event,
          SEKHEMET_CARD: ctx.cardId,
          SEKHEMET_TOOL: ctx.toolName ?? "",
          SEKHEMET_TOOL_TARGET: target(ctx),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`hook timed out after ${hook.timeoutMs / 1000}s: ${hook.command}`));
      }, hook.timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 2)
          return resolve({
            block: true,
            reason: err.trim().slice(0, 1000) || `blocked by hook: ${hook.command}`,
          });
        if (code !== 0)
          return reject(new Error(`hook exited ${code}: ${err.trim().slice(0, 300)}`));
        let inject: string[] = [];
        try {
          const j = JSON.parse(out.trim() || "{}") as { message?: string; inject?: string[] };
          inject = [
            ...(j.message ? [j.message] : []),
            ...(Array.isArray(j.inject) ? j.inject.map(String) : []),
          ];
        } catch {
          // Plain output is for the user's terminal, not the model.
        }
        resolve(inject.length ? { inject } : {});
      });
      child.stdin.end(JSON.stringify(ctx));
    });
}

/** An engine with the project's user hooks registered (none when there is no hooks.toml). */
export function hookEngineFor(
  repoPath: string,
  cwd = repoPath,
): { engine: LifecycleHookEngine; errors: string[]; count: number } {
  const engine = new LifecycleHookEngine();
  const { hooks, errors } = loadUserHooks(repoPath);
  for (const h of hooks) engine.register(h.event, hookHandler(h, cwd));
  return { engine, errors, count: hooks.length };
}
