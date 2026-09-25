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
import { userPaths } from "./user_dir.js";
import { isTrusted } from "./workspace_trust.js";

/**
 * User hooks (K12): shell commands the user attaches to lifecycle events,
 * the way Claude Code and git hooks work. Declared in .sekhemet/hooks.toml:
 *
 *   [[hook]]
 *   name = "format on write"     # optional: how a block by this hook is named
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

/**
 * Board-lifecycle events (NEW-extensibility-1): a hook on one observes a
 * transition that has happened; it cannot block or reverse it (rule 7).
 */
export const BOARD_EVENTS: readonly LifecycleHookEvent[] = [
  "card/status_changed",
  "card/accepted",
  "pr/opened",
];

/** The gating events, where a hook that does not answer blocks (kernel hooks.ts). */
const FAIL_CLOSED = new Set<LifecycleHookEvent>(["pre-step", "pre-tool", "pre-gate"]);

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
  ...BOARD_EVENTS,
]);

export interface UserHook {
  event: LifecycleHookEvent;
  command: string;
  /** Its configured name; a veto names the hook by this, else by its command (WL-T3-4). */
  name?: string;
  tool?: string;
  timeoutMs: number;
}

export function loadUserHooks(repoPath: string): {
  hooks: UserHook[];
  errors: string[];
  /** The file exists but the person has not trusted it as it is (S9, SEC-28). */
  untrusted?: boolean;
} {
  const path = join(repoPath, ".sekhemet", "hooks.toml");
  if (!existsSync(path)) return { hooks: [], errors: [] };
  // S9: a repository's hooks run outside the sandbox, so they are inert
  // until the person trusts this exact file (security items 38–40).
  if (!isTrusted(repoPath, join(".sekhemet", "hooks.toml"))) {
    return { hooks: [], errors: [], untrusted: true };
  }
  return parseHooksFile(path);
}

/**
 * The person's own hooks, `hooks.toml` in the user directory (EXT-13): their
 * configuration, trusted as theirs, and run before a project's.
 */
export function loadPersonHooks(): { hooks: UserHook[]; errors: string[]; path: string } {
  const path = userPaths().hooks;
  return { ...(existsSync(path) ? parseHooksFile(path) : { hooks: [], errors: [] }), path };
}

/** One hooks.toml: its hooks, and each entry that could not load (EXT-10). */
export function parseHooksFile(path: string): { hooks: UserHook[]; errors: string[] } {
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
    const name = typeof h.name === "string" ? h.name.trim() : "";
    hooks.push({
      event,
      command,
      ...(name ? { name } : {}),
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
        // EXT-12: a guard that does not answer in time blocks, and says why;
        // on any other event a timeout fails open and is recorded.
        if (FAIL_CLOSED.has(hook.event))
          return resolve({ block: true, reason: `hook timed out after ${hook.timeoutMs / 1000}s` });
        reject(new Error(`hook timed out after ${hook.timeoutMs / 1000}s: ${hook.command}`));
      }, hook.timeoutMs);
      // EXT-11: a hook that exits without reading its stdin closes the pipe;
      // the write's EPIPE is expected, and the exit code decides as usual.
      child.stdin.on("error", () => undefined);
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

/** How long an unnamed hook's command may be as its name. */
const HOOK_NAME_CHARS = 80;

/**
 * How a hook is named when it blocks (WL-T3-4): its configured name, else its
 * command cut to 80 characters — the name reaches the evidence and the park
 * detail, and a long command may carry inline credentials.
 */
export function hookName(hook: UserHook): string {
  if (hook.name) return hook.name;
  return hook.command.length > HOOK_NAME_CHARS
    ? `${hook.command.slice(0, HOOK_NAME_CHARS)}…`
    : hook.command;
}

/**
 * An engine with the person's hooks, then the project's, registered — so for
 * one event the person's run first (EXT-13). `errors` names each file with
 * what could not load (EXT-10), for `doctor` and the card's evidence.
 */
export function hookEngineFor(
  repoPath: string,
  cwd = repoPath,
): { engine: LifecycleHookEngine; errors: string[]; count: number } {
  const engine = new LifecycleHookEngine();
  const person = loadPersonHooks();
  const project = loadUserHooks(repoPath);
  const projectPath = join(repoPath, ".sekhemet", "hooks.toml");
  const hooks = [...person.hooks, ...project.hooks];
  for (const h of hooks) engine.register(h.event, hookHandler(h, cwd), hookName(h));
  const errors = [
    ...person.errors.map((e) => `${person.path}: ${e}`),
    ...project.errors.map((e) => `${projectPath}: ${e}`),
  ];
  return { engine, errors, count: hooks.length };
}
